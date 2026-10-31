import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { PlayerSnapshot } from '../src/model.ts';
import {
  MprisTracker,
  NO_TRACK,
  nearestStandardRate,
  normalizeMetadata,
  splitArtists,
  trackKeyOf,
  usToMs,
  type Clock,
  type MprisProps,
  type MprisTrackerOptions,
} from '../src/sources/mprisTracker.ts';

/** Deterministic clock: timers fire only inside advance(), in due order. */
class FakeClock implements Clock {
  t = 1_800_000_000_000;
  private queue: { id: number; at: number; fn: () => void }[] = [];
  private seq = 0;
  now = (): number => this.t;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.queue.push({ id, at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (id: unknown): void => {
    this.queue = this.queue.filter((x) => x.id !== id);
  };
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const next = this.queue.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      this.queue = this.queue.filter((x) => x !== next);
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
  get pending(): number {
    return this.queue.length;
  }
}

const S = 1000;
const us = (ms: number): bigint => BigInt(Math.round(ms * 1000));

function md(trackId: string, title: string, artist: string, extra: { album?: string; lengthMs?: number } = {}): Record<string, unknown> {
  const m: Record<string, unknown> = {
    'mpris:trackid': trackId,
    'xesam:title': title,
    'xesam:artist': [artist],
    'xesam:album': extra.album ?? '',
    'mpris:artUrl': 'file:///tmp/.org.chromium.Chromium.abc',
  };
  if (extra.lengthMs !== undefined) m['mpris:length'] = us(extra.lengthMs);
  return m;
}

function setup(opts: Partial<MprisTrackerOptions> = {}) {
  const clock = new FakeClock();
  const out: (PlayerSnapshot | null)[] = [];
  const tracker = new MprisTracker({ onSnapshot: (s) => out.push(s), clock, ...opts });
  return { clock, out, tracker };
}

/** A track playing from position 0; its first snapshot is already emitted and cleared from `out`. */
function playing(opts: Partial<MprisTrackerOptions> = {}) {
  const ctx = setup(opts);
  ctx.tracker.update({ Metadata: md('/t/1', 'One', 'Artist', { lengthMs: 300 * S }), PlaybackStatus: 'Playing', Position: 0 });
  ctx.clock.advance(250);
  assert.equal(ctx.out.length, 1);
  assert.equal(ctx.out[0]?.positionMs, 250);
  ctx.out.length = 0;
  return { ...ctx, t0: ctx.clock.t - 250 };
}

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('normalizes YM metadata: artist splitting, empty album, µs → ms, content-based trackKey', () => {
  assert.deepEqual(splitArtists(['PinkPantheress, Kenya Grace']), ['PinkPantheress', 'Kenya Grace']);
  assert.deepEqual(splitArtists(['']), []);
  assert.deepEqual(splitArtists(['A', 'B, C']), ['A', 'B, C']);
  assert.deepEqual(splitArtists('Solo'), ['Solo']);
  assert.deepEqual(splitArtists(undefined), []);
  assert.deepEqual(
    normalizeMetadata({ 'mpris:trackid': '/t/1', 'xesam:title': 'T', 'xesam:artist': ['A, B'], 'xesam:album': '', 'mpris:length': 223747482n }),
    { trackId: '/t/1', title: 'T', artists: ['A', 'B'], durationMs: 223747 },
  );
  assert.equal(normalizeMetadata({ 'xesam:title': 'T', 'mpris:length': 0n }).durationMs, undefined);
  assert.equal(usToMs(-5), undefined);
  assert.equal(usToMs(Number.NaN), undefined);
  assert.equal(usToMs('12'), undefined);
  assert.equal(usToMs(4319849), 4320);
  assert.equal(trackKeyOf({ trackId: NO_TRACK, title: 'T', artists: ['A', 'B'], durationMs: 223747 }), 'T|A, B|224');
  assert.equal(trackKeyOf({ title: 'T', artists: [] }), 'T||');
  assert.equal(trackKeyOf({ trackId: '/session/1', title: 'T', artists: ['A'], durationMs: 1400 }), 'T|A|1');
  assert.equal(nearestStandardRate(1.46, 0.08), 1.5);
  assert.equal(nearestStandardRate(1.13, 0.08), undefined);
  assert.equal(nearestStandardRate(Number.NaN, 0.08), undefined);
});

test('emits the first state once, after the 250 ms debounce', () => {
  const { clock, out, tracker } = setup();
  tracker.update({
    Metadata: md('/t/1', 'Capable of love', 'PinkPantheress', { album: 'Heaven knows', lengthMs: 223747 }),
    PlaybackStatus: 'Playing',
    Position: 10_000_000n,
    Rate: 1,
  });
  clock.advance(249);
  assert.equal(out.length, 0);
  clock.advance(1);
  assert.deepEqual(out, [
    {
      source: 'mpris',
      at: clock.t,
      status: 'playing',
      title: 'Capable of love',
      artists: ['PinkPantheress'],
      album: 'Heaven knows',
      durationMs: 223747,
      positionMs: 10_250,
      rate: 1,
      trackKey: 'Capable of love|PinkPantheress|224',
    },
  ]);
});

test('coalesces a half-updated metadata burst: the old title is never emitted alone', () => {
  const { clock, out, tracker } = playing();
  tracker.update({ Metadata: md('/t/2', 'One', 'Artist', { lengthMs: 300 * S }) }); // new trackid, old fields
  clock.advance(5);
  tracker.update({ Metadata: md('/t/2', 'Two', 'Artist') });
  tracker.seeked(0);
  clock.advance(5);
  tracker.update({ Metadata: md('/t/2', 'Two', 'X, Y', { album: 'Z', lengthMs: 180 * S }) });
  clock.advance(249);
  assert.equal(out.length, 0);
  clock.advance(1);
  assert.equal(out.length, 1);
  const s = out[0]!;
  assert.equal(s.title, 'Two');
  assert.deepEqual(s.artists, ['X', 'Y']);
  assert.equal(s.album, 'Z');
  assert.equal(s.durationMs, 180 * S);
  assert.equal(s.trackKey, 'Two|X, Y|180');
  assert.equal(s.positionMs, 255);
  clock.advance(10 * S);
  assert.equal(out.length, 1);
});

test('Stopped/NoTrack blip within the grace period is replaced by the next real track', () => {
  const { clock, out, tracker } = playing();
  tracker.update({ Metadata: md(NO_TRACK, 'One', 'Artist') });
  tracker.update({ PlaybackStatus: 'Stopped' });
  tracker.update({ Metadata: { 'mpris:trackid': NO_TRACK, 'xesam:title': '', 'xesam:artist': [''], 'mpris:length': 0n } });
  clock.advance(1500);
  assert.equal(out.length, 0);
  tracker.update({ Metadata: md('/t/2', 'Two', 'B'), PlaybackStatus: 'Playing' });
  clock.advance(10 * S);
  assert.deepEqual(
    out.map((s) => [s?.status, s?.title, s?.trackKey]),
    [['playing', 'Two', 'Two|B|']],
  );
});

test('a track change under the same Chromium trackid still changes trackKey', () => {
  // Chromium keeps one mpris:trackid per media session: consecutive YM tracks share it.
  const session = '/org/chromium/MediaPlayer2/TrackList/Track0123456789ABCDEF0123456789ABCDEF';
  const { clock, out, tracker } = setup();
  tracker.update({ Metadata: md(session, 'First song', 'Artist A', { album: 'Album A', lengthMs: 95_600 }), PlaybackStatus: 'Playing', Position: us(95 * S) });
  clock.advance(250);
  tracker.update({ Metadata: md(NO_TRACK, 'First song', 'Artist A', { lengthMs: 95_600 }), PlaybackStatus: 'Stopped' });
  clock.advance(40);
  tracker.update({ Metadata: md(session, 'Second song', 'Artist B', { album: 'Album B', lengthMs: 146_700 }), PlaybackStatus: 'Playing' });
  tracker.seeked(us(300));
  clock.advance(5 * S);
  assert.deepEqual(
    out.map((s) => [s?.title, s?.trackKey]),
    [
      ['First song', 'First song|Artist A|96'],
      ['Second song', 'Second song|Artist B|147'],
    ],
  );
  assert.equal(out[1]?.positionMs, 550);
});

test('a Stopped state that outlives the 2 s grace is reported once as stopped', () => {
  const { clock, out, tracker } = playing();
  tracker.update({ PlaybackStatus: 'Stopped', Metadata: { 'mpris:trackid': NO_TRACK, 'xesam:title': '', 'xesam:artist': [''] } });
  clock.advance(1999);
  assert.equal(out.length, 0);
  clock.advance(1);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.status, 'stopped');
  tracker.update({ Metadata: { 'mpris:trackid': NO_TRACK, 'xesam:title': '' } }); // still idle
  clock.advance(10 * S);
  assert.equal(out.length, 1);
});

test('replays a recorded YM track change (busctl monitor --json) into exactly one snapshot', () => {
  // The YM player's own signals around one track change (317 ms), recorded with `busctl --user monitor`
  // in JSON form and anonymized: unique name, cookies, timestamps, temp file names, the previous track.
  const lines = readFileSync(new URL('./fixtures/mpris-track-change.jsonl', import.meta.url), 'utf8').trim().split('\n');
  type Raw = { type: string; sender: string; path: string; member: string; 'timestamp-realtime': number; payload: { data: unknown[] } };
  const events = lines
    .map((l) => JSON.parse(l) as Raw)
    .filter((m) => m.type === 'signal' && m.sender === ':1.42' && m.path === '/org/mpris/MediaPlayer2');
  assert.equal(events.length, 27);
  // busctl --json form: {type, data}; dictionaries nest it per entry.
  const plain = (v: unknown): unknown => {
    const { type, data } = v as { type: string; data: unknown };
    return type.startsWith('a{') ? Object.fromEntries(Object.entries(data as object).map(([k, x]) => [k, plain(x)])) : data;
  };

  const { clock, out, tracker } = setup();
  // State right before the recording: the previous track is playing near its end.
  tracker.update({
    Metadata: { 'mpris:trackid': '/org/chromium/MediaPlayer2/TrackList/TrackOLD', 'xesam:title': 'Previous track', 'xesam:artist': ['Previous Artist'], 'mpris:length': 180_000_000 },
    PlaybackStatus: 'Playing',
    Position: 179_000_000,
  });
  clock.advance(500);
  out.length = 0;

  const t0 = clock.t;
  const ts0 = events[0]!['timestamp-realtime'];
  for (const m of events) {
    clock.advance(t0 + Math.round((m['timestamp-realtime'] - ts0) / 1000) - clock.t);
    if (m.member === 'PropertiesChanged') {
      const [iface, changed] = m.payload.data as [string, Record<string, unknown>];
      if (iface !== 'org.mpris.MediaPlayer2.Player') continue;
      tracker.update(Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, plain(v)])) as MprisProps);
    } else if (m.member === 'Seeked') {
      tracker.seeked(m.payload.data[0]);
    }
  }
  clock.advance(5 * S);

  assert.equal(out.length, 1);
  const s = out[0]!;
  assert.equal(s.status, 'playing');
  assert.equal(s.title, 'Capable of love');
  assert.deepEqual(s.artists, ['PinkPantheress']);
  assert.equal(s.album, 'Heaven knows');
  assert.equal(s.durationMs, 223747);
  assert.equal(s.trackKey, 'Capable of love|PinkPantheress|224');
  // Last Seeked (365886 µs at +312 ms) extrapolated to the settle 250 ms after the last signal (+317 ms).
  assert.equal(s.at, t0 + 567);
  assert.equal(s.positionMs, 366 + 255);
});

