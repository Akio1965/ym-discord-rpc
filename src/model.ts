// Shared contracts between sources, enrichment, presence and Discord layers.
// docs/ARCHITECTURE.md describes how they flow through the daemon.

export type PlaybackStatus = 'playing' | 'paused' | 'stopped';

/** Normalized player state read from an OS media API (MPRIS now, SMTC later). */
export interface PlayerSnapshot {
  source: 'mpris' | 'smtc';
  /** Date.now() at the moment positionMs was read. */
  at: number;
  /** 'stopped' is final (sources wait out their grace first) and may carry an empty title: consumers clear. */
  status: PlaybackStatus;
  title: string;
  /** Individual artist names. YM publishes one "A, B" string; sources split it. */
  artists: string[];
  album?: string;
  /** Undefined for streams without a known length (e.g. generative "My Wave" sets). */
  durationMs?: number;
  positionMs: number;
  /** Estimated playback rate. YM never reports it via MPRIS (always 1), so it is derived from Δpos/Δt. */
  rate: number;
  /**
   * Stable identity of the current track within this source (changes on every track switch).
   * MPRIS: content-based `${title}|${artists}|${round(durationS)}`, because Chromium's mpris:trackid is a
   * per-media-session id that survives track switches. Repeat-one keeps the key (the restart is a seek).
   */
  trackKey: string;
}

/** Catalog data found for a snapshot (cover, ids, links). */
export interface TrackInfo {
  provider: 'yandex' | 'itunes';
  trackId?: string;
  albumId?: string;
  artists?: { id?: string; name: string }[];
  title?: string;
  /** Yandex "version" field, e.g. "Remix", shown as "Title (Remix)". */
  version?: string;
  album?: string;
  /** https URL, at least 400x400 (Yandex 400x400, iTunes 600x600). */
  coverUrl?: string;
  durationMs?: number;
}

/** Yields snapshots; null means the player disappeared (app closed / no session). */
export interface PlayerSource {
  start(onUpdate: (snapshot: PlayerSnapshot | null) => void): Promise<void>;
  stop(): Promise<void>;
}

export interface Enricher {
  /**
   * Resolves catalog info; null when nothing trustworthy was found. Enrichers handed to the app
   * (CachingEnricher) never throw; individual catalog providers may throw so the chain can back off.
   */
  lookup(snapshot: PlayerSnapshot, signal?: AbortSignal): Promise<TrackInfo | null>;
}

// Discord activity payload (local RPC SET_ACTIVITY). The limits below are the ones the desktop
// client validates the command against; one invalid field rejects the whole command.

export const ActivityType = { Playing: 0, Listening: 2, Watching: 3, Competing: 5 } as const;
export const StatusDisplayType = { Name: 0, State: 1, Details: 2 } as const;

export interface ActivityButton {
  /** 1..32 chars */
  label: string;
  /** URI, 1..512 chars */
  url: string;
}

export interface Activity {
  type: number;
  /** 1..128 */
  name?: string;
  status_display_type?: number;
  /** 2..128 */
  details?: string;
  /** URI, ≤256 */
  details_url?: string;
  /** 2..128 */
  state?: string;
  /** URI, ≤256 */
  state_url?: string;
  /** Integer epoch ms, ≥1. start+end on a Listening activity renders a progress bar. */
  timestamps?: { start?: number; end?: number };
  assets?: {
    /** asset key or https URL, 1..300 */
    large_image?: string;
    /** 2..128 */
    large_text?: string;
    large_url?: string;
    small_image?: string;
    small_text?: string;
    small_url?: string;
  };
  /** 1..2 items; omit the field instead of sending [] */
  buttons?: ActivityButton[];
  instance?: boolean;
}

/** Transport to Discord. setActivity(null) clears the presence. Rejects with DiscordRpcError on an ERROR reply. */
export interface PresenceSink {
  setActivity(activity: Activity | null): Promise<void>;
}

/** ERROR response to a command (e.g. code 1000 when Discord cannot resolve an external large_image URL). */
export class DiscordRpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(`Discord RPC error ${code}: ${message}`);
    this.name = 'DiscordRpcError';
    this.code = code;
  }
}

export interface Config {
  /** Discord Application ID; empty → dry run only. */
  clientId: string;
  /** Overrides the app name shown as "Listening to <name>". */
  name: string;
  statusDisplayType: number;
  /** Which buttons to add: 'web' = music.yandex.ru track page. */
  buttons: Array<'web'>;
  /** Clear the presence after this many minutes on pause. 0 = clear immediately. */
  afkMinutes: number;
  search: { yandex: boolean; itunes: boolean };
  /** Print activities instead of sending them to Discord. */
  dryRun: boolean;
  /** Fallback asset keys uploaded in the Discord developer portal (Rich Presence → Art Assets). */
  assets: { logo: string; paused: string };
}
