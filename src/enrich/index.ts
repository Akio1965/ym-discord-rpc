// Provider chain with LRU cache, single-flight and per-provider backoff.
import type { Config, Enricher, PlayerSnapshot, TrackInfo } from '../model.ts';
import { logger } from '../log.ts';
import { ProviderUnavailableError, type HttpOptions } from './http.ts';
import { ItunesSearch } from './itunes.ts';
import { YandexSearch } from './yandex.ts';

export { ProviderUnavailableError, type HttpOptions } from './http.ts';
export { ItunesSearch } from './itunes.ts';
export { YandexSearch } from './yandex.ts';

const log = logger('enrich');

/** A catalog provider; lookup may throw (ProviderUnavailableError, abort). */
export interface Provider extends Enricher {
  readonly name: string;
}

export interface CachingEnricherOptions {
  /** Clock for TTLs and backoff; monotonic so a wall-clock step cannot stretch them. */
  now?: () => number;
  maxEntries?: number;
  hitTtlMs?: number;
  missTtlMs?: number;
  /** Skip a provider this long after ProviderUnavailableError (unless the error suggests its own backoff). */
  backoffMs?: number;
}

interface Outcome {
  info: TrackInfo | null;
  /** Every provider answered: no backoff skips, no errors. Only complete answers earn the long TTLs. */
  complete: boolean;
  aborted: boolean;
}

interface Flight {
  promise: Promise<Outcome>;
  controller: AbortController;
  waiters: number;
}

/** The first hit supplies ids and links; later providers only fill in a missing cover. */
const withCover = (primary: TrackInfo, extra: TrackInfo): TrackInfo =>
  primary.coverUrl || !extra.coverUrl ? primary : { ...primary, coverUrl: extra.coverUrl };

export const cacheKey = (s: PlayerSnapshot): string => [s.trackKey, s.title, s.artists.join('\u0001')].join('\u0000');

export class CachingEnricher implements Enricher {
  #providers: Provider[];
  #now: () => number;
  #maxEntries: number;
  #hitTtl: number;
  #missTtl: number;
  #backoff: number;
  #cache = new Map<string, { info: TrackInfo | null; expires: number }>();
  #inflight = new Map<string, Flight>();
  #skipUntil = new Map<string, number>();

  constructor(providers: Provider[], opts: CachingEnricherOptions = {}) {
    this.#providers = providers;
    this.#now = opts.now ?? (() => performance.now());
    this.#maxEntries = opts.maxEntries ?? 128;
    this.#hitTtl = opts.hitTtlMs ?? 6 * 3600_000;
    this.#missTtl = opts.missTtlMs ?? 30 * 60_000;
    this.#backoff = opts.backoffMs ?? 10 * 60_000;
  }

  async lookup(snapshot: PlayerSnapshot, signal?: AbortSignal): Promise<TrackInfo | null> {
    try {
      if (signal?.aborted || !snapshot.title.trim() || snapshot.artists.length === 0) return null;
      const key = cacheKey(snapshot);
      const hit = this.#cacheGet(key);
      if (hit !== undefined) return hit;
      const flight = this.#inflight.get(key) ?? this.#start(key, snapshot);
      return await this.#await(key, flight, signal);
    } catch (err) {
      log.warn('lookup failed', err);
      return null;
    }
  }

  #start(key: string, snapshot: PlayerSnapshot): Flight {
    const controller = new AbortController();
    const promise = this.#resolve(snapshot, controller.signal)
      .then((outcome) => {
        if (!outcome.aborted) this.#store(key, outcome);
        return outcome;
      })
      .catch((err): Outcome => {
        log.warn('lookup failed', err);
        return { info: null, complete: false, aborted: false };
      })
      .finally(() => {
        if (this.#inflight.get(key) === flight) this.#inflight.delete(key);
      });
    const flight: Flight = { promise, controller, waiters: 0 };
    this.#inflight.set(key, flight);
    return flight;
  }

  /** Waits for a shared flight; an aborting caller leaves at once, and the request is cancelled when nobody waits. */
  #await(key: string, flight: Flight, signal: AbortSignal | undefined): Promise<TrackInfo | null> {
    flight.waiters++;
    return new Promise((resolve) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        if (--flight.waiters === 0) {
          flight.controller.abort();
          if (this.#inflight.get(key) === flight) this.#inflight.delete(key);
        }
        resolve(null);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      void flight.promise.then((outcome) => {
        signal?.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        flight.waiters--;
        resolve(outcome.info);
      });
    });
  }

  async #resolve(snapshot: PlayerSnapshot, signal: AbortSignal): Promise<Outcome> {
    const aborted: Outcome = { info: null, complete: false, aborted: true };
    let info: TrackInfo | null = null;
    let complete = true;
    for (const p of this.#providers) {
      if (info?.coverUrl) break;
      const until = this.#skipUntil.get(p.name);
      if (until !== undefined && until > this.#now()) {
        complete = false;
        continue;
      }
      try {
        const found = await p.lookup(snapshot, signal);
        if (signal.aborted) return aborted;
        if (!found) continue;
        info = info ? withCover(info, found) : found;
      } catch (err) {
        if (signal.aborted) return aborted;
        complete = false;
        if (err instanceof ProviderUnavailableError) {
          const ms = err.backoffMs ?? this.#backoff;
          this.#skipUntil.set(p.name, this.#now() + ms);
          log.warn(`${err.message}; skipping ${p.name} for ${Math.round(ms / 1000)} s`);
        } else {
          log.warn(`${p.name} lookup failed`, err);
        }
      }
    }
    log.debug(info ? `found via ${info.provider}` : 'no match', { title: snapshot.title, artists: snapshot.artists, info });
    return { info, complete, aborted: false };
  }

  #cacheGet(key: string): TrackInfo | null | undefined {
    const entry = this.#cache.get(key);
    if (!entry) return undefined;
    this.#cache.delete(key);
    if (entry.expires <= this.#now()) return undefined;
    this.#cache.set(key, entry); // refresh LRU position
    return entry.info;
  }

  #store(key: string, { info, complete }: Outcome): void {
    // Errors are not cached; a partial hit (some provider skipped) is kept only briefly.
    const ttl = complete ? (info ? this.#hitTtl : this.#missTtl) : info ? this.#missTtl : 0;
    if (ttl <= 0) return;
    this.#cache.delete(key);
    this.#cache.set(key, { info, expires: this.#now() + ttl });
    for (const oldest of this.#cache.keys()) {
      if (this.#cache.size <= this.#maxEntries) break;
      this.#cache.delete(oldest);
    }
  }
}

/** Chain from config: Yandex first (ids, links, cover), iTunes as cover fallback. */
export function createEnricher(search: Config['search'], opts: CachingEnricherOptions & { http?: HttpOptions } = {}): CachingEnricher {
  const providers: Provider[] = [];
  if (search.yandex) providers.push(new YandexSearch(opts.http));
  if (search.itunes) providers.push(new ItunesSearch(opts.http));
  return new CachingEnricher(providers, opts);
}
