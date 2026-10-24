import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLibraryFile } from '../src/core/parse.js';

// fixture 全是自編的假歌詞
const parse = (text, path = 'テスト.md') => parseLibraryFile(text, { path });
const textOf = (line) => line.segments.map((s) => s.text).join('');
const lyricLines = (song) => song.lines.filter((l) => !l.blank);
const levels = (r, level) => r.issues.filter((x) => x.level === level);

const SAMPLE = `---
album: 架空アルバム
artist: 架空歌手
year: 2024
cover: cover.jpg          # 選填
audio: 01-hajimari.flac
offset: 0
---

# 01 はじまりの歌

Lyrics by 山田 / Composed by 田中 / Arranged by 佐藤

[00:01.00] あさひが のぼる
[00:03.50] まちが めざめる
[00:05.00-00:08.00] きょうも はじまる

[00:12.00] こえを あげて
ほら いっしょに<00:14.20>(いっしょに！)
[00:20.00]
`;

test('front matter、album 物件與歌曲基本欄位', () => {
  const r = parse(SAMPLE);
  assert.deepEqual(r.album, { title: '架空アルバム', artist: '架空歌手', year: '2024', cover: 'cover.jpg' });
  assert.equal(r.songs.length, 1);
  const [a] = r.songs;
  assert.equal(a.track, 1);
  assert.equal(a.title, 'はじまりの歌');
  assert.equal(a.album, '架空アルバム');
  assert.equal(a.artist, '架空歌手');
  assert.equal(a.path, 'テスト.md');
  assert.equal(a.id, '架空アルバム/はじまりの歌');
  assert.deepEqual(a.credits, ['Lyrics by 山田 / Composed by 田中 / Arranged by 佐藤']);
  assert.deepEqual(a.meta, { audio: '01-hajimari.flac', offset: 0 });
  assert.deepEqual(r.warnings, []);

  const b = parse('# 02. ふたつめの歌\n作詞：鈴木\n\nゆうやけ こやけ\n').songs[0];
  assert.equal(b.track, 2);
  assert.equal(b.title, 'ふたつめの歌');
  assert.deepEqual(b.credits, ['作詞：鈴木']);
  assert.deepEqual(b.meta, {});
  assert.equal(b.timed, false);
  assert.equal(b.duration, null);
});

test('行、空行、時間標記與行內標記', () => {
  const s = parse(SAMPLE).songs[0];
  assert.deepEqual(
    s.lines.map((l) => (l.blank ? '' : textOf(l))),
    ['あさひが のぼる', 'まちが めざめる', 'きょうも はじまる', '', 'こえを あげて', 'ほら いっしょに(いっしょに！)'],
  );
  assert.deepEqual(s.lines[5].segments, [
    { text: 'ほら いっしょに', call: false, at: null, ruby: null },
    { text: '(いっしょに！)', call: true, at: 14.2, ruby: null },
  ]);
  // 只有行內標記的行以第一個行內標記當開始；結束標記行不顯示、不算空行
  assert.deepEqual(s.spans, [
    { start: 1, end: 3.5, line: 0 },
    { start: 3.5, end: 5, line: 1 },
    { start: 5, end: 8, line: 2 },
    { start: 12, end: 14.2, line: 4 },
    { start: 14.2, end: 20, line: 5 },
  ]);
  assert.deepEqual(s.lines[0].times, [1]);
  assert.equal(s.timed, true);
  assert.equal(s.duration, 20);
});

test('隱含結束時間：下一個開始或結束標記；最後一行預設 5 秒；明確結束不截斷別行', () => {
  const s = parse(`# 歌
[00:10.00-00:30.00] ながい いき
[00:12.00] みじかい
[00:15.00] つぎ
[00:20.00]
[00:40.00] さいご
`).songs[0];
  assert.deepEqual(s.spans, [
    { start: 10, end: 30, line: 0 },
    { start: 12, end: 15, line: 1 },
    { start: 15, end: 20, line: 2 },
    { start: 40, end: 45, line: 3 },
  ]);
  assert.equal(s.duration, 45);
});

test('多重行首標記（LRC 重複行）、[mm:ss]、三位小數、分鐘超過 59', () => {
  const s = parse(`# 歌
[00:10.00][01:10.00] くりかえし
[00:15] つぎ
[01:15.125] またつぎ
[61:00.50] とても おそい
`).songs[0];
  assert.deepEqual(s.lines[0].times, [10, 70]);
  assert.deepEqual(
    s.spans.map((x) => [x.start, x.end, x.line]),
    [
      [10, 15, 0],
      [15, 70, 1],
      [70, 75.125, 0],
      [75.125, 3660.5, 2],
      [3660.5, 3665.5, 3],
    ],
  );
});

