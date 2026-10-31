import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PlayerSnapshot } from '../src/model.ts';
import { artistsMatch, normalize, pickBest, score, searchText, type Candidate } from '../src/enrich/matcher.ts';
import { parseYandexSearch, toTrackInfo } from '../src/enrich/yandex.ts';
import { parseItunesSearch } from '../src/enrich/itunes.ts';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const snap = (over: Partial<PlayerSnapshot> = {}): PlayerSnapshot => ({
  source: 'mpris',
  at: 0,
  status: 'playing',
  title: 'Capable of love',
  artists: ['PinkPantheress'],
  album: 'Heaven knows',
  durationMs: 223747,
  positionMs: 0,
  rate: 1,
  trackKey: '/com/yandex/music/1',
  ...over,
});

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  title: 'Song',
  artists: ['Artist'],
  durationMs: 200_000,
  hasCover: true,
  available: true,
  ...over,
});

test('normalize: NFKC, case, ё, diacritics, feat., punctuation', () => {
  assert.equal(normalize('ＣＡＰＡＢＬＥ　of　Love'), 'capable of love');
  assert.equal(normalize('Ёлка'), 'елка');
  assert.equal(normalize('Мой рай'), 'мой рай'); // й is a letter, not a diacritic
  assert.equal(normalize('Beyoncé — Café Ünïcode'), 'beyonce cafe unicode');
  assert.equal(normalize('İstanbul'), 'istanbul');
  assert.equal(normalize('Song (feat. Someone & Other)'), 'song');
  assert.equal(normalize('Song [ft. Someone]'), 'song');
  assert.equal(normalize('Song (Featuring Someone) (Remix)'), 'song remix');
  assert.equal(normalize('Song feat. Someone, Other'), 'song');
  assert.equal(normalize('Song ft. Someone'), 'song');
  assert.equal(normalize('Feature Presentation'), 'feature presentation');
  assert.equal(normalize("  Don’t   Stop!!  me-now "), 'dont stop me now');
  assert.equal(normalize('Straße'), 'strasse');
  assert.equal(normalize('ドラえもん'), 'ドラえもん');
});

test('Yandex fixture: exact match → 118138322 / 28127004 / 400x400 cover', () => {
  const best = pickBest(snap(), parseYandexSearch(fixture('yandex-search-capable-of-love.json')));
  assert.ok(best);
  assert.deepEqual(toTrackInfo(best), {
    provider: 'yandex',
    trackId: '118138322',
    albumId: '28127004',
    artists: [{ id: '12044483', name: 'PinkPantheress' }],
    title: 'Capable of love',
    album: 'Heaven knows',
    coverUrl: 'https://avatars.yandex.net/get-music-content/9837405/0f61442d.a.28127004-1/400x400',
    durationMs: 223680,
  });
});

test('Yandex fixture: matching ignores case/whitespace and works without album or duration', () => {
  const candidates = parseYandexSearch(fixture('yandex-search-capable-of-love.json'));
  const loose = snap({ title: '  CAPABLE OF LOVE ', artists: ['pinkpantheress'], album: undefined, durationMs: undefined });
  assert.equal(pickBest(loose, candidates)?.id, '118138322');
});

test('wrong artist is rejected', () => {
  const candidates = parseYandexSearch(fixture('yandex-search-capable-of-love.json'));
  assert.equal(pickBest(snap({ artists: ['LE SSERAFIM'] }), candidates), null);
  assert.equal(pickBest(snap({ artists: ['PinkPantheress', 'Ice Spice'] }), candidates), null); // extra artist not in candidate
  assert.equal(pickBest(snap({ artists: [] }), candidates), null);
});

