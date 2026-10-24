// 歌名正規化：songId 與音檔配對共用。

// 標點（P）、符號（S，含 ♪♡☆〜~ 等）、空白（Z）與控制字元一律去掉。
const DROP_RE = /[\p{P}\p{S}\p{Z}\p{Cc}\p{Cf}\s]/u;

// NFKC、小寫、去掉空白與標點符號。
// 「ほし・ストーリー」與「ほしストーリー」、「PON-PON!!!」與「pon pon」視為同名。
export function normalizeTitle(s) {
  if (s == null) return '';
  const nfkc = String(s).normalize('NFKC').toLowerCase();
  let out = '';
  for (const ch of nfkc) if (!DROP_RE.test(ch)) out += ch;
  // 全是符號的歌名（例如「♡♡♡」）去完會變空字串，退回保留符號的版本，避免 id 撞在一起。
  if (out === '') out = nfkc.replace(/\s+/gu, '');
  return out;
}

export function songId(album, title) {
  return `${normalizeTitle(album)}/${normalizeTitle(title)}`;
}
