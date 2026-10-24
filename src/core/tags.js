// 音檔標籤讀取：FLAC（STREAMINFO / VORBIS_COMMENT / PICTURE）與 MP3（ID3v2.2/2.3/2.4、ID3v1、MPEG 時長）。
// 純 JS，瀏覽器與 Node 共用。只用 blob.size 與 blob.slice(a, b).arrayBuffer() 分段讀取，不會整檔載入。
// 讀取失敗或格式損毀時不丟例外，回傳已讀到的欄位，其餘為 null。

const MAX_FLAC_BLOCKS = 512;
const MAX_STACKED_ID3 = 8;
const MPEG_SCAN_BYTES = 8192;

const VORBIS_FIELDS = new Map([
  ['TITLE', 'title'],
  ['ARTIST', 'artist'],
  ['ALBUM', 'album'],
  ['ALBUMARTIST', 'albumArtist'],
  ['ALBUM ARTIST', 'albumArtist'],
  ['TRACKNUMBER', 'track'],
  ['DISCNUMBER', 'disc'],
]);

const ID3_TEXT_FIELDS = new Map([
  ['TIT2', 'title'],
  ['TPE1', 'artist'],
  ['TALB', 'album'],
  ['TPE2', 'albumArtist'],
  ['TRCK', 'track'],
  ['TPOS', 'disc'],
  ['TT2', 'title'],
  ['TP1', 'artist'],
  ['TAL', 'album'],
  ['TP2', 'albumArtist'],
  ['TRK', 'track'],
  ['TPA', 'disc'],
]);

// MPEG 位元率表（kbps），索引為 header 的 bitrate index
const BITRATE_V1_L1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448];
const BITRATE_V1_L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
const BITRATE_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATE_V2_L1 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256];
const BITRATE_V2_L23 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  2.5: [11025, 12000, 8000],
};

// ---------------------------------------------------------------------------
// 公開介面
// ---------------------------------------------------------------------------

// 選項 picture（預設 true）：設為 false 時不讀取圖片，picture 一律回傳 null。
// 讀取量：FLAC 的 PICTURE block 完全不讀（只移動 offset）；MP3 的 ID3v2 標籤仍照常整段讀入
// （10 + 標籤大小 bytes，內嵌封面的位元組也包含在內），只是 frame 解析時略過 APIC / PIC。
export async function readTags(blob, { picture = true } = {}) {
  const wantPicture = picture !== false;
  const result = emptyResult('unknown');
  try {
    const size = blob.size;
    if (!(size > 0)) return result;
    const head = await readRange(blob, 0, 10);

    // 跳過檔案開頭的 ID3v2 標籤（可能連續多個）
    let firstTag = null;
    let audioStart = 0;
    for (let i = 0; i < MAX_STACKED_ID3; i++) {
      const h = i === 0 ? head : await readRange(blob, audioStart, audioStart + 10);
      const info = parseId3Header(h);
      if (!info) break;
      if (!firstTag) {
        firstTag = { offset: audioStart, major: info.major, flags: info.flags, size: info.size };
      }
      audioStart += info.total;
    }

    const sig = audioStart === 0 ? head.subarray(0, 4) : await readRange(blob, audioStart, audioStart + 4);
    if (isFlacSignature(sig)) {
      result.format = 'flac';
      await readFlac(blob, audioStart, result, wantPicture);
    } else if (firstTag || parseMpegHeader(sig, 0)) {
      result.format = 'mp3';
      await readMp3(blob, audioStart, firstTag, result, wantPicture);
    } else {
      const v1 = await readId3v1(blob, 0);
      if (v1) {
        result.format = 'mp3';
        await readMp3(blob, 0, null, result, wantPicture);
      }
    }
  } catch (e) {
    // 盡量回傳已讀到的欄位
  }
  return result;
}

// ---------------------------------------------------------------------------
// 共用工具
// ---------------------------------------------------------------------------

