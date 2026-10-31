// Hand-rolled Discord local RPC client over IPC (unix socket / Windows named pipe).
// Frames: int32LE opcode + int32LE length + UTF-8 JSON. HANDSHAKE {v: 1, client_id}, READY, then
// SET_ACTIVITY commands matched to replies by nonce. Overview: docs/ARCHITECTURE.md.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { logger } from '../log.ts';
import { DiscordRpcError, type Activity, type PresenceSink } from '../model.ts';
import { discoverSocketPaths } from './socketPaths.ts';

const log = logger('discord');

export const Op = { Handshake: 0, Frame: 1, Close: 2, Ping: 3, Pong: 4 } as const;
/** CLOSE code for an application id Discord does not know. */
export const CLOSE_INVALID_CLIENT_ID = 4000;

const HEADER_BYTES = 8;
/** Discord itself caps frames at 3 MiB; a much larger length means the stream is out of sync. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_BACKOFF_MS = [5000, 10000, 20000, 30000];

export interface Frame {
  op: number;
  body: Buffer;
}

/** Header is int32LE opcode + int32LE byte length (the client uses signed ints), then UTF-8 JSON. */
export function encodeFrame(op: number, payload: object): Buffer {
  const json = JSON.stringify(payload);
  const length = Buffer.byteLength(json);
  const buf = Buffer.alloc(HEADER_BYTES + length);
  buf.writeInt32LE(op, 0);
  buf.writeInt32LE(length, 4);
  buf.write(json, HEADER_BYTES, 'utf8');
  return buf;
}

function encodeRaw(op: number, body: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** Streaming decoder: accepts arbitrary chunk boundaries (partial and coalesced frames). */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  /** Returns every complete frame; throws on an impossible length (the stream is unusable then). */
  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: Frame[] = [];
    while (this.buf.length >= HEADER_BYTES) {
      const op = this.buf.readInt32LE(0);
      const length = this.buf.readInt32LE(4);
      if (length < 0 || length > MAX_FRAME_BYTES) throw new Error(`invalid IPC frame length ${length}`);
      if (this.buf.length < HEADER_BYTES + length) break;
      frames.push({ op, body: this.buf.subarray(HEADER_BYTES, HEADER_BYTES + length) });
      this.buf = this.buf.subarray(HEADER_BYTES + length);
    }
    return frames;
  }
}

/** Delay before reconnect attempt number `failures` (0-based); the last value repeats. */
export function backoffDelay(failures: number, backoffMs: readonly number[], invalidClient = false): number {
  const last = backoffMs.length - 1;
  return backoffMs[invalidClient ? last : Math.min(failures, last)] ?? 0;
}

interface RpcMessage {
  cmd?: string;
  evt?: string | null;
  nonce?: string | null;
  data?: unknown;
}

function parseBody(body: Buffer): RpcMessage | undefined {
  try {
    const value: unknown = JSON.parse(body.toString('utf8'));
    return value !== null && typeof value === 'object' ? (value as RpcMessage) : undefined;
  } catch {
    return undefined;
  }
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  discriminator?: string;
  avatar?: string | null;
}

/** DISPATCH READY payload. */
export interface ReadyInfo {
  v?: number;
  config?: { cdn_host?: string; api_endpoint?: string; environment?: string };
  user?: DiscordUser;
}

export interface DiscordIpcEvents {
  ready: [info: ReadyInfo];
  disconnected: [reason: string];
  /** The automatic re-send after READY failed (foreground setActivity calls reject instead). */
  resendFailed: [error: Error, activity: Activity];
}

export interface DiscordIpcOptions {
  clientId: string;
  pid?: number;
  /** Socket discovery, called once per connect cycle. Tests inject a temp path here. */
  paths?: () => string[];
  /** Delays between connect cycles; the last value repeats. */
  backoffMs?: number[];
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Wait for READY after the handshake. Discord queues rate-limited handshakes rather than failing them. */
  readyTimeoutMs?: number;
  /** Bound on the clear that stop() sends. */
  stopTimeoutMs?: number;
}

interface Pending {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Conn {
  sock: Socket;
  path: string;
  reason: string;
}

/**
 * One long-lived IPC connection (handshakes are rate-limited per client id: burst 2, then 1/30 s).
 * Remembers the desired activity and re-sends it after every (re)connect.
 */
export class DiscordIpc extends EventEmitter<DiscordIpcEvents> implements PresenceSink {
  private readonly clientId: string;
  private readonly pid: number;
  private readonly paths: () => string[];
  private readonly backoffMs: number[];
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly stopTimeoutMs: number;