test('pause freezes the position; resume continues from it and restarts rate estimation', () => {
  const { clock, out, tracker } = playing();
  clock.advance(5 * S - 250);
  tracker.poll(us(7500)); // looks like 1.5x: first candidate vote
  clock.advance(5 * S);
  tracker.update({ PlaybackStatus: 'Paused' });
  clock.advance(250);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.status, 'paused');
  assert.equal(out[0]?.positionMs, 7500 + 5000);
  assert.equal(tracker.playing, false);

  clock.advance(60 * S);
  assert.equal(out.length, 1);
  tracker.update({ PlaybackStatus: 'Playing' });
  clock.advance(250);
  assert.equal(out.length, 2);
  assert.equal(out[1]?.status, 'playing');
  assert.equal(out[1]?.positionMs, 12_500 + 250);
  assert.equal(out[1]?.rate, 1);

  // One 1.5x-looking poll after resume must not complete the pre-pause streak.
  clock.advance(5 * S - 250);
  tracker.poll(us(12_500 + 5 * S)); // sets the baseline
  clock.advance(5 * S);
  tracker.poll(us(12_500 + 5 * S + 7500)); // first 1.5x vote after resume
  assert.equal(out.length, 2);
});

test('poll drift beyond 1.5 s is treated as a seek; consistent polls stay silent', () => {
  const { clock, out, tracker, t0 } = playing();
  clock.advance(5 * S);
  tracker.poll(us(clock.t - t0)); // on time
  assert.equal(out.length, 0);
  clock.advance(5 * S);
  tracker.poll(us(60 * S));
  assert.equal(out.length, 1);
  assert.equal(out[0]?.positionMs, 60 * S);
  assert.equal(out[0]?.at, clock.t);
  clock.advance(5 * S);
  tracker.poll(us(65 * S));
  clock.advance(5 * S);
  tracker.poll(us(70 * S + 1400)); // small jump, below the seek threshold
  clock.advance(5 * S);
  tracker.poll(us(75 * S + 1400));
  assert.equal(out.length, 1);
});

