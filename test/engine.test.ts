import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { DiscordRpcError, type Activity, type Config, type PlayerSnapshot, type PresenceSink, type TrackInfo } from '../src/model.ts';
import { PresenceEngine, type EngineOptions } from '../src/presence/engine.ts';

const T0 = 1793450000000;
const flush = () => new Promise<void>((r) => setImmediate(r));

/** Deterministic clock + scheduler; advance() runs due timers in order and lets promises settle. */
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
  get pending() {
    return this.timers.size;
  }
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

class FakeSink implements PresenceSink {
  calls: { at: number; activity: Activity | null }[] = [];
  /** Errors thrown by the next calls, in order (undefined = succeed). */
  failures: (Error | undefined)[] = [];
  /** When set, calls stay in flight until release() is called. */
  hold = false;
  inFlight = 0;
  maxInFlight = 0;
  private releases: (() => void)[] = [];
  private clock: FakeClock;
  constructor(clock: FakeClock) {
    this.clock = clock;
  }
  async setActivity(activity: Activity | null): Promise<void> {
    this.calls.push({ at: this.clock.now(), activity });
    this.maxInFlight = Math.max(this.maxInFlight, ++this.inFlight);
    try {
      if (this.hold) await new Promise<void>((r) => this.releases.push(r));
      const err = this.failures.shift();
      if (err) throw err;
    } finally {
      this.inFlight--;
    }
  }
  release(): void {
    for (const r of this.releases.splice(0)) r();
  }
  last(): Activity | null | undefined {
    return this.calls.at(-1)?.activity;
  }
}

function setup(cfg: Partial<Config> = {}, opts: EngineOptions = {}) {
  const clock = new FakeClock();
  const sink = new FakeSink(clock);
  const engine = new PresenceEngine(sink, { ...DEFAULT_CONFIG, ...cfg }, {
    now: clock.now,
    monotonic: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...opts,
  });
  /** A playing snapshot whose track started at `startedAt` (position follows the clock). */
  const snap = (o: Partial<PlayerSnapshot> & { startedAt?: number } = {}): PlayerSnapshot => {
    const { startedAt = T0 - 60_000, ...rest } = o;
    return {
      source: 'mpris',
      at: clock.now(),
      status: 'playing',
      title: 'Capable of love',
      artists: ['PinkPantheress'],
      album: 'Heaven knows',
      durationMs: 223747,
      positionMs: clock.now() - startedAt,
      rate: 1,
      trackKey: 't1',
      ...rest,
    };
  };
  return { clock, sink, engine, snap };
}

const COVER = 'https://avatars.yandex.net/get-music-content/9837405/0f61442d.a.28127004-1/400x400';
const info: TrackInfo = {
  provider: 'yandex',
  trackId: '118138322',
  albumId: '28127004',
  artists: [{ id: '12044483', name: 'PinkPantheress' }],
  album: 'Heaven knows',
  coverUrl: COVER,
};

test('new track is debounced; fields arriving one by one collapse into one send', async () => {
  const { clock, sink, engine, snap } = setup();
  engine.update(snap({ title: 'Old title' })); // first signal may still carry the old title
  await clock.advance(50);
  engine.update(snap());
  await clock.advance(349);
  assert.equal(sink.calls.length, 0);
  await clock.advance(1);
  assert.equal(sink.calls.length, 1);
  assert.equal(sink.calls[0]!.at, T0 + 400);
  assert.equal(sink.last()?.details, 'Capable of love');
  assert.equal(sink.last()?.assets?.large_image, 'logo');
});

test('track change drops old info and restarts the debounce', async () => {
  const { clock, sink, engine, snap } = setup();
  engine.update(snap());
  engine.setTrackInfo('t1', info);
  await clock.advance(400);
  assert.equal(sink.calls.length, 1);
  assert.equal(sink.last()?.assets?.large_image, COVER); // info inside the debounce window → one send
  await clock.advance(10_000);
  engine.update(snap({ trackKey: 't2', title: 'Next', startedAt: clock.now() }));
  await clock.advance(399);
  assert.equal(sink.calls.length, 1);
  await clock.advance(1);
  assert.equal(sink.calls.length, 2);
  assert.equal(sink.last()?.details, 'Next');
  assert.equal(sink.last()?.assets?.large_image, 'logo');
  assert.equal(sink.last()?.details_url, undefined);
});

