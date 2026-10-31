// Pure MPRIS state machine (no D-Bus): raw Player property reads/changes in, PlayerSnapshot | null out.
// Absorbs YM quirks: one "A, B" artist string, Stopped/NoTrack blips and half-updated metadata on
// track change, and a Rate that is always 1. See docs/ARCHITECTURE.md, "Причуды MPRIS".
import { logger } from '../log.ts';
import type { PlaybackStatus, PlayerSnapshot } from '../model.ts';

const log = logger('mpris');

export const NO_TRACK = '/org/mpris/MediaPlayer2/TrackList/NoTrack';
export const STANDARD_RATES: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/** Player properties with variants unwrapped; times in µs (number or bigint). Other keys are ignored. */
export interface MprisProps {
  Metadata?: Record<string, unknown>;
  PlaybackStatus?: unknown;
  Position?: unknown;
  [key: string]: unknown;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface TrackMeta {
  trackId?: string;
  title: string;
  artists: string[];
  album?: string;
  durationMs?: number;
}

/** µs (number | bigint) → integer ms; undefined for anything non-finite or negative. */
export function usToMs(v: unknown): number | undefined {
  const n = typeof v === 'bigint' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n / 1000) : undefined;
}

export function mapStatus(v: unknown): PlaybackStatus | undefined {
  return v === 'Playing' ? 'playing' : v === 'Paused' ? 'paused' : v === 'Stopped' ? 'stopped' : undefined;
}

