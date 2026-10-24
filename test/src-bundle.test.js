// 真正的 src/ 能不能打包：只驗證「能打包」與「輸出語法正確」。
// src/ 還有人在改，所以這裡不斷言模組清單或模組內容。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundleHtml } from '../tools/bundle.mjs';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('src/ 能打包成單一 HTML，輸出的 module script 通過 module goal 語法檢查', async (t) => {
  if (!fs.existsSync(path.join(srcDir, 'index.html'))) {
    t.skip('src/index.html 不存在');
    return;
  }

  const library = { version: 1, files: [] };
  const { html, modules } = await bundleHtml({ srcDir, library });
  assert.ok(modules.length > 0, '沒有任何模組被打包');

  // 只有一個 inline module script，沒有指向本地檔案的 script src
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((m) => ({
    attrs: m[1],
    body: m[2],
  }));
  const moduleScripts = scripts.filter((s) => /\btype\s*=\s*["']?module\b/i.test(s.attrs));
  assert.equal(moduleScripts.length, 1, '應該剛好一個 module script');
  assert.ok(!/\bsrc\s*=/i.test(moduleScripts[0].attrs), 'module script 不該有 src');
  const localSrc = scripts.filter((s) => {
    const m = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(s.attrs);
    const value = m && (m[1] ?? m[2] ?? m[3]);
    return value != null && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value);
  });
  assert.equal(localSrc.length, 0, '不該有指向本地檔案的 script src');

  // library 已注入
  const libraryScript = scripts.find((s) => /\bid\s*=\s*["']?lv-library\b/i.test(s.attrs));
  assert.ok(libraryScript, '找不到 lv-library script');
  assert.deepEqual(JSON.parse(libraryScript.body), library);

  // module goal 語法檢查：用 data: URL 載入，外面包 if (false) 所以不會執行
  const code = moduleScripts[0].body;
  await import('data:text/javascript,' + encodeURIComponent('if (false) {\n' + code + '\n}'));
});
