// MprisSource against a private dbus-daemon on a temp socket with fake MPRIS players. Never the real session bus.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once, type EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Message, Variant, sessionBus, type MessageBus } from '@jellybrick/dbus-next';
import type { PlayerSnapshot } from '../src/model.ts';

// log.ts reads LOG_LEVEL at import time; expected WARNs (bus lost, refresh timeouts) would be noise.
process.env.LOG_LEVEL ??= 'error';
const { MprisSource } = await import('../src/sources/mpris.ts');

const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PROPS = 'org.freedesktop.DBus.Properties';
const ROOT = 'org.mpris.MediaPlayer2';
const PLAYER = 'org.mpris.MediaPlayer2.Player';
const YM = 'org.mpris.MediaPlayer2.chromium.instance4242';
const EDGE = 'org.mpris.MediaPlayer2.edge.instance77';
const skip = spawnSync('dbus-daemon', ['--version']).status === 0 ? false : 'dbus-daemon is not installed';

/** A session bus of our own on a temp unix socket; restartable at the same address. */
class PrivateBus {
  readonly dir = mkdtempSync(join(tmpdir(), 'ym-rpc-dbus-'));
  readonly socket = join(this.dir, 'bus');
  readonly address = `unix:path=${this.socket}`;
  private proc: ChildProcess | undefined;

