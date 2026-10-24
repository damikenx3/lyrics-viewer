#!/usr/bin/env node
// lyrics-viewer 指令列工具（零依賴）：build / check / serve / share
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectLibrary, displayPath, relativeUrl, toPosix } from './library.mjs';
import { bundleHtml, BundleError } from './bundle.mjs';
import { startServer, lanAddresses } from './serve.mjs';
import { exportCommitted, ShareError } from './share.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// LV_SRC_DIR 只給測試用：讓 CLI 測試用自己的假介面，不受 src/ 開發中的內容影響。
const SRC_DIR = process.env.LV_SRC_DIR ? path.resolve(process.env.LV_SRC_DIR) : path.join(ROOT, 'src');
const DEFAULT_LIBRARY = path.join(ROOT, 'library');
const DEFAULT_OUT = path.join(ROOT, 'dist', 'lyrics-viewer.html');
const DEFAULT_SHARE_OUT = path.join(ROOT, 'dist', 'share', 'lyrics-viewer.html');
// 格式規格以這個 repo 的為準，歌詞庫裡放一份相同的副本
const SPEC = path.join(ROOT, 'docs', 'lyrics-format.md');
const SPEC_COPY = path.join('docs', 'lyrics-format.md');

const USAGE = `用法：node tools/lv.mjs <指令> [選項]（或 npm run <指令> -- [選項]）

  build   建置單一 HTML
          --library <資料夾>    歌詞庫（預設 library）
          --audio-dir <資料夾>  音檔資料夾，用來產生路徑提示（預設＝歌詞庫）
          --out <檔案>          輸出（預設 dist/lyrics-viewer.html）
  check   跟 build 一樣檢查，但不輸出檔案
          --library、--audio-dir 同上
  serve   區網伺服器，每次開啟 / 都重新建置
          --port <埠號>         預設 8080
          --library、--audio-dir 同上
  share   分享用的單一 HTML：只包含歌詞庫已 commit 的歌詞，不含音源路徑；
          名為 original 的子資料夾裡的歌詞檔不包含
          --library 同上
          --out <檔案>          輸出（預設 dist/share/lyrics-viewer.html）
`;

const LEVEL_LABEL = { error: '錯誤', warning: '警告', hint: '提示' };

function parseArgs(argv, allowed) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      opts.help = true;
      continue;
    }
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m || !allowed.includes(m[1])) throw new Error(`不認得的參數：${a}`);
    const v = m[2] ?? argv[++i];
    if (v == null || v.startsWith('--')) throw new Error(`--${m[1]} 需要一個值`);
    opts[m[1]] = v;
  }
  return opts;
}

const resolveOpt = (v, def) => (v ? path.resolve(process.cwd(), v) : def);

// 歌詞庫裡有規格副本、內容又跟這裡的不同時警告（換行字元不算差異）
function checkSpecCopy(libraryDir, issues) {
  const copy = path.join(libraryDir, SPEC_COPY);
  if (!fs.existsSync(copy) || !fs.existsSync(SPEC)) return;
  const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
  if (read(copy) === read(SPEC)) return;
  issues.push({ level: 'warning', file: displayPath(copy), line: null, message: `格式規格和 ${displayPath(SPEC)} 不同，以後者為準，請把它複製過來覆蓋` });
}

function printLibrary(lib) {
  const songCount = lib.files.reduce((n, f) => n + f.result.songs.length, 0);
  console.log(`歌詞庫：${lib.files.length} 個檔案、${songCount} 首歌`);
  for (const f of lib.files) {
    console.log(`\n${f.shown}  [${f.result.album.title}]${f.coverBytes ? '  封面已內嵌' : ''}`);
    for (const s of f.result.songs) {
      const total = s.lines.filter((l) => !l.blank).length;
      const timed = s.lines.filter((l) => !l.blank && l.times.length).length;
      const a = lib.best?.get(s.id);
      const head = s.track != null ? `${String(s.track).padStart(2, '0')} ` : '';
      console.log(`  ${String(timed).padStart(3)}/${String(total).padEnd(3)}  ${head}${s.title}${a ? `  ♪ ${a.shown}` : ''}`);
    }
  }
  if (lib.audio.length) {
    const unmatched = lib.audio.filter((a) => !a.match);
    const used = new Set([...(lib.best?.values() || [])]);
    const extra = lib.audio.filter((a) => a.match && !used.has(a));
    console.log(`\n音檔：${lib.audio.length} 個，${lib.best.size} 首歌有路徑提示`);
    for (const a of extra) console.log(`  （同一首已有較佳的檔案，略過）${a.shown}`);
    for (const a of unmatched) console.log(`  （對不到歌曲）${a.shown}`);
  }
}

function printIssues(issues) {
  const order = { error: 0, warning: 1, hint: 2 };
  const sorted = issues
    .map((x, i) => ({ x, i }))
    .sort((a, b) => a.x.file.localeCompare(b.x.file) || (a.x.line ?? 0) - (b.x.line ?? 0) || order[a.x.level] - order[b.x.level] || a.i - b.i)
    .map((e) => e.x);
  if (sorted.length) console.log('');
  for (const x of sorted) console.log(`${x.file}${x.line ? `:${x.line}` : ''}: ${LEVEL_LABEL[x.level]}：${x.message}`);
  const count = (lv) => issues.filter((x) => x.level === lv).length;
  console.log(`\n錯誤 ${count('error')}、警告 ${count('warning')}、提示 ${count('hint')}`);
  return count('error');
}

