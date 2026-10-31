// Wiring shared by src/main.ts and scripts/dump.ts: source → engine, plus one catalog lookup per
// track whose result goes to the engine; a lookup superseded by a newer track is aborted.
import { logger } from './log.ts';
import type { Config, Enricher, PlayerSnapshot, PlayerSource, PresenceSink, TrackInfo } from './model.ts';
import { PresenceEngine, type EngineOptions } from './presence/engine.ts';

const log = logger('app');

/**
 * How long a new track's first card waits for the lookup (Yandex answers in ~0.4 s, the iTunes cover
 * fallback adds ~0.5 s). Past it the card goes out with the logo and the cover follows when found.
 */
export const INFO_WAIT_MS = 1500;

/**
 * A track whose lookup found nothing is looked up once more after this long (the enricher's network-error
 * backoff). Failures are not cached, so this retries them; a real miss is cached and costs nothing.
 */
export const LOOKUP_RETRY_MS = 60_000;

/** Sinks with a connection to manage (DiscordIpc); the console sink has none. */
export type ManagedSink = PresenceSink & { start?(): void; stop?(): Promise<void> };

export interface AppParts {
  cfg: Config;
  source: PlayerSource;
  enricher: Enricher;
  sink: ManagedSink;
  /** Engine tuning; its scheduler also runs the lookup retry. */
  engine?: EngineOptions;
  /** Observers for scripts/dump.ts. */
  onSnapshot?: (snapshot: PlayerSnapshot | null) => void;
  onTrackInfo?: (snapshot: PlayerSnapshot, info: TrackInfo | null) => void;
}

export const describeTrack = (s: PlayerSnapshot): string => `${s.title || '?'} — ${s.artists.join(', ') || '?'}`;

export function describeInfo(info: TrackInfo | null): string {
  if (!info) return 'no catalog match, using the logo';
  const what = info.trackId ? `track ${info.trackId}, album ${info.albumId ?? '?'}` : 'cover only';
  return `found via ${info.provider}: ${what}${info.coverUrl ? '' : ', no cover'}`;
}

export class App {
  readonly engine: PresenceEngine;
  private readonly source: PlayerSource;
  private readonly enricher: Enricher;
  private readonly sink: ManagedSink;
  private readonly onSnapshotHook: AppParts['onSnapshot'];
  private readonly onTrackInfoHook: AppParts['onTrackInfo'];

  /** trackKey of the last lookup that was started; cleared when the player goes away or stops. */
  private lookupKey: string | undefined;
  private lookup: AbortController | undefined;
  private retryTimer: unknown;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private status: PlayerSnapshot['status'] | undefined;
  private present = false;
  private stopping: Promise<void> | undefined;

  constructor(parts: AppParts) {
    this.source = parts.source;
    this.enricher = parts.enricher;
    this.sink = parts.sink;
    this.onSnapshotHook = parts.onSnapshot;
    this.onTrackInfoHook = parts.onTrackInfo;
    this.engine = new PresenceEngine(parts.sink, parts.cfg, { infoWaitMs: INFO_WAIT_MS, ...parts.engine });
    this.setTimer = parts.engine?.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = parts.engine?.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Rejects only when the source cannot start at all (e.g. no D-Bus session bus). */
  async start(): Promise<void> {
    this.sink.start?.();
    await this.source.start((s) => this.onSnapshot(s));
  }

  /** Stops the source, clears the presence, then closes the sink. Safe to call more than once. */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.lookup?.abort();
      this.lookup = undefined;
      this.cancelRetry();
      try {
        await this.source.stop();
      } catch (err) {
        log.warn('stopping the player source failed', err);
      }
      await this.engine.stop();
      try {
        await this.sink.stop?.();
      } catch (err) {
        log.warn('stopping the sink failed', err);
      }
    })();
    return this.stopping;
  }

  private onSnapshot(s: PlayerSnapshot | null): void {
    if (this.stopping) return;
    this.onSnapshotHook?.(s);
    if (!s) {
      if (this.present) log.info('player lost, clearing presence');
      this.present = false;
      this.status = undefined;
      this.forgetLookup();
      this.engine.update(null);
      return;
    }
    if (!this.present) log.info('player found');
    this.present = true;
    this.engine.update(s);

    // 'stopped' carries no usable track (possibly an empty title); the engine just clears.
    const newTrack = s.status !== 'stopped' && s.trackKey !== this.lookupKey;
    if (newTrack) log.info(`${s.status}: ${describeTrack(s)}`);
    else if (s.status !== this.status) log.info(s.status === 'stopped' ? 'playback stopped' : s.status);
    this.status = s.status;
    if (s.status === 'stopped') this.forgetLookup();
    if (newTrack) this.startLookup(s);
  }

  /** The track coming back looks it up again (a cache hit, or another try after a failure). */
  private forgetLookup(): void {
    this.lookupKey = undefined;
    this.cancelRetry();
  }

  private startLookup(s: PlayerSnapshot, retry = false): void {
    this.lookup?.abort();
    this.cancelRetry();
    const ctl = new AbortController();
    this.lookup = ctl;
    this.lookupKey = s.trackKey;
    // Enricher.lookup never throws and resolves null at once when aborted.
    void this.enricher.lookup(s, ctl.signal).then((info) => {
      if (ctl.signal.aborted) return;
      this.lookup = undefined;
      log.info(describeInfo(info));
      this.onTrackInfoHook?.(s, info);
      this.engine.setTrackInfo(s.trackKey, info);
      if (info || retry || this.stopping || this.lookupKey !== s.trackKey) return;
      this.retryTimer = this.setTimer(() => {
        this.retryTimer = undefined;
        if (this.lookupKey === s.trackKey && !this.lookup) this.startLookup(s, true);
      }, LOOKUP_RETRY_MS);
    });
  }

  private cancelRetry(): void {
    if (this.retryTimer === undefined) return;
    this.clearTimer(this.retryTimer);
    this.retryTimer = undefined;
  }
}
