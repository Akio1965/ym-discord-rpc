// Shared HTTP plumbing for catalog providers.
import { logger } from '../log.ts';

const log = logger('enrich');

export const USER_AGENT = 'ym-discord-rpc/0.1';
const DEFAULT_TIMEOUT_MS = 5000;
/** Network failures are often transient (boot before network is up), so they back off less than a geo-block. */
const NETWORK_BACKOFF_MS = 60_000;

export interface HttpOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** The provider refused or could not be reached (451 geo-block, 403, 429, 5xx, network); the chain should skip it for a while. */
export class ProviderUnavailableError extends Error {
  provider: string;
  status?: number;
  /** Suggested backoff; undefined → the chain's default. */
  backoffMs?: number;
  constructor(provider: string, message: string, opts: { status?: number; backoffMs?: number; cause?: unknown } = {}) {
    super(`${provider}: ${message}`, { cause: opts.cause });
    this.name = 'ProviderUnavailableError';
    this.provider = provider;
    this.status = opts.status;
    this.backoffMs = opts.backoffMs;
  }
}

const unavailable = (status: number) => status === 451 || status === 403 || status === 429 || status >= 500;

function retryAfterMs(res: Response): number | undefined {
  const secs = Number(res.headers.get('retry-after'));
  return Number.isFinite(secs) && secs > 0 ? Math.min(Math.max(secs * 1000, 60_000), 3_600_000) : undefined;
}

/**
 * GET a JSON document. Returns null for other HTTP errors and unparsable bodies.
 * Throws ProviderUnavailableError (see above) or, when the caller's signal aborts, the abort reason.
 */
export async function getJson(provider: string, url: string, signal: AbortSignal | undefined, opts: HttpOptions = {}): Promise<unknown> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const failed = (err: unknown, what: string): never => {
    if (signal?.aborted) throw signal.reason;
    throw new ProviderUnavailableError(provider, `${what}: ${(err as Error)?.message ?? String(err)}`, { backoffMs: NETWORK_BACKOFF_MS, cause: err });
  };

  let res: Response;
  try {
    res = await doFetch(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, signal: combined });
  } catch (err) {
    return failed(err, 'request failed');
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    if (unavailable(res.status)) throw new ProviderUnavailableError(provider, `HTTP ${res.status}`, { status: res.status, backoffMs: retryAfterMs(res) });
    log.warn(`${provider} search: HTTP ${res.status}`);
    return null;
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    return failed(err, 'reading body failed');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    log.warn(`${provider} search: response is not JSON`);
    return null;
  }
}

// Narrowing helpers for untrusted JSON.
export const asObject = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const asString = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
export const asNumber = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
export const asId = (v: unknown): string | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? String(v) : asString(v);

/** Drops undefined fields so results compare and log cleanly. */
export function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