  private running = false;
  /** Bumped by start/stop so a connect cycle from an older run bails out. */
  private epoch = 0;
  private conn: Conn | undefined;
  private connecting: Socket | undefined;
  private ready = false;
  private failures = 0;
  private invalidClient = false;
  private missLogged = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private readyTimer: NodeJS.Timeout | undefined;
  private desired: Activity | null = null;
  /** What Discord shows on this connection: the last activity it accepted. */
  private accepted: Activity | null = null;
  /** A non-null activity was the last thing sent on this connection. */
  private shown = false;
  private readonly pending = new Map<string, Pending>();

  constructor(opts: DiscordIpcOptions) {
    super();
    this.clientId = opts.clientId;
    this.pid = opts.pid ?? process.pid;
    this.paths = opts.paths ?? (() => discoverSocketPaths());
    this.backoffMs = opts.backoffMs?.length ? opts.backoffMs : DEFAULT_BACKOFF_MS;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 3000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10000;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 60000;
    this.stopTimeoutMs = opts.stopTimeoutMs ?? 1000;
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** Starts the background connect loop. Never throws; failures are retried with backoff. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.epoch++;
    this.failures = 0;
    this.connect();
  }

  /**
   * Sets the desired presence (null clears). Sent now when connected, otherwise resolves at once
   * and the activity goes out after the next READY. Rejects with DiscordRpcError on an ERROR reply.
   */
  async setActivity(activity: Activity | null): Promise<void> {
    this.desired = activity;
    if (!this.ready) return;
    await this.deliver(activity);
  }

  /** Clears what we showed (bounded wait), closes the socket and stops reconnecting. */
  async stop(): Promise<void> {
    this.running = false;
    this.epoch++;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.connecting?.destroy();
    const conn = this.conn;
    if (!conn) return;
    if (this.ready && this.shown) {
      try {
        await this.request('SET_ACTIVITY', { pid: this.pid }, this.stopTimeoutMs);
      } catch (err) {
        log.debug('clear on stop failed', (err as Error).message);
      }
    }
    conn.reason = 'stopped';
    this.detach(conn);
    await closeSocket(conn.sock);
  }

  /** A rejected command changed nothing in Discord, so it must not stay the activity re-sent after a reconnect. */
  private async deliver(activity: Activity | null): Promise<void> {
    try {
      await this.send(activity);
      this.accepted = activity;
    } catch (err) {
      if (err instanceof DiscordRpcError && this.desired === activity) this.desired = this.accepted;
      throw err;
    }
  }

  private send(activity: Activity | null): Promise<void> {
    this.shown = activity !== null;
    return this.request('SET_ACTIVITY', activity ? { pid: this.pid, activity } : { pid: this.pid }, this.requestTimeoutMs);
  }

