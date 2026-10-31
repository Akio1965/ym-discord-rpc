import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PlayerSnapshot, TrackInfo } from '../src/model.ts';
import { CachingEnricher, createEnricher, ProviderUnavailableError, type Provider } from '../src/enrich/index.ts';
import { YandexSearch, yandexCoverUrl } from '../src/enrich/yandex.ts';
import { ItunesSearch, itunesCoverUrl } from '../src/enrich/itunes.ts';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const YANDEX = fixture('yandex-search-capable-of-love.json');
const ITUNES = fixture('itunes-capable-of-love.json');
const YANDEX_451_BODY = { error: { name: 'Unavailable For Legal Reasons', message: '' } };
const EMPTY_YANDEX = { result: { tracks: { results: [] } } };
const EMPTY_ITUNES = { resultCount: 0, results: [] };

const YANDEX_INFO: TrackInfo = {
  provider: 'yandex',
  trackId: '118138322',
  albumId: '28127004',
  artists: [{ id: '12044483', name: 'PinkPantheress' }],
  title: 'Capable of love',
  album: 'Heaven knows',
  coverUrl: 'https://avatars.yandex.net/get-music-content/9837405/0f61442d.a.28127004-1/400x400',
  durationMs: 223680,
};
const ITUNES_COVER = 'https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/05/59/17/0559179a-9f72-3384-2bc0-ebfee2c5c9e3/5054197835070.jpg/600x600bb.jpg';

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

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

/** Fake fetch routing by host; records every call. */
function fakeNet(routes: { yandex?: Handler; itunes?: Handler }) {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, init });
    const handler = url.hostname === 'api.music.yandex.net' ? routes.yandex : url.hostname === 'itunes.apple.com' ? routes.itunes : undefined;
    if (!handler) throw new TypeError(`unexpected request ${url.href}`);
    return handler(url, init);
  }) as typeof globalThis.fetch;
  const count = (host: string) => calls.filter((c) => c.url.hostname === host).length;
  return { fetch, calls, routes, yandexCalls: () => count('api.music.yandex.net'), itunesCalls: () => count('itunes.apple.com') };
}

