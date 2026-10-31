// App + PresenceEngine + real DiscordIpc against a fake Discord server on a temp unix socket
// (never the real Discord socket). Covers main.ts's resendFailed → engine.sinkFailed wiring.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Activity, Enricher, PlayerSnapshot, PlayerSource, TrackInfo } from '../src/model.ts';

// log.ts reads LOG_LEVEL at import time; the expected cover-rejection WARN would be noise.
process.env.LOG_LEVEL ??= 'error';
const { App } = await import('../src/app.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');
const { DiscordIpc } = await import('../src/discord/ipc.ts');

const COVER = 'https://avatars.yandex.net/get-music-content/9837405/0f61442d.a.28127004-1/400x400';
const INFO: TrackInfo = { provider: 'yandex', trackId: '118138322', albumId: '28127004', artists: [{ id: '12044483', name: 'PinkPantheress' }], coverUrl: COVER };

const frame = (op: number, payload: unknown) => {
  const body = Buffer.from(JSON.stringify(payload));
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};

async function until(cond: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await delay(5);
  }
}

test('a cover rejected during the post-READY re-send falls back to the logo; stop clears and closes', async (t) => {
  // Teardown runs on failure too, newest first: open sockets would otherwise keep the runner alive.
  const cleanup: (() => unknown)[] = [];
  t.after(async () => {
    for (const fn of cleanup.reverse()) await fn();
  });
  const dir = mkdtempSync(join(tmpdir(), 'ym-rpc-test-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'discord-ipc-0');

  // Server log: 'handshake', 'set:<large_image>', 'clear', 'end'. READY is held back until the test sends it.
  const log: string[] = [];
  let peer: Socket | undefined;
  const server = createServer((conn) => {
    peer = conn;
    let buf = Buffer.alloc(0);
    conn.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8 && buf.length >= 8 + buf.readInt32LE(4)) {
        const op = buf.readInt32LE(0);
        const msg = JSON.parse(buf.subarray(8, 8 + buf.readInt32LE(4)).toString('utf8'));
        buf = buf.subarray(8 + buf.readInt32LE(4));
        if (op === 0) {
          log.push('handshake');
          continue;
        }
        const activity: Activity | undefined = msg.args?.activity;
        log.push(activity ? `set:${activity.assets?.large_image}` : 'clear');
        const reject = activity?.assets?.large_image === COVER;
        conn.write(frame(1, reject
          ? { cmd: 'SET_ACTIVITY', evt: 'ERROR', data: { code: 1000, message: 'Unknown Error' }, nonce: msg.nonce }
          : { cmd: 'SET_ACTIVITY', evt: null, data: activity ?? null, nonce: msg.nonce }));
      }
    });
    conn.on('end', () => log.push('end'));
    conn.on('error', () => {});
  });
  server.listen(path);
  await once(server, 'listening');
  cleanup.push(() => {
    peer?.destroy();
    server.close();
  });

  let emit: (s: PlayerSnapshot | null) => void = () => {};
  const source: PlayerSource = { start: async (cb) => void (emit = cb), stop: async () => {} };
  const enricher: Enricher = { lookup: async () => INFO };
  const ipc = new DiscordIpc({ clientId: '123456789012345678', pid: 4242, paths: () => [path], backoffMs: [20] });
  const sent: (Activity | null)[] = [];
  const setActivity = ipc.setActivity.bind(ipc);
  ipc.setActivity = (a) => (sent.push(a), setActivity(a));

  const app = new App({ cfg: { ...DEFAULT_CONFIG, clientId: '123456789012345678' }, source, enricher, sink: ipc, engine: { trackDebounceMs: 10, infoWaitMs: 50 } });
  ipc.on('resendFailed', (err, activity) => app.engine.sinkFailed(activity, err)); // as in src/main.ts
  cleanup.push(() => app.stop()); // idempotent: the same promise as the stop() below
  await app.start();
  await until(() => log.includes('handshake'), 'handshake');

  const now = Date.now();
  emit({ source: 'mpris', at: now, status: 'playing', title: 'Capable of love', artists: ['PinkPantheress'], album: 'Heaven knows', durationMs: 223747, positionMs: 60_000, rate: 1, trackKey: 'k1' });
  await until(() => sent.length === 1, 'engine send while not ready');
  assert.equal(sent[0]?.assets?.large_image, COVER);
  assert.deepEqual(log, ['handshake']); // nothing on the wire before READY

  peer!.write(frame(1, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1, user: { id: '1', username: 'tester' } }, nonce: null }));
  await until(() => log.length >= 3, 'cover re-send and logo fallback');
  assert.deepEqual(log, ['handshake', `set:${COVER}`, 'set:logo']);
  assert.equal(sent.at(-1)?.details_url, 'https://music.yandex.ru/album/28127004/track/118138322');

  await app.stop();
  await until(() => log.includes('end'), 'socket close');
  assert.deepEqual(log, ['handshake', `set:${COVER}`, 'set:logo', 'clear', 'end']);
  assert.equal(ipc.isReady, false);
});