test('wrong title is rejected, including prefix/suffix variants', () => {
  assert.equal(score(snap({ title: 'Song' }), cand({ title: 'Song 2' })), null);
  assert.equal(score(snap({ title: 'Song (Live)', artists: ['Artist'], durationMs: 200_000 }), cand({ title: 'Song' })), null);
  assert.equal(score(snap({ title: 'Song', artists: ['Artist'], durationMs: 200_000 }), cand({ title: 'Song (Live)' })), null);
});

test('version: MPRIS bare title picks the version by duration; "title (version)" is a weaker match', () => {
  const original = cand({ title: 'Song', durationMs: 200_000 });
  const remix = cand({ title: 'Song', version: 'Remix', durationMs: 260_000, album: 'Song (Remixes)' });
  const base = { artists: ['Artist'], album: undefined };

  assert.equal(pickBest(snap({ ...base, title: 'Song', durationMs: 200_400 }), [remix, original]), original);
  assert.equal(pickBest(snap({ ...base, title: 'Song', durationMs: 260_400 }), [original, remix]), remix);
  // Same duration: prefer the album the player reports, otherwise the original.
  const remixSameLen = { ...remix, durationMs: 200_000 };
  assert.equal(pickBest(snap({ ...base, title: 'Song', durationMs: 200_000 }), [remixSameLen, original]), original);
  assert.equal(pickBest(snap({ ...base, title: 'Song', durationMs: 200_000, album: 'Song (Remixes)' }), [original, remixSameLen]), remixSameLen);

  // Player title that includes the version (e.g. SMTC or other sources).
  const withVersion = snap({ ...base, title: 'Song (Remix)', durationMs: 260_000 });
  const exactScore = score(snap({ ...base, title: 'Song', durationMs: 260_000 }), remix)!;
  const weakScore = score(withVersion, remix)!;
  assert.ok(weakScore > 0 && weakScore < exactScore);
  assert.equal(pickBest(withVersion, [original, remix]), remix);
  // A weak title match needs corroboration (duration or album).
  assert.equal(pickBest(snap({ ...base, title: 'Song (Remix)', durationMs: undefined }), [remix]), null);
  assert.equal(pickBest(snap({ ...base, title: 'Song (Remix)', durationMs: undefined, album: 'Song (Remixes)' }), [remix]), remix);
});

test('karaoke / instrumental / 8-bit / cover variants are rejected unless the player asks for them', () => {
  const itunes = parseItunesSearch(fixture('itunes-capable-of-love.json'));
  assert.equal(itunes.length, 3);
  const best = pickBest(snap(), itunes);
  assert.equal(best?.album, 'Heaven knows');
  assert.equal(best?.durationMs, 223680);

  // Same title/artist/duration but a karaoke album must not be used.
  const s = snap({ album: undefined });
  assert.equal(score(s, cand({ title: 'Capable of love', artists: ['PinkPantheress'], durationMs: 223_000, album: 'Pristine Karaoke, Vol. 132' })), null);
  assert.equal(score(s, cand({ title: 'Capable of love', artists: ['PinkPantheress'], durationMs: 223_000, version: 'Instrumental' })), null);
  assert.equal(score(s, cand({ title: 'Capable of love', artists: ['PinkPantheress'], durationMs: 223_000, album: 'Heaven knows (8-Bit Edition)' })), null);
  assert.equal(score(s, cand({ title: 'Capable of love', artists: ['PinkPantheress'], durationMs: 223_000, album: 'Pop Covers 2024' })), null);
  // …unless the player's own title/album says so.
  const karaoke = cand({ title: 'Song (Karaoke Version)', artists: ['Artist'] });
  assert.notEqual(score(snap({ title: 'Song (Karaoke Version)', artists: ['Artist'], durationMs: 200_000 }), karaoke), null);
  assert.notEqual(score(snap({ title: 'Song', artists: ['Artist'], durationMs: 200_000, album: 'Karaoke Hits' }), cand({ album: 'Karaoke Hits' })), null);
  // "Cover Me" is a real title, not a variant.
  assert.notEqual(score(snap({ title: 'Cover Me', artists: ['Artist'], durationMs: 200_000 }), cand({ title: 'Cover Me' })), null);
});