test('late info triggers exactly one update; repeated info is deduped', async () => {
  const { clock, sink, engine, snap } = setup();
  engine.update(snap());
  await clock.advance(5000);
  assert.equal(sink.calls.length, 1);
  engine.setTrackInfo('t1', info);
  await clock.advance(0);
  assert.equal(sink.calls.length, 2);
  assert.equal(sink.last()?.assets?.large_image, COVER);
  assert.equal(sink.last()?.details_url, 'https://music.yandex.ru/album/28127004/track/118138322');
  engine.setTrackInfo('t1', { ...info });
  await clock.advance(5000);
  assert.equal(sink.calls.length, 2);
});

test('info for a stale trackKey is ignored', async () => {
  const { clock, sink, engine, snap } = setup();
  engine.update(snap());
  await clock.advance(5000);
  engine.update(snap({ trackKey: 't2', title: 'Next' }));
  engine.setTrackInfo('t1', info); // lookup for the previous track finished late
  await clock.advance(400);
  assert.equal(sink.calls.length, 2);
  assert.equal(sink.last()?.assets?.large_image, 'logo');
  engine.setTrackInfo('t1', info);
  await clock.advance(5000);
  assert.equal(sink.calls.length, 2);
});

test('throttle: leading send, then bursts collapse to the latest state', async () => {
  const { clock, sink, engine, snap } = setup();
  engine.update(snap());
  await clock.advance(400); // leading send at T0+400
  for (const seekTo of [10_000, 50_000, 120_000]) {
    await clock.advance(1000);
    engine.update(snap({ startedAt: clock.now() - seekTo }));
  }
  assert.equal(sink.calls.length, 1);
  await clock.advance(999);
  assert.equal(sink.calls.length, 1);
  await clock.advance(1); // T0+4400 = leading + minInterval
  assert.equal(sink.calls.length, 2);
  assert.equal(sink.calls[1]!.at, T0 + 4400);
  assert.equal(sink.last()?.timestamps?.start, T0 + 3400 - 120_000);
  await clock.advance(60_000);
  assert.equal(sink.calls.length, 2);
});

test('dedupe: identical state with small drift is not re-sent, end drift counts too', async () => {
  const { clock, sink, engine, snap } = setup();
  engine.update(snap());
  await clock.advance(400);
  for (const drift of [300, -1500, 2000]) {
    await clock.advance(5000);
    engine.update(snap({ startedAt: T0 - 60_000 - drift }));
  }
  await clock.advance(5000);
  assert.equal(sink.calls.length, 1);
  // Same start, but a corrected duration moves end by > 2 s → resend.
  engine.update(snap({ durationMs: 223747 + 5000 }));
  await clock.advance(0);
  assert.equal(sink.calls.length, 2);
});

test('seek > 2 s sends new timestamps', async () => {
  const { clock, sink, engine, snap } = setup();
  engine.update(snap());
  await clock.advance(5000);
  engine.update(snap({ startedAt: T0 - 60_000 - 2001 }));
  await clock.advance(0);
  assert.equal(sink.calls.length, 2);
  assert.equal(sink.last()?.timestamps?.start, T0 - 60_000 - 2001);
});