function emptyResult(format) {
  return {
    format,
    title: null,
    artist: null,
    album: null,
    albumArtist: null,
    track: null,
    disc: null,
    duration: null,
    picture: null,
  };
}

async function readRange(blob, start, end) {
  const s = Math.max(0, Math.floor(start));
  const e = Math.min(blob.size, Math.floor(end));
  if (!(e > s)) return new Uint8Array(0);
  const buf = await blob.slice(s, e).arrayBuffer();
  return new Uint8Array(buf);
}

function u32be(b, i) {
  return b[i] * 0x1000000 + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
}

function u32le(b, i) {
  return b[i + 3] * 0x1000000 + ((b[i + 2] << 16) | (b[i + 1] << 8) | b[i]);
}

function syncsafe(b, i) {
  return ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f);
}

function isSyncsafe(b, i) {
  return (b[i] | b[i + 1] | b[i + 2] | b[i + 3]) < 0x80;
}

function latin1(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 4096) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + 4096)));
  }
  return out;
}

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8').decode(bytes);
}

function decodeUtf16(bytes, littleEndian) {
  const n = bytes.length >> 1;
  let out = '';
  for (let i = 0; i < n; i += 4096) {
    const m = Math.min(n, i + 4096);
    const units = new Array(m - i);
    for (let j = i; j < m; j++) {
      units[j - i] = littleEndian
        ? bytes[2 * j] | (bytes[2 * j + 1] << 8)
        : (bytes[2 * j] << 8) | bytes[2 * j + 1];
    }
    out += String.fromCharCode.apply(null, units);
  }
  return out;
}

// 去掉尾端 \0 並 trim；空字串回傳 null
function cleanString(s) {
  if (typeof s !== 'string') return null;
  let t = s;
  for (;;) {
    let end = t.length;
    while (end > 0 && t.charCodeAt(end - 1) === 0) end--;
    const u = (end === t.length ? t : t.slice(0, end)).trim();
    const done = u.length === t.length;
    t = u;
    if (done) break;
  }
  return t === '' ? null : t;
}

// "3/11" -> 3；非數字回傳 null
function parseIndex(s) {
  const t = cleanString(s);
  if (t === null) return null;
  const m = /^(\d{1,9})\s*(?:\/.*)?$/.exec(t);
  return m ? parseInt(m[1], 10) : null;
}

function setField(r, field, raw) {
  if (r[field] !== null) return;
  r[field] = field === 'track' || field === 'disc' ? parseIndex(raw) : cleanString(raw);
}

function sniffImageMime(data) {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return 'image/png';
  }
  if (data.length >= 4 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) {
    return 'image/gif';
  }
  if (data.length >= 12 && latin1(data.subarray(0, 4)) === 'RIFF' && latin1(data.subarray(8, 12)) === 'WEBP') {
    return 'image/webp';
  }
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp';
  return 'application/octet-stream';
}

// 補全不完整的 mime（jpg -> image/jpeg）；空的 mime 以檔頭判斷。"-->" 表示連結圖片，回傳 null
function normalizeMime(raw, data) {
  let m = (cleanString(raw) || '').toLowerCase();
  if (m === '-->') return null;
  if (m.indexOf('/') < 0) {
    if (m === 'jpg' || m === 'jpeg') m = 'image/jpeg';
    else if (m !== '') m = 'image/' + m;
    else m = sniffImageMime(data);
  } else if (m === 'image/jpg') {
    m = 'image/jpeg';
  }
  return m;
}

// ---------------------------------------------------------------------------
// FLAC
// ---------------------------------------------------------------------------

function isFlacSignature(b) {
  return b.length >= 4 && b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43;
}

