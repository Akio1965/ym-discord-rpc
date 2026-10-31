// Strict catalog matching: a wrong cover or link is worse than none, so anything that is not clearly
// the same recording is rejected. The rules (NFKC + casefold + ё→е, feat. stripping, player artists ⊆
// catalog artists, duration within max(8 s, 4%), prefer the same album) follow the approach of
// FozerG/WinYandexMusicRPC; this is an independent TypeScript implementation with its own scoring.
import type { PlayerSnapshot } from '../model.ts';

/** Catalog entry in provider-neutral form. Providers extend it with their own payload. */
export interface Candidate {
  title: string;
  /** Yandex "version" (e.g. "Remix"). YM's MPRIS title is the bare title without it. */
  version?: string;
  /** Names as the catalog lists them; one name may itself contain ", " ("Tyler, The Creator") or be "A & B" (iTunes). */
  artists: string[];
  album?: string;
  durationMs?: number;
  hasCover?: boolean;
  available?: boolean;
}

export const MATCH_THRESHOLD = 80;
const TITLE_EXACT = 100;
const TITLE_WITH_VERSION = 70;
const STRONG_DURATION_MS = 2500;

const FEAT_BRACKETED = /[([]\s*(?:featuring|feat|ft)\b[^)\]]*[)\]]/gu;
const FEAT_TAIL = /\s(?:feat\.|ft\.|featuring\b).*$/u;
const LATIN_ACCENTED = /[\u00c0-\u024f\u1e00-\u1eff]/gu;
const COMBINING = /[\u0300-\u036f]/gu;
// Splits a catalog artist string into individual names (iTunes joins them with ", " / " & ").
const ARTIST_SEP = /\s*(?:[,;&]|\s(?:x|×|feat\.?|ft\.?|featuring)\s)\s*/iu;

// Re-recordings that share title and artist with the original (common in iTunes results).
const VARIANT_MARKERS = [
  'karaoke', 'instrumental', '8 bit', '16 bit', 'chiptune', 'originally performed', 'made famous',
  'in the style of', 'tribute', 'cover', 'covers', 'cover version', 'lullaby', 'lullabies', 'backing track',
  'acapella', 'a cappella', 'acappella', 'piano version', 'music box',
  'караоке', 'инструментал', 'минус', 'кавер',
].map((m) => ` ${m} `);

/** Comparison key: NFKC, lowercase, ё→е, Latin diacritics stripped, feat. parts dropped, punctuation collapsed. */
export function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(FEAT_BRACKETED, ' ')
    .replace(FEAT_TAIL, '')
    .replace(LATIN_ACCENTED, (ch) => ch.normalize('NFD').replace(COMBINING, ''))
    .replace(/([a-z])[\u0300-\u036f]+/gu, '$1') // e.g. "İ".toLowerCase() leaves a bare combining dot
    .replace(/ß/gu, 'ss')
    .replace(/['’ʼ`]/gu, '')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim();
}

function variantMarkers(...texts: Array<string | undefined>): Set<string> {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    const padded = ` ${normalize(text)} `;
    for (const m of VARIANT_MARKERS) if (padded.includes(m)) found.add(m);
  }
  return found;
}

/** Every player artist must be one of the candidate's, or the joined strings must agree (splitting "A, B" is lossy). */
export function artistsMatch(wanted: readonly string[], candidate: readonly string[]): boolean {
  const need = wanted.map(normalize).filter(Boolean);
  if (need.length === 0 || candidate.length === 0) return false;
  if (normalize(wanted.join(', ')) === normalize(candidate.join(', '))) return true;
  const pool = new Set<string>();
  for (const name of candidate) {
    pool.add(normalize(name));
    for (const part of name.split(ARTIST_SEP)) pool.add(normalize(part));
  }
  return need.every((a) => pool.has(a));
}

const positive = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Match quality, or null when the candidate must not be used. */
export function score(snap: PlayerSnapshot, c: Candidate): number | null {
  const title = normalize(snap.title);
  if (!title) return null;

  let s: number;
  if (normalize(c.title) === title) s = TITLE_EXACT + (c.version ? 0 : 1); // tie-break towards the original
  else if (c.version && normalize(`${c.title} ${c.version}`) === title) s = TITLE_WITH_VERSION;
  else return null;

  if (!artistsMatch(snap.artists, c.artists)) return null;

  const allowed = variantMarkers(snap.title, snap.album);
  for (const m of variantMarkers(c.title, c.version, c.album)) if (!allowed.has(m)) return null;

  if (positive(snap.durationMs) && positive(c.durationMs)) {
    const delta = Math.abs(snap.durationMs - c.durationMs);
    const tolerance = Math.max(8000, snap.durationMs * 0.04);
    if (delta <= STRONG_DURATION_MS) s += 20 + 10 * (1 - delta / STRONG_DURATION_MS);
    else if (delta <= tolerance) s += 10 + 5 * (1 - (delta - STRONG_DURATION_MS) / (tolerance - STRONG_DURATION_MS));
    else return null;
  }

  if (snap.album && c.album && normalize(snap.album) === normalize(c.album)) s += 20;
  if (c.hasCover) s += 3;
  if (c.available) s += 3;
  return s;
}

/** Free-text query for catalog search: artists then title. */
export function searchText(snap: PlayerSnapshot): string {
  return [...snap.artists, snap.title].map((s) => s.trim()).filter(Boolean).join(' ');
}

/** Highest-scoring candidate at or above MATCH_THRESHOLD; earlier candidates win ties (provider relevance order). */
export function pickBest<C extends Candidate>(snap: PlayerSnapshot, candidates: readonly C[]): C | null {
  let best: C | null = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const s = score(snap, c);
    if (s !== null && s >= MATCH_THRESHOLD && s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}
