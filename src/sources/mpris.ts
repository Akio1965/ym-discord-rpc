// Linux source: finds Yandex Music on the session bus by MPRIS Identity and feeds MprisTracker.
// Strictly read-only towards the player: Properties.Get/GetAll and signal subscriptions, never Player methods.
import type { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import { Message, MessageType, Variant, sessionBus, type MessageBus, type ProxyInterface } from '@jellybrick/dbus-next';
import { logger } from '../log.ts';
import type { PlayerSnapshot, PlayerSource } from '../model.ts';
import { MprisTracker, type Clock, type MprisProps } from './mprisTracker.ts';

const log = logger('mpris');

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const ROOT_IFACE = 'org.mpris.MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';

export interface MprisSourceOptions {
  /** MPRIS Identity of the player to follow. */
  identity?: string;
  /** Position poll interval while playing (rate estimation, seek safety net). */
  pollMs?: number;
  /** Re-scan interval while no player is attached (safety net for missed NameOwnerChanged), and reconnect interval after the bus connection is lost. */
  rescanMs?: number;
  /** Timeout for a single D-Bus call. */
  callTimeoutMs?: number;
  /** Session bus factory (tests). */
  bus?: () => MessageBus;
  /** Tracker clock (tests). */
  clock?: Clock;
}

type DBusDaemon = ProxyInterface & {
  ListNames(): Promise<string[]>;
  GetNameOwner(name: string): Promise<string>;
  AddMatch(rule: string): Promise<void>;
  RemoveMatch(rule: string): Promise<void>;
};

interface Player {
  /** Well-known name, e.g. org.mpris.MediaPlayer2.chromium.instance<PID>. */
  name: string;
  /** Unique connection name (e.g. ":1.42"); all calls and the signal sender check use it. */
  owner: string;
  rules: string[];
}

/** Recursively replaces dbus-next Variants with their values and BigInts with numbers. */
export function unwrap(v: unknown): unknown {
  if (v instanceof Variant) return unwrap(v.value);
  if (typeof v === 'bigint') return Number(v);
  if (Array.isArray(v)) return v.map(unwrap);
  if (v !== null && typeof v === 'object' && !Buffer.isBuffer(v)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unwrap(x)]));
  }
  return v;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class MprisSource implements PlayerSource {
  private readonly identity: string;
  private readonly pollMs: number;
  private readonly rescanMs: number;
  private readonly callTimeoutMs: number;
  private readonly makeBus: () => MessageBus;
  private readonly clock: Clock | undefined;

  private bus: MessageBus | undefined;
  private daemon: DBusDaemon | undefined;
  private tracker: MprisTracker | undefined;
  private player: Player | undefined;
  private scan: Promise<void> | undefined;
  private rescanQueued = false;
  private reconnecting: Promise<void> | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private rescanTimer: NodeJS.Timeout | undefined;
  private polling = false;

  constructor(opts: MprisSourceOptions = {}) {
    this.identity = opts.identity ?? 'YandexMusic';
    this.pollMs = opts.pollMs ?? 5000;
    this.rescanMs = opts.rescanMs ?? 10_000;
    this.callTimeoutMs = opts.callTimeoutMs ?? 3000;
    this.makeBus = opts.bus ?? (() => sessionBus());
    this.clock = opts.clock;
  }

  async start(onUpdate: (snapshot: PlayerSnapshot | null) => void): Promise<void> {
    if (this.tracker) throw new Error('MprisSource already started');
    this.tracker = new MprisTracker({ onSnapshot: onUpdate, refresh: () => this.readPlayer(), clock: this.clock });
    try {
      await this.connect();
    } catch (err) {
      await this.stop();
      throw new Error(`D-Bus session bus unavailable: ${errorMessage(err)}`);
    }
    this.rescanTimer = setInterval(() => {
      if (!this.bus) void this.reconnect();
      else if (!this.player) void this.discover();
    }, this.rescanMs);
    await this.discover();
  }

  async stop(): Promise<void> {
    clearInterval(this.rescanTimer);
    this.rescanTimer = undefined;
    this.tracker?.dispose();
    this.tracker = undefined;
    this.closeBus();
  }

  private async connect(): Promise<void> {
    const bus = this.makeBus();
    this.bus = bus;
    // Without an 'error' listener a socket error would crash the daemon. Failed reconnects repeat every rescanMs.
    (bus as EventEmitter).on('error', (err: unknown) => (this.reconnecting ? log.debug : log.warn)(`D-Bus error: ${errorMessage(err)}`));
    bus.on('message', this.onMessage);
    try {
      // Referenced timer: when the bus socket fails (no session bus) dbus-next never settles this and nothing else
      // keeps the event loop alive, so without it Node would exit 13 instead of logging 'cannot start' and exiting 1.
      const obj = await this.timed(bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus'), true);
      // MessageBus reports neither the end nor the close of its socket (dbus-next 0.11), and afterwards calls
      // queue up or fail forever. The socket exists once the handshake (and so the call above) is done.
      const socket = (bus as unknown as { _connection: { stream?: Duplex } })._connection.stream;
      if (this.bus !== bus || !socket || socket.destroyed) throw new Error('connection closed');
      socket.once('close', () => this.onBusEnd(bus));
      this.daemon = obj.getInterface<DBusDaemon>('org.freedesktop.DBus');
      this.daemon.on('NameOwnerChanged', this.onNameOwnerChanged);
    } catch (err) {
      if (this.bus === bus) this.closeBus();
      throw err;
    }
  }

  /** Single-flight reconnect attempt, driven by the rescan interval. */
  private reconnect(): Promise<void> {
    this.reconnecting ??= this.connect()
      .then(() => {
        log.info('reconnected to the D-Bus session bus');
        return this.discover();
      })
      .catch((err: unknown) => log.debug(`D-Bus reconnect failed: ${errorMessage(err)}`))
      .finally(() => {
        this.reconnecting = undefined;
      });
    return this.reconnecting;
  }

  /** The session bus went away (restart, session teardown): clear the card and keep reconnecting. */
  private onBusEnd(bus: MessageBus): void {
    if (bus !== this.bus) return;
    log.warn(`D-Bus connection lost; reconnecting every ${this.rescanMs / 1000} s`);
    this.closeBus();
    this.tracker?.gone();
  }

  /** Drops the connection and everything bound to it; the bus forgets our match rules with the connection. */
  private closeBus(): void {
    const bus = this.bus;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.player = undefined;
    this.daemon?.off('NameOwnerChanged', this.onNameOwnerChanged);
    this.daemon = undefined;
    this.bus = undefined;
    bus?.off('message', this.onMessage);
    bus?.disconnect();
  }

  // Signals arrive through the low-level message stream so the sender can be checked against the
  // attached player's unique name: Edge (and any other MPRIS player) must never reach the tracker.
  private readonly onMessage = (msg: Message): void => {
    const p = this.player;
    if (msg.type !== MessageType.SIGNAL || !p || msg.sender !== p.owner || msg.path !== MPRIS_PATH) return;
    if (msg.interface === PROPS_IFACE && msg.member === 'PropertiesChanged') {
      const [iface, changed] = msg.body;
      // Even an empty change (e.g. only invalidated names) triggers the debounced re-read.
      if (iface === PLAYER_IFACE && isRecord(changed)) this.tracker?.update(unwrap(changed) as MprisProps);
    } else if (msg.interface === PLAYER_IFACE && msg.member === 'Seeked') {
      void this.onSeeked(p, msg.body[0]);
    }
  };

  private readonly onNameOwnerChanged = (...args: unknown[]): void => {
    const [name, , newOwner] = args;
    if (typeof name !== 'string' || typeof newOwner !== 'string') return;
    const p = this.player;
    if (p) {
      if ((name === p.name || name === p.owner) && newOwner !== p.owner) {
        this.detach();
        void this.discover();
      }
    } else if (name.startsWith(MPRIS_PREFIX) && newOwner !== '') {
      void this.discover();
    }
  };

  /** Single-flight scan; a request during a scan queues one more pass. */
  private discover(): Promise<void> {
    if (this.scan) {
      this.rescanQueued = true;
      return this.scan;
    }
    this.scan = (async () => {
      do {
        this.rescanQueued = false;
        await this.scanOnce();
      } while (this.rescanQueued && !this.player && this.bus);
    })()
      .catch((err: unknown) => log.warn(`player discovery failed: ${errorMessage(err)}`))
      .finally(() => {
        this.scan = undefined;
      });
    return this.scan;
  }

  private async scanOnce(): Promise<void> {
    const daemon = this.daemon;
    if (!daemon || this.player) return;
    const names = (await this.timed(daemon.ListNames())).filter((n) => n.startsWith(MPRIS_PREFIX));
    for (const name of names) {
      let identity: unknown;
      try {
        identity = await this.getProp(name, ROOT_IFACE, 'Identity');
      } catch (err) {
        log.debug(`cannot read Identity of ${name}: ${errorMessage(err)}`);
        continue;
      }
      if (identity !== this.identity) {
        log.debug(`ignoring MPRIS player ${name} (${String(identity)})`);
        continue;
      }
      const owner = await this.timed(daemon.GetNameOwner(name));
      if (!this.bus || this.player) return;
      await this.attach(name, owner);
      return;
    }
    log.debug(`no MPRIS player with Identity "${this.identity}"`);
  }

  private async attach(name: string, owner: string): Promise<void> {
    const rules = [
      `type='signal',sender='${owner}',path='${MPRIS_PATH}',interface='${PROPS_IFACE}',member='PropertiesChanged',arg0='${PLAYER_IFACE}'`,
      `type='signal',sender='${owner}',path='${MPRIS_PATH}',interface='${PLAYER_IFACE}',member='Seeked'`,
    ];
    const p: Player = { name, owner, rules };
    this.player = p;
    log.info(`attached to ${name} (${owner})`);
    try {
      // Subscribe before the first read so no change can slip in between.
      for (const rule of rules) await this.timed(this.daemon!.AddMatch(rule));
      const props = await this.getAll(owner, PLAYER_IFACE);
      if (this.player !== p) return;
      this.tracker?.update(props);
      this.pollTimer = setInterval(() => void this.poll(p), this.pollMs);
    } catch (err) {
      log.warn(`cannot attach to ${name}: ${errorMessage(err)}`);
      if (this.player === p) this.detach();
    }
  }

  private detach(): void {
    const p = this.player;
    if (!p) return;
    this.player = undefined;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    for (const rule of p.rules) {
      this.daemon?.RemoveMatch(rule).catch((err: unknown) => log.debug(`RemoveMatch failed: ${errorMessage(err)}`));
    }
    log.info(`player ${p.name} (${p.owner}) is gone`);
    this.tracker?.gone();
  }

  private async poll(p: Player): Promise<void> {
    if (this.polling || this.player !== p || !this.tracker?.playing) return;
    this.polling = true;
    try {
      const pos = await this.getProp(p.owner, PLAYER_IFACE, 'Position');
      if (this.player === p) this.tracker?.poll(pos);
    } catch (err) {
      log.debug(`Position poll failed: ${errorMessage(err)}`);
    } finally {
      this.polling = false;
    }
  }

  private async onSeeked(p: Player, signalPos: unknown): Promise<void> {
    let pos = unwrap(signalPos);
    try {
      pos = await this.getProp(p.owner, PLAYER_IFACE, 'Position');
    } catch (err) {
      log.debug(`Position re-read after Seeked failed, using the signal value: ${errorMessage(err)}`);
    }
    if (this.player === p) this.tracker?.seeked(pos);
  }

  /** Tracker refresh after a burst: the authoritative Player state. */
  private async readPlayer(): Promise<MprisProps | undefined> {
    const p = this.player;
    return p ? this.getAll(p.owner, PLAYER_IFACE) : undefined;
  }

  private async getProp(dest: string, iface: string, prop: string): Promise<unknown> {
    return unwrap((await this.callProps(dest, 'Get', 'ss', [iface, prop]))[0]);
  }

  private async getAll(dest: string, iface: string): Promise<MprisProps> {
    const all = unwrap((await this.callProps(dest, 'GetAll', 's', [iface]))[0]);
    if (!isRecord(all)) throw new Error(`GetAll(${iface}) on ${dest} returned no dict`);
    return all;
  }

  private async callProps(dest: string, member: string, signature: string, body: string[]): Promise<unknown[]> {
    const bus = this.bus;
    if (!bus) throw new Error('MprisSource is stopped');
    const msg = new Message({ destination: dest, path: MPRIS_PATH, interface: PROPS_IFACE, member, signature, body });
    return (await this.timed(bus.call(msg)))?.body ?? [];
  }

  /** bus.call() has no timeout of its own; a hung player must not stall polls or discovery. keepAlive keeps the timer referenced. */
  private timed<T>(promise: Promise<T>, keepAlive = false): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`D-Bus call timed out after ${this.callTimeoutMs} ms`)), this.callTimeoutMs);
      if (!keepAlive) timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}