test('offset 套用到行首、行內與結束標記', () => {
  const s = parse(`---
offset: 1.5
---
# 歌
[00:01.00] いち
に<00:03.00>(さん)
[00:06.00]
`).songs[0];
  assert.equal(s.meta.offset, 1.5);
  assert.deepEqual(s.spans, [
    { start: 2.5, end: 4.5, line: 0 },
    { start: 4.5, end: 7.5, line: 1 },
  ]);
  assert.equal(s.lines[1].segments[1].at, 4.5);
});

test('call：全形／半形括號、跳脫、取最外層、可跨行但不跨段', () => {
  const s = parse(`# 歌
はい（ハイ！）と (よい (しょ) よい) \\(ちがう\\)
(ながい
call です)
ふつう

(とじない
つぎのだん
`).songs[0];
  const L = lyricLines(s);
  assert.deepEqual(L[0].segments, [
    { text: 'はい', call: false, at: null, ruby: null },
    { text: '（ハイ！）', call: true, at: null, ruby: null },
    { text: 'と ', call: false, at: null, ruby: null },
    { text: '(よい (しょ) よい)', call: true, at: null, ruby: null },
    { text: ' (ちがう)', call: false, at: null, ruby: null },
  ]);
  assert.deepEqual(L[1].segments, [{ text: '(ながい', call: true, at: null, ruby: null }]);
  assert.deepEqual(L[2].segments, [{ text: 'call です)', call: true, at: null, ruby: null }]);
  assert.deepEqual(L[3].segments, [{ text: 'ふつう', call: false, at: null, ruby: null }]);
  assert.deepEqual(L[4].segments, [{ text: '(とじない', call: false, at: null, ruby: null }]);
});

test('標題內的括號不是 call；標題數字的各種分隔；\\ 跳脫數字', () => {
  const heads = ['# 03 うた (ver.2)', '# 4-ハイフン', '# 5.ドット', '# 1999', '# \\7 days'];
  assert.deepEqual(
    heads.map((h) => parse(`${h}\nあ\n`).songs[0]).map((s) => [s.track, s.title]),
    [
      [3, 'うた (ver.2)'],
      [4, 'ハイフン'],
      [5, 'ドット'],
      [null, '1999'],
      [null, '7 days'],
    ],
  );
});

test('註解只是備註：一般註解與跨行註解不顯示、行內註解去掉、key: value 不會變成設定', () => {
  const r = parse(`---
album: 盤
---
# 歌
<!-- これはメモ -->
<!-- audio: a.flac; album: 別アルバム -->
<!-- TODO: あとで -->
<!-- TODO: もう一度 -->
<!--
ながいメモ
[00:01.00] これは時間ではない
-->
うたう <!-- ここもメモ --> こえ
`);
  const s = r.songs[0];
  assert.deepEqual(s.meta, {});
  assert.equal(s.album, '盤');
  assert.equal(s.id, '盤/歌');
  assert.deepEqual(s.lines.map(textOf), ['うたう  こえ']);
  assert.equal(s.timed, false);
  assert.deepEqual(r.issues, []);
});

test('專輯名稱：front matter > 子資料夾 > 未分類', () => {
  assert.equal(parse('# 歌\nあ\n', 'わたしのアルバム/x.md').songs[0].album, 'わたしのアルバム');
  assert.equal(parse('# 歌\nあ\n', 'x.md').songs[0].album, '未分類');
  assert.equal(parse('---\nalbum: FM\n---\n# 歌\nあ\n', 'sub/x.md').songs[0].album, 'FM');
});

test('空行：保留段落間的每個空行、裁掉首尾空行；只有註解的行不算空行', () => {
  const s = parse(`# 歌


あ


<!-- メモ -->
い


`).songs[0];
  assert.deepEqual(
    s.lines.map((l) => l.blank),
    [false, true, true, false],
  );
  assert.deepEqual(
    s.lines.map((l) => l.index),
    [0, 1, 2, 3],
  );
});

test('credits 只在第一行歌詞之前；之後出現的同字樣是歌詞', () => {
  const s = parse(`# 歌

Music by 誰か

Words by 別の人
はじまり
作曲 という歌詞
`).songs[0];
  assert.deepEqual(s.credits, ['Music by 誰か', 'Words by 別の人']);
  assert.deepEqual(s.lines.map(textOf), ['はじまり', '作曲 という歌詞']);
});