async function readFlac(blob, base, r, wantPicture) {
  let pos = base + 4;
  let gotInfo = false;
  let gotComment = false;
  let cover = null;
  let first = null;

  try {
    for (let n = 0; n < MAX_FLAC_BLOCKS; n++) {
      const h = await readRange(blob, pos, pos + 4);
      if (h.length < 4) break;
      const isLast = (h[0] & 0x80) !== 0;
      const type = h[0] & 0x7f;
      const len = (h[1] << 16) | (h[2] << 8) | h[3];
      const body = pos + 4;
      if (type === 127) break;

      if (type === 0 && !gotInfo) {
        gotInfo = true;
        const b = await readRange(blob, body, body + Math.min(len, 18));
        if (b.length >= 18) {
          const rate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
          const total = (b[13] & 0x0f) * 0x100000000 + u32be(b, 14);
          if (rate > 0 && total > 0) r.duration = total / rate;
        }
      } else if (type === 4 && !gotComment) {
        gotComment = true;
        const b = await readRange(blob, body, body + len);
        parseVorbisComment(b, r);
      } else if (type === 6 && wantPicture && !cover) {
        const pic = await readFlacPictureMeta(blob, body, len);
        if (pic) {
          if (pic.type === 3) cover = pic;
          else if (!first) first = pic;
        }
      }

      if (isLast || (gotInfo && gotComment && (cover || !wantPicture))) break;
      pos = body + len;
    }
  } catch (e) {
    // 保留已讀到的欄位
  }

  const pic = cover || first;
  if (pic) {
    try {
      const data = await readRange(blob, pic.dataOffset, pic.dataOffset + pic.dataLen);
      if (data.length === pic.dataLen) {
        const mime = normalizeMime(pic.rawMime, data);
        if (mime !== null) r.picture = { mime, data };
      }
    } catch (e) {
      // 圖片讀取失敗就維持 null
    }
  }
}

function parseVorbisComment(b, r) {
  if (b.length < 8) return;
  let p = 4 + u32le(b, 0);
  if (p + 4 > b.length) return;
  const count = u32le(b, p);
  p += 4;
  for (let i = 0; i < count && p + 4 <= b.length; i++) {
    const len = u32le(b, p);
    p += 4;
    if (p + len > b.length) break;
    const end = p + len;
    let eq = p;
    while (eq < end && b[eq] !== 0x3d) eq++;
    if (eq < end) {
      const key = latin1(b.subarray(p, eq)).toUpperCase();
      const field = VORBIS_FIELDS.get(key);
      if (field !== undefined) setField(r, field, decodeUtf8(b.subarray(eq + 1, end)));
    }
    p = end;
  }
}

// 只讀 PICTURE block 的標頭欄位，圖片資料留到確定要用時再讀
async function readFlacPictureMeta(blob, body, len) {
  const end = Math.min(body + len, blob.size);
  let p = body;
  let b = await readRange(blob, p, Math.min(p + 8, end));
  if (b.length < 8) return null;
  const type = u32be(b, 0);
  const mimeLen = u32be(b, 4);
  p += 8;
  if (p + mimeLen + 4 > end) return null;
  b = await readRange(blob, p, p + mimeLen + 4);
  const rawMime = latin1(b.subarray(0, mimeLen));
  const descLen = u32be(b, mimeLen);
  p += mimeLen + 4 + descLen;
  if (p + 20 > end) return null;
  b = await readRange(blob, p, p + 20);
  if (b.length < 20) return null;
  const dataLen = u32be(b, 16);
  const dataOffset = p + 20;
  if (dataLen === 0 || dataOffset + dataLen > end) return null;
  if (cleanString(rawMime) === '-->') return null;
  return { type, rawMime, dataOffset, dataLen };
}

// ---------------------------------------------------------------------------
// ID3
// ---------------------------------------------------------------------------

function parseId3Header(h) {
  if (h.length < 10 || h[0] !== 0x49 || h[1] !== 0x44 || h[2] !== 0x33) return null;
  const major = h[3];
  if (major < 2 || major > 4 || h[4] === 0xff) return null;
  if (!isSyncsafe(h, 6)) return null;
  const flags = h[5];
  const size = syncsafe(h, 6);
  const footer = major === 4 && (flags & 0x10) !== 0 ? 10 : 0;
  return { major, flags, size, total: 10 + size + footer };
}