  async start(): Promise<void> {
    const conf = join(this.dir, 'bus.conf');
    writeFileSync(conf, `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>${this.address}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy>
</busconfig>`);
    rmSync(this.socket, { force: true });
    const proc = spawn('dbus-daemon', [`--config-file=${conf}`, '--nofork', '--nopidfile', '--nosyslog', '--print-address=1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.proc = proc;
    await once(proc.stdout!, 'data'); // the address is printed once it listens
  }

  async kill(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = once(proc, 'exit');
    proc.kill(signal);
    await exited;
  }

  async dispose(): Promise<void> {
    await this.kill();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const metadata = (title: string) =>
  new Variant('a{sv}', {
    'mpris:trackid': new Variant('o', '/org/chromium/MediaPlayer2/TrackList/Track0123456789ABCDEF0123456789ABCDEF'),
    'xesam:title': new Variant('s', title),
    'xesam:artist': new Variant('as', ['PinkPantheress']),
    'xesam:album': new Variant('s', 'Heaven knows'),
    'mpris:length': new Variant('x', 223_747_000n),
  });

/** Chromium-like MPRIS player built from raw messages: answers Properties.Get/GetAll, emits signals. */
class FakePlayer {
  readonly name: string;
  readonly root: Record<string, Variant>;
  readonly player: Record<string, Variant>;
  /** Unique names of the connections that called us (the source). */
  readonly callers = new Set<string>();
  /** A hung player: calls are never answered. */
  muted = false;
  private bus: MessageBus | undefined;

  constructor(name: string, identity: string, title: string) {
    this.name = name;
    this.root = { Identity: new Variant('s', identity) };
    this.player = { Metadata: metadata(title), PlaybackStatus: new Variant('s', 'Playing'), Position: new Variant('x', 60_000_000n), Rate: new Variant('d', 1) };
  }

  async register(address: string): Promise<void> {
    const bus = sessionBus({ busAddress: address });
    this.bus = bus;
    (bus as EventEmitter).on('error', () => {});
    bus.addMethodHandler((msg: Message) => {
      if (msg.path !== MPRIS_PATH || msg.interface !== PROPS) return false;
      if (msg.sender) this.callers.add(msg.sender);
      if (this.muted) return true;
      const [iface, prop] = msg.body as [string, string];
      const props = iface === ROOT ? this.root : iface === PLAYER ? this.player : {};
      const value = props[prop];
      if (msg.member === 'GetAll') bus.send(Message.newMethodReturn(msg, 'a{sv}', [props]));
      else if (msg.member === 'Get' && value) bus.send(Message.newMethodReturn(msg, 'v', [value]));
      else bus.send(Message.newError(msg, 'org.freedesktop.DBus.Error.InvalidArgs', `no property ${prop}`));
      return true;
    });
    await bus.requestName(this.name, 0);
  }

  /** PropertiesChanged, broadcast or sent straight to `to`. */
  changed(props: Record<string, Variant>, to?: string): void {
    Object.assign(this.player, props);
    this.signal(Message.newSignal(MPRIS_PATH, PROPS, 'PropertiesChanged', 'sa{sv}as', [PLAYER, props, []]), to);
  }

  seeked(positionUs: bigint, to?: string): void {
    this.signal(Message.newSignal(MPRIS_PATH, PLAYER, 'Seeked', 'x', [positionUs]), to);
  }

  close(): void {
    this.bus?.disconnect();
    this.bus = undefined;
  }

  private signal(msg: Message, to: string | undefined): void {
    if (to) msg.destination = to;
    this.bus!.send(msg);
  }
}

async function until(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
}

async function setup(t: TestContext, rescanMs: number) {
  const dbus = new PrivateBus();
  const players: FakePlayer[] = [];
  const source = new MprisSource({ bus: () => sessionBus({ busAddress: dbus.address }), pollMs: 60_000, rescanMs, callTimeoutMs: 500 });
  t.after(async () => {
    await source.stop();
    for (const p of players) p.close();
    await dbus.dispose();
  });
  await dbus.start();
  const player = async (name: string, identity: string, title: string) => {
    const p = new FakePlayer(name, identity, title);
    players.push(p);
    await p.register(dbus.address);
    return p;
  };
  const out: (PlayerSnapshot | null)[] = [];
  return { dbus, source, player, out, start: () => source.start((s) => out.push(s)) };
}

test('follows only the YM player: Edge is ignored, YM quitting clears, YM restarting re-attaches', { skip, timeout: 20_000 }, async (t) => {
  // No rescans during the test: re-attaching must come from NameOwnerChanged.
  const { player, out, start } = await setup(t, 60_000);
  const edge = await player(EDGE, 'Microsoft Edge', 'Edge video');
  const ym = await player(YM, 'YandexMusic', 'Capable of love');
  await start();
  await until(() => out.length === 1, 'first YM snapshot');
  assert.equal(out[0]?.title, 'Capable of love');
  assert.equal(out[0]?.status, 'playing');
  assert.equal(out[0]?.durationMs, 223_747);

  // Edge's signals never reach the tracker, even sent straight to us while YM hangs: a leaked Seeked would force
  // a fresh snapshot, a leaked PropertiesChanged would settle on Edge's data once the re-read times out.
  const me = [...ym.callers][0]!;
  ym.muted = true;
  edge.changed({ Metadata: metadata('Edge video'), PlaybackStatus: new Variant('s', 'Paused') }, me);
  edge.seeked(5_000_000n, me);
  await delay(1000); // > 250 ms tracker debounce + 500 ms call timeout
  ym.muted = false;
  assert.deepEqual(out.map((s) => s?.title), ['Capable of love']);

  // YM's own signals carry its unique name, not the well-known one.
  ym.changed({ PlaybackStatus: new Variant('s', 'Paused') });
  await until(() => out.length === 2, 'paused snapshot');
  assert.equal(out[1]?.status, 'paused');

  ym.close();
  await until(() => out.length === 3, 'null after YM quit');
  assert.equal(out[2], null);
  await player(YM, 'YandexMusic', 'Another song'); // new process, new unique name
  await until(() => out.length === 4, 're-attach after the YM restart');
  assert.equal(out[3]?.title, 'Another song');
  assert.equal(out[3]?.status, 'playing');
});

test('session bus lost: clears at once, reconnects and re-attaches when the bus is back', { skip, timeout: 20_000 }, async (t) => {
  const { dbus, player, out, start } = await setup(t, 100);
  const ym = await player(YM, 'YandexMusic', 'Capable of love');
  await start();
  await until(() => out.length === 1, 'first YM snapshot');

  await dbus.kill('SIGKILL'); // a crash: no NameOwnerChanged, the socket just closes
  await until(() => out.length === 2, 'null after the bus went away');
  assert.equal(out[1], null);
  ym.close();

  await dbus.start();
  await player(YM, 'YandexMusic', 'Capable of love');
  await until(() => out.length === 3, 'reconnect and re-attach');
  assert.equal(out[2]?.title, 'Capable of love');
  assert.equal(out[2]?.status, 'playing');
});