test('pause → paused card, AFK clears after 10 min, resume restores timestamps', async () => {
  const { clock, sink, engine, snap } = setup();
  engine.update(snap());
  await clock.advance(5000);
  const pausedAt = clock.now();
  engine.update(snap({ status: 'paused', positionMs: 65_000 }));
  await clock.advance(0);
  assert.equal(sink.calls.length, 2);
  assert.equal(sink.last()?.timestamps, undefined);
  assert.equal(sink.last()?.assets?.small_image, 'paused');
  assert.equal(sink.last()?.assets?.small_text, 'На паузе');
  // MPRIS polls keep reporting "paused"; that must not restart the AFK timer.
  for (let i = 0; i < 119; i++) {
    await clock.advance(5000);
    engine.update(snap({ status: 'paused', positionMs: 65_000 }));
  }
  assert.equal(sink.calls.length, 2);
  await clock.advance(pausedAt + 600_000 - clock.now());
  assert.equal(sink.calls.length, 3);
  assert.equal(sink.last(), null);
  assert.equal(sink.calls[2]!.at, pausedAt + 600_000);
  engine.update(snap({ status: 'paused', positionMs: 65_000 }));
  await clock.advance(5000);
  assert.equal(sink.calls.length, 3);
  engine.update(snap({ startedAt: clock.now() - 65_000 }));
  await clock.advance(0);
  assert.equal(sink.calls.length, 4);
  assert.equal(sink.last()?.timestamps?.start, clock.now() - 65_000);
  assert.equal(sink.last()?.assets?.small_image, undefined);
});

test('resume before AFK cancels it', async () => {
  const { clock, sink, engine, snap } = setup();
  engine.update(snap());
  await clock.advance(5000);
  engine.update(snap({ status: 'paused', positionMs: 65_000 }));
  await clock.advance(5 * 60_000);
  engine.update(snap({ startedAt: clock.now() - 65_000 }));
  await clock.advance(60 * 60_000);
  assert.deepEqual(sink.calls.map((c) => (c.activity ? (c.activity.timestamps ? 'playing' : 'paused') : 'clear')), ['playing', 'paused', 'playing']);
});

test('afkMinutes 0 clears immediately on pause', async () => {
  const { clock, sink, engine, snap } = setup({ afkMinutes: 0 });
  engine.update(snap());
  await clock.advance(5000);
  engine.update(snap({ status: 'paused' }));
  await clock.advance(0);
  assert.equal(sink.calls.length, 2);
  assert.equal(sink.last(), null);
  assert.equal(clock.pending, 0);
});

test('null / stopped snapshot clears once; nothing shown → no clear', async () => {
  const { clock, sink, engine, snap } = setup();
  engine.update(null);
  await clock.advance(1000);
  assert.equal(sink.calls.length, 0);
  engine.update(snap());
  await clock.advance(5000);
  engine.update(null);
  await clock.advance(0);
  assert.equal(sink.calls.length, 2);
  assert.equal(sink.last(), null);
  engine.update(null);
  engine.update(snap({ status: 'stopped' }));
  await clock.advance(10_000);
  assert.equal(sink.calls.length, 2);
  // Same track comes back: no debounce needed, info for it is still valid.
  engine.update(snap());
  await clock.advance(0);
  assert.equal(sink.calls.length, 3);
  engine.update(snap({ status: 'stopped' }));
  await clock.advance(4000);
  assert.equal(sink.last(), null);
});

test('stopped during the debounce cancels the pending track', async () => {
  const { clock, sink, engine, snap } = setup();
  engine.update(snap());
  await clock.advance(100);
  engine.update(null);
  await clock.advance(10_000);
  assert.equal(sink.calls.length, 0);
});

test('DiscordRpcError with a cover → retry at once with the logo, cover remembered as bad', async () => {
  const { clock, sink, engine, snap } = setup();
  sink.failures = [new DiscordRpcError(1000, 'Unknown Error')];
  engine.update(snap());
  engine.setTrackInfo('t1', info);
  await clock.advance(400);
  assert.equal(sink.calls.length, 2);
  assert.equal(sink.calls[0]!.activity?.assets?.large_image, COVER);
  assert.equal(sink.calls[1]!.activity?.assets?.large_image, 'logo');
  assert.equal(sink.calls[1]!.at, sink.calls[0]!.at); // not throttled
  assert.equal(sink.calls[1]!.activity?.details_url, 'https://music.yandex.ru/album/28127004/track/118138322');
  await clock.advance(5000);
  engine.update(snap({ startedAt: T0 - 100_000 }));
  await clock.advance(0);
  assert.equal(sink.calls.length, 3);
  assert.equal(sink.last()?.assets?.large_image, 'logo');
});

