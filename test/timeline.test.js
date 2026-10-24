import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLibraryFile } from '../src/core/parse.js';
import { queryTimeline, segmentLit, stanzaStarts } from '../src/core/timeline.js';

const song = (text) => parseLibraryFile(text, { path: 't.md' }).songs[0];

const S = song(`# 歌
[00:01.00] いち
[00:02.00] に
[00:02.00] にの2
[00:04.00-00:10.00] ながい
[00:05.00] かさなる

[00:12.00] よん<00:13.00>(コール)<00:14.00>おわり
`);

test('queryTimeline：start 含、end 不含', () => {
  assert.deepEqual(queryTimeline(S, 0.5), { active: [], latest: -1, next: 0 });
  assert.deepEqual(queryTimeline(S, 1), { active: [{ line: 0, start: 1, end: 2 }], latest: 0, next: 1 });
  assert.deepEqual(queryTimeline(S, 1.999).latest, 0);
  const at2 = queryTimeline(S, 2);
  assert.deepEqual(
    at2.active.map((a) => a.line),
    [1, 2],
  );
  // 同時開始取前面那行
  assert.equal(at2.latest, 1);
  assert.equal(at2.next, 3);
});

test('queryTimeline：重疊的行與 latest；最後一行之後', () => {
  const r = queryTimeline(S, 6);
  assert.deepEqual(
    r.active.map((a) => a.line),
    [3, 4],
  );
  assert.equal(r.latest, 4);
  assert.equal(r.next, 6);
  // 行 3 的明確結束（10 秒）不是其他行的時間點：行 4 亮到下一段開始（12 秒）
  assert.deepEqual(queryTimeline(S, 11), { active: [{ line: 4, start: 5, end: 12 }], latest: 4, next: 6 });
  const end = queryTimeline(S, 17);
  assert.deepEqual(end, { active: [], latest: -1, next: -1 });
  assert.equal(queryTimeline(S, 16.999).latest, 6);
});

test('segmentLit：沒有行內標記的片段整段亮，有標記的到時間才亮，維持到行結束', () => {
  // 行 6：よん | (コール)@13 | おわり@14，行 12～17
  assert.equal(segmentLit(S, 6, 0, 11.99), false);
  assert.equal(segmentLit(S, 6, 0, 12), true);
  assert.equal(segmentLit(S, 6, 1, 12.99), false);
  assert.equal(segmentLit(S, 6, 1, 13), true);
  assert.equal(segmentLit(S, 6, 2, 13.5), false);
  assert.equal(segmentLit(S, 6, 2, 14), true);
  assert.equal(segmentLit(S, 6, 1, 16.99), true);
  assert.equal(segmentLit(S, 6, 1, 17), false);
  // 不存在的行／片段、空行
  assert.equal(segmentLit(S, 5, 0, 12), false);
  assert.equal(segmentLit(S, 99, 0, 12), false);
  assert.equal(segmentLit(S, 6, 9, 12), false);
});

test('segmentLit：多重行首標記時，行內時間相對於第一次出現位移', () => {
  const s = song(`# 歌
[00:10.00][01:10.00] サビ<00:12.00>(コール)
[00:20.00]
[01:20.00]
`);
  assert.equal(segmentLit(s, 0, 1, 11), false);
  assert.equal(segmentLit(s, 0, 1, 12), true);
  assert.equal(segmentLit(s, 0, 1, 71), false);
  assert.equal(segmentLit(s, 0, 1, 72), true);
  assert.equal(segmentLit(s, 0, 0, 70), true);
});

test('stanzaStarts：每段第一個有時間的行', () => {
  assert.deepEqual(stanzaStarts(S), [1, 12]);
  const s = song(`# 歌
まえおき
[00:03.00] いち

なし

[00:20.00][01:20.00] サビ
`);
  assert.deepEqual(stanzaStarts(s), [3, 20, 80]);
  assert.deepEqual(stanzaStarts(song('# 歌\nあ\n')), []);
});