test('沒有 # 標題的檔案整個當一首歌，歌名與曲序取自檔名', () => {
  const s = parse('[00:01.00] ひとつだけ\n', 'アルバム/07 ひとりの歌.md').songs[0];
  assert.equal(s.track, 7);
  assert.equal(s.title, 'ひとりの歌');
  assert.equal(s.album, 'アルバム');
  assert.equal(s.timed, true);
});

test('CRLF 與 BOM', () => {
  const s = parse(String.fromCharCode(0xfeff) + '# 歌\r\n[00:01.00] あ\r\n\r\nい\r\n').songs[0];
  assert.deepEqual(
    s.lines.map((l) => (l.blank ? '' : textOf(l))),
    ['あ', '', 'い'],
  );
});

test('跳脫：\\[ 讓行首的時間字樣變成文字；\\\\ 是反斜線；其他反斜線保留', () => {
  const s = parse('# 歌\n\\[00:01.00] もじ\na\\\\b c\\d\n').songs[0];
  assert.deepEqual(s.lines.map(textOf), ['[00:01.00] もじ', 'a\\b c\\d']);
  assert.equal(s.timed, false);
});

// ---- 手誤檢查（issues）

test('時間格式錯誤以檔名:行號回報為 error', () => {
  const r = parse(`# 歌
[0:5.2] いち
[00:75.00] に
[00:05.2] さん
[00:05.2345] よん
[00;05.20] ご
ろく<00:7.00>なな
[00:09.00] はち
`);
  const errs = levels(r, 'error');
  assert.deepEqual(
    errs.map((x) => x.line),
    [2, 3, 4, 5, 6, 7],
  );
  assert.match(errs[0].message, /\[0:5\.2\]/);
  assert.match(errs[1].message, /小於 60/);
  assert.match(errs[2].message, /2 或 3 位/);
  assert.ok(r.warnings.every((w) => /^テスト\.md:\d+: /.test(w)));
  // 格式錯的標記不會被當成文字顯示
  assert.equal(textOf(r.songs[0].lines[0]), 'いち');
});

test('歌詞裡的 [1, 2, 3] 不誤判為時間手誤', () => {
  const r = parse('# 歌\n[1, 2, 3] かぞえる\n');
  assert.deepEqual(r.issues, []);
  assert.equal(textOf(r.songs[0].lines[0]), '[1, 2, 3] かぞえる');
});

test('結束早於開始是 error，該行改用隱含結束', () => {
  const r = parse('# 歌\n[00:10.00-00:05.00] あ\n[00:12.00] い\n');
  assert.equal(levels(r, 'error')[0].line, 2);
  assert.deepEqual(r.songs[0].spans[0], { start: 10, end: 12, line: 0 });
});

test('開始時間倒退是 warning；LRC 多重標記的行不檢查', () => {
  const r = parse(`# 歌
[00:10.00] あ
[00:30.00] い
[00:20.00] う
[00:05.00][00:50.00] え
[00:55.00] お
`);
  const w = levels(r, 'warning');
  assert.equal(w.length, 1);
  assert.equal(w[0].line, 4);
  assert.match(w[0].message, /第 3 行/);
});

test('括號沒關是 warning；有時間軸的歌裡沒時間的行是 hint', () => {
  const r = parse(`# 歌
[00:01.00] あ (かっこ
い
`);
  assert.deepEqual(
    r.issues.map((x) => [x.level, x.line]),
    [
      ['warning', 2],
      ['hint', 3],
    ],
  );
  // hint 不進 warnings 字串
  assert.equal(r.warnings.length, 1);
  // 沒有時間軸的歌不提示
  assert.deepEqual(parse('# 歌\nあ\nい\n').issues, []);
});

test('行首時間寫在行中間、行內時間早於行首時間是 warning', () => {
  const r = parse('# 歌\nあ [00:01.00] い\n[00:05.00] う<00:04.00>え\n');
  assert.deepEqual(
    levels(r, 'warning').map((x) => x.line),
    [2, 3],
  );
});

test('front matter 沒結束、註解沒結束是 error', () => {
  assert.equal(levels(parse('---\nalbum: x\n# 歌\nあ\n'), 'error').length, 1);
  assert.equal(levels(parse('# 歌\n<!-- とじない\nあ\n'), 'error').length, 1);
});