test('retry happens once: a second DiscordRpcError is only logged', async () => {
  const { clock, sink, engine, snap } = setup();
  sink.failures = [new DiscordRpcError(1000, 'a'), new DiscordRpcError(4000, 'b')];
  engine.update(snap());
  engine.setTrackInfo('t1', info);
  await clock.advance(60_000);
  assert.equal(sink.calls.length, 2);
});

test('other errors: no retry, same state not re-sent, next change is', async () => {
  const { clock, sink, engine, snap } = setup();
  sink.failures = [new Error('EPIPE')];
  engine.update(snap());
  await clock.advance(5000);
  assert.equal(sink.calls.length, 1);
  engine.update(snap());
  await clock.advance(5000);
  assert.equal(sink.calls.length, 1);
  engine.update(snap({ status: 'paused' }));
  await clock.advance(0);
  assert.equal(sink.calls.length, 2);
});

test('sends are serialized and the latest state wins', async () => {
  const { clock, sink, engine, snap } = setup();
  sink.hold = true;
  engine.update(snap());
  await clock.advance(400);
  assert.equal(sink.calls.length, 1);
  await clock.advance(5000);
  engine.update(snap({ status: 'paused' }));
  engine.update(snap({ startedAt: T0 }));
  await clock.advance(5000);
  assert.equal(sink.calls.length, 1); // first call still in flight
  sink.release();
  await clock.advance(0);
  assert.equal(sink.calls.length, 2);
  assert.equal(sink.last()?.timestamps?.start, T0);
  sink.release();
  await clock.advance(0);
  assert.equal(sink.maxInFlight, 1);
});

test('stop() waits for the in-flight send, clears, cancels timers and ignores later updates', async () => {
  const { clock, sink, engine, snap } = setup();
  engine.update(snap());
  await clock.advance(5000);
  engine.update(snap({ status: 'paused' })); // starts the AFK timer
  sink.hold = true;
  engine.update(snap({ startedAt: T0 })); // throttled → trailing timer pending
  await clock.advance(0);
  const stopping = engine.stop();
  await flush();
  sink.hold = false;
  sink.release();
  await stopping;
  assert.equal(sink.last(), null);
  assert.equal(sink.maxInFlight, 1);
  assert.equal(clock.pending, 0);
  const n = sink.calls.length;
  engine.update(snap({ trackKey: 't9' }));
  engine.setTrackInfo('t9', info);
  await clock.advance(3_600_000);
  assert.equal(sink.calls.length, n);
});

test('infoWaitMs: the first card waits for the lookup, then goes out once with the cover', async () => {
  const { clock, sink, engine, snap } = setup({}, { infoWaitMs: 1500 });
  engine.update(snap());
  await clock.advance(400);
  assert.equal(sink.calls.length, 0); // settled, but still waiting for info
  await clock.advance(300);
  engine.setTrackInfo('t1', info);
  await clock.advance(0);
  assert.equal(sink.calls.length, 1);
  assert.equal(sink.calls[0]!.at, T0 + 700);
  assert.equal(sink.last()?.assets?.large_image, COVER);
  await clock.advance(10_000);
  assert.equal(sink.calls.length, 1);
});

test('infoWaitMs: early info still respects the settle debounce; a hung lookup falls back to the logo', async () => {
  const { clock, sink, engine, snap } = setup({}, { infoWaitMs: 1500 });
  engine.update(snap());
  engine.setTrackInfo('t1', null); // cache miss answered at once
  await clock.advance(399);
  assert.equal(sink.calls.length, 0);
  await clock.advance(1);
  assert.equal(sink.calls.length, 1);
  assert.equal(sink.last()?.assets?.large_image, 'logo');

  await clock.advance(10_000);
  engine.update(snap({ trackKey: 't2', title: 'Next', startedAt: clock.now() }));
  await clock.advance(1499);
  assert.equal(sink.calls.length, 1);
  await clock.advance(1);
  assert.equal(sink.calls.length, 2);
  assert.equal(sink.last()?.details, 'Next');
  assert.equal(sink.last()?.assets?.large_image, 'logo');
});