test('adopts 1.5x after two consistent polls without false seeks, then stays silent', () => {
  const { clock, out, tracker, t0 } = playing();
  const truePos = (): number => Math.floor(((clock.t - t0) * 1.5) / 100) * 100; // YM moves in ~100 ms steps
  clock.advance(5 * S - 250);
  tracker.poll(us(truePos()));
  assert.equal(out.length, 0, 'first deviating poll is only a candidate, not a seek');
  clock.advance(5 * S);
  tracker.poll(us(truePos()));
  assert.equal(out.length, 1);
  assert.equal(out[0]?.rate, 1.5);
  assert.equal(out[0]?.positionMs, truePos());
  for (let i = 0; i < 12; i++) {
    clock.advance(5 * S + (i % 3) * 37);
    tracker.poll(us(truePos()));
  }
  assert.equal(out.length, 1);

  // Back to 1x: adopted again after two polls.
  let pos = truePos();
  for (let i = 0; i < 2; i++) {
    clock.advance(5 * S);
    pos += 5 * S;
    tracker.poll(us(pos));
  }
  assert.equal(out.length, 2);
  assert.equal(out[1]?.rate, 1);
});

test('steady 1x polls with position jitter never emit', () => {
  const { clock, out, tracker, t0 } = playing();
  for (let i = 0; i < 30; i++) {
    clock.advance(5 * S + (i % 2 ? 13 : -9));
    tracker.poll(us(Math.floor((clock.t - t0) / 100) * 100));
  }
  assert.equal(out.length, 0);
});