test('artists: subset, joined form and names containing ", "', () => {
  // MPRIS "Tyler, The Creator" is split lossily by the source.
  assert.ok(artistsMatch(['Tyler', 'The Creator'], ['Tyler, The Creator']));
  assert.ok(artistsMatch(['Tyler', 'The Creator', 'Kali Uchis'], ['Tyler, The Creator', 'Kali Uchis']));
  assert.ok(artistsMatch(['Tyler, The Creator'], ['Tyler, The Creator']));
  assert.ok(!artistsMatch(['Tyler', 'The Creator'], ['Tyler']));
  // Player artists must be a subset of the candidate's (catalog may list extra guests).
  assert.ok(artistsMatch(['PinkPantheress'], ['PinkPantheress', 'Ice Spice']));
  assert.ok(!artistsMatch(['PinkPantheress', 'Ice Spice'], ['PinkPantheress']));
  // iTunes joins names into one string.
  assert.ok(artistsMatch(['PinkPantheress', 'Ice Spice'], ['PinkPantheress & Ice Spice']));
  assert.ok(artistsMatch(['Lil Nas X', 'Jack Harlow'], ['Lil Nas X, Jack Harlow']));
  assert.ok(artistsMatch(['Simon & Garfunkel'], ['Simon & Garfunkel']));
  assert.ok(artistsMatch(['Земфира'], ['ЗЕМФИРА']));
  assert.ok(artistsMatch(['Beyoncé'], ['Beyonce']));
  assert.ok(!artistsMatch([], ['Anyone']));

  const tyler = cand({ title: 'EARFQUAKE', artists: ['Tyler, The Creator'], durationMs: 190_000 });
  assert.equal(pickBest(snap({ title: 'EARFQUAKE', artists: ['Tyler', 'The Creator'], album: 'IGOR', durationMs: 190_300 }), [tyler]), tyler);
});

test('duration tolerance: ≤2.5 s strong, ≤max(8 s, 4%) weaker, beyond rejected', () => {
  const c = cand({ durationMs: 180_000 });
  const at = (ms: number | undefined) => score(snap({ title: 'Song', artists: ['Artist'], album: undefined, durationMs: ms }), c);
  const exact = at(180_000)!;
  const strong = at(182_000)!;
  const weak = at(187_000)!;
  assert.ok(exact > strong && strong > weak && weak > 0);
  assert.notEqual(at(188_000), null); // 8 s edge accepted
  assert.equal(at(188_500), null); // 4% of 180 s = 7.2 s, so the 8 s floor applies
  assert.notEqual(at(undefined), null); // unknown duration: no bonus, no rejection
  assert.ok(at(undefined)! < strong);

  const long = cand({ durationMs: 600_000 });
  const longAt = (ms: number) => score(snap({ title: 'Song', artists: ['Artist'], album: undefined, durationMs: ms }), long);
  assert.notEqual(longAt(620_000), null); // 4% of ~600 s ≈ 24 s
  assert.equal(longAt(630_000), null);
});

test('album equality and cover/availability break ties', () => {
  const a = cand({ album: 'Other' });
  const b = cand({ album: 'Real Album' });
  assert.equal(pickBest(snap({ title: 'Song', artists: ['Artist'], album: 'Real Album', durationMs: 200_000 }), [a, b]), b);
  const noCover = cand({ hasCover: false });
  const withCover = cand({ hasCover: true });
  assert.equal(pickBest(snap({ title: 'Song', artists: ['Artist'], album: undefined, durationMs: 200_000 }), [noCover, withCover]), withCover);
});

test('searchText joins artists and title', () => {
  assert.equal(searchText(snap()), 'PinkPantheress Capable of love');
  assert.equal(searchText(snap({ artists: ['A', ' B '], title: 'T' })), 'A B T');
});