test('infoWaitMs: a newer snapshot of the same track during the wait does not send early', async () => {
  const { clock, sink, engine, snap } = setup({}, { infoWaitMs: 1500 });
  engine.update(snap());
  await clock.advance(600);
  engine.update(snap({ status: 'paused' }));
  await clock.advance(0);
  assert.equal(sink.calls.length, 0);
  await clock.advance(900);
  assert.equal(sink.calls.length, 1);
  assert.equal(sink.last()?.assets?.small_image, 'paused');
});

test('sinkFailed: a cover rejected during the sink re-send falls back to the logo at once', async () => {
  const { clock, sink, engine, snap } = setup();
  engine.update(snap());
  engine.setTrackInfo('t1', info);
  await clock.advance(400);
  const shown = sink.last()!;
  assert.equal(shown.assets?.large_image, COVER);
  await clock.advance(1000); // inside the throttle window: the fallback must not wait for it
  engine.sinkFailed(shown, new DiscordRpcError(1000, 'Unknown Error'));
  await clock.advance(0);
  assert.equal(sink.calls.length, 2);
  assert.equal(sink.last()?.assets?.large_image, 'logo');
  engine.sinkFailed(sink.last()!, new Error('Discord IPC disconnected')); // not a rejection
  await clock.advance(10_000);
  assert.equal(sink.calls.length, 2);
});

test('track change drops the old track\'s throttled state (fast skips)', async () => {
  const { clock, sink, engine, snap } = setup({}, { infoWaitMs: 1500 });
  engine.update(snap({ trackKey: 'a', title: 'Track A' }));
  engine.setTrackInfo('a', null);
  await clock.advance(1000); // A sent at 400
  engine.update(snap({ trackKey: 'b', title: 'Track B' })); // B's card is queued at 2500, throttled until 4400
  await clock.advance(3200);
  engine.update(snap({ trackKey: 'c', title: 'Track C' })); // skipped again at 4200
  await clock.advance(1000);
  engine.setTrackInfo('c', null); // C's lookup answers at 5200
  await clock.advance(10_000);
  assert.deepEqual(sink.calls.map((c) => [c.at - T0, c.activity?.details]), [[400, 'Track A'], [5200, 'Track C']]);
});

test('track change drops a throttled pause of the previous track', async () => {
  const { clock, sink, engine, snap } = setup({}, { infoWaitMs: 1500 });
  engine.update(snap({ trackKey: 'a', title: 'Track A' }));
  engine.setTrackInfo('a', null);
  await clock.advance(2400);
  engine.update(snap({ trackKey: 'a', title: 'Track A', status: 'paused' })); // throttled until 4400
  await clock.advance(1000);
  engine.update(snap({ trackKey: 'b', title: 'Track B' })); // next track starts playing at 3400
  await clock.advance(10_000);
  assert.deepEqual(sink.calls.map((c) => [c.at - T0, c.activity?.details, c.activity?.timestamps ? 'playing' : 'paused']), [[400, 'Track A', 'playing'], [4900, 'Track B', 'playing']]);
});

test('track change while a send is in flight: the old track\'s queued state is not sent afterwards', async () => {
  const { clock, sink, engine, snap } = setup();
  sink.hold = true;
  engine.update(snap({ trackKey: 'a', title: 'Track A' }));
  await clock.advance(4500); // A goes out at 400; Discord is slow to answer
  engine.update(snap({ trackKey: 'a', title: 'Track A', status: 'paused' })); // queued behind the in-flight send
  await clock.advance(100);
  engine.update(snap({ trackKey: 'b', title: 'Track B' }));
  await clock.advance(100);
  sink.hold = false;
  sink.release(); // reply arrives during B's debounce
  await clock.advance(10_000);
  assert.deepEqual(sink.calls.map((c) => [c.at - T0, c.activity?.details]), [[400, 'Track A'], [5000, 'Track B']]);
});