async function buildOrCheck(argv, write) {
  const opts = parseArgs(argv, write ? ['library', 'audio-dir', 'out'] : ['library', 'audio-dir']);
  if (opts.help) return void console.log(USAGE);
  const libraryDir = resolveOpt(opts.library, DEFAULT_LIBRARY);
  const audioDir = resolveOpt(opts['audio-dir'], libraryDir);
  const out = resolveOpt(opts.out, DEFAULT_OUT);
  const outDir = path.dirname(out);

  const lib = await collectLibrary({ libraryDir, audioDir, audioUrl: (abs) => relativeUrl(outDir, abs) });
  if (lib.library) printLibrary(lib);
  if (lib.library) checkSpecCopy(libraryDir, lib.issues);
  const html = await bundleLibrary(lib, write);
  if (printIssues(lib.issues)) {
    console.log(write ? '有錯誤，未輸出檔案。' : '');
    process.exitCode = 1;
    return;
  }
  if (write && html != null) await writeOut(out, html);
}

// 打包也是檢查的一部分（模組慣例違規會在這裡抓到）；問題加進 lib.issues
async function bundleLibrary(lib, write) {
  const htmlPath = path.join(SRC_DIR, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    lib.issues.push({ level: write ? 'error' : 'warning', file: displayPath(htmlPath), line: null, message: '找不到介面主檔，略過打包' });
    return null;
  }
  if (!lib.library) return null;
  try {
    const r = await bundleHtml({ srcDir: SRC_DIR, library: lib.library });
    for (const w of r.warnings) lib.issues.push({ level: 'warning', file: '打包', line: null, message: w });
    return r.html;
  } catch (e) {
    if (!(e instanceof BundleError)) throw e;
    lib.issues.push({ level: 'error', file: '打包', line: null, message: e.message });
    return null;
  }
}

async function writeOut(out, html) {
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.writeFile(out, html, 'utf8');
  console.log(`輸出：${displayPath(out)}（${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB）`);
}

// 分享用：只打包歌詞庫已 commit 的歌詞，不含音源路徑提示
async function share(argv) {
  const opts = parseArgs(argv, ['library', 'out']);
  if (opts.help) return void console.log(USAGE);
  const libraryDir = resolveOpt(opts.library, DEFAULT_LIBRARY);
  const out = resolveOpt(opts.out, DEFAULT_SHARE_OUT);
  if (!fs.existsSync(libraryDir)) throw new Error(`找不到歌詞庫資料夾：${displayPath(libraryDir)}`);

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'lv-share-'));
  try {
    let exp;
    try {
      exp = exportCommitted(libraryDir, tmp);
    } catch (e) {
      if (e instanceof ShareError) throw new Error(e.message);
      throw e;
    }
    console.log(`分享用打包：${displayPath(libraryDir)} 的 commit ${exp.commit.hash}（${exp.commit.date}）${exp.commit.subject}\n`);
    const shownRoot = displayPath(libraryDir);
    const lib = await collectLibrary({
      libraryDir: tmp,
      audioDir: null,
      audioUrl: () => '',
      display: (abs) => `${shownRoot}/${toPosix(path.relative(tmp, abs))}`,
    });
    if (lib.library) printLibrary(lib);
    // 未 commit 的修改：列進警告（算進警告數），輸出後再提醒一次，免得以為分享檔是最新的
    for (const p of exp.pending) {
      const message = p.status === '??' ? '還沒 commit，不會包含在分享檔裡' : '有還沒 commit 的修改，分享檔裡是最後一次 commit 的版本';
      lib.issues.push({ level: 'warning', file: `${shownRoot}/${p.path}`, line: null, message });
    }
    const html = await bundleLibrary(lib, true);
    if (printIssues(lib.issues)) {
      console.log('有錯誤，未輸出檔案。');
      process.exitCode = 1;
      return;
    }
    if (html != null) {
      await writeOut(out, html);
      console.log('不含音源和電腦上的檔案路徑，可以直接分享這個檔案。');
      if (exp.pending.length) {
        console.log(`\n注意：${exp.pending.length} 個歌詞檔的修改沒有包含在分享檔裡（見上面的警告）。要包含的話，先到 ${shownRoot}/ 裡 commit，再重新執行 npm run share。`);
      }
    }
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

async function serve(argv) {
  const opts = parseArgs(argv, ['port', 'library', 'audio-dir']);
  if (opts.help) return void console.log(USAGE);
  const port = Number(opts.port ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`埠號不正確：${opts.port}`);
  const libraryDir = resolveOpt(opts.library, DEFAULT_LIBRARY);
  const audioDir = resolveOpt(opts['audio-dir'], libraryDir);
  let server;
  try {
    server = await startServer({ port, srcDir: SRC_DIR, libraryDir, audioDir });
  } catch (e) {
    if (e.code === 'EADDRINUSE') throw new Error(`埠號 ${port} 已被佔用，改用 --port 指定其他埠號`);
    throw e;
  }
  const actual = server.address().port;
  console.log(`歌詞庫：${displayPath(libraryDir)}　音檔：${displayPath(audioDir)}`);
  console.log(`本機：  http://localhost:${actual}/`);
  for (const ip of lanAddresses()) console.log(`區網：  http://${ip}:${actual}/`);
  console.log(`開發用（未打包）：http://localhost:${actual}/src/index.html`);
  console.log('Ctrl+C 結束');
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  switch (cmd) {
    case 'build':
      return buildOrCheck(argv, true);
    case 'check':
      return buildOrCheck(argv, false);
    case 'serve':
      return serve(argv);
    case 'share':
      return share(argv);
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      return void console.log(USAGE);
    default:
      throw new Error(`不認得的指令：${cmd}\n\n${USAGE}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
