// tools/lv.mjs（build / check）與 serve 的整合測試。全部在暫存目錄用假資料進行。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { startServer, streamFile } from '../tools/serve.mjs';

const LV = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'lv.mjs');
let tmp;

// 最小 FLAC：STREAMINFO（44.1kHz、10 秒）＋ VORBIS_COMMENT
function fakeFlac(tags) {
  const block = (type, body, last) => Buffer.concat([Buffer.from([(last ? 0x80 : 0) | type, body.length >> 16, (body.length >> 8) & 0xff, body.length & 0xff]), body]);
  const si = Buffer.alloc(34);
  si.writeUInt16BE(4096, 0);
  si.writeUInt16BE(4096, 2);
  si.writeBigUInt64BE((44100n << 44n) | (1n << 41n) | (15n << 36n) | 441000n, 10);
  const parts = [Buffer.alloc(4), Buffer.from('test'), Buffer.alloc(4)];
  parts[0].writeUInt32LE(4);
  parts[2].writeUInt32LE(Object.keys(tags).length);
  for (const [k, v] of Object.entries(tags)) {
    const s = Buffer.from(`${k}=${v}`);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(s.length);
    parts.push(len, s);
  }
  return Buffer.concat([Buffer.from('fLaC'), block(0, si, false), block(4, Buffer.concat(parts), true), Buffer.alloc(2000, 0x55)]);
}

// 一個檔一首歌
const SONG_1 = `---
album: テスト盤
artist: テスト歌手
cover: cover.png
---

# 01 にせの歌
Lyrics by だれか

[00:01.00] いち
[00:02.00] に
さん
`;
const SONG_2 = `---
album: テスト盤
artist: テスト歌手
---

# 02 べつの歌
よん
`;

function write(rel, data) {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}

function lv(...args) {
  // GIT_CEILING_DIRECTORIES：git 不往暫存目錄外面找 repo（share 測試）
  const env = { ...process.env, LV_SRC_DIR: path.join(tmp, 'src'), GIT_CEILING_DIRECTORIES: path.dirname(tmp) };
  const r = spawnSync(process.execPath, [LV, ...args], { cwd: tmp, encoding: 'utf8', env });
  return { code: r.status, out: r.stdout + r.stderr };
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-cli-'));
  write('src/index.html', `<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body>
<script id="lv-library" type="application/json">{"version":1,"files":[]}</script>
<script type="module" src="app/main.js"></script></body></html>`);
  write('src/styles.css', 'body { color: red; }');
  write('src/app/main.js', "import { x } from './x.js';\nglobalThis.result = x;\n");
  write('src/app/x.js', 'export const x = 42;\n');
  write('lib/盤/01 にせの歌.md', SONG_1);
  write('lib/盤/02 べつの歌.md', SONG_2);
  write('lib/盤/cover.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  write('audio/sub/01 にせの歌.flac', fakeFlac({ TITLE: 'にせの歌', ALBUM: 'テスト盤', TRACKNUMBER: '1' }));
  write('audio/unrelated.flac', fakeFlac({ TITLE: '無関係' }));
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('check：印出每首歌有時間的行數／總行數、提示，不輸出檔案', () => {
  const r = lv('check', '--library', 'lib', '--audio-dir', 'audio');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /2\/3 +01 にせの歌 +♪ audio\/sub\/01 にせの歌\.flac/);
  assert.match(r.out, /0\/1 +02 べつの歌/);
  assert.match(r.out, /lib\/盤\/01 にせの歌\.md:12: 提示：這行沒有時間/);
  assert.match(r.out, /（對不到歌曲）audio\/unrelated\.flac/);
  assert.match(r.out, /錯誤 0、警告 0、提示 1/);
  assert.equal(fs.existsSync(path.join(tmp, 'dist')), false);
});

test('check：歌詞庫裡的 README.md 是說明文件，不當成歌詞', () => {
  write('lib-readme/README.md', '# 說明\n這個資料夾放歌詞\n');
  write('lib-readme/盤.md', '# 01 にせの歌\nいち\n');
  const r = lv('check', '--library', 'lib-readme', '--audio-dir', 'audio');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /歌詞庫：1 個檔案、1 首歌/);
  assert.doesNotMatch(r.out, /README/);
});

