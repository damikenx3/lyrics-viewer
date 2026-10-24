import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLibraryFile } from '../src/core/parse.js';
import { matchAudio } from '../src/core/match.js';
import { normalizeTitle, songId } from '../src/core/normalize.js';

// 一個檔一首歌：每個標題各自解析成一首。front 是額外的 front matter 行（例如 audio）
const albumSongs = (album, heads, front = {}) =>
  heads.flatMap((h, k) => parseLibraryFile(`---\nalbum: ${album}\n${front[h] ?? ''}---\n# ${h}\nあ\n`, { path: `${album}/${k}.md` }).songs);

const songs = albumSongs('架空アルバム', ['01 ほし・ストーリー', '02 ストーリー', '03 PON-PON!!!', '04 よる'], {
  '01 ほし・ストーリー': 'audio: 001-star_123.flac\n',
});
const other = albumSongs('別盤', ['05 ストーリー']);
const all = [...songs, ...other];
const id = (album, title) => songId(album, title);

test('normalizeTitle / songId', () => {
  assert.equal(normalizeTitle('ほし・ストーリー'), 'ほしストーリー');
  assert.equal(normalizeTitle(' PON-PON!!! '), 'ponpon');
  assert.equal(normalizeTitle('ＡＢＣ　１２３'), 'abc123');
  assert.equal(normalizeTitle('♡♡'), '♡♡');
  assert.equal(songId('Album X', 'Song♪'), 'albumx/song');
});

test('優先序 1：meta.audio 檔名（不分大小寫，也接受換副檔名）', () => {
  assert.equal(matchAudio({ fileName: '001-star_123.flac', tags: { title: 'よる' } }, all), id('架空アルバム', 'ほし・ストーリー'));
  assert.equal(matchAudio({ fileName: 'C:\\music\\001-STAR_123.mp3' }, all), id('架空アルバム', 'ほし・ストーリー'));
});

test('優先序 2：標籤歌名，專輯／曲序打破平手', () => {
  assert.equal(matchAudio({ fileName: 'x.mp3', tags: { title: 'ストーリー', album: '別盤' } }, all), id('別盤', 'ストーリー'));
  assert.equal(matchAudio({ fileName: 'x.mp3', tags: { title: 'ストーリー', album: '架空アルバム' } }, all), id('架空アルバム', 'ストーリー'));
  assert.equal(matchAudio({ fileName: 'x.mp3', tags: { title: 'ストーリー', track: 5 } }, all), id('別盤', 'ストーリー'));
  assert.equal(matchAudio({ fileName: 'x.mp3', tags: { title: 'pon pon' } }, all), id('架空アルバム', 'PON-PON!!!'));
});

test('優先序 3：檔名包含歌名；較長的歌名、曲序優先', () => {
  // 「ほし・ストーリー」與「ストーリー」都被包含 → 較長者
  assert.equal(matchAudio({ fileName: 'うた - ほしストーリー.flac' }, songs), id('架空アルバム', 'ほし・ストーリー'));
  // 檔名開頭數字當曲序
  assert.equal(matchAudio({ fileName: '05 ストーリー.flac' }, all), id('別盤', 'ストーリー'));
  assert.equal(matchAudio({ fileName: '02 ストーリー.flac' }, all), id('架空アルバム', 'ストーリー'));
  assert.equal(matchAudio({ fileName: 'Track - PON PON.mp3' }, all), id('架空アルバム', 'PON-PON!!!'));
  assert.equal(matchAudio({ fileName: '001-ほし・ストーリー_123.flac' }, songs), id('架空アルバム', 'ほし・ストーリー'));
});

// 反例：容易誤配的情形
const tricky = albumSongs('盤', ['01 Ai', '02 みこ', '03 Intro', '04 March', '05 よるのうた', '06 Ai (Instrumental)']);

test('反例：英數歌名要對在字詞邊界', () => {
  assert.equal(matchAudio({ fileName: 'Daisuki.flac' }, tricky), null);
  assert.equal(matchAudio({ fileName: 'Rain.flac' }, tricky), null);
  assert.equal(matchAudio({ fileName: 'Marching band.flac' }, tricky), null);
  assert.equal(matchAudio({ fileName: 'Ai.flac' }, tricky), id('盤', 'Ai'));
  assert.equal(matchAudio({ fileName: 'artist - march.flac' }, tricky), id('盤', 'March'));
});

test('反例：非英數歌名正規化後少於 3 個字不用「檔名包含」比對', () => {
  assert.equal(matchAudio({ fileName: 'ひなたみこ - ぜんぜんちがううた.flac' }, tricky), null);
  assert.equal(matchAudio({ fileName: 'ひなたみこ - よるのうた.flac' }, tricky), id('盤', 'よるのうた'));
  // 標籤歌名完全相同時，短歌名照樣配得到
  assert.equal(matchAudio({ fileName: 'x.flac', tags: { title: 'みこ' } }, tricky), id('盤', 'みこ'));
});

test('反例：伴奏版（instrumental / off vocal / inst / karaoke）不配到原曲', () => {
  assert.equal(matchAudio({ fileName: 'よるのうた (Instrumental).flac' }, tricky), null);
  assert.equal(matchAudio({ fileName: 'よるのうた -off vocal-.flac' }, tricky), null);
  assert.equal(matchAudio({ fileName: 'よるのうた_inst.flac' }, tricky), null);
  assert.equal(matchAudio({ fileName: 'よるのうた (Karaoke).flac' }, tricky), null);
  assert.equal(matchAudio({ fileName: 'x.flac', tags: { title: 'よるのうた (Off Vocal)' } }, tricky), null);
  // 「Instant」不是伴奏；歌名本身就是伴奏版的照常配
  assert.equal(matchAudio({ fileName: 'よるのうた instant.flac' }, tricky), id('盤', 'よるのうた'));
  assert.equal(matchAudio({ fileName: 'Ai (Instrumental).flac' }, tricky), id('盤', 'Ai (Instrumental)'));
});

test('反例：標籤的專輯與曲序都對不上任何候選就不配', () => {
  assert.equal(matchAudio({ fileName: 'x.flac', tags: { title: 'Intro', album: '全然別のアルバム', track: 1 } }, tricky), null);
  assert.equal(matchAudio({ fileName: 'x.flac', tags: { title: 'Intro', album: '全然別のアルバム', track: 3 } }, tricky), id('盤', 'Intro'));
  assert.equal(matchAudio({ fileName: 'x.flac', tags: { title: 'Intro', album: '盤', track: 9 } }, tricky), id('盤', 'Intro'));
  assert.equal(matchAudio({ fileName: 'x.flac', tags: { title: 'Intro' } }, tricky), id('盤', 'Intro'));
});

test('反例：檔名開頭的曲序與歌曲不同就不配', () => {
  assert.equal(matchAudio({ fileName: '05 March of Something.flac' }, tricky), null);
  assert.equal(matchAudio({ fileName: '04 March.flac' }, tricky), id('盤', 'March'));
});

test('對不到回傳 null', () => {
  assert.equal(matchAudio({ fileName: 'unknown.flac', tags: { title: 'ない' } }, all), null);
  assert.equal(matchAudio({ fileName: '' }, all), null);
  assert.equal(matchAudio({}, []), null);
});