// FF 00 -> FF
function ununsync(b) {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    const v = b[i];
    out[n++] = v;
    if (v === 0xff && i + 1 < b.length && b[i + 1] === 0) i++;
  }
  return out.subarray(0, n);
}

// 找字串結尾的 \0（UTF-16 為對齊的雙 \0）；沒有則回傳 -1
function findTerminator(b, start, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = start; i + 1 < b.length; i += 2) {
      if (b[i] === 0 && b[i + 1] === 0) return i;
    }
    return -1;
  }
  for (let i = start; i < b.length; i++) {
    if (b[i] === 0) return i;
  }
  return -1;
}

function decodeId3String(bytes, enc) {
  switch (enc) {
    case 1:
      if (bytes.length >= 2) {
        if (bytes[0] === 0xff && bytes[1] === 0xfe) return decodeUtf16(bytes.subarray(2), true);
        if (bytes[0] === 0xfe && bytes[1] === 0xff) return decodeUtf16(bytes.subarray(2), false);
      }
      return decodeUtf16(bytes, true);
    case 2:
      return decodeUtf16(bytes, false);
    case 3:
      return decodeUtf8(bytes);
    default:
      return latin1(bytes);
  }
}

// 文字 frame：第一個 byte 是編碼，只取第一個字串（多值以 \0 分隔）
function decodeTextFrame(fd) {
  if (fd.length < 2) return null;
  const enc = fd[0];
  const t = findTerminator(fd, 1, enc);
  return decodeId3String(fd.subarray(1, t < 0 ? fd.length : t), enc);
}

function parseApic(fd, major) {
  if (fd.length < 5) return null;
  const enc = fd[0];
  let p;
  let rawMime;
  if (major === 2) {
    const fmt = latin1(fd.subarray(1, 4)).toUpperCase();
    rawMime = fmt === 'JPG' ? 'image/jpeg' : fmt === 'PNG' ? 'image/png' : fmt;
    p = 4;
  } else {
    let z = 1;
    while (z < fd.length && fd[z] !== 0) z++;
    if (z >= fd.length) return null;
    rawMime = latin1(fd.subarray(1, z));
    p = z + 1;
  }
  if (p >= fd.length) return null;
  const type = fd[p++];
  const t = findTerminator(fd, p, enc);
  if (t < 0) return null;
  const dataStart = t + (enc === 1 || enc === 2 ? 2 : 1);
  if (dataStart >= fd.length) return null;
  const data = fd.slice(dataStart);
  const mime = normalizeMime(rawMime, data);
  if (mime === null) return null;
  return { type, mime, data };
}

// v2.4：pos 是否像「下一個 frame 的開頭」：恰為標籤結尾、之後全是 0 的 padding，
// 或是 4 個 [A-Z0-9] 的 id 加上大小不超出標籤的完整 frame header
function isFrameBoundaryV24(data, pos) {
  const n = data.length;
  if (pos === n) return true;
  if (pos > n) return false;
  if (data[pos] === 0) {
    for (let i = pos; i < n; i++) {
      if (data[i] !== 0) return false;
    }
    return true;
  }
  if (pos + 10 > n) return false;
  for (let i = pos; i < pos + 4; i++) {
    const c = data[i];
    if (!((c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39))) return false;
  }
  const size = isSyncsafe(data, pos + 4) ? syncsafe(data, pos + 4) : u32be(data, pos + 4);
  return pos + 10 + size <= n;
}