test('check：根目錄 docs/ 裡的規格副本不當成歌詞；和本 repo 的規格不同時警告', () => {
  const spec = fs.readFileSync(path.join(path.dirname(LV), '..', 'docs', 'lyrics-format.md'), 'utf8');
  write('lib-docs/盤.md', '# 01 にせの歌\nいち\n');
  write('lib-docs/docs/lyrics-format.md', spec.replace(/\n/g, '\r\n'));
  let r = lv('check', '--library', 'lib-docs', '--audio-dir', 'audio');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /歌詞庫：1 個檔案、1 首歌/);
  assert.match(r.out, /錯誤 0、警告 0、提示 0/);

  write('lib-docs/docs/lyrics-format.md', spec + '\n多出來的一行\n');
  r = lv('check', '--library', 'lib-docs', '--audio-dir', 'audio');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /lib-docs\/docs\/lyrics-format\.md: 警告：格式規格和 .*docs\/lyrics-format\.md 不同/);
});

test('build：同專輯的每個檔都寫同一張封面時只內嵌一次', () => {
  write('lib-cover/盤/c.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]));
  write('lib-cover/盤/01 a.md', '---\nalbum: 盤\ncover: c.png\n---\n# 01 a\nあ\n');
  write('lib-cover/盤/02 b.md', '---\nalbum: 盤\ncover: c.png\n---\n# 02 b\nい\n');
  write('lib-cover/別/01 c.md', '---\nalbum: 別\ncover: ../盤/c.png\n---\n# 01 c\nう\n');
  const r = lv('build', '--library', 'lib-cover', '--audio-dir', 'audio', '--out', 'out-cover/app.html');
  assert.equal(r.code, 0, r.out);
  const html = fs.readFileSync(path.join(tmp, 'out-cover/app.html'), 'utf8');
  const lib = JSON.parse(/<script id="lv-library" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  const cover = Object.fromEntries(lib.files.map((f) => [f.path, f.cover ? 'data' : null]));
  // 別張專輯用同一張圖時各自內嵌
  assert.deepEqual(cover, { '別/01 c.md': 'data', '盤/01 a.md': 'data', '盤/02 b.md': null });
});

test('build：內嵌歌詞庫、封面 data URL、相對於輸出 HTML 的音檔路徑', () => {
  const r = lv('build', '--library', 'lib', '--audio-dir', 'audio', '--out', 'out/site/app.html');
  assert.equal(r.code, 0, r.out);
  const html = fs.readFileSync(path.join(tmp, 'out/site/app.html'), 'utf8');
  const json = /<script id="lv-library" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1];
  assert.equal(json.includes('<'), false);
  const lib = JSON.parse(json);
  assert.equal(lib.version, 1);
  assert.ok(!Number.isNaN(Date.parse(lib.builtAt)));
  assert.equal(lib.files.length, 2);
  assert.equal(lib.files[0].path, '盤/01 にせの歌.md');
  assert.equal(lib.files[0].text, SONG_1);
  assert.equal(lib.files[1].cover, null);
  assert.equal(lib.files[0].cover, `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64')}`);
  assert.deepEqual(lib.audio, { 'テスト盤/にせの歌': `../../audio/sub/${encodeURIComponent('01 にせの歌.flac')}` });
  assert.match(html, /<style>\s*body \{ color: red; \}/);
  assert.equal((html.match(/<script type="module">/g) || []).length, 1);
});

test('check / build：手誤以「檔名:行號」回報，有錯誤時非零結束且不輸出', () => {
  write('bad/x.md', '# 歌\n[0:5.2] いち\n[00:10.00] に\n[00:08.00] さん\n(とじない\n');
  const r = lv('check', '--library', 'bad');
  assert.equal(r.code, 1);
  assert.match(r.out, /bad\/x\.md:2: 錯誤：時間格式錯：\[0:5\.2\]/);
  assert.match(r.out, /bad\/x\.md:4: 警告：開始時間 00:08\.00/);
  assert.match(r.out, /bad\/x\.md:5: 警告：括號/);
  assert.match(r.out, /bad\/x\.md:5: 提示：/);
  const b = lv('build', '--library', 'bad', '--out', 'bad-out/x.html');
  assert.equal(b.code, 1);
  assert.match(b.out, /未輸出檔案/);
  assert.equal(fs.existsSync(path.join(tmp, 'bad-out')), false);
});

test('跨檔案重複歌曲、封面過大、找不到封面', () => {
  write('dup/a.md', '---\nalbum: 盤\ncover: big.jpg\n---\n# 歌\nあ\n');
  write('dup/b.md', '---\nalbum: 盤\ncover: none.png\n---\n# 歌\nい\n');
  write('dup/big.jpg', Buffer.alloc(401 * 1024));
  const r = lv('check', '--library', 'dup');
  assert.equal(r.code, 1);
  assert.match(r.out, /dup\/a\.md:3: 警告：封面圖檔 401 KB/);
  assert.match(r.out, /dup\/b\.md:3: 警告：找不到封面圖檔：none\.png/);
  assert.match(r.out, /dup\/b\.md:5: 錯誤：歌曲「歌」與 dup\/a\.md:5 的歌同名且同專輯/);
});

test('打包錯誤會被 check 抓到', () => {
  write('src2/index.html', '<script id="lv-library" type="application/json">{}</script><script type="module" src="main.js"></script>');
  write('src2/main.js', 'export default 1;\n');
  const r = spawnSync(process.execPath, [LV, 'check', '--library', 'lib'], { cwd: tmp, encoding: 'utf8', env: { ...process.env, LV_SRC_DIR: path.join(tmp, 'src2') } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /打包: 錯誤：.*main\.js:1/);
});

test('參數錯誤', () => {
  assert.equal(lv('build', '--nope').code, 1);
  assert.equal(lv('frobnicate').code, 1);
  assert.match(lv('help').out, /build/);
});

test('serve：/ 即時建置、/audio 支援 Range、/src 開發模式、擋路徑越界', async () => {
  const server = await startServer({
    port: 0,
    host: '127.0.0.1',
    srcDir: path.join(tmp, 'src'),
    libraryDir: path.join(tmp, 'lib'),
    audioDir: path.join(tmp, 'audio'),
    log: () => {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const home = await fetch(base + '/');
    assert.equal(home.status, 200);
    const html = await home.text();
    const lib = JSON.parse(/<script id="lv-library" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
    const url = lib.audio['テスト盤/にせの歌'];
    assert.equal(url, `/audio/sub/${encodeURIComponent('01 にせの歌.flac')}`);

    // 每次請求都重新建置：改了歌詞馬上看得到
    write('lib/盤/01 にせの歌.md', SONG_1.replace('さん', 'さんばん'));
    assert.match(await (await fetch(base + '/')).text(), /さんばん/);

    const full = await fetch(base + url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(full.headers.get('content-type'), 'audio/flac');
    const size = (await full.arrayBuffer()).byteLength;

    const part = await fetch(base + url, { headers: { Range: 'bytes=0-3' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 0-3/${size}`);
    assert.equal(Buffer.from(await part.arrayBuffer()).toString(), 'fLaC');

    const tail = await fetch(base + url, { headers: { Range: 'bytes=-2' } });
    assert.equal(tail.status, 206);
    assert.equal((await tail.arrayBuffer()).byteLength, 2);

    const open = await fetch(base + url, { headers: { Range: `bytes=${size - 10}-` } });
    assert.equal(open.status, 206);
    assert.equal((await open.arrayBuffer()).byteLength, 10);

    assert.equal((await fetch(base + url, { headers: { Range: `bytes=${size}-` } })).status, 416);
    assert.equal((await fetch(base + '/audio/..%2F..%2Fsrc%2Fapp%2Fx.js')).status, 403);
    assert.equal((await fetch(base + '/audio/missing.flac')).status, 404);
    // /audio/ 只提供音檔
    write('audio/notes.txt', 'memo');
    assert.equal((await fetch(base + '/audio/notes.txt')).status, 404);
    // /src 轉到 /src/
    const redirect = await fetch(base + '/src', { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), '/src/');

    const js = await fetch(base + '/src/app/x.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /text\/javascript/);
    const dev = await (await fetch(base + '/src/index.html')).text();
    assert.match(dev, /<script type="module" src="app\/main\.js">/);
    assert.match(dev, /にせの歌/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('serve：client 在檔案開啟前就中斷，不會崩潰也不洩漏 read stream', async () => {
  const file = path.join(tmp, 'audio/sub/01 にせの歌.flac');
  const logs = [];

  // 對一個「已離開」的假 response 呼叫 streamFile。事件順序是確定的：
  // fs 的 open 回呼一定排在目前這段同步程式與 nextTick（res 的 close 事件）之後。
  // 舊程式會在 open 事件裡同步丟 ERR_STREAM_UNABLE_TO_PIPE（uncaughtException），
  // 所以暫時接管 uncaughtException，讓它變成可斷言的失敗而不是整個測試行程結束。
  async function dead(closedBeforeCall) {
    const res = new Writable({ write: (chunk, enc, cb) => cb() });
    const headed = [];
    res.writeHead = (...args) => headed.push(args);
    if (closedBeforeCall) {
      res.destroy();
      await once(res, 'close'); // close 已經發生：只剩 open 事件裡的檢查能擋住
    }
    let rs;
    const createReadStream = fs.createReadStream;
    fs.createReadStream = (...args) => (rs = createReadStream.apply(fs, args));
    const saved = process.listeners('uncaughtException');
    process.removeAllListeners('uncaughtException');
    let onCrash;
    const crashed = new Promise((resolve) => process.once('uncaughtException', (onCrash = resolve)));
    try {
      streamFile(res, file, {}, 200, { 'Content-Type': 'audio/flac' }, (m) => logs.push(m));
      if (!closedBeforeCall) res.destroy(); // 開檔還沒完成，client 就走了
      const crash = await Promise.race([once(rs, 'close').then(() => null), crashed]);
      assert.equal(crash, null, `不該有 uncaught exception：${crash && crash.message}`);
      assert.deepEqual(headed, [], '已離開的 client 不該再寫 header');
      assert.equal(rs.destroyed, true);
      assert.equal(rs.fd, null, 'read stream 的 fd 要關掉');
    } finally {
      fs.createReadStream = createReadStream;
      process.off('uncaughtException', onCrash);
      for (const l of saved) process.on('uncaughtException', l);
    }
  }

  await dead(true); // 開檔時 res 已經關閉
  await dead(false); // 開檔前 res 才關閉（由 res 的 close 事件關掉 read stream）
  assert.deepEqual(logs, []);

  // 之後的請求照常
  const server = await startServer({
    port: 0,
    host: '127.0.0.1',
    srcDir: path.join(tmp, 'src'),
    libraryDir: path.join(tmp, 'lib'),
    audioDir: path.join(tmp, 'audio'),
    log: () => {},
  });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/audio/sub/${encodeURIComponent('01 にせの歌.flac')}`);
    assert.equal(r.status, 200);
    assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 4).toString(), 'fLaC');
  } finally {
    // 連線是否已閒置取決於時序，直接關掉，免得 close 等 keep-alive 逾時
    await new Promise((r) => {
      server.close(r);
      server.closeAllConnections();
    });
  }
});

const hasGit = spawnSync('git', ['--version']).status === 0;

test('share：只打包已 commit 的歌詞與封面，不含音源路徑；列出未 commit 的檔', { skip: !hasGit && '沒有 git' }, () => {
  const repo = path.join(tmp, 'repo');
  const g = (...args) => {
    const r = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  write('repo/盤/01 a.md', '---\nalbum: 盤\ncover: c.png\naudio: 01 a.flac\n---\n# 01 a\n[00:01.00] コミット済み\n');
  write('repo/盤/c.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 7]));
  write('repo/盤/01 a.flac', fakeFlac({ TITLE: 'a', ALBUM: '盤' }));
  write('repo/README.md', '# 說明\n');
  write('repo/.gitignore', '*.flac\n');
  g('init', '-q');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  // 還沒 commit 的修改與新檔
  write('repo/盤/01 a.md', '---\nalbum: 盤\n---\n# 01 a\n[00:01.00] 編集中\n');
  write('repo/盤/02 b.md', '---\nalbum: 盤\n---\n# 02 b\nまだ\n');

  const r = lv('share', '--library', 'repo', '--out', 'share-out/x.html');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /commit [0-9a-f]+（\d{4}-\d{2}-\d{2}）init/);
  assert.match(r.out, /歌詞庫：1 個檔案、1 首歌/);
  assert.match(r.out, /repo\/盤\/01 a\.md +\[盤\]/);
  assert.match(r.out, /repo\/盤\/01 a\.md: 警告：有還沒 commit 的修改，分享檔裡是最後一次 commit 的版本/);
  assert.match(r.out, /repo\/盤\/02 b\.md: 警告：還沒 commit，不會包含在分享檔裡/);
  assert.match(r.out, /錯誤 0、警告 2/);
  assert.match(r.out, /注意：2 個歌詞檔的修改沒有包含在分享檔裡/);
  const html = fs.readFileSync(path.join(tmp, 'share-out/x.html'), 'utf8');
  const lib = JSON.parse(/<script id="lv-library" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.deepEqual(lib.audio, {});
  assert.deepEqual(lib.files.map((f) => f.path), ['盤/01 a.md']);
  assert.match(lib.files[0].text, /コミット済み/);
  assert.match(lib.files[0].cover, /^data:image\/png;base64,/);
  assert.equal(html.includes(tmp.replace(/\\/g, '/')), false);
  assert.equal(html.includes(tmp), false);
});

test('share：略過名為 original 的子資料夾裡的歌詞檔（任一層、不分大小寫），圖片照常', { skip: !hasGit && '沒有 git' }, () => {
  const repo = path.join(tmp, 'repo-skip');
  const g = (...args) => {
    const r = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  write('repo-skip/盤/01 a.md', '---\nalbum: 盤\ncover: original/c.png\n---\n# 01 a\n[00:01.00] 公開\n');
  write('repo-skip/盤/original/c.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]));
  // 和上面同專輯同歌名：沒略過的話會是「同專輯有同名的歌」錯誤
  write('repo-skip/盤/original/01 a.md', '---\nalbum: 盤\n---\n# 01 a\n[00:01.00] 原稿\n');
  write('repo-skip/盤/Original/03 c.md', '# 03 c\n原稿\n');
  write('repo-skip/original/04 d.md', '# 04 d\n原稿\n');
  // 名稱要完全相同，originals 不算
  write('repo-skip/盤/originals/02 b.md', '---\nalbum: 盤\n---\n# 02 b\n[00:02.00] 公開その2\n');
  g('init', '-q');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  // original 裡還沒 commit 的修改與新檔：不列進警告
  write('repo-skip/盤/original/01 a.md', '---\nalbum: 盤\n---\n# 01 a\n[00:01.00] 原稿の編集中\n');
  write('repo-skip/盤/original/05 e.md', '# 05 e\n原稿\n');

  const r = lv('share', '--library', 'repo-skip', '--out', 'share-skip/x.html');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /歌詞庫：2 個檔案、2 首歌/);
  assert.match(r.out, /錯誤 0、警告 0/);
  assert.doesNotMatch(r.out, /注意：/);
  const html = fs.readFileSync(path.join(tmp, 'share-skip/x.html'), 'utf8');
  const lib = JSON.parse(/<script id="lv-library" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.deepEqual(lib.files.map((f) => f.path).sort(), ['盤/01 a.md', '盤/originals/02 b.md']);
  assert.equal(html.includes('原稿'), false);
  assert.match(lib.files.find((f) => f.path === '盤/01 a.md').cover, /^data:image\/png;base64,/);
});

test('share：只有 original 裡有歌詞時視為沒有歌詞檔', { skip: !hasGit && '沒有 git' }, () => {
  write('repo-only-original/original/a.md', '# a\nあ\n');
  const repo = path.join(tmp, 'repo-only-original');
  const g = (...args) => assert.equal(spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args]).status, 0);
  g('init', '-q');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  const r = lv('share', '--library', 'repo-only-original', '--out', 'share-skip2/x.html');
  assert.equal(r.code, 1);
  assert.match(r.out, /沒有任何歌詞檔/);
  assert.equal(fs.existsSync(path.join(tmp, 'share-skip2')), false);
});

test('share：不是 git repo、或還沒有 commit 時報錯', { skip: !hasGit && '沒有 git' }, () => {
  let r = lv('share', '--library', 'lib', '--out', 'share-none/x.html');
  assert.equal(r.code, 1);
  assert.match(r.out, /不是 git repo/);
  write('repo-empty/a.md', '# a\nあ\n');
  spawnSync('git', ['-C', path.join(tmp, 'repo-empty'), 'init', '-q']);
  r = lv('share', '--library', 'repo-empty', '--out', 'share-none/x.html');
  assert.equal(r.code, 1);
  assert.match(r.out, /還沒有任何 commit/);
  assert.equal(fs.existsSync(path.join(tmp, 'share-none')), false);
});
