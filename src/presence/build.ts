// Snapshot + catalog info → Discord activity. Pure. Discord's SET_ACTIVITY validation: details/state
// 2..128 chars, details_url/state_url/large_url ≤256, large_image ≤300, buttons 1..2 (label ≤32, url ≤512).
// Card layout: docs/ARCHITECTURE.md.
import { ActivityType, StatusDisplayType, type Activity, type ActivityButton, type Config, type PlayerSnapshot, type TrackInfo } from '../model.ts';

const WEB = 'https://music.yandex.ru';
const FILLER = '\u2800'; // Braille blank: survives Discord's trim, unlike a space
export const PAUSED_TEXT = 'На паузе';
export const WEB_BUTTON_LABEL = 'Слушать в Яндекс Музыке';
const MAX_URL = 256;
const MAX_BUTTON_URL = 512;
const MAX_IMAGE = 300;
const MAX_BUTTONS = 2;
const DISPLAY_TYPES: readonly number[] = Object.values(StatusDisplayType);

/** Trims and clamps to [min, max] UTF-16 units; empty → undefined. */
export function fit(s: string | undefined, min = 2, max = 128): string | undefined {
  let t = s?.trim();
  if (!t) return undefined;
  if (t.length > max) {
    let cut = max - 1;
    const c = t.charCodeAt(cut - 1);
    if (c >= 0xd800 && c <= 0xdbff) cut--; // don't leave a lone high surrogate
    t = t.slice(0, cut) + '…';
  }
  while (t.length < min) t += FILLER;
  return t;
}

const id = (v: string) => encodeURIComponent(v);
export const trackUrl = (albumId: string, trackId: string) => `${WEB}/album/${id(albumId)}/track/${id(trackId)}`;
export const artistUrl = (artistId: string) => `${WEB}/artist/${id(artistId)}`;
export const albumUrl = (albumId: string) => `${WEB}/album/${id(albumId)}`;
export const searchUrl = (text: string) => `${WEB}/search?text=${encodeURIComponent(text)}`;

// Over-long URLs are dropped, never cut: a truncated URL fails Discord's URI check and sinks the whole command.
const limitUrl = (url: string | undefined, max = MAX_URL) => (url && url.length <= max ? url : undefined);
const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Drops undefined fields so payloads compare and serialize cleanly. */
function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}
const nonEmpty = <T extends object>(o: T) => (Object.keys(o).length ? o : undefined);

/** Absolute start/end so every viewer's client animates the bar itself. */
export function timestampsFor(s: PlayerSnapshot, at: number): Activity['timestamps'] {
  const rate = Number.isFinite(s.rate) && s.rate > 0 ? s.rate : 1;
  const start = Math.round(at - Math.max(0, s.positionMs) / rate);
  const ts: { start: number; end?: number } = { start };
  if (s.durationMs !== undefined && s.durationMs > 0) ts.end = start + Math.round(s.durationMs / rate);
  return Object.values(ts).every((v) => Number.isFinite(v) && v >= 1) ? ts : undefined;
}

export function buildActivity(s: PlayerSnapshot, info: TrackInfo | null, cfg: Config, now: number): Activity | null {
  if (s.status === 'stopped') return null;
  const ym = info?.provider === 'yandex' ? info : undefined;
  const title = s.title.trim();
  const artists = s.artists.map((a) => a.trim()).filter(Boolean);
  const version = ym?.version?.trim();
  // MPRIS title never carries the version, but don't double it if a source ever does.
  const fullTitle = version && !norm(title).endsWith(norm(`(${version})`)) ? `${title} (${version})` : title;
  const album = s.album?.trim() || info?.album?.trim();
  const link = ym?.albumId && ym.trackId ? trackUrl(ym.albumId, ym.trackId) : undefined;
  const artistId = ym?.artists?.[0]?.id;
  const paused = s.status === 'paused';

  const buttons: ActivityButton[] = [];
  // The config is not validated: a repeated entry must not push the payload past Discord's 2-button limit.
  for (const b of new Set(cfg.buttons)) {
    if (b !== 'web' || buttons.length === MAX_BUTTONS) continue;
    const query = [artists.join(' '), title].filter(Boolean).join(' ');
    const url = limitUrl(link ?? (query ? searchUrl(query) : undefined), MAX_BUTTON_URL);
    if (url) buttons.push({ label: WEB_BUTTON_LABEL, url });
  }

  return compact<Activity>({
    type: ActivityType.Listening,
    name: fit(cfg.name, 1),
    status_display_type: DISPLAY_TYPES.includes(cfg.statusDisplayType) ? cfg.statusDisplayType : undefined,
    details: fit(fullTitle),
    details_url: limitUrl(link),
    state: fit(artists.join(', ')),
    state_url: limitUrl(artistId ? artistUrl(artistId) : undefined),
    // An unstamped snapshot (at ≤ 0) is anchored to now rather than dropped.
    timestamps: paused ? undefined : timestampsFor(s, Number.isFinite(s.at) && s.at > 0 ? s.at : now),
    assets: nonEmpty(compact({
      large_image: limitUrl(info?.coverUrl, MAX_IMAGE) ?? (cfg.assets.logo || undefined),
      large_text: album && norm(album) !== norm(title) ? fit(album) : undefined,
      large_url: limitUrl(ym?.albumId ? albumUrl(ym.albumId) : undefined),
      small_image: paused ? cfg.assets.paused || undefined : undefined,
      small_text: paused ? PAUSED_TEXT : undefined,
    })),
    buttons: buttons.length ? buttons : undefined,
    instance: false,
  });
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
}

/** Stable identity of an activity ignoring timestamps (dedupe key). */
export function activityKey(activity: Activity): string {
  const { timestamps: _, ...rest } = activity;
  return JSON.stringify(sortKeys(rest));
}
