// DiscordIpc against a fake Discord IPC server on a temp unix socket. Never touches the real Discord socket.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { candidateSocketPaths, discoverSocketPaths } from '../src/discord/socketPaths.ts';
import type { DiscordIpcOptions } from '../src/discord/ipc.ts';
import { DiscordRpcError, type Activity } from '../src/model.ts';

// log.ts reads LOG_LEVEL at import time, so load the module after quieting it.
process.env.LOG_LEVEL ??= 'error';
const { DiscordIpc, FrameDecoder, encodeFrame, backoffDelay, Op } = await import('../src/discord/ipc.ts');

const CLIENT_ID = '123456789012345678';
const PID = 4242;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTIVITY: Activity = {
  type: 2,
  name: 'Яндекс Музыка',
  status_display_type: 1,
  details: 'Capable of love',
  state: 'PinkPantheress',
  timestamps: { start: 1793449929258, end: 1793450153005 },
  assets: { large_image: 'https://avatars.yandex.net/get-music-content/9837405/0f61442d.a.28127004-1/400x400', large_text: 'Heaven knows' },
  buttons: [{ label: 'Слушать в Яндекс Музыке', url: 'https://music.yandex.ru/album/28127004/track/118138322' }],
  instance: false,
};

// Independent wire helpers so the tests do not just mirror the implementation.
function wire(op: number, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

interface Received {
  conn: Socket;
  op: number;
  data: any;
}

/** Minimal Discord IPC server: answers HANDSHAKE with READY and echoes SET_ACTIVITY unless told otherwise. */
class FakeDiscord {
  readonly dir = mkdtempSync(join(tmpdir(), 'ym-rpc-test-'));
  readonly path = join(this.dir, 'discord-ipc-0');
  readonly conns: Socket[] = [];
  /** Ordered server-side event log: 'connect', op names / commands, 'end'. */
  readonly log: string[] = [];
  autoReady = true;
  autoReply = true;
  /** Return true to suppress the default reply. */
  onFrame: ((r: Received) => boolean | void) | undefined;
  private server: Server | undefined;
  private queue: Received[] = [];
  private waiters: { match: (r: Received) => boolean; resolve: (r: Received) => void }[] = [];

  async listen(): Promise<void> {
    this.server = createServer((conn) => {
      this.conns.push(conn);
      this.log.push('connect');
      let buf: Buffer = Buffer.alloc(0);
      conn.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 8) {
          const op = buf.readInt32LE(0);
          const len = buf.readInt32LE(4);
          if (buf.length < 8 + len) break;
          const data: unknown = JSON.parse(buf.subarray(8, 8 + len).toString('utf8'));
          buf = buf.subarray(8 + len);
          this.receive({ conn, op, data });
        }
      });
      conn.on('end', () => this.log.push('end'));
      conn.on('error', () => {});
    });
    this.server.listen(this.path);
    await once(this.server, 'listening');
  }

  private receive(r: Received): void {
    this.log.push(r.op === Op.Frame ? `${r.data.cmd}${r.data.args && !('activity' in r.data.args) ? '(clear)' : ''}` : `op${r.op}`);
    if (!this.onFrame?.(r)) {
      if (r.op === Op.Handshake && this.autoReady) this.ready(r.conn);
      if (r.op === Op.Frame && r.data.cmd === 'SET_ACTIVITY' && this.autoReply) this.reply(r);
    }
    const i = this.waiters.findIndex((w) => w.match(r));
    if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(r);
    else this.queue.push(r);
  }

  ready(conn: Socket): void {
    const data = { v: 1, config: { cdn_host: 'cdn.discordapp.com', api_endpoint: '//discord.com/api', environment: 'production' }, user: { id: '1', username: 'tester', global_name: 'Tester' } };
    conn.write(wire(Op.Frame, { cmd: 'DISPATCH', evt: 'READY', data, nonce: null }));
  }

  reply(r: Received, extra: object = {}): void {
    r.conn.write(wire(Op.Frame, { cmd: r.data.cmd, evt: null, data: r.data.args?.activity ?? null, nonce: r.data.nonce, ...extra }));
  }

  /** Next received frame matching `match` (including ones that already arrived). */
  next(match: (r: Received) => boolean = () => true, timeoutMs = 2000): Promise<Received> {
    const i = this.queue.findIndex(match);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fake Discord: no matching frame within ${timeoutMs} ms; log=${this.log.join(',')}`)), timeoutMs);
      this.waiters.push({ match, resolve: (r) => (clearTimeout(timer), resolve(r)) });
    });
  }

  pending(match: (r: Received) => boolean): Received[] {
    return this.queue.filter(match);
  }

  dropAll(): void {
    for (const c of this.conns) c.destroy();
  }

  async dispose(): Promise<void> {
    this.dropAll();
    if (this.server?.listening) {
      this.server.close();
      await once(this.server, 'close');
    }
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const isSet = (r: Received) => r.op === Op.Frame && r.data.cmd === 'SET_ACTIVITY';
const isHandshake = (r: Received) => r.op === Op.Handshake;

function withTimeout<T>(p: Promise<T>, ms = 2000, label = 'operation'): Promise<T> {
  return Promise.race([p, delay(ms).then(() => Promise.reject(new Error(`${label} timed out`)))]);
}

async function waitUntil(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await delay(5);
  }
}

async function setup(t: TestContext, opts: Partial<DiscordIpcOptions> = {}, listen = true) {
  const fake = new FakeDiscord();
  if (listen) await fake.listen();
  const ipc = new DiscordIpc({ clientId: CLIENT_ID, pid: PID, paths: () => [fake.path], backoffMs: [10, 20], connectTimeoutMs: 200, requestTimeoutMs: 500, stopTimeoutMs: 100, ...opts });
  t.after(async () => {
    await ipc.stop();
    await fake.dispose();
  });
  return { fake, ipc };
}

async function startReady(t: TestContext, opts: Partial<DiscordIpcOptions> = {}) {
  const ctx = await setup(t, opts);
  const ready = once(ctx.ipc, 'ready');
  ctx.ipc.start();
  await withTimeout(ready, 2000, 'READY');
  return ctx;
}

// ---- socket discovery -------------------------------------------------------------------------

test('candidateSocketPaths: linux bases × subdirs × indexes, deduplicated, in priority order', () => {
  const paths = candidateSocketPaths({ XDG_RUNTIME_DIR: '/run/user/1000', TMPDIR: '/tmp/' }, 'linux', 1000);
  // /run/user/1000 and /tmp appear twice each in the base list; 2 bases × 7 subdirs × 10 indexes remain.
  assert.equal(paths.length, 140);
  assert.equal(new Set(paths).size, 140);
  assert.equal(paths[0], '/run/user/1000/discord-ipc-0');
  assert.equal(paths[9], '/run/user/1000/discord-ipc-9');
  assert.equal(paths[10], '/run/user/1000/app/com.discordapp.Discord/discord-ipc-0');
  assert.equal(paths[70], '/tmp/discord-ipc-0');
  for (const sub of ['app/com.discordapp.DiscordCanary', 'app/com.discordapp.DiscordPTB', 'app/dev.vencord.Vesktop', '.flatpak/dev.vencord.Vesktop/xdg-run', 'snap.discord']) {
    assert.ok(paths.includes(`/run/user/1000/${sub}/discord-ipc-3`), sub);
  }
});

test('candidateSocketPaths: base order TMPDIR, TMP, TEMP, /run/user/<uid>, /tmp; skips unset vars', () => {
  const paths = candidateSocketPaths({ TMPDIR: '/a', TMP: '/b', TEMP: '/c' }, 'darwin', 501);
  assert.deepEqual(
    [0, 70, 140, 210, 280].map((i) => paths[i]),
    ['/a/discord-ipc-0', '/b/discord-ipc-0', '/c/discord-ipc-0', '/run/user/501/discord-ipc-0', '/tmp/discord-ipc-0'],
  );
  assert.equal(candidateSocketPaths({}, 'linux', null).length, 70);
});

test('candidateSocketPaths: windows named pipes', () => {
  const paths = candidateSocketPaths({ TEMP: 'C:\\Temp' }, 'win32', null);
  assert.equal(paths.length, 10);
  assert.equal(paths[0], String.raw`\\?\pipe\discord-ipc-0`);
  assert.equal(paths[9], String.raw`\\?\pipe\discord-ipc-9`);
});

test('discoverSocketPaths keeps only existing sockets (not on windows)', async (t) => {
  const fake = new FakeDiscord();
  await fake.listen();
  t.after(() => fake.dispose());
  const file = join(fake.dir, 'discord-ipc-1');
  writeFileSync(file, '');
  const missing = join(fake.dir, 'discord-ipc-2');
  assert.deepEqual(discoverSocketPaths([missing, file, fake.path], 'linux'), [fake.path]);
  assert.deepEqual(discoverSocketPaths(['a', 'b'], 'win32', () => false), ['a', 'b']);
});

// ---- framing ----------------------------------------------------------------------------------

test('encodeFrame: int32LE opcode, int32LE UTF-8 byte length, JSON body', () => {
  const payload = { cmd: 'SET_ACTIVITY', s: 'Слушать в Яндекс Музыке' };
  const json = JSON.stringify(payload);
  const buf = encodeFrame(Op.Frame, payload);
  assert.equal(buf.readInt32LE(0), 1);
  assert.equal(buf.readInt32LE(4), Buffer.byteLength(json));
  assert.notEqual(Buffer.byteLength(json), json.length);
  assert.equal(buf.subarray(8).toString('utf8'), json);
  assert.deepEqual(buf, wire(Op.Frame, payload));
});

test('FrameDecoder handles partial and coalesced frames', () => {
  const a = wire(Op.Frame, { cmd: 'DISPATCH', evt: 'READY', s: 'Слушает' });
  const b = wire(Op.Ping, { x: 1 });
  const stream = Buffer.concat([a, b, a]);
  const decode = (chunks: Buffer[]) => {
    const d = new FrameDecoder();
    return chunks.flatMap((c) => d.push(c)).map((f) => ({ op: f.op, data: JSON.parse(f.body.toString('utf8')) as unknown }));
  };
  const expected = [
    { op: 1, data: { cmd: 'DISPATCH', evt: 'READY', s: 'Слушает' } },
    { op: 3, data: { x: 1 } },
    { op: 1, data: { cmd: 'DISPATCH', evt: 'READY', s: 'Слушает' } },
  ];
  assert.deepEqual(decode([stream]), expected);
  assert.deepEqual(decode([...stream].map((byte) => Buffer.from([byte]))), expected);
  // Splits inside the header, at the header boundary, inside a multi-byte character.
  const cuts = [3, 8, a.length - 2, a.length + 5, stream.length];
  assert.deepEqual(decode(cuts.map((end, i) => stream.subarray(cuts[i - 1] ?? 0, end))), expected);
  const empty = new FrameDecoder();
  assert.deepEqual(empty.push(Buffer.alloc(0)), []);
  const bad = Buffer.alloc(8);
  bad.writeInt32LE(1, 0);
  bad.writeInt32LE(-1, 4);
  assert.throws(() => new FrameDecoder().push(bad), /invalid IPC frame length/);
});

test('backoffDelay: walks the list, repeats the last value, max delay for an invalid client id', () => {
  const b = [5000, 10000, 20000, 30000];
  assert.deepEqual([0, 1, 2, 3, 4, 50].map((n) => backoffDelay(n, b)), [5000, 10000, 20000, 30000, 30000, 30000]);
  assert.equal(backoffDelay(0, b, true), 30000);
});

// ---- connection -------------------------------------------------------------------------------

test('handshake sends {v:1, client_id}; READY marks ready and reports the user', { timeout: 5000 }, async (t) => {
  const { fake, ipc } = await setup(t);
  const ready = once(ipc, 'ready');
  assert.equal(ipc.isReady, false);
  ipc.start();
  const hs = await fake.next(isHandshake);
  assert.deepEqual(hs.data, { v: 1, client_id: CLIENT_ID });
  const [info] = await withTimeout(ready);
  assert.equal(info.user?.username, 'tester');
  assert.equal(ipc.isReady, true);
});

test('SET_ACTIVITY carries pid, nonce and activity; resolves on the reply with the same nonce', { timeout: 5000 }, async (t) => {
  const { fake, ipc } = await startReady(t);
  fake.autoReply = false;
  let settled = false;
  const sent = ipc.setActivity(ACTIVITY).finally(() => (settled = true));
  const f = await fake.next(isSet);
  assert.equal(f.op, Op.Frame);
  assert.deepEqual(Object.keys(f.data).sort(), ['args', 'cmd', 'nonce']);
  assert.deepEqual(f.data.args, { pid: PID, activity: ACTIVITY });
  assert.match(f.data.nonce, UUID_RE);
  fake.reply(f, { nonce: 'someone-else' });
  await delay(30);
  assert.equal(settled, false);
  fake.reply(f);
  await withTimeout(sent);
});

test('clear sends args {pid} without an activity key', { timeout: 5000 }, async (t) => {
  const { fake, ipc } = await startReady(t);
  await ipc.setActivity(null);
  const f = await fake.next(isSet);
  assert.deepEqual(f.data.args, { pid: PID });
  assert.equal('activity' in f.data.args, false);
  assert.match(f.data.nonce, UUID_RE);
});

test('ERROR reply rejects with DiscordRpcError carrying the code; the connection stays up', { timeout: 5000 }, async (t) => {
  const { fake, ipc } = await startReady(t);
  fake.onFrame = (r) => {
    if (!isSet(r)) return;
    fake.reply(r, { evt: 'ERROR', data: { code: 1000, message: 'Unknown Error' } });
    return true;
  };
  await assert.rejects(ipc.setActivity(ACTIVITY), (err: unknown) => {
    assert.ok(err instanceof DiscordRpcError);
    assert.equal(err.code, 1000);
    assert.match(err.message, /Unknown Error/);
    return true;
  });
  assert.equal(ipc.isReady, true);
  fake.onFrame = undefined;
  await ipc.setActivity(ACTIVITY);
});

test('request without a reply times out', { timeout: 5000 }, async (t) => {
  const { fake, ipc } = await startReady(t, { requestTimeoutMs: 50 });
  fake.autoReply = false;
  await assert.rejects(ipc.setActivity(ACTIVITY), /timed out after 50 ms/);
});

test('PING is answered with PONG carrying the same payload', { timeout: 5000 }, async (t) => {
  const { fake, ipc } = await startReady(t);
  assert.ok(ipc.isReady);
  fake.conns[0]!.write(wire(Op.Ping, { token: 'abc', n: 7 }));
  const pong = await fake.next((r) => r.op === Op.Pong);
  assert.deepEqual(pong.data, { token: 'abc', n: 7 });
});

test('client decodes server frames split across and coalesced within TCP chunks', { timeout: 5000 }, async (t) => {
  const { fake, ipc } = await setup(t);
  fake.autoReady = false;
  const ready = once(ipc, 'ready');
  ipc.start();
  const hs = await fake.next(isHandshake);
  const readyFrame = wire(Op.Frame, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1, user: { id: '1', username: 'Тестер' } }, nonce: null });
  const stream = Buffer.concat([readyFrame, wire(Op.Ping, { i: 1 }), wire(Op.Ping, { i: 2 })]);
  for (const [from, to] of [[0, 5], [5, readyFrame.length + 20], [readyFrame.length + 20, stream.length]] as const) {
    hs.conn.write(stream.subarray(from, to));
    await delay(15);
  }
  const [info] = await withTimeout(ready);
  assert.equal(info.user?.username, 'Тестер');
  assert.deepEqual((await fake.next((r) => r.op === Op.Pong)).data, { i: 1 });
  assert.deepEqual((await fake.next((r) => r.op === Op.Pong)).data, { i: 2 });
});

test('server closes → reconnect with backoff → last activity re-sent after READY', { timeout: 5000 }, async (t) => {
  const { fake, ipc } = await startReady(t);
  await ipc.setActivity(ACTIVITY);
  const first = await fake.next(isSet);
  const disconnected = once(ipc, 'disconnected');
  fake.dropAll();
  await withTimeout(disconnected);
  assert.equal(ipc.isReady, false);
  const hs2 = await fake.next((r) => isHandshake(r) && r.conn !== first.conn);
  assert.deepEqual(hs2.data, { v: 1, client_id: CLIENT_ID });
  const resent = await fake.next((r) => isSet(r) && r.conn === hs2.conn);
  assert.deepEqual(resent.data.args, { pid: PID, activity: ACTIVITY });
  assert.notEqual(resent.data.nonce, first.data.nonce);
  assert.equal(fake.conns.length, 2);
});

test('after a clear, a reconnect does not re-send anything', { timeout: 5000 }, async (t) => {
  const { fake, ipc } = await startReady(t);
  await ipc.setActivity(ACTIVITY);
  await ipc.setActivity(null);
  fake.dropAll();
  await waitUntil(() => fake.conns.length === 2 && ipc.isReady);
  await delay(30);
  assert.deepEqual(fake.pending((r) => isSet(r) && r.conn === fake.conns[1]), []);
});

test('pending requests are rejected when the connection drops', { timeout: 5000 }, async (t) => {
  const { fake, ipc } = await startReady(t);
  fake.autoReply = false;
  const sent = ipc.setActivity(ACTIVITY);
  const f = await fake.next(isSet);
  f.conn.end(wire(Op.Close, { code: 1000, message: 'bye' }));
  await assert.rejects(sent, /disconnected: CLOSE 1000: bye/);
});

test('CLOSE 4000 (invalid client id) disconnects and retries with the max backoff', { timeout: 5000 }, async (t) => {
  const { fake, ipc } = await setup(t, { backoffMs: [5, 80] });
  fake.autoReady = false;
  fake.onFrame = (r) => {
    if (isHandshake(r)) r.conn.end(wire(Op.Close, { code: 4000, message: 'Invalid Client ID' }));
  };
  const disconnected = once(ipc, 'disconnected');
  ipc.start();
  await fake.next(isHandshake);
  const t0 = Date.now();
  const [reason] = await withTimeout(disconnected);
  assert.match(reason, /4000: Invalid Client ID/);
  await fake.next(isHandshake);
  assert.ok(Date.now() - t0 >= 70, `retried after ${Date.now() - t0} ms, expected the 80 ms max backoff`);
  assert.equal(ipc.isReady, false);
});

test('no READY within readyTimeoutMs → drop and reconnect', { timeout: 5000 }, async (t) => {
  const { fake, ipc } = await setup(t, { readyTimeoutMs: 40 });
  fake.autoReady = false;
  ipc.start();
  const hs1 = await fake.next(isHandshake);
  const hs2 = await fake.next(isHandshake);
  assert.notEqual(hs1.conn, hs2.conn);
});

test('stop() sends a clear, then closes the socket and stops reconnecting', { timeout: 5000 }, async (t) => {
  const { fake, ipc } = await startReady(t);
  await ipc.setActivity(ACTIVITY);
  await fake.next(isSet);
  const disconnected = once(ipc, 'disconnected');
  await withTimeout(ipc.stop());
  const clear = await fake.next(isSet);
  assert.deepEqual(clear.data.args, { pid: PID });
  await waitUntil(() => fake.log.includes('end'));
  assert.deepEqual(fake.log.slice(-2), ['SET_ACTIVITY(clear)', 'end']);
  assert.deepEqual(await withTimeout(disconnected), ['stopped']);
  assert.equal(ipc.isReady, false);
  await delay(60);
  assert.equal(fake.conns.length, 1);
  await ipc.setActivity(ACTIVITY); // not connected any more: resolves without sending
  assert.deepEqual(fake.pending(isSet), []);
});

test('stop() without anything shown just closes', { timeout: 5000 }, async (t) => {
  const { fake, ipc } = await startReady(t);
  await withTimeout(ipc.stop());
  await waitUntil(() => fake.log.includes('end'));
  assert.deepEqual(fake.log, ['connect', 'op0', 'end']);
});

test('without a socket it keeps retrying quietly; the desired activity goes out after READY', { timeout: 5000 }, async (t) => {
  let calls = 0;
  let fake!: FakeDiscord;
  const ctx = await setup(t, { backoffMs: [5], paths: () => (++calls <= 2 ? [] : [fake.path]) }, false);
  fake = ctx.fake;
  const { ipc } = ctx;
  ipc.start();
  ipc.start(); // idempotent
  await waitUntil(() => calls >= 5);
  assert.equal(ipc.isReady, false);
  await withTimeout(ipc.setActivity({ ...ACTIVITY, details: 'old' }), 50, 'setActivity while offline');
  await ipc.setActivity(ACTIVITY); // only the latest desired state is sent
  await fake.listen();
  const hs = await fake.next(isHandshake);
  assert.deepEqual(hs.data, { v: 1, client_id: CLIENT_ID });
  const f = await fake.next(isSet);
  assert.deepEqual(f.data.args, { pid: PID, activity: ACTIVITY });
  await delay(30);
  assert.deepEqual(fake.pending(isSet), []);
});

const rejectCover = (fake: FakeDiscord) => {
  fake.onFrame = (r) => {
    if (!isSet(r) || r.data.args.activity?.assets?.large_image !== ACTIVITY.assets!.large_image) return;
    fake.reply(r, { evt: 'ERROR', data: { code: 1000, message: 'Unknown Error' } });
    return true;
  };
};

test('a rejected activity never becomes the re-send target: the last accepted one is re-sent', { timeout: 5000 }, async (t) => {
  const { fake, ipc } = await startReady(t);
  rejectCover(fake);
  const logo: Activity = { ...ACTIVITY, assets: { large_image: 'logo', large_text: 'Heaven knows' } };
  await ipc.setActivity(logo);
  await assert.rejects(ipc.setActivity(ACTIVITY), DiscordRpcError); // Discord keeps showing the logo card
  fake.dropAll();
  const hs2 = await fake.next((r) => isHandshake(r) && r.conn === fake.conns[1]);
  const resent = await fake.next((r) => isSet(r) && r.conn === hs2.conn);
  assert.deepEqual(resent.data.args.activity, logo);
});

test('a re-send rejected after READY is reported and not repeated on the next reconnect', { timeout: 5000 }, async (t) => {
  const { fake, ipc } = await setup(t);
  rejectCover(fake);
  await ipc.setActivity(ACTIVITY); // not connected yet: only remembered
  const failed = once(ipc, 'resendFailed');
  ipc.start();
  const [err, activity] = await withTimeout(failed, 2000, 'resendFailed');
  assert.ok(err instanceof DiscordRpcError);
  assert.equal(activity, ACTIVITY);
  fake.dropAll();
  await waitUntil(() => fake.conns.length === 2 && ipc.isReady);
  await delay(30);
  assert.deepEqual(fake.pending((r) => isSet(r) && r.conn === fake.conns[1]), []);
});