test('logo card, late iTunes cover rejected, socket dropped: the reconnect restores the logo card, not the rejected one', async (t) => {
  const cleanup: (() => unknown)[] = [];
  t.after(async () => {
    for (const fn of cleanup.reverse()) await fn();
  });
  const dir = mkdtempSync(join(tmpdir(), 'ym-rpc-test-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'discord-ipc-0');
  const itunesCover = 'https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/x/600x600bb.jpg';

  // Server log: 'handshake', 'set:<large_image>'. READY right after the handshake; the iTunes cover is rejected.
  const log: string[] = [];
  const peers: Socket[] = [];
  const server = createServer((conn) => {
    peers.push(conn);
    let buf = Buffer.alloc(0);
    conn.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8 && buf.length >= 8 + buf.readInt32LE(4)) {
        const op = buf.readInt32LE(0);
        const msg = JSON.parse(buf.subarray(8, 8 + buf.readInt32LE(4)).toString('utf8'));
        buf = buf.subarray(8 + buf.readInt32LE(4));
        if (op === 0) {
          log.push('handshake');
          conn.write(frame(1, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1 }, nonce: null }));
          continue;
        }
        const activity: Activity | undefined = msg.args?.activity;
        log.push(activity ? `set:${activity.assets?.large_image}` : 'clear');
        conn.write(frame(1, activity?.assets?.large_image === itunesCover
          ? { cmd: 'SET_ACTIVITY', evt: 'ERROR', data: { code: 1000, message: 'Unknown Error' }, nonce: msg.nonce }
          : { cmd: 'SET_ACTIVITY', evt: null, data: activity ?? null, nonce: msg.nonce }));
      }
    });
    conn.on('error', () => {});
  });
  server.listen(path);
  await once(server, 'listening');
  cleanup.push(() => {
    for (const p of peers) p.destroy();
    server.close();
  });

  let emit: (s: PlayerSnapshot | null) => void = () => {};
  const source: PlayerSource = { start: async (cb) => void (emit = cb), stop: async () => {} };
  let answer: (info: TrackInfo | null) => void = () => {};
  const enricher: Enricher = { lookup: () => new Promise((resolve) => (answer = resolve)) }; // Yandex miss, then iTunes: slow
  const ipc = new DiscordIpc({ clientId: '123456789012345678', pid: 4242, paths: () => [path], backoffMs: [20] });
  const app = new App({ cfg: { ...DEFAULT_CONFIG, clientId: '123456789012345678' }, source, enricher, sink: ipc, engine: { trackDebounceMs: 10, infoWaitMs: 50, minIntervalMs: 0 } });
  ipc.on('resendFailed', (err, activity) => app.engine.sinkFailed(activity, err)); // as in src/main.ts
  cleanup.push(() => app.stop());
  await app.start();
  await until(() => ipc.isReady, 'READY');

  emit({ source: 'mpris', at: Date.now(), status: 'playing', title: 'Capable of love', artists: ['PinkPantheress'], album: 'Heaven knows', durationMs: 223747, positionMs: 60_000, rate: 1, trackKey: 'k1' });
  await until(() => log.includes('set:logo'), 'logo card after the info wait');
  answer({ provider: 'itunes', album: 'Heaven knows', coverUrl: itunesCover }); // adds no links: the fallback equals the logo card
  await until(() => log.includes(`set:${itunesCover}`), 'cover card');
  await delay(50);
  assert.deepEqual(log, ['handshake', 'set:logo', `set:${itunesCover}`]);

  peers[0]!.destroy(); // Discord restarts
  await until(() => log.length >= 5, 're-send after the reconnect');
  await delay(50);
  assert.deepEqual(log, ['handshake', 'set:logo', `set:${itunesCover}`, 'handshake', 'set:logo']);
});