test('Seeked re-anchors the position and always yields a fresh snapshot', () => {
  const { clock, out, tracker } = playing();
  clock.advance(3 * S);
  tracker.seeked(us(90 * S));
  clock.advance(249);
  assert.equal(out.length, 0);
  clock.advance(1);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.positionMs, 90 * S + 250);
  // A seek to where playback already is still produces a snapshot (the engine dedupes).
  tracker.seeked(us(90 * S + 250));
  clock.advance(250);
  assert.equal(out.length, 2);
});

test('player gone emits null immediately and cancels pending work', () => {
  const { clock, out, tracker } = playing();
  tracker.update({ Metadata: md('/t/2', 'Two', 'B') });
  tracker.gone();
  assert.deepEqual(out, [null]);
  assert.equal(clock.pending, 0);
  clock.advance(10 * S);
  tracker.gone();
  assert.deepEqual(out, [null]);
  assert.equal(tracker.playing, false);
});

test('missing duration: no durationMs, no clamping, key without a duration part', () => {
  const { clock, out, tracker } = setup();
  tracker.update({ Metadata: md('/wave/1', 'Generative', 'Нейромузыка'), PlaybackStatus: 'Playing', Position: us(3600 * S) });
  clock.advance(250);
  assert.equal(out.length, 1);
  const s = out[0]!;
  assert.equal('durationMs' in s, false);
  assert.equal('album' in s, false);
  assert.equal(s.positionMs, 3600 * S + 250);
  assert.equal(s.trackKey, 'Generative|Нейромузыка|');
});

