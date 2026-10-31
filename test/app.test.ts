import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App, LOOKUP_RETRY_MS, describeInfo, type ManagedSink } from '../src/app.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { Activity, Enricher, PlayerSnapshot, PlayerSource, TrackInfo } from '../src/model.ts';
import { ConsoleSink, describeTimestamps } from '../src/presence/consoleSink.ts';

const T0 = 1793450000000;
const flush = () => new Promise<void>((r) => setImmediate(r));

/** Deterministic scheduler for the engine; advance() runs due timers in order. */
class FakeClock {
  t = T0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    this.timers.set(++this.seq, { at: this.t + ms, fn });
    return this.seq;
  };
  clearTimeout = (id: unknown) => {
    this.timers.delete(id as number);
  };
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await flush();
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
    await flush();
  }
}

class FakeSource implements PlayerSource {
  emit: (s: PlayerSnapshot | null) => void = () => {
    throw new Error('not started');
  };
  stops = 0;
  async start(onUpdate: (s: PlayerSnapshot | null) => void): Promise<void> {
    this.emit = onUpdate;
  }
  async stop(): Promise<void> {
    this.stops++;
  }
}

/** Lookups stay pending until the test resolves them; like a provider that ignores abort. */
class FakeEnricher implements Enricher {
  calls: { snapshot: PlayerSnapshot; signal: AbortSignal; resolve: (info: TrackInfo | null) => void }[] = [];
  lookup(snapshot: PlayerSnapshot, signal?: AbortSignal): Promise<TrackInfo | null> {
    return new Promise((resolve) => this.calls.push({ snapshot, signal: signal!, resolve }));
  }
}

class RecordingSink implements ManagedSink {
  events: string[] = [];
  activities: (Activity | null)[] = [];
  start(): void {
    this.events.push('start');
  }
  async stop(): Promise<void> {
    this.events.push('stop');
  }
  async setActivity(activity: Activity | null): Promise<void> {
    this.activities.push(activity);
    this.events.push(activity ? 'set' : 'clear');
  }
  last(): Activity | null | undefined {
    return this.activities.at(-1);
  }
}

const cover = (n: number) => `https://avatars.yandex.net/get-music-content/1/${n}.a.1-1/400x400`;
const infoFor = (n: number): TrackInfo => ({ provider: 'yandex', trackId: `${n}`, albumId: `${n}0`, coverUrl: cover(n) });