test('一個檔只能有一首歌：第二個 # 標題是 error，那一行照字面當歌詞', () => {
  const r = parse('# 01 ひとつめ\nあ\n# 02 ふたつめ\nい\n');
  assert.equal(r.songs.length, 1);
  assert.equal(r.songs[0].title, 'ひとつめ');
  assert.deepEqual(r.songs[0].lines.map(textOf), ['あ', '# 02 ふたつめ', 'い']);
  assert.deepEqual(
    levels(r, 'error').map((x) => x.line),
    [3],
  );
  assert.match(levels(r, 'error')[0].message, /一個檔只能有一首歌/);
  // \# 開頭是歌詞，不是標題
  assert.deepEqual(parse('# 歌\n\\#ハッシュタグ\n').issues, []);
});

test('front matter：offset 不是數字、同一個 key 重複是 warning', () => {
  const r = parse('---\noffset: abc\naudio: a.flac\naudio: b.flac\n---\n# 歌\n[00:01.00] あ\n');
  assert.deepEqual(
    levels(r, 'warning').map((x) => x.line),
    [2, 4],
  );
  assert.match(levels(r, 'warning')[1].message, /第 3 行已設定/);
  assert.deepEqual(r.songs[0].meta, { audio: 'b.flac' });
  assert.equal(r.songs[0].spans[0].start, 1);
});

// ---- 振假名（ruby）

const seg = (text, ruby = null, call = false, at = null) => ({ text, call, at, ruby });

test('ruby：漢字《よみ》的 base 是《前面連續的漢字（含 々〆ヶ）', () => {
  const s = parse(`# 歌
はるの夜空《よぞら》へ
人々《ひとびと》 〆切《しめきり》 三ヶ月《さんかげつ》
`).songs[0];
  assert.deepEqual(s.lines[0].segments, [seg('はるの'), seg('夜空', 'よぞら'), seg('へ')]);
  assert.deepEqual(s.lines[1].segments, [
    seg('人々', 'ひとびと'),
    seg(' '),
    seg('〆切', 'しめきり'),
    seg(' '),
    seg('三ヶ月', 'さんかげつ'),
  ]);
});

test('ruby：｜（全形或半形）標出 base 起點，base 可含假名', () => {
  const s = parse('# 歌\nわたしの｜おうち《ホーム》へ |ゆめ見る《ドリーム》\n').songs[0];
  assert.deepEqual(s.lines[0].segments, [seg('わたしの'), seg('おうち', 'ホーム'), seg('へ '), seg('ゆめ見る', 'ドリーム')]);
});

test('ruby：在 call 內沿用 call 屬性；行內時間延續到被 ruby 切開的後續片段', () => {
  const s = parse('# 歌\n[00:01.00] うたう<00:02.00>(大空《そら》へ)\n').songs[0];
  assert.deepEqual(s.lines[0].segments, [seg('うたう'), seg('(', null, true, 2), seg('大空', 'そら', true, 2), seg('へ)', null, true, 2)]);
  // base 裡的行內時間移到 ruby 片段前面，ruby 片段不被切開
  const t = parse('# 歌\n[00:01.00] あ｜か<00:02.00>な《カナ》\n').songs[0];
  assert.deepEqual(t.lines[0].segments, [seg('あ'), seg('かな', 'カナ', false, 2)]);
});

test('ruby：跳脫與照字面顯示的情形（警告附行號）', () => {
  const r = parse(`# 歌
\\《ちがう》 \\｜これも《もじ》
かな《よみ》
漢字《》
漢字《とじない
`);
  const [a, b, c, d] = r.songs[0].lines;
  assert.deepEqual(a.segments, [seg('《ちがう》 ｜これも《もじ》')]);
  assert.deepEqual(b.segments, [seg('かな《よみ》')]);
  assert.deepEqual(c.segments, [seg('漢字《》')]);
  assert.deepEqual(d.segments, [seg('漢字《とじない')]);
  // 第 2 行：前面的 ｜ 已跳脫、「これも」不是漢字 → 照字面
  assert.deepEqual(
    levels(r, 'warning').map((x) => x.line),
    [2, 3, 4, 5],
  );
});

test('ruby：標題與 credits 不處理，歌名比對不受影響', () => {
  const s = parse('# 01 夜空《よぞら》の歌\nLyrics by 山田《やまだ》\nあ\n').songs[0];
  assert.equal(s.title, '夜空《よぞら》の歌');
  assert.deepEqual(s.credits, ['Lyrics by 山田《やまだ》']);
});

// ---- 審查追加：行內時間延續、標題寫法、手誤偵測、LRC 標籤、meta

