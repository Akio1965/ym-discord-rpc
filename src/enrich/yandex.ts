// Unauthenticated Yandex Music catalog search: GET api.music.yandex.net/search, no token needed.
// Unofficial API; MarshalX/yandex-music-api is the community documentation of it.
import type { Enricher, PlayerSnapshot, TrackInfo } from '../model.ts';
import { asArray, asId, asNumber, asObject, asString, compact, getJson, type HttpOptions } from './http.ts';
import { pickBest, searchText, type Candidate } from './matcher.ts';

const ENDPOINT = 'https://api.music.yandex.net/search';
const COVER_HOST = /^avatars\.(?:mds\.)?yandex\.net$/;

export interface YandexCandidate extends Candidate {
  id: string;
  albumId?: string;
  artistRefs: { id?: string; name: string }[];
  coverUrl?: string;
}

/** 'avatars.yandex.net/get-music-content/…/%%' → https 400x400 URL; anything else (blob:, foreign hosts) → undefined. */
export function yandexCoverUrl(uri: unknown): string | undefined {
  const raw = asString(uri);
  if (!raw || !raw.includes('%%')) return undefined;
  const href = 'https://' + raw.replace(/^(?:https?:)?\/\//, '').replace('%%', '400x400');
  try {
    return COVER_HOST.test(new URL(href).hostname) ? href : undefined;
  } catch {
    return undefined;
  }
}

export function parseYandexSearch(body: unknown): YandexCandidate[] {
  const results = asArray(asObject(asObject(asObject(body)?.result)?.tracks)?.results);
  const out: YandexCandidate[] = [];
  for (const item of results) {
    const t = asObject(item);
    const id = asId(t?.id);
    const title = asString(t?.title);
    if (!t || !id || !title) continue;
    const artistRefs = asArray(t.artists).flatMap((a) => {
      const name = asString(asObject(a)?.name);
      return name ? [compact({ id: asId(asObject(a)?.id), name })] : [];
    });
    const album = asObject(asArray(t.albums)[0]);
    const coverUrl = yandexCoverUrl(t.coverUri) ?? yandexCoverUrl(t.ogImage) ?? yandexCoverUrl(album?.coverUri);
    out.push(compact({
      id,
      title,
      version: asString(t.version),
      artists: artistRefs.map((a) => a.name),
      artistRefs,
      album: asString(album?.title),
      albumId: asId(album?.id),
      durationMs: asNumber(t.durationMs),
      coverUrl,
      hasCover: coverUrl !== undefined,
      available: t.available === true,
    }));
  }
  return out;
}

export function toTrackInfo(c: YandexCandidate): TrackInfo {
  return compact({
    provider: 'yandex',
    trackId: c.id,
    albumId: c.albumId,
    artists: c.artistRefs,
    title: c.title,
    version: c.version,
    album: c.album,
    coverUrl: c.coverUrl,
    durationMs: c.durationMs,
  } satisfies TrackInfo);
}

/**
 * Catalog provider. Unlike the Enricher contract it may throw: ProviderUnavailableError on 451/403/429/5xx
 * or network failure, and the abort reason when `signal` aborts. CachingEnricher turns those into null.
 */
export class YandexSearch implements Enricher {
  readonly name = 'yandex';
  #http: HttpOptions;

  constructor(http: HttpOptions = {}) {
    this.#http = http;
  }

  async lookup(snapshot: PlayerSnapshot, signal?: AbortSignal): Promise<TrackInfo | null> {
    const text = searchText(snapshot);
    if (!text) return null;
    const url = `${ENDPOINT}?text=${encodeURIComponent(text)}&type=track&page=0&nocorrect=true`;
    const body = await getJson(this.name, url, signal, this.#http);
    if (body === null) return null;
    const best = pickBest(snapshot, parseYandexSearch(body));
    return best && toTrackInfo(best);
  }
}