/** Response that never arrives unless released; rejects like fetch when the request signal aborts. */
function deferred() {
  let release!: (r: Response) => void;
  const handler: Handler = (_url, init) =>
    new Promise<Response>((resolve, reject) => {
      release = resolve;
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });
  return { handler, release: (r: Response) => release(r) };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

// --- YandexSearch -----------------------------------------------------------------------------

test('YandexSearch: request shape and fixture parsing', async () => {
  const net = fakeNet({ yandex: () => json(YANDEX) });
  const info = await new YandexSearch({ fetch: net.fetch }).lookup(snap());
  assert.deepEqual(info, YANDEX_INFO);

  assert.equal(net.calls.length, 1);
  const { url, init } = net.calls[0]!;
  assert.equal(url.origin + url.pathname, 'https://api.music.yandex.net/search');
  assert.equal(url.searchParams.get('text'), 'PinkPantheress Capable of love');
  assert.equal(url.searchParams.get('type'), 'track');
  assert.equal(url.searchParams.get('page'), '0');
  assert.equal(url.searchParams.get('nocorrect'), 'true');
  const headers = new Headers(init?.headers);
  assert.equal(headers.get('accept'), 'application/json');
  assert.equal(headers.get('user-agent'), 'ym-discord-rpc/0.1');
  assert.ok(init?.signal instanceof AbortSignal);
});

test('YandexSearch: 451/403/429/5xx throw ProviderUnavailableError', async () => {
  for (const status of [451, 403, 429, 500, 503]) {
    const net = fakeNet({ yandex: () => json(YANDEX_451_BODY, status) });
    await assert.rejects(new YandexSearch({ fetch: net.fetch }).lookup(snap()), (err: unknown) => {
      assert.ok(err instanceof ProviderUnavailableError);
      assert.equal(err.provider, 'yandex');
      assert.equal(err.status, status);
      return true;
    });
  }
  const net = fakeNet({ yandex: () => json({}, 429, { 'retry-after': '120' }) });
  await assert.rejects(new YandexSearch({ fetch: net.fetch }).lookup(snap()), (err: ProviderUnavailableError) => err.backoffMs === 120_000);
});

test('YandexSearch: network failure and timeout are ProviderUnavailableError with a short backoff', async () => {
  const down = fakeNet({ yandex: () => Promise.reject(new TypeError('fetch failed')) });
  await assert.rejects(new YandexSearch({ fetch: down.fetch }).lookup(snap()), (err: unknown) => {
    assert.ok(err instanceof ProviderUnavailableError);
    assert.equal(err.status, undefined);
    assert.equal(err.backoffMs, 60_000);
    return true;
  });
  const hang = fakeNet({ yandex: deferred().handler });
  await assert.rejects(new YandexSearch({ fetch: hang.fetch, timeoutMs: 5 }).lookup(snap()), ProviderUnavailableError);
});

test('YandexSearch: caller abort rejects with the abort reason, not ProviderUnavailableError', async () => {
  const net = fakeNet({ yandex: deferred().handler });
  const ctrl = new AbortController();
  const pending = new YandexSearch({ fetch: net.fetch }).lookup(snap(), ctrl.signal);
  await tick();
  ctrl.abort();
  await assert.rejects(pending, (err: Error) => err.name === 'AbortError');
});

test('YandexSearch: other HTTP errors, bad JSON, error bodies and misses → null', async () => {
  const cases: Handler[] = [
    () => json({}, 404),
    () => new Response('<html>oops</html>', { status: 200 }),
    () => json(YANDEX_451_BODY),
    () => json(EMPTY_YANDEX),
    () => json(YANDEX), // fixture, but the snapshot below matches nothing in it
  ];
  for (const handler of cases) {
    const net = fakeNet({ yandex: handler });
    assert.equal(await new YandexSearch({ fetch: net.fetch }).lookup(snap({ title: 'Nothing like this' })), null);
  }
});

test('Yandex cover URL: only avatars.yandex.net templates become https 400x400', () => {
  assert.equal(yandexCoverUrl('avatars.yandex.net/get-music-content/1/ab.a.2-1/%%'), 'https://avatars.yandex.net/get-music-content/1/ab.a.2-1/400x400');
  assert.equal(yandexCoverUrl('//avatars.mds.yandex.net/get-music-content/1/x/%%'), 'https://avatars.mds.yandex.net/get-music-content/1/x/400x400');
  assert.equal(yandexCoverUrl('blob:https://music.yandex.ru/123'), undefined);
  assert.equal(yandexCoverUrl('evil.example/avatars.yandex.net/%%'), undefined);
  assert.equal(yandexCoverUrl('avatars.yandex.net.evil.example/x/%%'), undefined);
  assert.equal(yandexCoverUrl('avatars.yandex.net/get-music-content/1/x/200x200'), undefined);
  assert.equal(yandexCoverUrl(undefined), undefined);
  assert.equal(yandexCoverUrl(''), undefined);
});

test('YandexSearch: a track without a usable cover still yields ids, without coverUrl', async () => {
  const net = fakeNet({ yandex: () => json(withoutYandexCover()) });
  const info = await new YandexSearch({ fetch: net.fetch }).lookup(snap());
  const { coverUrl, ...rest } = YANDEX_INFO;
  assert.deepEqual(info, rest);
});

function withoutYandexCover(): unknown {
  const body = structuredClone(YANDEX) as { result: { tracks: { results: Record<string, unknown>[] } } };
  for (const t of body.result.tracks.results) {
    t.coverUri = 'blob:https://music.yandex.ru/1';
    delete t.ogImage;
    for (const a of t.albums as Record<string, unknown>[]) delete a.coverUri;
  }
  return body;
}

// --- ItunesSearch -----------------------------------------------------------------------------

test('ItunesSearch: request shape; cover-only TrackInfo without ids or links', async () => {
  const net = fakeNet({ itunes: () => json(ITUNES) });
  const info = await new ItunesSearch({ fetch: net.fetch }).lookup(snap());
  assert.deepEqual(info, { provider: 'itunes', coverUrl: ITUNES_COVER, title: 'Capable of love', album: 'Heaven knows', durationMs: 223680 });

  const { url, init } = net.calls[0]!;
  assert.equal(url.origin + url.pathname, 'https://itunes.apple.com/search');
  assert.equal(url.searchParams.get('term'), 'PinkPantheress Capable of love');
  assert.equal(url.searchParams.get('entity'), 'song');
  assert.equal(url.searchParams.get('limit'), '10');
  assert.equal(new Headers(init?.headers).get('user-agent'), 'ym-discord-rpc/0.1');
});

test('ItunesSearch: karaoke/instrumental results alone never match', async () => {
  const body = structuredClone(ITUNES) as { results: unknown[] };
  body.results = body.results.slice(1); // only "Vox Freaks" instrumental and "Backing Business" karaoke
  const net = fakeNet({ itunes: () => json(body) });
  assert.equal(await new ItunesSearch({ fetch: net.fetch }).lookup(snap()), null);
});

test('iTunes cover URL: mzstatic https only, upscaled to 600x600', () => {
  assert.equal(itunesCoverUrl('https://is1-ssl.mzstatic.com/a/100x100bb.jpg'), 'https://is1-ssl.mzstatic.com/a/600x600bb.jpg');
  assert.equal(itunesCoverUrl('http://is1-ssl.mzstatic.com/a/100x100bb.jpg'), undefined);
  assert.equal(itunesCoverUrl('https://example.com/a/100x100bb.jpg'), undefined);
  assert.equal(itunesCoverUrl(42), undefined);
});

// --- CachingEnricher --------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;

function setup(routes: { yandex?: Handler; itunes?: Handler }, search = { yandex: true, itunes: true }) {
  const clock = { now: 1_000_000 };
  const net = fakeNet(routes);
  const enricher = createEnricher(search, { http: { fetch: net.fetch }, now: () => clock.now });
  return { clock, net, enricher };
}

test('chain: Yandex hit with cover → iTunes not queried', async () => {
  const { net, enricher } = setup({ yandex: () => json(YANDEX), itunes: () => json(ITUNES) });
  assert.deepEqual(await enricher.lookup(snap()), YANDEX_INFO);
  assert.equal(net.itunesCalls(), 0);
});

test('chain: 451 → iTunes cover used, Yandex skipped for 10 min, then retried', async () => {
  const { clock, net, enricher } = setup({ yandex: () => json(YANDEX_451_BODY, 451), itunes: () => json(ITUNES) });

  const first = await enricher.lookup(snap());
  assert.equal(first?.provider, 'itunes');
  assert.equal(first?.coverUrl, ITUNES_COVER);
  assert.equal(first?.trackId, undefined);
  assert.deepEqual([net.yandexCalls(), net.itunesCalls()], [1, 1]);

  clock.now += 5 * MIN;
  assert.equal((await enricher.lookup(snap({ trackKey: 't2' })))?.provider, 'itunes');
  assert.deepEqual([net.yandexCalls(), net.itunesCalls()], [1, 2], 'Yandex is in backoff');

  clock.now += 6 * MIN;
  net.routes.yandex = () => json(YANDEX);
  assert.deepEqual(await enricher.lookup(snap({ trackKey: 't3' })), YANDEX_INFO);
  assert.deepEqual([net.yandexCalls(), net.itunesCalls()], [2, 2]);
});

test('chain: a partial answer (provider in backoff) is cached only for 30 min', async () => {
  const { clock, net, enricher } = setup({ yandex: () => json({}, 503), itunes: () => json(ITUNES) });
  await enricher.lookup(snap());
  clock.now += 20 * MIN;
  assert.equal((await enricher.lookup(snap()))?.provider, 'itunes');
  assert.equal(net.itunesCalls(), 1, 'served from cache');

  clock.now += 11 * MIN; // 31 min: cache expired and Yandex backoff (10 min) is over
  net.routes.yandex = () => json(YANDEX);
  assert.deepEqual(await enricher.lookup(snap()), YANDEX_INFO);
});

test('chain: Yandex info without cover gets the iTunes cover merged in', async () => {
  const { net, enricher } = setup({ yandex: () => json(withoutYandexCover()), itunes: () => json(ITUNES) });
  assert.deepEqual(await enricher.lookup(snap()), { ...YANDEX_INFO, coverUrl: ITUNES_COVER });
  assert.deepEqual([net.yandexCalls(), net.itunesCalls()], [1, 1]);
});

test('chain: config flags select providers', async () => {
  const onlyItunes = setup({ yandex: () => json(YANDEX), itunes: () => json(ITUNES) }, { yandex: false, itunes: true });
  assert.equal((await onlyItunes.enricher.lookup(snap()))?.provider, 'itunes');
  assert.equal(onlyItunes.net.yandexCalls(), 0);

  const none = setup({}, { yandex: false, itunes: false });
  assert.equal(await none.enricher.lookup(snap()), null);
  assert.equal(none.net.calls.length, 0);
});

test('cache: hits live 6 h, "not found" 30 min', async () => {
  const hit = setup({ yandex: () => json(YANDEX) });
  await hit.enricher.lookup(snap());
  hit.clock.now += 6 * HOUR - 1;
  assert.deepEqual(await hit.enricher.lookup(snap()), YANDEX_INFO);
  assert.equal(hit.net.yandexCalls(), 1);
  hit.clock.now += 2;
  await hit.enricher.lookup(snap());
  assert.equal(hit.net.yandexCalls(), 2);

  const miss = setup({ yandex: () => json(EMPTY_YANDEX), itunes: () => json(EMPTY_ITUNES) });
  assert.equal(await miss.enricher.lookup(snap()), null);
  miss.clock.now += 29 * MIN;
  assert.equal(await miss.enricher.lookup(snap()), null);
  assert.deepEqual([miss.net.yandexCalls(), miss.net.itunesCalls()], [1, 1]);
  miss.clock.now += 2 * MIN;
  await miss.enricher.lookup(snap());
  assert.deepEqual([miss.net.yandexCalls(), miss.net.itunesCalls()], [2, 2]);
});

test('cache: key covers trackKey, title and artists', async () => {
  const { net, enricher } = setup({ yandex: () => json(YANDEX), itunes: () => json(EMPTY_ITUNES) });
  await enricher.lookup(snap());
  await enricher.lookup(snap({ trackKey: 'other' }));
  await enricher.lookup(snap({ title: 'capable of love' }));
  await enricher.lookup(snap({ artists: ['PinkPantheress', 'X'] }));
  await enricher.lookup(snap({ positionMs: 5000, at: 99 })); // same key → cached
  assert.equal(net.yandexCalls(), 4);
});

test('cache: errors are not cached, and lookup never throws', async () => {
  let calls = 0;
  const flaky: Provider = {
    name: 'flaky',
    lookup: () => {
      calls++;
      throw new Error('boom'); // synchronous throw from a misbehaving provider
    },
  };
  const enricher = new CachingEnricher([flaky]);
  assert.equal(await enricher.lookup(snap()), null);
  assert.equal(await enricher.lookup(snap()), null);
  assert.equal(calls, 2);
});

test('cache: LRU evicts the least recently used entry', async () => {
  const clock = { now: 0 };
  const net = fakeNet({ yandex: () => json(YANDEX) });
  const enricher = new CachingEnricher([new YandexSearch({ fetch: net.fetch })], { maxEntries: 2, now: () => clock.now });
  await enricher.lookup(snap({ trackKey: 'a' }));
  await enricher.lookup(snap({ trackKey: 'b' }));
  await enricher.lookup(snap({ trackKey: 'a' })); // refresh a
  await enricher.lookup(snap({ trackKey: 'c' })); // evicts b
  assert.equal(net.yandexCalls(), 3);
  await enricher.lookup(snap({ trackKey: 'a' }));
  await enricher.lookup(snap({ trackKey: 'c' }));
  assert.equal(net.yandexCalls(), 3);
  await enricher.lookup(snap({ trackKey: 'b' }));
  assert.equal(net.yandexCalls(), 4);
});

test('snapshots without title or artists are not looked up', async () => {
  const { net, enricher } = setup({ yandex: () => json(YANDEX) });
  assert.equal(await enricher.lookup(snap({ artists: [] })), null);
  assert.equal(await enricher.lookup(snap({ title: '  ' })), null);
  assert.equal(net.calls.length, 0);
});

test('single-flight: concurrent lookups of one key share one request', async () => {
  const slow = deferred();
  const { net, enricher } = setup({ yandex: slow.handler });
  const a = enricher.lookup(snap());
  const b = enricher.lookup(snap());
  await tick();
  assert.equal(net.yandexCalls(), 1);
  slow.release(json(YANDEX));
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual(ra, YANDEX_INFO);
  assert.equal(ra, rb);
});

test('abort: resolves null at once, cancels the request, does not poison cache or backoff', async () => {
  const slow = deferred();
  const { net, enricher } = setup({ yandex: slow.handler, itunes: () => json(ITUNES) });
  const ctrl = new AbortController();
  const pending = enricher.lookup(snap(), ctrl.signal);
  await tick();
  ctrl.abort();
  assert.equal(await pending, null);
  assert.equal(net.calls[0]!.init?.signal?.aborted, true, 'HTTP request cancelled');
  assert.equal(net.itunesCalls(), 0, 'chain stops after abort');

  net.routes.yandex = () => json(YANDEX);
  assert.deepEqual(await enricher.lookup(snap()), YANDEX_INFO);
  assert.equal(net.yandexCalls(), 2);
});

test('abort: a provider that ignores the signal cannot hold the caller', async () => {
  const stuck: Provider = { name: 'stuck', lookup: () => new Promise(() => {}) };
  const enricher = new CachingEnricher([stuck]);
  const ctrl = new AbortController();
  const pending = enricher.lookup(snap(), ctrl.signal);
  ctrl.abort();
  assert.equal(await pending, null);
  const pre = new AbortController();
  pre.abort();
  assert.equal(await enricher.lookup(snap({ trackKey: 'x' }), pre.signal), null);
});

test('abort: one waiter leaving does not cancel the shared request for the others', async () => {
  const slow = deferred();
  const { net, enricher } = setup({ yandex: slow.handler });
  const ctrl = new AbortController();
  const leaver = enricher.lookup(snap(), ctrl.signal);
  const stayer = enricher.lookup(snap());
  await tick();
  ctrl.abort();
  assert.equal(await leaver, null);
  assert.equal(net.calls[0]!.init?.signal?.aborted, false);
  slow.release(json(YANDEX));
  assert.deepEqual(await stayer, YANDEX_INFO);
  assert.deepEqual(await enricher.lookup(snap()), YANDEX_INFO);
  assert.equal(net.yandexCalls(), 1, 'result cached');
});

test('backoff runs on a monotonic clock by default: a backward wall-clock step does not stretch it', async (t) => {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  t.mock.method(Date, 'now', () => realNow() + offset);
  let calls = 0;
  const blocked: Provider = {
    name: 'blocked',
    lookup: async () => {
      calls++;
      throw new ProviderUnavailableError('blocked', 'HTTP 451', { status: 451, backoffMs: 20 });
    },
  };
  const enricher = new CachingEnricher([blocked]);
  assert.equal(await enricher.lookup(snap()), null);
  offset = -3 * 3600_000; // the wall clock steps back 3 h (e.g. an NTP or manual correction)
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(await enricher.lookup(snap()), null);
  assert.equal(calls, 2, 'the 20 ms backoff must not grow by the 3 h step');
});
