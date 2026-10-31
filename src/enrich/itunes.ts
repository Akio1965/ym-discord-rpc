// iTunes Search as a cover-only fallback. Never yields ids or links: those must point to Yandex.
import type { Enricher, PlayerSnapshot, TrackInfo } from '../model.ts';
import { asArray, asNumber, asObject, asString, compact, getJson, type HttpOptions } from './http.ts';
import { pickBest, searchText, type Candidate } from './matcher.ts';

const ENDPOINT = 'https://itunes.apple.com/search';

export interface ItunesCandidate extends Candidate {
  coverUrl?: string;
}

/** artworkUrl100 → 600x600 variant on Apple's image CDN; anything else → undefined. */
export function itunesCoverUrl(artworkUrl100: unknown): string | undefined {
  const raw = asString(artworkUrl100);
  if (!raw) return undefined;
  const href = raw.replace('100x100bb', '600x600bb');
  try {
    const u = new URL(href);
    return u.protocol === 'https:' && /(?:^|\.)mzstatic\.com$/.test(u.hostname) ? href : undefined;
  } catch {
    return undefined;
  }
}

export function parseItunesSearch(body: unknown): ItunesCandidate[] {
  const out: ItunesCandidate[] = [];
  for (const item of asArray(asObject(body)?.results)) {
    const r = asObject(item);
    const title = asString(r?.trackName);
    const artist = asString(r?.artistName);
    if (!r || !title || !artist || (r.kind !== undefined && r.kind !== 'song')) continue;
    const coverUrl = itunesCoverUrl(r.artworkUrl100);
    out.push(compact({
      title,
      artists: [artist],
      album: asString(r.collectionName),
      durationMs: asNumber(r.trackTimeMillis),
      coverUrl,
      hasCover: coverUrl !== undefined,
      available: true,
    }));
  }
  return out;
}

/** Same throwing semantics as YandexSearch. */
export class ItunesSearch implements Enricher {
  readonly name = 'itunes';
  #http: HttpOptions;

  constructor(http: HttpOptions = {}) {
    this.#http = http;
  }

  async lookup(snapshot: PlayerSnapshot, signal?: AbortSignal): Promise<TrackInfo | null> {
    const term = searchText(snapshot);
    if (!term) return null;
    const url = `${ENDPOINT}?term=${encodeURIComponent(term)}&entity=song&limit=10`;
    const body = await getJson(this.name, url, signal, this.#http);
    if (body === null) return null;
    const best = pickBest(snapshot, parseItunesSearch(body));
    if (!best) return null;
    return compact({ provider: 'itunes', coverUrl: best.coverUrl, title: best.title, album: best.album, durationMs: best.durationMs } satisfies TrackInfo);
  }
}
