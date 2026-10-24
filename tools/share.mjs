// 分享用打包：只取歌詞庫 repo 已 commit 的內容（HEAD），未 commit 的修改與音源一律不包含。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export class ShareError extends Error {}

// 要取出的檔案：歌詞與封面圖
const EXPORT_EXTS = new Set(['.md', '.jpg', '.jpeg', '.png', '.webp', '.gif']);

// binary: 回傳 Buffer（讀 blob 用），否則回傳字串
function git(dir, args, { input, binary = false } = {}) {
  const r = spawnSync('git', ['-C', dir, '-c', 'core.quotepath=false', ...args], {
    input: input == null ? undefined : Buffer.from(input, 'utf8'),
    encoding: binary ? undefined : 'utf8',
    maxBuffer: 1 << 30,
  });
  if (r.error) {
    if (r.error.code === 'ENOENT') throw new ShareError('找不到 git，分享用打包需要 git');
    throw r.error;
  }
  return r;
}

// 名為 original 的子資料夾（任一層、不分大小寫）放的是原稿，分享時略過裡面的歌詞檔
const inOriginalDir = (rel) => rel.toLowerCase().split('/').slice(0, -1).includes('original');

const isLyrics = (rel) => {
  const lower = rel.toLowerCase();
  return lower.endsWith('.md') && path.posix.basename(lower) !== 'readme.md' && lower.split('/')[0] !== 'docs' && !inOriginalDir(rel);
};

// 把 libraryDir 在 HEAD 的歌詞與封面寫到 destDir（保持相對路徑）。
// 回傳 { commit: { hash, date, subject }, count, pending: [{ status, path }] }；pending 是有未 commit 修改的歌詞檔。
export function exportCommitted(libraryDir, destDir) {
  const prefixRes = git(libraryDir, ['rev-parse', '--show-prefix']);
  if (prefixRes.status !== 0) throw new ShareError(`${libraryDir} 不是 git repo。分享用打包只包含已 commit 的歌詞，請先把歌詞庫 clone 下來或 git init`);
  const prefix = prefixRes.stdout.trim();
  const head = git(libraryDir, ['log', '-1', '--format=%h%x00%cs%x00%s']);
  if (head.status !== 0) throw new ShareError('歌詞庫還沒有任何 commit，請先 commit 完成的歌詞');
  const [hash, date, subject] = head.stdout.trim().split('\0');

  // HEAD 裡這個資料夾底下的檔案：「<mode> <type> <sha>\t<完整路徑>」以 \0 分隔
  const tree = git(libraryDir, ['ls-tree', '-r', '-z', '--full-name', 'HEAD', '--', '.']);
  if (tree.status !== 0) throw new ShareError(`讀取 commit 內容失敗：${tree.stderr.trim()}`);
  const entries = [];
  for (const rec of tree.stdout.split('\0')) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(rec);
    if (!m) continue;
    const rel = m[2].startsWith(prefix) ? m[2].slice(prefix.length) : m[2];
    const ext = path.posix.extname(rel).toLowerCase();
    if (!EXPORT_EXTS.has(ext) || (ext === '.md' && inOriginalDir(rel))) continue;
    entries.push({ sha: m[1], rel });
  }
  if (!entries.some((e) => isLyrics(e.rel))) throw new ShareError('最後一次 commit 裡沒有任何歌詞檔');

  // 一次讀出所有 blob：每筆是「<sha> blob <size>\n<內容>\n」
  const batch = git(libraryDir, ['cat-file', '--batch'], { input: entries.map((e) => e.sha).join('\n') + '\n', binary: true });
  if (batch.status !== 0) throw new ShareError(`讀取 commit 內容失敗：${batch.stderr.toString().trim()}`);
  const buf = batch.stdout;
  let pos = 0;
  for (const e of entries) {
    const nl = buf.indexOf(0x0a, pos);
    const size = Number(buf.toString('utf8', pos, nl).split(' ')[2]);
    const data = buf.subarray(nl + 1, nl + 1 + size);
    pos = nl + 1 + size + 1;
    const out = path.join(destDir, ...e.rel.split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
  }

  // 未 commit 的歌詞檔：「XY 路徑」以 \0 分隔；改名時後面多一筆原路徑
  const status = git(libraryDir, ['status', '--porcelain=v1', '-z', '-uall', '--', '.']);
  const pending = [];
  const recs = status.status === 0 ? status.stdout.split('\0') : [];
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (rec.length < 4) continue;
    const code = rec.slice(0, 2);
    // porcelain 的路徑相對於 repo 根目錄
    const full = rec.slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++;
    const rel = full.startsWith(prefix) ? full.slice(prefix.length) : full;
    if (isLyrics(rel)) pending.push({ status: code.trim(), path: rel });
  }
  return { commit: { hash, date, subject }, count: entries.filter((e) => isLyrics(e.rel)).length, pending };
}