test('行內時間延續到被 call / ruby 切開的後續片段，到下一個標記才更新', () => {
  const s = parse('# 歌\n[00:01.00] あ<00:02.00>い(コール)う夜空《よぞら》え<00:04.00>お\n[00:10.00]\n').songs[0];
  assert.deepEqual(
    s.lines[0].segments.map((g) => [g.text, g.at]),
    [
      ['あ', null],
      ['い', 2],
      ['(コール)', 2],
      ['う', 2],
      ['夜空', 2],
      ['え', 2],
      ['お', 4],
    ],
  );
});

test('標題：# 後的空白可省略或用全形空白；## 不算標題', () => {
  const songOf = (text) => parse(text).songs[0];
  assert.deepEqual(
    ['# 01 A\nあ\n', '#02 B\nい\n', '#　03 C\n## サビ\nう\n'].map(songOf).map((s) => [s.track, s.title, s.lines.map(textOf)]),
    [
      [1, 'A', ['あ']],
      [2, 'B', ['い']],
      [3, 'C', ['## サビ', 'う']],
    ],
  );
});

test('行首的全形空白：標記前後的全形空白都不算歌詞', () => {
  const s = parse('# 歌\n　[00:01.00] あ\n[00:02.00]　い\n　ふつう\n').songs[0];
  assert.deepEqual(s.lines.map(textOf), ['あ', 'い', '　ふつう']);
  assert.deepEqual(s.lines[0].times, [1]);
  assert.deepEqual(s.lines[1].times, [2]);
});

test('時間手誤：全形字元、範圍用 ~ 〜 – —、少了 ] 都是格式錯（不只是沒有時間的提示）', () => {
  const r = parse(`# 歌
[00:01.00~00:02.00] いち
[00:01.00〜00:02.00] に
[00:01.00–00:02.00] さん
[00:01.00—00:02.00] よん
[00:01．00] ご
［00:01.00］ ろく
[０１:００.００] なな
[00:01.00 はち
きゅう＜00:01.00＞じゅう
[00:09.00] おわり
`);
  const errs = levels(r, 'error');
  assert.deepEqual(
    errs.map((x) => x.line),
    [2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.match(errs[0].message, /範圍請用半形 -/);
  assert.match(errs[3].message, /範圍請用半形 -/);
  assert.match(errs[4].message, /請改用半形字元：\[00:01\.00\]/);
  assert.match(errs[5].message, /請改用半形字元/);
  assert.match(errs[7].message, /少了 \]/);
  // 格式錯的標記不當歌詞顯示
  assert.deepEqual(r.songs[0].lines.map(textOf).slice(0, 9), ['いち', 'に', 'さん', 'よん', 'ご', 'ろく', 'なな', 'はち', 'きゅうじゅう']);
});

test('LRC 的 ID 標籤行不顯示並給提示；[offset:] 給警告並說明正負相反', () => {
  const r = parse('[ti:うた]\n[ar:だれか]\n[offset:+500]\n[length:03:20]\n[00:01.00] あ\n', 'x/01 うた.md');
  const s = r.songs[0];
  assert.deepEqual(s.lines.map(textOf), ['あ']);
  assert.deepEqual(
    r.issues.map((x) => [x.level, x.line]),
    [
      ['hint', 1],
      ['hint', 2],
      ['warning', 3],
      ['hint', 4],
    ],
  );
  assert.match(r.issues[2].message, /相當於 offset: -0\.5/);
  assert.match(r.issues[2].message, /正負相反/);
  assert.equal(s.meta.offset, undefined);
});

test('警告：行尾的行內時間、行內時間晚於行的結束、重複的行首時間、多餘的 )', () => {
  const r = parse(`# 歌
[00:01.00] あ<00:02.00>い<00:03.00>
[00:05.00] う<00:09.00>え
[00:06.00][00:06.00] お
か) き
[00:20.00]
`);
  const w = levels(r, 'warning');
  assert.deepEqual(
    w.map((x) => x.line),
    [2, 3, 4, 5],
  );
  assert.match(w[0].message, /行尾的 <00:03\.00>/);
  assert.match(w[1].message, /<00:09\.00> 不早於這行的結束時間 00:06\.00/);
  assert.match(w[2].message, /重複的行首時間/);
  assert.match(w[3].message, /多餘的「\)」/);
  // 重複的行首時間只算一次
  assert.deepEqual(r.songs[0].lines[2].times, [6]);
});

test('# 標題之前的文字是 warning 並忽略；註解不算', () => {
  const r = parse('<!-- メモ -->\nまえがき\n# 01 A\nあ\n');
  assert.deepEqual(
    levels(r, 'warning').map((x) => x.line),
    [2],
  );
  assert.deepEqual(r.songs[0].lines.map(textOf), ['あ']);
});
