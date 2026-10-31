import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { PlayerSnapshot, TrackInfo } from '../src/model.ts';
import { activityKey, buildActivity, fit, searchUrl, trackUrl } from '../src/presence/build.ts';

const NOW = 1793450000000;
const cfg = { ...DEFAULT_CONFIG, clientId: '123' };

// MPRIS values as YM reports them: mpris:length 223 747 482 µs, Position 70 741 862 µs.
const snap = (o: Partial<PlayerSnapshot> = {}): PlayerSnapshot => ({
  source: 'mpris',
  at: NOW,
  status: 'playing',
  title: 'Capable of love',
  artists: ['PinkPantheress'],
  album: 'Heaven knows',
  durationMs: 223747,
  positionMs: 70742,
  rate: 1,
  trackKey: '/org/chromium/MediaPlayer2/TrackList/Track1',
  ...o,
});

// Values from test/fixtures/yandex-search-capable-of-love.json.
const COVER = 'https://avatars.yandex.net/get-music-content/9837405/0f61442d.a.28127004-1/400x400';
const yandex: TrackInfo = {
  provider: 'yandex',
  trackId: '118138322',
  albumId: '28127004',
  artists: [{ id: '12044483', name: 'PinkPantheress' }],
  title: 'Capable of love',
  album: 'Heaven knows',
  coverUrl: COVER,
  durationMs: 223680,
};

test('Capable of love: full payload matches the example in docs/ARCHITECTURE.md', () => {
  const a = buildActivity(snap(), yandex, cfg, NOW);
  assert.deepEqual(a, {
    type: 2,
    name: 'Яндекс Музыка',
    status_display_type: 1,
    details: 'Capable of love',
    details_url: 'https://music.yandex.ru/album/28127004/track/118138322',
    state: 'PinkPantheress',
    state_url: 'https://music.yandex.ru/artist/12044483',
    timestamps: { start: 1793449929258, end: 1793450153005 },
    assets: {
      large_image: COVER,
      large_text: 'Heaven knows',
      large_url: 'https://music.yandex.ru/album/28127004',
    },
    buttons: [{ label: 'Слушать в Яндекс Музыке', url: 'https://music.yandex.ru/album/28127004/track/118138322' }],
    instance: false,
  });
  assert.deepEqual(Object.keys(a!), [
    'type', 'name', 'status_display_type', 'details', 'details_url', 'state', 'state_url', 'timestamps', 'assets', 'buttons', 'instance',
  ]);
});

test('fit: trim, empty, padding, cut, surrogate pairs', () => {
  assert.equal(fit(undefined), undefined);
  assert.equal(fit(''), undefined);
  assert.equal(fit('   '), undefined);
  assert.equal(fit('  ab  '), 'ab');
  assert.equal(fit('a'), 'a⠀');
  assert.equal(fit('a', 1), 'a');
  assert.equal(fit('x', 3), 'x⠀⠀');
  const exact = 'y'.repeat(128);
  assert.equal(fit(exact), exact);
  const cut = fit('x'.repeat(200))!;
  assert.equal(cut.length, 128);
  assert.equal(cut, 'x'.repeat(127) + '…');
  // High surrogate would land at the last kept position → drop the whole pair.
  assert.equal(fit('a'.repeat(126) + '😀' + 'b'.repeat(10)), 'a'.repeat(126) + '…');
  // Pair fits entirely before the cut → kept.
  assert.equal(fit('a'.repeat(125) + '😀' + 'b'.repeat(10)), 'a'.repeat(125) + '😀…');
  assert.equal(fit('😀'), '😀'); // 2 UTF-16 units already satisfy min=2
});

test('1-char title is padded, 200-char title is cut', () => {
  assert.equal(buildActivity(snap({ title: 'X' }), null, cfg, NOW)!.details, 'X⠀');
  const long = buildActivity(snap({ title: 'T'.repeat(200) }), null, cfg, NOW)!;
  assert.equal(long.details, 'T'.repeat(127) + '…');
});

test('paused card: paused icon, no timestamps, links and button kept', () => {
  const a = buildActivity(snap({ status: 'paused' }), yandex, cfg, NOW)!;
  assert.equal(a.timestamps, undefined);
  assert.deepEqual(a.assets, {
    large_image: COVER,
    large_text: 'Heaven knows',
    large_url: 'https://music.yandex.ru/album/28127004',
    small_image: 'paused',
    small_text: 'На паузе',
  });
  assert.equal(a.buttons?.length, 1);
  assert.equal(a.details_url, trackUrl('28127004', '118138322'));
});

test('no info: logo, no links, search button', () => {
  const a = buildActivity(snap(), null, cfg, NOW)!;
  assert.deepEqual(a.assets, { large_image: 'logo', large_text: 'Heaven knows' });
  assert.equal(a.details_url, undefined);
  assert.equal(a.state_url, undefined);
  assert.deepEqual(a.buttons, [
    { label: 'Слушать в Яндекс Музыке', url: 'https://music.yandex.ru/search?text=PinkPantheress%20Capable%20of%20love' },
  ]);
});