async function setup() {
  const clock = new FakeClock();
  const source = new FakeSource();
  const enricher = new FakeEnricher();
  const sink = new RecordingSink();
  const app = new App({
    cfg: DEFAULT_CONFIG,
    source,
    enricher,
    sink,
    engine: { now: clock.now, monotonic: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
  });
  await app.start();
  const snap = (o: Partial<PlayerSnapshot> = {}): PlayerSnapshot => ({
    source: 'mpris',
    at: clock.now(),
    status: 'playing',
    title: 'Capable of love',
    artists: ['PinkPantheress'],
    album: 'Heaven knows',
    durationMs: 223747,
    positionMs: 60_000,
    rate: 1,
    trackKey: 'Capable of love|PinkPantheress|224',
    ...o,
  });
  return { clock, source, enricher, sink, app, snap };
}

test('one lookup per track; the first card already carries the found cover', async () => {
  const { clock, source, enricher, sink, snap } = await setup();
  assert.deepEqual(sink.events, ['start']);
  source.emit(snap());
  source.emit(snap({ positionMs: 90_000 })); // seek
  source.emit(snap({ status: 'paused' }));
  source.emit(snap());
  assert.equal(enricher.calls.length, 1);
  assert.equal(enricher.calls[0]!.snapshot.title, 'Capable of love');
  await clock.advance(700); // lookup answers after the 400 ms settle debounce
  enricher.calls[0]!.resolve(infoFor(1));
  await clock.advance(0);
  assert.equal(sink.activities.length, 1);
  assert.equal(sink.last()?.assets?.large_image, cover(1));
  assert.equal(sink.last()?.details_url, 'https://music.yandex.ru/album/10/track/1');
});

test('a track change aborts the superseded lookup and its late answer is ignored', async () => {
  const { clock, source, enricher, sink, snap } = await setup();
  source.emit(snap());
  await clock.advance(100);
  source.emit(snap({ title: 'Next', trackKey: 'Next|PinkPantheress|200' }));
  assert.equal(enricher.calls.length, 2);
  assert.equal(enricher.calls[0]!.signal.aborted, true);
  assert.equal(enricher.calls[1]!.signal.aborted, false);
  enricher.calls[0]!.resolve(infoFor(1)); // provider ignored the abort
  enricher.calls[1]!.resolve(infoFor(2));
  await clock.advance(10_000);
  assert.equal(sink.activities.length, 1);
  assert.equal(sink.last()?.details, 'Next');
  assert.equal(sink.last()?.assets?.large_image, cover(2));
});

test('stopped and null clear without lookups; the same track coming back keeps its info and is looked up again', async () => {
  const { clock, source, enricher, sink, snap } = await setup();
  source.emit(snap());
  enricher.calls[0]!.resolve(infoFor(1));
  await clock.advance(5000);
  assert.equal(sink.activities.length, 1);

  source.emit(snap({ status: 'stopped', title: '', artists: [], trackKey: '||' }));
  await clock.advance(5000);
  assert.equal(sink.last(), null);
  assert.equal(enricher.calls.length, 1);
  source.emit(snap());
  await clock.advance(5000);
  assert.equal(enricher.calls.length, 2); // a cache hit in practice; retries an earlier failure
  assert.equal(sink.last()?.assets?.large_image, cover(1)); // shown at once, without waiting for it

  source.emit(null);
  await clock.advance(5000);
  assert.equal(sink.last(), null);
  source.emit(snap({ title: 'Other', trackKey: 'Other|X|100', artists: ['X'] }));
  assert.equal(enricher.calls.length, 3);
});

test('a track whose lookup failed gets the cover after the player comes back', async () => {
  const { clock, source, enricher, sink, snap } = await setup();
  source.emit(snap());
  enricher.calls[0]!.resolve(null); // network briefly down: not cached
  await clock.advance(5000);
  assert.equal(sink.last()?.assets?.large_image, 'logo');
  source.emit(null); // YM closed and reopened on the same track
  await clock.advance(1000);
  source.emit(snap());
  assert.equal(enricher.calls.length, 2);
  enricher.calls[1]!.resolve(infoFor(1));
  await clock.advance(5000);
  assert.equal(sink.last()?.assets?.large_image, cover(1));
});

test('a lookup that found nothing is retried once for the same track', async () => {
  const { clock, source, enricher, sink, snap } = await setup();
  source.emit(snap());
  enricher.calls[0]!.resolve(null);
  await clock.advance(LOOKUP_RETRY_MS - 1);
  assert.equal(enricher.calls.length, 1);
  await clock.advance(1);
  assert.equal(enricher.calls.length, 2);
  enricher.calls[1]!.resolve(infoFor(1));
  await clock.advance(5000);
  assert.equal(sink.last()?.assets?.large_image, cover(1));
  await clock.advance(10 * LOOKUP_RETRY_MS);
  assert.equal(enricher.calls.length, 2);

  // Only once per track, and a superseded track's retry is dropped.
  source.emit(snap({ title: 'B', trackKey: 'B|X|1', artists: ['X'] }));
  enricher.calls[2]!.resolve(null);
  await clock.advance(LOOKUP_RETRY_MS);
  assert.equal(enricher.calls.length, 4);
  enricher.calls[3]!.resolve(null);
  await clock.advance(1000);
  source.emit(snap({ title: 'C', trackKey: 'C|X|1', artists: ['X'] }));
  enricher.calls[4]!.resolve(infoFor(3));
  await clock.advance(10 * LOOKUP_RETRY_MS);
  assert.equal(enricher.calls.length, 5);
});

test('stop(): aborts the lookup, stops the source, clears, then stops the sink; idempotent', async () => {
  const { source, enricher, sink, app, snap } = await setup();
  source.emit(snap());
  const a = app.stop();
  const b = app.stop();
  assert.equal(a, b);
  await a;
  assert.equal(enricher.calls[0]!.signal.aborted, true);
  assert.equal(source.stops, 1);
  assert.deepEqual(sink.events, ['start', 'clear', 'stop']);
  source.emit(snap({ trackKey: 'late' }));
  assert.equal(enricher.calls.length, 1);
});

test('describeInfo names the provider and ids', () => {
  assert.equal(describeInfo(null), 'no catalog match, using the logo');
  assert.equal(describeInfo(infoFor(7)), 'found via yandex: track 7, album 70');
  assert.equal(describeInfo({ provider: 'itunes', coverUrl: 'https://x.mzstatic.com/a.jpg' }), 'found via itunes: cover only');
  assert.equal(describeInfo({ provider: 'yandex', trackId: '7', albumId: '70' }), 'found via yandex: track 7, album 70, no cover');
});

test('ConsoleSink prints a timestamped header, the bar position and pretty JSON', async () => {
  let out = '';
  const sink = new ConsoleSink({ write: (s) => (out += s), now: () => T0 });
  await sink.setActivity({ type: 2, details: 'Capable of love', timestamps: { start: T0 - 70_742, end: T0 - 70_742 + 223_747 } });
  await sink.setActivity(null);
  const lines = out.split('\n');
  assert.equal(lines[0], '2026-10-31T12:33:20.000Z SET_ACTIVITY (bar 1:11 / 3:44)');
  assert.equal(lines[1], '{');
  assert.match(out, /\n {2}"details": "Capable of love",\n/);
  assert.match(out, /\n2026-10-31T12:33:20\.000Z CLEAR_ACTIVITY\nnull\n$/);
  assert.equal(describeTimestamps({ start: T0 - 5000 }, T0), 'elapsed 0:05');
  assert.equal(describeTimestamps(undefined, T0), undefined);
});