/** YM joins all artists into one "A, B" element; a genuine multi-element list is kept as is. [""] → []. */
export function splitArtists(v: unknown): string[] {
  const list = (Array.isArray(v) ? v : [v]).filter((a): a is string => typeof a === 'string');
  const names = list.length === 1 ? list[0]!.split(', ') : list;
  return names.map((a) => a.trim()).filter((a) => a !== '');
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function normalizeMetadata(md: Record<string, unknown>): TrackMeta {
  const meta: TrackMeta = { title: str(md['xesam:title']), artists: splitArtists(md['xesam:artist']) };
  const trackId = str(md['mpris:trackid']);
  if (trackId) meta.trackId = trackId;
  const album = str(md['xesam:album']);
  if (album) meta.album = album;
  const durationMs = usToMs(md['mpris:length']);
  if (durationMs) meta.durationMs = durationMs;
  return meta;
}

// Content-based on purpose: Chromium's mpris:trackid is a per-media-session id that survives track
// switches (consecutive tracks carry the same .../TrackList/Track<hex>), not a track id. Only the
// NoTrack blips between tracks change it.
export function trackKeyOf(m: TrackMeta): string {
  const dur = m.durationMs === undefined ? '' : Math.round(m.durationMs / 1000);
  return `${m.title}|${m.artists.join(', ')}|${dur}`;
}

/** The standard player speed within ±tolerance of the observed Δpos/Δt, if any. */
export function nearestStandardRate(observed: number, tolerance: number): number | undefined {
  if (!Number.isFinite(observed)) return undefined;
  return STANDARD_RATES.find((r) => Math.abs(observed - r) <= tolerance);
}

const DEFAULTS = {
  /** Quiet period after the last change before deciding (fields arrive one by one). */
  debounceMs: 250,
  /** Cap on how long a continuous stream of changes may postpone a decision. */
  maxWaitMs: 1000,
  /** How long a Stopped/NoTrack/empty-title state may last before it is reported. */
  graceMs: 2000,
  /** Poll drift beyond this (vs. the last emitted snapshot) counts as a seek. */
  seekThresholdMs: 1500,
  rateTolerance: 0.08,
  /** Consecutive polls that must agree on a new rate before it is adopted. */
  rateStreak: 2,
  /** Below this Δt the YM position (~100 ms steps) makes Δpos/Δt too noisy. */
  minRateSpanMs: 2000,
  /** A Position that moved less than this over minRateSpanMs of playback is not moving at all. */
  stillToleranceMs: 100,
};

export interface MprisTrackerOptions extends Partial<typeof DEFAULTS> {
  onSnapshot: (snapshot: PlayerSnapshot | null) => void;
  /** Re-reads all Player properties once a burst settles, before deciding (signals can be partial). */
  refresh?: () => Promise<MprisProps | undefined>;
  clock?: Clock;
}

interface Reading {
  pos: number;
  at: number;
}

const EMPTY: TrackMeta = { title: '', artists: [] };

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class MprisTracker {
  private readonly onSnapshot: (snapshot: PlayerSnapshot | null) => void;
  private readonly refresh: (() => Promise<MprisProps | undefined>) | undefined;
  private readonly clock: Clock;
  private readonly cfg: typeof DEFAULTS;

  private meta: TrackMeta | undefined;
  private status: PlaybackStatus | undefined;
  /** Latest position reading; extrapolated with `rate` while playing. */
  private anchor: Reading | undefined;
  /** Last Position read from the player as is (never extrapolated). */
  private raw: Reading | undefined;
  private rate = 1;
  private candidate: { rate: number; streak: number } | undefined;
  /** Start of the current Δpos/Δt span; cleared on every discontinuity. */
  private baseline: Reading | undefined;
  private last: PlayerSnapshot | null | undefined;
  private lastKey = '';
  /** Emit the next settled state even if it looks unchanged (seek). */
  private forced = false;
  private debounceTimer: unknown;
  private burstStart = 0;
  private graceTimer: unknown;
  private graceExpired = false;
  private refreshing = false;
  /** Bumped by gone()/dispose() so in-flight refreshes are dropped. */
  private epoch = 0;
  private disposed = false;

  constructor(opts: MprisTrackerOptions) {
    const { onSnapshot, refresh, clock = systemClock, ...tuning } = opts;
    this.onSnapshot = onSnapshot;
    this.refresh = refresh;
    this.clock = clock;
    this.cfg = { ...DEFAULTS, ...tuning };
  }

  /** True while the player reports Playing (the source polls Position only then). */
  get playing(): boolean {
    return this.status === 'playing';
  }

  /** GetAll result or PropertiesChanged payload. */
  update(props: MprisProps, at = this.clock.now()): void {
    if (this.disposed) return;
    this.apply(props, at);
    this.changed();
  }

  /** Seeked signal (position as re-read by the source). Always yields a fresh snapshot after the debounce. */
  seeked(positionUs: unknown, at = this.clock.now()): void {
    const pos = usToMs(positionUs);
    if (this.disposed || pos === undefined) return;
    this.anchor = this.raw = { pos, at };
    this.restartEstimation(this.anchor);
    this.forced = true;
    this.changed();
  }

  /** Periodic Position read while playing: rate estimation and seek detection. Silent when nothing changed. */
  poll(positionUs: unknown, at = this.clock.now()): void {
    const pos = usToMs(positionUs);
    if (this.disposed || pos === undefined) return;
    const reading = { pos, at };
    const prev = this.raw;
    this.raw = reading;
    const last = this.last;
    const steady =
      this.status === 'playing' &&
      this.debounceTimer === undefined &&
      !this.refreshing &&
      !this.isTransitional() &&
      last?.status === 'playing' &&
      last.trackKey === trackKeyOf(this.meta ?? EMPTY);
    if (!steady || !last) {
      // A settle is pending (it will use this reading) or there is nothing to compare against yet.
      this.anchor = reading;
      this.baseline ??= reading;
      return;
    }
    // YM clears the position state for generative streams, which may leave a Position that never moves.
    // Keep extrapolating the emitted timeline instead of taking every poll for a seek.
    const still = prev !== undefined && at - prev.at >= this.cfg.minRateSpanMs && Math.abs(pos - prev.pos) <= this.cfg.stillToleranceMs;
    if (still && last.durationMs === undefined) return;
    this.anchor = reading;

    const base = this.baseline;
    if (base && at - base.at >= this.cfg.minRateSpanMs) {
      this.baseline = reading;
      const std = nearestStandardRate((pos - base.pos) / (at - base.at), this.cfg.rateTolerance);
      if (std !== undefined && std !== this.rate) {
        const streak = this.candidate?.rate === std ? this.candidate.streak + 1 : 1;
        if (streak < this.cfg.rateStreak) {
          this.candidate = { rate: std, streak };
          return;
        }
        log.debug(`playback rate ${this.rate} -> ${std}`);
        this.rate = std;
        this.candidate = undefined;
        this.settle();
        return;
      }
      this.candidate = undefined;
    } else {
      this.baseline ??= reading;
    }
    // While a different rate is being confirmed the drift is expected, not a seek.
    if (this.candidate) return;

    const expected = last.positionMs + (at - last.at) * last.rate;
    if (Math.abs(pos - expected) > this.cfg.seekThresholdMs) {
      log.debug(`seek detected by poll: expected ${Math.round(expected)} ms, got ${pos} ms`);
      this.restartEstimation(reading);
      this.forced = true;
      this.settle();
    }
  }

  /** Player vanished: emit null right away and forget everything. */
  gone(): void {
    if (this.disposed) return;
    this.reset();
    if (this.last === null) return;
    this.last = null;
    this.lastKey = '';
    this.onSnapshot(null);
  }

  /** Cancels timers; no further emissions. */
  dispose(): void {
    this.disposed = true;
    this.reset();
  }

  private apply(p: MprisProps, at: number): void {
    if (p.Metadata && typeof p.Metadata === 'object') {
      const meta = normalizeMetadata(p.Metadata);
      // YM passes through the NoTrack id on every track change, so a trackid change marks a new
      // track and the old position is meaningless.
      if (meta.trackId !== this.meta?.trackId) {
        this.anchor = this.raw = undefined;
        this.restartEstimation();
      }
      this.meta = meta;
    }
    const status = mapStatus(p.PlaybackStatus);
    if (status && status !== this.status) {
      // Freeze (pause) or restart (resume) the extrapolation at the moment of the transition.
      if (this.anchor) this.anchor = { pos: this.positionAt(at), at };
      this.status = status;
      this.restartEstimation();
    }
    const pos = usToMs(p.Position);
    if (pos !== undefined) {
      this.anchor = this.raw = { pos, at };
      this.baseline ??= this.anchor;
    }
    this.updateGrace();
  }

  private isTransitional(): boolean {
    const m = this.meta;
    return !m || !m.title || m.trackId === NO_TRACK || this.status === undefined || this.status === 'stopped';
  }

  private updateGrace(): void {
    if (!this.isTransitional()) {
      this.clearGrace();
      this.graceExpired = false;
    } else if (this.graceTimer === undefined && !this.graceExpired) {
      this.graceTimer = this.clock.setTimeout(() => {
        this.graceTimer = undefined;
        this.graceExpired = true;
        this.settle();
      }, this.cfg.graceMs);
    }
  }

  private changed(): void {
    const now = this.clock.now();
    if (this.debounceTimer === undefined) this.burstStart = now;
    else this.clock.clearTimeout(this.debounceTimer);
    const wait = Math.min(this.cfg.debounceMs, Math.max(0, this.burstStart + this.cfg.maxWaitMs - now));
    this.debounceTimer = this.clock.setTimeout(() => this.flush(), wait);
  }

  private flush(): void {
    this.debounceTimer = undefined;
    if (!this.refresh) return this.settle();
    const epoch = this.epoch;
    this.refreshing = true;
    this.refresh()
      .catch((err: unknown) => {
        log.warn(`property refresh failed: ${errorMessage(err)}`);
        return undefined;
      })
      .then((props) => {
        if (epoch !== this.epoch) return;
        this.refreshing = false;
        // Newer changes arrived meanwhile; their own flush re-reads.
        if (this.debounceTimer !== undefined) return;
        if (props) this.apply(props, this.clock.now());
        this.settle();
      });
  }

  private settle(): void {
    if (this.disposed) return;
    if (!this.isTransitional()) this.emit(this.build(this.status ?? 'stopped'));
    else if (this.graceExpired) this.emit(this.build('stopped'));
  }

  private emit(snap: PlayerSnapshot): void {
    const key = JSON.stringify([snap.status, snap.trackKey, snap.title, snap.artists, snap.album, snap.durationMs, snap.rate]);
    if (!this.forced && this.last && key === this.lastKey) return;
    this.forced = false;
    this.last = snap;
    this.lastKey = key;
    this.onSnapshot(snap);
  }

  private build(status: PlaybackStatus): PlayerSnapshot {
    const at = this.clock.now();
    const m = this.meta ?? EMPTY;
    let pos = this.positionAt(at);
    if (m.durationMs !== undefined) pos = Math.min(pos, m.durationMs);
    const snap: PlayerSnapshot = {
      source: 'mpris',
      at,
      status,
      title: m.title,
      artists: [...m.artists],
      positionMs: Math.round(pos),
      rate: this.rate,
      trackKey: trackKeyOf(m),
    };
    if (m.album !== undefined) snap.album = m.album;
    if (m.durationMs !== undefined) snap.durationMs = m.durationMs;
    return snap;
  }

  private positionAt(at: number): number {
    const a = this.anchor;
    if (!a) return 0;
    return this.status === 'playing' ? a.pos + Math.max(0, at - a.at) * this.rate : a.pos;
  }

  private restartEstimation(from?: Reading): void {
    this.candidate = undefined;
    this.baseline = from;
  }

  private clearGrace(): void {
    if (this.graceTimer !== undefined) this.clock.clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
  }

  private reset(): void {
    this.epoch++;
    if (this.debounceTimer !== undefined) this.clock.clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    this.clearGrace();
    this.graceExpired = false;
    this.refreshing = false;
    this.forced = false;
    this.meta = undefined;
    this.status = undefined;
    this.anchor = this.raw = undefined;
    this.rate = 1;
    this.restartEstimation();
  }
}