  private request(cmd: string, args: object, timeoutMs: number): Promise<void> {
    const sock = this.conn?.sock;
    if (!sock || !this.ready || !sock.writable) return Promise.reject(new Error('Discord IPC is not connected'));
    const nonce = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(new Error(`${cmd} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(nonce, { resolve, reject, timer });
      sock.write(encodeFrame(Op.Frame, { cmd, args, nonce }));
    });
  }

  private connect(): void {
    this.retryTimer = undefined;
    const epoch = this.epoch;
    this.cycle(epoch).catch((err: unknown) => {
      log.error('connect cycle failed', err);
      if (epoch === this.epoch) this.scheduleReconnect();
    });
  }

  private async cycle(epoch: number): Promise<void> {
    let paths: string[] = [];
    try {
      paths = this.paths();
    } catch (err) {
      log.warn('socket discovery failed', (err as Error).message);
    }
    for (const path of paths) {
      if (epoch !== this.epoch) return;
      const sock = await this.probe(path);
      if (!sock) continue;
      if (epoch !== this.epoch) {
        sock.destroy();
        return;
      }
      this.attach(sock, path);
      return;
    }
    if (epoch !== this.epoch) return;
    if (!this.missLogged) {
      log.info('no Discord IPC socket accepted a connection (is Discord running?); retrying in the background');
      this.missLogged = true;
    }
    this.scheduleReconnect();
  }

  /** Resolves the connected socket, or undefined on error/timeout. */
  private probe(path: string): Promise<Socket | undefined> {
    let sock: Socket;
    try {
      sock = createConnection(path);
    } catch (err) {
      log.debug(`connect ${path} failed: ${(err as Error).message}`);
      return Promise.resolve(undefined);
    }
    this.connecting = sock;
    return new Promise((resolve) => {
      const finish = (ok: boolean, why = '') => {
        clearTimeout(timer);
        sock.off('connect', onConnect).off('error', onError).off('close', onClose);
        if (this.connecting === sock) this.connecting = undefined;
        if (!ok) {
          log.debug(`connect ${path} failed: ${why}`);
          sock.destroy();
        }
        resolve(ok ? sock : undefined);
      };
      const onConnect = () => finish(true);
      const onError = (err: Error) => finish(false, err.message);
      const onClose = () => finish(false, 'closed');
      const timer = setTimeout(() => finish(false, 'timeout'), this.connectTimeoutMs);
      sock.once('connect', onConnect).once('error', onError).once('close', onClose);
    });
  }

  private attach(sock: Socket, path: string): void {
    const conn: Conn = { sock, path, reason: 'socket closed' };
    this.conn = conn;
    const decoder = new FrameDecoder();
    sock.on('data', (chunk: Buffer) => {
      let frames: Frame[];
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        conn.reason = (err as Error).message;
        log.warn(`protocol error from ${path}: ${conn.reason}`);
        sock.destroy();
        return;
      }
      for (const frame of frames) {
        if (this.conn !== conn) break;
        this.onFrame(conn, frame);
      }
    });
    sock.on('error', (err) => {
      conn.reason = err.message;
    });
    sock.on('close', () => this.detach(conn));
    this.readyTimer = setTimeout(() => {
      conn.reason = `no READY within ${this.readyTimeoutMs} ms`;
      log.warn(conn.reason);
      sock.destroy();
    }, this.readyTimeoutMs);
    log.debug(`connected to ${path}, sending handshake`);
    sock.write(encodeFrame(Op.Handshake, { v: 1, client_id: this.clientId }));
  }

  private onFrame(conn: Conn, frame: Frame): void {
    switch (frame.op) {
      case Op.Ping:
        conn.sock.write(encodeRaw(Op.Pong, frame.body));
        return;
      case Op.Pong:
      case Op.Handshake:
        return;
      case Op.Close: {
        const data = (parseBody(frame.body) ?? {}) as { code?: unknown; message?: unknown };
        conn.reason = `CLOSE ${String(data.code)}: ${String(data.message ?? '')}`;
        if (data.code === CLOSE_INVALID_CLIENT_ID) {
          this.invalidClient = true;
          const every = backoffDelay(0, this.backoffMs, true);
          log.error(`Discord rejected client id "${this.clientId}" (${conn.reason}); check clientId in the config. Retrying every ${every} ms`);
        } else {
          log.warn(`Discord closed the connection: ${conn.reason}`);
        }
        conn.sock.destroy();
        return;
      }
      case Op.Frame: {
        const msg = parseBody(frame.body);
        if (!msg) {
          log.warn('ignoring a frame with invalid JSON');
          return;
        }
        if (msg.cmd === 'DISPATCH' && msg.evt === 'READY') this.onReady(conn, (msg.data ?? {}) as ReadyInfo);
        else if (typeof msg.nonce === 'string') this.settle(msg.nonce, msg);
        return;
      }
      default:
        log.debug(`ignoring opcode ${frame.op}`);
    }
  }

  private onReady(conn: Conn, info: ReadyInfo): void {
    if (this.ready) return;
    clearTimeout(this.readyTimer);
    this.ready = true;
    this.failures = 0;
    this.invalidClient = false;
    this.missLogged = false;
    const user = info.user;
    log.info(`connected to Discord${user ? ` as ${user.global_name ?? user.username}` : ''} via ${conn.path}`);
    const activity = this.desired;
    if (activity) {
      this.deliver(activity).catch((err: Error) => {
        log.warn(`re-sending activity after READY failed: ${err.message}`);
        this.emit('resendFailed', err, activity);
      });
    }
    this.emit('ready', info);
  }

  private settle(nonce: string, msg: RpcMessage): void {
    const p = this.pending.get(nonce);
    if (!p) return;
    this.pending.delete(nonce);
    clearTimeout(p.timer);
    if (msg.evt === 'ERROR') {
      const data = (msg.data ?? {}) as { code?: unknown; message?: unknown };
      p.reject(new DiscordRpcError(typeof data.code === 'number' ? data.code : 0, typeof data.message === 'string' ? data.message : 'unknown error'));
    } else {
      p.resolve();
    }
  }

  private detach(conn: Conn): void {
    if (this.conn !== conn) return;
    this.conn = undefined;
    clearTimeout(this.readyTimer);
    const wasReady = this.ready;
    this.ready = false;
    this.shown = false;
    this.accepted = null;
    const err = new Error(`Discord IPC disconnected: ${conn.reason}`);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    if (wasReady) log.info(`disconnected from Discord: ${conn.reason}`);
    else log.debug(`connection to ${conn.path} closed before READY: ${conn.reason}`);
    this.emit('disconnected', conn.reason);
    if (this.running) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running || this.retryTimer) return;
    const delay = backoffDelay(this.failures, this.backoffMs, this.invalidClient);
    this.failures++;
    log.debug(`next connect attempt in ${delay} ms`);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }
}

/** Flushes and closes; destroys after a short grace if the peer does not cooperate. */
function closeSocket(sock: Socket, graceMs = 200): Promise<void> {
  if (sock.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => sock.destroy(), graceMs);
    sock.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    sock.destroySoon();
  });
}
