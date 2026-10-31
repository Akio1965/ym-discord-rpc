// Decides WHEN to send: track debounce, AFK on pause, dedupe, throttle,
// serialized sends and one retry without the cover when Discord rejects it.
import { DiscordRpcError, type Activity, type Config, type PlayerSnapshot, type PresenceSink, type TrackInfo } from '../model.ts';
import { logger } from '../log.ts';
import { activityKey, buildActivity } from './build.ts';

const log = logger('presence');

export interface EngineOptions {
  /** Wall clock for the epoch timestamps sent to Discord. */
  now?: () => number;
  /** Clock for throttle/debounce intervals; must share a timeline with setTimeout. A wall-clock step must not stretch them. */
  monotonic?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Min gap between sends (Discord allows 5 presence updates per 20 s). */
  minIntervalMs?: number;
  /** MPRIS delivers a new track's fields one by one; wait for them to settle. */
  trackDebounceMs?: number;
  /**
   * After the debounce, keep waiting for setTrackInfo() until this long after the track change, so the
   * first card already has the cover instead of logo-then-cover (two updates). 0 = don't wait.
   */
  infoWaitMs?: number;
}

/** Timestamps within this distance count as the same (seek/drift threshold). */
const DRIFT_MS = 2000;
/** setTimeout fires longer delays after 1 ms; ~24.8 days is "never" for a paused card. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const near = (a: number | undefined, b: number | undefined) =>
  a === undefined || b === undefined ? a === b : Math.abs(a - b) <= DRIFT_MS;

function same(a: Activity | null, b: Activity | null): boolean {
  if (a === null || b === null) return a === b;
  return activityKey(a) === activityKey(b) && near(a.timestamps?.start, b.timestamps?.start) && near(a.timestamps?.end, b.timestamps?.end);
}

export class PresenceEngine {
  private readonly sink: PresenceSink;
  private readonly cfg: Config;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly minIntervalMs: number;
  private readonly trackDebounceMs: number;
  private readonly infoWaitMs: number;

  private snapshot: PlayerSnapshot | null = null;
  private trackKey: string | undefined;
  private info: TrackInfo | null = null;
  /** setTrackInfo() was called for the current trackKey. */
  private infoSettled = false;
  private readonly badCovers = new Set<string>();

  private debounceTimer: unknown;
  /** End of the pending debounce's settle window; past it the debounce only waits for info. */
  private debounceUntil = 0;
  private afkTimer: unknown;
  private afkExpired = false;
  private throttleTimer: unknown;

  /** Latest desired state not yet handed to the sink; undefined = nothing pending. */
  private pending: Activity | null | undefined;
  /** Last state handed to the sink (null = nothing shown). Dedupe compares against it. */
  private last: Activity | null = null;
  private lastSendAt = -Infinity;
  private inFlight: Promise<void> | undefined;
  private bypassThrottle = false;
  private stopped = false;

  constructor(sink: PresenceSink, cfg: Config, opts: EngineOptions = {}) {
    this.sink = sink;
    this.cfg = cfg;
    this.now = opts.now ?? Date.now;
    this.monotonic = opts.monotonic ?? (() => performance.now());
    this.setTimer = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.minIntervalMs = opts.minIntervalMs ?? 4000;
    this.trackDebounceMs = opts.trackDebounceMs ?? 400;
    this.infoWaitMs = opts.infoWaitMs ?? 0;
  }

  update(snapshot: PlayerSnapshot | null): void {
    if (this.stopped) return;
    this.snapshot = snapshot;
    if (!snapshot || snapshot.status === 'stopped') {
      // Sources already waited out their grace period, so this is final.
      this.cancel('debounceTimer');
      this.refresh();
      return;
    }
    if (snapshot.trackKey !== this.trackKey) {
      this.trackKey = snapshot.trackKey;
      // A throttled or queued card of the previous track must not go out during the new track's debounce.
      this.pending = undefined;
      this.info = null;
      this.infoSettled = false;
      this.resetAfk();
      this.startDebounce();
      return;
    }
    if (this.debounceTimer === undefined) this.refresh();
  }

  setTrackInfo(trackKey: string, info: TrackInfo | null): void {
    if (this.stopped) return;
    if (trackKey !== this.trackKey) {
      log.debug('ignoring info for a stale track', { trackKey });
      return;
    }
    this.info = info;
    this.infoSettled = true;
    if (this.debounceTimer !== undefined && this.monotonic() >= this.debounceUntil) this.cancel('debounceTimer');
    if (this.debounceTimer === undefined) this.refresh();
  }

  /** The sink failed to deliver `activity` on its own, e.g. DiscordIpc's automatic re-send after a reconnect. */
  sinkFailed(activity: Activity, err: unknown): void {
    if (this.stopped) return;
    const cover = activity.assets?.large_image;
    // A cover rejected earlier still means the fallback must go out: the re-send ran on a fresh connection.
    if (!this.rejectCover(activity, err) && !(err instanceof DiscordRpcError && cover && this.badCovers.has(cover))) return;
    this.last = null; // Discord shows nothing now, so even a fallback equal to the last send is not a repeat
    this.bypassThrottle = true;
    if (this.debounceTimer === undefined) this.refresh();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of ['debounceTimer', 'afkTimer', 'throttleTimer'] as const) this.cancel(t);
    this.pending = undefined;
    await this.inFlight;
    try {
      await this.sink.setActivity(null);
    } catch (err) {
      log.warn('failed to clear presence on stop', err);
    }
    this.last = null;
  }

  private cancel(timer: 'debounceTimer' | 'afkTimer' | 'throttleTimer'): void {
    if (this[timer] === undefined) return;
    this.clearTimer(this[timer]);
    this[timer] = undefined;
  }

  /** New track: wait trackDebounceMs for MPRIS fields to settle, then up to infoWaitMs in total for the lookup. */
  private startDebounce(): void {
    this.cancel('debounceTimer');
    const started = this.monotonic();
    this.debounceUntil = started + this.trackDebounceMs;
    const fire = () => {
      this.debounceTimer = undefined;
      const left = started + this.infoWaitMs - this.monotonic();
      if (!this.infoSettled && left > 0) {
        this.debounceTimer = this.setTimer(fire, left);
        return;
      }
      this.refresh();
    };
    this.debounceTimer = this.setTimer(fire, this.trackDebounceMs);
  }

  private resetAfk(): void {
    this.cancel('afkTimer');
    this.afkExpired = false;
  }

  /** Recomputes the desired state from the current snapshot and info, then tries to send it. */
  private refresh(): void {
    this.pending = this.desired();
    this.pump();
  }

  private desired(): Activity | null {
    const s = this.snapshot;
    if (!s || s.status === 'stopped') {
      this.resetAfk();
      return null;
    }
    if (s.status === 'playing') {
      this.resetAfk();
    } else {
      if (!(this.cfg.afkMinutes > 0) || this.afkExpired) return null;
      this.afkTimer ??= this.setTimer(() => {
        this.afkTimer = undefined;
        this.afkExpired = true;
        log.info(`paused for ${this.cfg.afkMinutes} min, clearing presence`);
        this.refresh();
      }, Math.min(this.cfg.afkMinutes * 60_000, MAX_TIMER_MS));
    }
    let info = this.info;
    if (info?.coverUrl && this.badCovers.has(info.coverUrl)) info = { ...info, coverUrl: undefined };
    const activity = buildActivity(s, info, this.cfg, this.now());
    // The logo itself may be an external URL (e.g. an app emoji); if Discord rejected it too, go imageless.
    if (activity?.assets?.large_image && this.badCovers.has(activity.assets.large_image)) delete activity.assets.large_image;
    return activity;
  }

  /**
   * Sends the pending state if allowed: one send at a time, leading+trailing throttle, dedupe.
   * Only the newest state is ever pending and a finished send just records what Discord shows,
   * so an older result can never override a newer state.
   */
  private pump(): void {
    if (this.stopped || this.inFlight || this.pending === undefined) return;
    const bypass = this.bypassThrottle;
    this.bypassThrottle = false;
    if (same(this.pending, this.last)) {
      this.pending = undefined;
      return;
    }
    const wait = this.lastSendAt + this.minIntervalMs - this.monotonic();
    if (wait > 0 && !bypass) {
      this.throttleTimer ??= this.setTimer(() => {
        this.throttleTimer = undefined;
        this.pump();
      }, wait);
      return;
    }
    this.cancel('throttleTimer');
    const activity = this.pending;
    this.pending = undefined;
    this.lastSendAt = this.monotonic();
    this.inFlight = this.send(activity).finally(() => {
      this.inFlight = undefined;
      this.pump();
    });
  }

  private async send(activity: Activity | null): Promise<void> {
    try {
      await this.sink.setActivity(activity);
      this.last = activity;
      log.debug(activity ? `presence set: ${activity.details} — ${activity.state}${activity.timestamps ? '' : ' (paused)'}` : 'presence cleared');
    } catch (err) {
      if (this.rejectCover(activity, err)) {
        if (!this.stopped) {
          // Rebuild the latest state (the bad cover now maps to the logo) and send it right after this one;
          // the rejected command changed nothing in Discord, so it doesn't use up a throttle slot.
          if (this.debounceTimer === undefined) this.refresh();
          this.bypassThrottle = true;
        }
        return;
      }
      if (err instanceof DiscordRpcError) log.error('Discord rejected activity', { message: err.message, activity });
      else log.warn('setActivity failed', err);
      // The sink re-sends its last activity after reconnecting; don't spin on the same state.
      this.last = activity;
    }
  }

  /** Discord could not resolve the external image and rejected the whole command. True once per URL. */
  private rejectCover(activity: Activity | null, err: unknown): boolean {
    const cover = activity?.assets?.large_image;
    if (!(err instanceof DiscordRpcError) || !cover?.startsWith('https://') || this.badCovers.has(cover)) return false;
    this.badCovers.add(cover);
    log.warn(`Discord rejected cover ${cover}, retrying with the logo`, err.message);
    return true;
  }
}