// v2.4 的 frame 大小應為 syncsafe，但部分舊工具寫成一般大端整數。
// byte >= 0x80 必定不是 syncsafe；全部 < 0x80 時先照 syncsafe 算，若下一個位置不像 frame 開頭、
// 而照一般整數算的位置像，就改用一般整數。sizePos 是 frame header 中 size 欄位的位置。
function frameSizeV24(data, sizePos) {
  const plain = u32be(data, sizePos);
  if (!isSyncsafe(data, sizePos)) return plain;
  const ss = syncsafe(data, sizePos);
  if (ss === plain) return ss;
  const start = sizePos + 6;
  if (isFrameBoundaryV24(data, start + ss)) return ss;
  return isFrameBoundaryV24(data, start + plain) ? plain : ss;
}

function parseId3Frames(body, major, flags, r, wantPicture) {
  let data = body;
  if ((flags & 0x80) !== 0 && major <= 3) data = ununsync(data);
  let p = 0;
  if ((flags & 0x40) !== 0) {
    if (major === 2) return;
    if (data.length < 4) return;
    p = major === 3 ? 4 + u32be(data, 0) : syncsafe(data, 0);
  }
  const tagUnsync = major === 4 && (flags & 0x80) !== 0;
  const idLen = major === 2 ? 3 : 4;
  const hdrLen = major === 2 ? 6 : 10;
  let cover = null;
  let first = null;

  while (p + hdrLen <= data.length) {
    if (data[p] === 0) break;
    const id = latin1(data.subarray(p, p + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break;

    let size;
    if (major === 2) {
      size = (data[p + 3] << 16) | (data[p + 4] << 8) | data[p + 5];
    } else if (major === 3) {
      size = u32be(data, p + 4);
    } else {
      size = frameSizeV24(data, p + 4);
    }
    const fflags = major >= 3 ? (data[p + 8] << 8) | data[p + 9] : 0;
    const start = p + hdrLen;
    const end = start + size;
    p = end;
    if (end > data.length) break;
    if (size === 0) continue;

    const field = ID3_TEXT_FIELDS.get(id);
    const isPic = id === 'APIC' || id === 'PIC';
    if (field === undefined && !isPic) continue;
    if (isPic && (cover || !wantPicture)) continue;
    if (field !== undefined && r[field] !== null) continue;

    let fd = data.subarray(start, end);
    if (major === 3) {
      if ((fflags & 0x00c0) !== 0) continue; // 壓縮（0x0080）或加密（0x0040）
      if ((fflags & 0x0020) !== 0) fd = fd.subarray(1); // grouping identity
    } else if (major === 4) {
      if ((fflags & 0x000c) !== 0) continue; // 壓縮（0x08）或加密（0x04）
      if ((fflags & 0x0040) !== 0) fd = fd.subarray(1); // grouping identity
      if ((fflags & 0x0001) !== 0) fd = fd.subarray(4); // data length indicator
      if (tagUnsync || (fflags & 0x0002) !== 0) fd = ununsync(fd);
    }

    if (field !== undefined) {
      setField(r, field, decodeTextFrame(fd));
    } else {
      const pic = parseApic(fd, major);
      if (pic) {
        if (pic.type === 3) cover = pic;
        else if (!first) first = pic;
      }
    }
  }

  const pic = cover || first;
  if (pic) r.picture = { mime: pic.mime, data: pic.data };
}

async function readId3v1(blob, minStart) {
  const size = blob.size;
  if (size - 128 < minStart) return null;
  const b = await readRange(blob, size - 128, size);
  if (b.length < 128 || b[0] !== 0x54 || b[1] !== 0x41 || b[2] !== 0x47) return null;
  const text = (s, e) => {
    let z = s;
    while (z < e && b[z] !== 0) z++;
    return cleanString(latin1(b.subarray(s, z)));
  };
  return {
    title: text(3, 33),
    artist: text(33, 63),
    album: text(63, 93),
    track: b[125] === 0 && b[126] !== 0 ? b[126] : null,
  };
}

// ---------------------------------------------------------------------------
// MP3
// ---------------------------------------------------------------------------

async function readMp3(blob, audioStart, firstTag, r, wantPicture) {
  let v1 = null;
  try {
    v1 = await readId3v1(blob, audioStart);
  } catch (e) {
    v1 = null;
  }

  if (firstTag) {
    try {
      const bytes = await readRange(blob, firstTag.offset, firstTag.offset + 10 + firstTag.size);
      if (bytes.length > 10) parseId3Frames(bytes.subarray(10), firstTag.major, firstTag.flags, r, wantPicture);
    } catch (e) {
      // 保留已讀到的欄位
    }
  } else if (v1) {
    r.title = v1.title;
    r.artist = v1.artist;
    r.album = v1.album;
    r.track = v1.track;
  }

  try {
    r.duration = await mp3Duration(blob, audioStart, v1 !== null);
  } catch (e) {
    r.duration = null;
  }
}

// 解析 4 byte MPEG audio frame header；無效回傳 null
function parseMpegHeader(b, i) {
  if (i + 4 > b.length) return null;
  const b1 = b[i + 1];
  const b2 = b[i + 2];
  const b3 = b[i + 3];
  if (b[i] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const vbits = (b1 >> 3) & 3;
  if (vbits === 1) return null;
  const lbits = (b1 >> 1) & 3;
  if (lbits === 0) return null;
  const version = vbits === 3 ? 1 : vbits === 2 ? 2 : 2.5;
  const layer = 4 - lbits;
  const brIdx = b2 >> 4;
  if (brIdx === 0 || brIdx === 15) return null;
  const srIdx = (b2 >> 2) & 3;
  if (srIdx === 3) return null;

  let table;
  if (version === 1) table = layer === 1 ? BITRATE_V1_L1 : layer === 2 ? BITRATE_V1_L2 : BITRATE_V1_L3;
  else table = layer === 1 ? BITRATE_V2_L1 : BITRATE_V2_L23;

  return {
    version,
    layer,
    bitrate: table[brIdx], // kbps
    sampleRate: SAMPLE_RATES[version][srIdx],
    samplesPerFrame: layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576,
    hasCrc: (b1 & 1) === 0,
    mono: ((b3 >> 6) & 3) === 3,
  };
}

// 在第一個 frame 內找 Xing/Info 或 VBRI 的 frames 欄位；沒有則回傳 0
function findVbrFrames(win, i, h) {
  const sideInfo = h.version === 1 ? (h.mono ? 17 : 32) : h.mono ? 9 : 17;
  const base = i + 4 + sideInfo;
  const offsets = h.hasCrc ? [base, base + 2] : [base];
  for (const o of offsets) {
    if (o + 8 > win.length) continue;
    const tag = latin1(win.subarray(o, o + 4));
    if (tag === 'Xing' || tag === 'Info') {
      const flags = u32be(win, o + 4);
      if ((flags & 1) !== 0 && o + 12 <= win.length) return u32be(win, o + 8);
      return 0;
    }
  }
  const v = i + 36;
  if (v + 18 <= win.length && latin1(win.subarray(v, v + 4)) === 'VBRI') return u32be(win, v + 14);
  return 0;
}

async function mp3Duration(blob, audioStart, hasV1) {
  const win = await readRange(blob, audioStart, audioStart + MPEG_SCAN_BYTES);
  for (let i = 0; i + 4 <= win.length; i++) {
    if (win[i] !== 0xff || (win[i + 1] & 0xe0) !== 0xe0) continue;
    const h = parseMpegHeader(win, i);
    if (!h) continue;

    const frames = findVbrFrames(win, i, h);
    let seconds;
    if (frames > 0) {
      seconds = (frames * h.samplesPerFrame) / h.sampleRate;
    } else {
      const bytes = blob.size - (audioStart + i) - (hasV1 ? 128 : 0);
      seconds = bytes > 0 ? (bytes * 8) / (h.bitrate * 1000) : null;
    }
    return seconds !== null && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }
  return null;
}