test('iTunes info: cover only, no Yandex links or version', () => {
  const itunes: TrackInfo = { provider: 'itunes', coverUrl: 'https://is1-ssl.mzstatic.com/image/x/400x400bb.jpg', version: 'Remix', albumId: '1', trackId: '2' };
  const a = buildActivity(snap(), itunes, cfg, NOW)!;
  assert.equal(a.assets?.large_image, itunes.coverUrl);
  assert.equal(a.assets?.large_url, undefined);
  assert.equal(a.details_url, undefined);
  assert.equal(a.details, 'Capable of love');
  assert.equal(a.buttons?.[0]?.url, searchUrl('PinkPantheress Capable of love'));
});

test('yandex version is appended once', () => {
  const info = { ...yandex, version: 'Sped Up' };
  assert.equal(buildActivity(snap(), info, cfg, NOW)!.details, 'Capable of love (Sped Up)');
  assert.equal(buildActivity(snap({ title: 'Capable of love (sped up)' }), info, cfg, NOW)!.details, 'Capable of love (sped up)');
});

test('multiple artists joined, none → state omitted', () => {
  assert.equal(buildActivity(snap({ artists: ['A', ' B '] }), null, cfg, NOW)!.state, 'A, B');
  const a = buildActivity(snap({ artists: [] }), null, cfg, NOW)!;
  assert.equal('state' in a, false);
  assert.equal(a.buttons?.[0]?.url, searchUrl('Capable of love'));
});

test('album equal to title (normalized) → no large_text', () => {
  const a = buildActivity(snap({ album: '  capable  OF love ' }), null, cfg, NOW)!;
  assert.deepEqual(a.assets, { large_image: 'logo' });
});

test('rate 1.5 scales start and end', () => {
  const a = buildActivity(snap({ positionMs: 60000, durationMs: 180000, rate: 1.5 }), null, cfg, NOW)!;
  assert.deepEqual(a.timestamps, { start: NOW - 40000, end: NOW - 40000 + 120000 });
});

test('rate 0 / NaN / negative fall back to 1; non-finite position drops timestamps', () => {
  const expected = { start: NOW - 70742, end: NOW - 70742 + 223747 };
  for (const rate of [0, NaN, -1, Infinity]) {
    assert.deepEqual(buildActivity(snap({ rate }), null, cfg, NOW)!.timestamps, expected, `rate ${rate}`);
  }
  assert.equal(buildActivity(snap({ positionMs: NaN }), null, cfg, NOW)!.timestamps, undefined);
  assert.equal('timestamps' in buildActivity(snap({ positionMs: NaN }), null, cfg, NOW)!, false);
  assert.deepEqual(buildActivity(snap({ durationMs: Infinity }), null, cfg, NOW)!.timestamps, undefined);
  // An unstamped snapshot is anchored to `now`.
  assert.deepEqual(buildActivity(snap({ at: NaN }), null, cfg, NOW + 1000)!.timestamps, { start: NOW + 1000 - 70742, end: NOW + 1000 - 70742 + 223747 });
});

test('stopped → null', () => {
  assert.equal(buildActivity(snap({ status: 'stopped' }), yandex, cfg, NOW), null);
});

test('generative (no duration) → only start', () => {
  assert.deepEqual(buildActivity(snap({ durationMs: undefined }), null, cfg, NOW)!.timestamps, { start: NOW - 70742 });
  assert.deepEqual(buildActivity(snap({ durationMs: 0 }), null, cfg, NOW)!.timestamps, { start: NOW - 70742 });
});

test('over-long URLs are dropped, not cut', () => {
  const title = 'Ж'.repeat(100); // 6 bytes each once percent-encoded → search URL > 512
  const a = buildActivity(snap({ title }), null, cfg, NOW)!;
  assert.equal('buttons' in a, false);
  const info = { ...yandex, albumId: '9'.repeat(300), coverUrl: 'https://x/' + 'c'.repeat(300) };
  const b = buildActivity(snap(), info, cfg, NOW)!;
  assert.equal(b.details_url, undefined);
  assert.equal(b.assets?.large_url, undefined);
  assert.equal(b.assets?.large_image, 'logo');
  assert.equal(b.state_url, 'https://music.yandex.ru/artist/12044483');
});

test('config: no buttons, empty name, invalid status_display_type', () => {
  const a = buildActivity(snap(), yandex, { ...cfg, buttons: [], name: ' ', statusDisplayType: 7 }, NOW)!;
  assert.equal('buttons' in a, false);
  assert.equal('name' in a, false);
  assert.equal('status_display_type' in a, false);
});

test('activityKey ignores timestamps and key order', () => {
  const a = buildActivity(snap(), yandex, cfg, NOW)!;
  const b = buildActivity(snap({ at: NOW + 5000, positionMs: 75742 + 900 }), yandex, cfg, NOW)!;
  assert.notDeepEqual(a.timestamps, b.timestamps);
  assert.equal(activityKey(a), activityKey(b));
  const reordered = { instance: false, ...a, assets: { large_url: a.assets!.large_url, ...a.assets } };
  assert.equal(activityKey(reordered), activityKey(a));
  assert.notEqual(activityKey(a), activityKey(buildActivity(snap({ status: 'paused' }), yandex, cfg, NOW)!));
});

test('buttons: repeated config entries are deduplicated and capped at Discord\'s max of 2', () => {
  const a = buildActivity(snap(), yandex, { ...cfg, buttons: ['web', 'web', 'web'] }, NOW);
  assert.deepEqual(a?.buttons, [{ label: 'Слушать в Яндекс Музыке', url: 'https://music.yandex.ru/album/28127004/track/118138322' }]);
});