test('a backward wall-clock step does not freeze throttle or debounce (intervals are monotonic)', async () => {
  let wall = (): number => 0;
  const { clock, sink, engine, snap } = setup({}, { now: () => wall(), infoWaitMs: 1500 });
  let offset = 0;
  wall = () => clock.t + offset;
  engine.update(snap());
  engine.setTrackInfo('t1', null);
  await clock.advance(1000);
  assert.equal(sink.calls.length, 1); // sent at 400
  offset -= 3 * 3600_000; // the wall clock steps back 3 h (e.g. an NTP or manual correction)
  engine.update(snap({ status: 'paused', at: wall() }));
  await clock.advance(3400);
  assert.equal(sink.calls.length, 2); // 4 s after the first send, not 3 h
  assert.equal(sink.last()?.assets?.small_image, 'paused');

  await clock.advance(10_000);
  const changedAt = wall();
  engine.update(snap({ trackKey: 't2', title: 'Next', at: changedAt, positionMs: 0 }));
  await clock.advance(200);
  offset -= 3600_000; // another step inside the new track's debounce
  await clock.advance(600);
  engine.setTrackInfo('t2', null); // lookup answers 800 ms after the change
  await clock.advance(0);
  assert.equal(sink.calls.length, 3);
  assert.equal(sink.last()?.details, 'Next');
  assert.equal(sink.last()?.timestamps?.start, changedAt); // epoch timestamps come from the snapshot's wall clock
});

test('a huge afkMinutes does not overflow setTimeout (Node fires overflowed delays after 1 ms)', async () => {
  const delays: number[] = [];
  let set = (_fn: () => void, _ms: number): unknown => undefined;
  const { clock, sink, engine, snap } = setup({ afkMinutes: 99999 }, { setTimeout: (fn, ms) => (delays.push(ms), set(fn, ms)) });
  set = clock.setTimeout;
  engine.update(snap());
  await clock.advance(5000);
  engine.update(snap({ status: 'paused' }));
  await clock.advance(24 * 3600_000);
  assert.ok(Math.max(...delays) <= 2 ** 31 - 1, `max delay ${Math.max(...delays)}`);
  assert.equal(sink.calls.length, 2);
  assert.equal(sink.last()?.assets?.small_image, 'paused');
});

test('sinkFailed: a re-send rejected for a cover that is already bad still restores the fallback card', async () => {
  const { clock, sink, engine, snap } = setup();
  engine.update(snap());
  await clock.advance(5000); // logo card L
  const itunes: TrackInfo = { provider: 'itunes', album: 'Heaven knows', coverUrl: 'https://is1-ssl.mzstatic.com/image/thumb/x/600x600bb.jpg' };
  sink.failures = [new DiscordRpcError(1000, 'Unknown Error')];
  engine.setTrackInfo('t1', itunes); // L + cover → rejected; the fallback equals L and is deduped
  await clock.advance(1000);
  assert.deepEqual(sink.calls.map((c) => c.activity?.assets?.large_image), ['logo', itunes.coverUrl]);
  // Discord reconnects and DiscordIpc's re-send of the rejected payload fails again: Discord shows nothing now.
  engine.sinkFailed(sink.calls[1]!.activity!, new DiscordRpcError(1000, 'Unknown Error'));
  await clock.advance(0);
  assert.equal(sink.calls.length, 3);
  assert.equal(sink.last()?.assets?.large_image, 'logo');
  engine.sinkFailed(sink.calls[1]!.activity!, new Error('Discord IPC disconnected')); // not a rejection: nothing to do
  await clock.advance(10_000);
  assert.equal(sink.calls.length, 3);
});
