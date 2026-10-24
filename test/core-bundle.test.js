// 真正的 src/core 能被 bundler 打包，打包後在無 DOM 的環境照常運作（確認 core 遵守模組慣例且不碰 DOM）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { bundleModules } from '../tools/bundle.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('src/core 打包後可執行，結果與直接 import 相同', async () => {
  // bundler 要求入口在 rootDir 內：把 core 複製到暫存目錄，旁邊放一個測試入口
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-core-'));
  try {
    fs.cpSync(path.join(SRC, 'core'), path.join(tmp, 'core'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'entry.js'),
      `import { parseLibraryFile, queryTimeline, segmentLit, stanzaStarts, songId, matchAudio, normalizeTitle, formatTime } from './core/index.js';
const r = parseLibraryFile('# 01 にせの歌\\n[00:01.00] あ<00:01.50>(コール)\\n[00:03.00]\\n', { path: '盤/x.md' });
const s = r.songs[0];
globalThis.result = {
  id: s.id,
  spans: s.spans,
  q: queryTimeline(s, 2),
  lit: [segmentLit(s, 0, 1, 1.2), segmentLit(s, 0, 1, 1.6)],
  stanzas: stanzaStarts(s),
  match: matchAudio({ fileName: '01 にせの歌.flac' }, r.songs),
  same: songId('盤', 'にせの歌') === s.id && normalizeTitle('に・せ') === 'にせ',
  time: formatTime(61.5),
};
`,
    );
    const { code, modules } = await bundleModules(path.join(tmp, 'entry.js'), { rootDir: tmp });
    assert.ok(modules.includes('core/tags.js'));
    const sandbox = { TextDecoder, Uint8Array, DataView, ArrayBuffer, Math, Number, String, Map, Set, Array, Object, JSON, RegExp, Error, Promise };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(code, sandbox);
    assert.deepEqual(JSON.parse(JSON.stringify(sandbox.result)), {
      id: '盤/にせの歌',
      spans: [{ start: 1, end: 3, line: 0 }],
      q: { active: [{ line: 0, start: 1, end: 3 }], latest: 0, next: -1 },
      lit: [false, true],
      stanzas: [1],
      match: '盤/にせの歌',
      same: true,
      time: '01:01.50',
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