test('position past the reported duration is clamped', () => {
  const { clock, out, tracker } = setup();
  tracker.update({ Metadata: md('/t/1', 'T', 'A', { lengthMs: 10 * S }), PlaybackStatus: 'Playing', Position: us(9900) });
  clock.advance(250);
  assert.equal(out[0]?.positionMs, 10 * S);
});

test('invalid positions are ignored', () => {
  const { clock, out, tracker } = playing();
  clock.advance(5 * S);
  tracker.poll(Number.NaN);
  tracker.poll(-1);
  tracker.poll('5000000');
  tracker.seeked(undefined);
  clock.advance(5 * S);
  assert.equal(out.length, 0);
});

test('refresh() re-reads the player before settling; stale refreshes are dropped', async () => {
  const replies: Array<(p: MprisProps) => void> = [];
  const { clock, out, tracker } = setup({ refresh: () => new Promise((resolve) => replies.push(resolve)) });
  tracker.update({ Metadata: md('/t/1', 'Half', 'A'), PlaybackStatus: 'Playing' });
  clock.advance(250);
  assert.equal(replies.length, 1);
  tracker.update({ Metadata: md('/t/1', 'Full', 'A') }); // arrives while the first refresh is in flight
  replies[0]!({ Metadata: md('/t/1', 'Half', 'A'), PlaybackStatus: 'Playing', Position: us(1000) });
  await flushMicrotasks();
  assert.equal(out.length, 0);
  clock.advance(250);
  assert.equal(replies.length, 2);
  replies[1]!({ Metadata: md('/t/1', 'Full', 'A'), PlaybackStatus: 'Playing', Position: us(42 * S) });
  await flushMicrotasks();
  assert.equal(out.length, 1);
  assert.equal(out[0]?.title, 'Full');
  assert.equal(out[0]?.positionMs, 42 * S);
});

test('a failing refresh still settles on the signal data', async () => {
  const { clock, out, tracker } = setup({ refresh: () => Promise.reject(new Error('NoReply')) });
  tracker.update({ Metadata: md('/t/1', 'T', 'A'), PlaybackStatus: 'Paused', Position: us(5 * S) });
  clock.advance(250);
  await flushMicrotasks();
  assert.equal(out.length, 1);
  assert.equal(out[0]?.status, 'paused');
  assert.equal(out[0]?.positionMs, 5 * S);
});

test('a stream without a length whose Position never moves: polls are not seeks, the timeline keeps running', () => {
  const { clock, out, tracker } = setup();
  tracker.update({ Metadata: md('/wave/1', 'Generative', 'Нейромузыка'), PlaybackStatus: 'Playing', Position: 0 });
  clock.advance(250);
  assert.equal(out.length, 1);
  const start = out[0]!.at - out[0]!.positionMs;
  for (let i = 0; i < 12; i++) {
    clock.advance(5 * S);
    tracker.poll(0);
  }
  assert.equal(out.length, 1, 'no re-emit every 5 s with the elapsed counter reset');
  const pausedAt = clock.t;
  tracker.update({ PlaybackStatus: 'Paused' });
  clock.advance(250);
  assert.equal(out.length, 2);
  assert.equal(out[1]?.positionMs, pausedAt - start); // still extrapolated from the first snapshot
});

test('a track with a length whose Position stalls is still re-anchored like a seek', () => {
  const { clock, out, tracker } = playing();
  clock.advance(5 * S);
  tracker.poll(us(2 * S));
  assert.equal(out.length, 1);
  assert.equal(out[0]?.positionMs, 2 * S);
});
