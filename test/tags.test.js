import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTags } from '../src/core/tags.js';

// ---------------------------------------------------------------------------
// 位元組組裝 helper（所有 fixture 都在這裡用程式組出來）
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

function latin1Bytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// 字串視為 latin1；陣列/TypedArray 直接用
function cat(...parts) {
  const arrs = parts.map((p) => (typeof p === 'string' ? latin1Bytes(p) : Uint8Array.from(p)));
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

const u24be = (n) => [(n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u32be = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u32le = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const syncsafe = (n) => [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f];
const utf8 = (s) => textEncoder.encode(s);
const zeros = (n) => new Uint8Array(n);

function utf16le(s) {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    out[2 * i] = s.charCodeAt(i) & 255;
    out[2 * i + 1] = s.charCodeAt(i) >> 8;
  }
  return out;
}

function utf16be(s) {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    out[2 * i] = s.charCodeAt(i) >> 8;
    out[2 * i + 1] = s.charCodeAt(i) & 255;
  }
  return out;
}

function approx(actual, expected, eps = 1e-6) {
  assert.ok(typeof actual === 'number', `expected number, got ${actual}`);
  assert.ok(Math.abs(actual - expected) < eps, `expected ${expected}, got ${actual}`);
}

const blobOf = (...parts) => new Blob([cat(...parts)]);

// 假的圖片資料
const JPEG_BYTES = cat([0xff, 0xd8, 0xff, 0xe0], 'FAKE-JPEG-COVER', [0xff, 0x00, 0xff, 0xd9]);
const PNG_BYTES = cat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'FAKE-PNG-BODY');

const EMPTY = {
  title: null,
  artist: null,
  album: null,
  albumArtist: null,
  track: null,
  disc: null,
  duration: null,
  picture: null,
};

// ---------------------------------------------------------------------------
// FLAC fixture
// ---------------------------------------------------------------------------

function flacBlock(type, body, last = false) {
  return cat([(last ? 0x80 : 0) | type], u24be(body.length), body);
}

function streamInfo({ sampleRate = 44100, channels = 2, bps = 16, totalSamples = 0 } = {}) {
  const b = new Uint8Array(34);
  b.set([0x10, 0x00, 0x10, 0x00], 0); // min/max block size
  const packed =
    (BigInt(sampleRate) << 44n) | (BigInt(channels - 1) << 41n) | (BigInt(bps - 1) << 36n) | BigInt(totalSamples);
  for (let i = 0; i < 8; i++) b[10 + i] = Number((packed >> BigInt(56 - 8 * i)) & 0xffn);
  return b;
}

function vorbisComment(entries, vendor = 'Fake Encoder 1.0') {
  const parts = [u32le(utf8(vendor).length), utf8(vendor), u32le(entries.length)];
  for (const e of entries) {
    const b = utf8(e);
    parts.push(u32le(b.length), b);
  }
  return cat(...parts);
}

function flacPicture({ type = 3, mime = 'image/jpeg', desc = '', data }) {
  const d = utf8(desc);
  return cat(
    u32be(type),
    u32be(mime.length),
    mime,
    u32be(d.length),
    d,
    u32be(640),
    u32be(480),
    u32be(24),
    u32be(0),
    u32be(data.length),
    data,
  );
}

// blocks: [[type, body], ...]；最後一個 block 自動加上 last 旗標
function flacFile(blocks, audio = new Uint8Array(0), prefix = new Uint8Array(0)) {
  const parts = blocks.map(([type, body], i) => flacBlock(type, body, i === blocks.length - 1));
  return cat(prefix, 'fLaC', ...parts, audio);
}

// ---------------------------------------------------------------------------
// ID3 fixture
// ---------------------------------------------------------------------------

function frame(major, id, body, flags = 0) {
  if (major === 2) return cat(id, u24be(body.length), body);
  const size = major === 4 ? syncsafe(body.length) : u32be(body.length);
  return cat(id, size, [flags >> 8, flags & 0xff], body);
}

function id3Tag(major, body, { flags = 0 } = {}) {
  const footer = major === 4 && (flags & 0x10) !== 0 ? cat('3DI', [major, 0, flags], syncsafe(body.length)) : [];
  return cat('ID3', [major, 0, flags], syncsafe(body.length), body, footer);
}

// 文字 frame 內容
const textLatin1 = (s) => cat([0], latin1Bytes(s));
const textUtf16Bom = (s) => cat([1, 0xff, 0xfe], utf16le(s));
const textUtf16BomBe = (s) => cat([1, 0xfe, 0xff], utf16be(s));
const textUtf16Be = (s) => cat([2], utf16be(s));
const textUtf8 = (s) => cat([3], utf8(s));

// APIC 內容（v2.3/2.4）
function apicBody({ enc = 0, mime = 'image/jpeg', type = 3, desc = new Uint8Array(0), data }) {
  const term = enc === 1 || enc === 2 ? [0, 0] : [0];
  return cat([enc], mime, [0], [type], desc, term, data);
}

// 還原 unsync 的反向：在 FF 後面接 00 或 >= E0 的 byte（以及結尾的 FF）之間插入 00
function unsync(b) {
  const out = [];
  for (let i = 0; i < b.length; i++) {
    out.push(b[i]);
    if (b[i] === 0xff && (i === b.length - 1 || b[i + 1] === 0 || b[i + 1] >= 0xe0)) out.push(0);
  }
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// MPEG fixture
// ---------------------------------------------------------------------------

const BITRATES = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };

function mpegHeader({ version = 1, layer = 3, bitrate = 128, sampleRate = 44100, mono = false, crc = false } = {}) {
  const vbits = { 1: 3, 2: 2, 2.5: 0 }[version];
  const lbits = { 1: 3, 2: 2, 3: 1 }[layer];
  const table = BITRATES[`${version === 1 ? 1 : 2}-${layer}`];
  const brIdx = table.indexOf(bitrate);
  const srIdx = RATES[version].indexOf(sampleRate);
  assert.ok(brIdx > 0 && srIdx >= 0, 'bad mpeg fixture params');
  return [0xff, 0xe0 | (vbits << 3) | (lbits << 1) | (crc ? 0 : 1), (brIdx << 4) | (srIdx << 2), mono ? 0xc0 : 0];
}

// 一個完整 MPEG frame（header + 補零），可在指定位置塞資料
function mpegFrame(opts = {}, inserts = []) {
  const { version = 1, layer = 3, bitrate = 128, sampleRate = 44100 } = opts;
  let len;
  if (layer === 1) len = Math.floor((12 * bitrate * 1000) / sampleRate) * 4;
  else if (layer === 3 && version !== 1) len = Math.floor((72 * bitrate * 1000) / sampleRate);
  else len = Math.floor((144 * bitrate * 1000) / sampleRate);
  const f = new Uint8Array(len);
  f.set(mpegHeader(opts), 0);
  for (const [off, bytes] of inserts) f.set(bytes, off);
  return f;
}

function sideInfoSize({ version = 1, mono = false } = {}) {
  return version === 1 ? (mono ? 17 : 32) : mono ? 9 : 17;
}

function xingFrame({ tag = 'Xing', frames = 1000, flags = 0x0001, crc = false, ...opts } = {}) {
  const off = 4 + (crc ? 2 : 0) + sideInfoSize(opts);
  const body = cat(tag, u32be(flags), (flags & 1) !== 0 ? u32be(frames) : []);
  return mpegFrame({ ...opts, crc }, [[off, body]]);
}

function vbriFrame({ frames = 2000, ...opts } = {}) {
  const body = cat('VBRI', [0, 1], [0, 0], [0, 0], u32be(123456), u32be(frames));
  return mpegFrame(opts, [[4 + 32, body]]);
}

function id3v1({ title = '', artist = '', album = '', track = 0 } = {}) {
  const pad = (s, n) => {
    const b = latin1Bytes(s);
    const out = new Uint8Array(n);
    out.set(b.subarray(0, n));
    return out;
  };
  return cat('TAG', pad(title, 30), pad(artist, 30), pad(album, 30), '2020', pad('', 28), [0, track], [255]);
}

// ---------------------------------------------------------------------------
// 讀取計數用的假 Blob
// ---------------------------------------------------------------------------

function countingBlob(bytes) {
  const state = { bytesRead: 0, sliceCalls: 0, wholeFileCalls: 0 };
  const blob = {
    size: bytes.length,
    slice(a, b) {
      state.sliceCalls++;
      return {
        async arrayBuffer() {
          const part = bytes.slice(a, b);
          state.bytesRead += part.length;
          return part.buffer;
        },
      };
    },
    arrayBuffer() {
      state.wholeFileCalls++;
      throw new Error('whole-file arrayBuffer() is forbidden');
    },
    text() {
      state.wholeFileCalls++;
      throw new Error('whole-file text() is forbidden');
    },
    stream() {
      state.wholeFileCalls++;
      throw new Error('whole-file stream() is forbidden');
    },
  };
  return { blob, state };
}

// ===========================================================================
// FLAC
// ===========================================================================

test('FLAC: STREAMINFO 算出 duration', async () => {
  const bytes = flacFile([[0, streamInfo({ sampleRate: 44100, totalSamples: 44100 * 200 })]]);
  const r = await readTags(new Blob([bytes]));
  assert.equal(r.format, 'flac');
  approx(r.duration, 200);
  assert.deepEqual({ ...r, format: undefined, duration: null }, { ...EMPTY, format: undefined });
});

test('FLAC: 48kHz 非整數秒、total samples 超過 32 bit、total=0', async () => {
  let r = await readTags(blobOf(flacFile([[0, streamInfo({ sampleRate: 48000, totalSamples: 48000 * 3 + 12000 })]])));
  approx(r.duration, 3.25);

  const big = 5_000_000_000; // > 2^32
  r = await readTags(blobOf(flacFile([[0, streamInfo({ sampleRate: 96000, totalSamples: big })]])));
  approx(r.duration, big / 96000);

  r = await readTags(blobOf(flacFile([[0, streamInfo({ sampleRate: 44100, totalSamples: 0 })]])));
  assert.equal(r.format, 'flac');
  assert.equal(r.duration, null);
});

test('FLAC: VORBIS_COMMENT 大小寫混用的 key、3/11 track、同 key 取第一則', async () => {
  const comment = vorbisComment([
    'Title=テスト曲',
    'artist=Fake Artist',
    'AlBuM=Fake Album',
    'AlbumArtist=Fake Album Artist',
    'tracknumber=3/11',
    'DiscNumber=1/2',
    'TITLE=第二個標題',
    'ARTIST=Second Artist',
    'GENRE=Fake',
    'garbage line without equals',
  ]);
  const bytes = flacFile([
    [0, streamInfo({ totalSamples: 441000 })],
    [4, comment],
  ]);
  const r = await readTags(blobOf(bytes));
  assert.equal(r.format, 'flac');
  assert.equal(r.title, 'テスト曲');
  assert.equal(r.artist, 'Fake Artist');
  assert.equal(r.album, 'Fake Album');
  assert.equal(r.albumArtist, 'Fake Album Artist');
  assert.equal(r.track, 3);
  assert.equal(r.disc, 1);
  approx(r.duration, 10);
  assert.equal(r.picture, null);
});

test('FLAC: ALBUM ARTIST 寫法、空值與非數字', async () => {
  const comment = vorbisComment([
    'album artist=Fake Album Artist',
    'TITLE=   ',
    'ARTIST=  Spaced Name \u0000',
    'TRACKNUMBER=abc',
    'DISCNUMBER=',
  ]);
  const r = await readTags(blobOf(flacFile([[4, comment]])));
  assert.equal(r.albumArtist, 'Fake Album Artist');
  assert.equal(r.title, null);
  assert.equal(r.artist, 'Spaced Name');
  assert.equal(r.track, null);
  assert.equal(r.disc, null);
});

test('FLAC: 單純數字 track、前導 0', async () => {
  const r = await readTags(blobOf(flacFile([[4, vorbisComment(['TRACKNUMBER=07', 'DISCNUMBER=2'])]])));
  assert.equal(r.track, 7);
  assert.equal(r.disc, 2);
});

test('FLAC: PADDING / SEEKTABLE 被略過，非封面 + 封面時選封面', async () => {
  const bytes = flacFile([
    [0, streamInfo({ totalSamples: 44100 })],
    [1, zeros(500)], // PADDING
    [3, cat(zeros(36))], // SEEKTABLE
    [6, flacPicture({ type: 0, mime: 'image/png', desc: '其他', data: PNG_BYTES })],
    [4, vorbisComment(['TITLE=テスト曲'])],
    [6, flacPicture({ type: 3, mime: 'image/jpeg', desc: 'front', data: JPEG_BYTES })],
    [1, zeros(100)],
  ]);
  const r = await readTags(blobOf(bytes));
  assert.equal(r.title, 'テスト曲');
  assert.equal(r.picture.mime, 'image/jpeg');
  assert.deepEqual(Array.from(r.picture.data), Array.from(JPEG_BYTES));
  assert.ok(r.picture.data instanceof Uint8Array);
});

test('FLAC: 沒有封面時用第一張圖片', async () => {
  const bytes = flacFile([
    [6, flacPicture({ type: 4, mime: 'image/png', data: PNG_BYTES })],
    [6, flacPicture({ type: 0, mime: 'image/jpeg', data: JPEG_BYTES })],
  ]);
  const r = await readTags(blobOf(bytes));
  assert.equal(r.picture.mime, 'image/png');
  assert.deepEqual(Array.from(r.picture.data), Array.from(PNG_BYTES));
});

test('FLAC: 圖片 mime 為空時用檔頭判斷；連結圖片（-->）略過', async () => {
  let r = await readTags(blobOf(flacFile([[6, flacPicture({ type: 3, mime: '', data: PNG_BYTES })]])));
  assert.equal(r.picture.mime, 'image/png');

  r = await readTags(blobOf(flacFile([[6, flacPicture({ type: 3, mime: '-->', data: utf8('http://example.invalid/a.jpg') })]])));
  assert.equal(r.picture, null);
});

test('FLAC: 前面有 ID3v2 標籤時先跳過', async () => {
  const tag = id3Tag(3, frame(3, 'TIT2', textLatin1('Wrong Title')));
  const bytes = flacFile(
    [
      [0, streamInfo({ totalSamples: 44100 * 5 })],
      [4, vorbisComment(['TITLE=Real Title'])],
    ],
    zeros(0),
    tag,
  );
  const r = await readTags(blobOf(bytes));
  assert.equal(r.format, 'flac');
  assert.equal(r.title, 'Real Title');
  approx(r.duration, 5);
});

test('FLAC: 只有 fLaC 標頭 → format flac，其餘 null', async () => {
  const r = await readTags(blobOf('fLaC'));
  assert.deepEqual(r, { format: 'flac', ...EMPTY });
});

test('FLAC: block 長度超出檔案（損毀）時回傳已讀到的欄位', async () => {
  const streamBlock = flacBlock(0, streamInfo({ totalSamples: 44100 * 7 }));
  const comment = vorbisComment(['TITLE=テスト曲', 'ARTIST=Fake Artist', 'ALBUM=Fake Album']);
  // 宣告完整長度，但只放前半段
  const truncated = cat([4], u24be(comment.length), comment.subarray(0, comment.length - 12));
  const r = await readTags(blobOf('fLaC', streamBlock, truncated));
  assert.equal(r.format, 'flac');
  approx(r.duration, 7);
  assert.equal(r.title, 'テスト曲');
  assert.equal(r.artist, 'Fake Artist');
  assert.equal(r.album, null);
});

test('FLAC: 圖片資料被截斷時不回傳圖片也不丟例外', async () => {
  const pic = flacPicture({ type: 3, data: JPEG_BYTES });
  const bytes = cat('fLaC', flacBlock(4, vorbisComment(['TITLE=テスト曲'])), [0x86], u24be(pic.length), pic.subarray(0, pic.length - 5));
  const r = await readTags(blobOf(bytes));
  assert.equal(r.title, 'テスト曲');
  assert.equal(r.picture, null);
});

// ===========================================================================
// ID3v2.3
// ===========================================================================

test('ID3v2.3: UTF-16 帶 BOM、ISO-8859-1、TPE2、TRCK、TPOS、APIC', async () => {
  const frames = cat(
    frame(3, 'TIT2', textUtf16Bom('テスト曲')),
    frame(3, 'TPE1', textLatin1('Fake Artist é')),
    frame(3, 'TALB', textUtf16BomBe('Fake Album')),
    frame(3, 'TPE2', textLatin1('Fake Album Artist')),
    frame(3, 'TRCK', textLatin1('3/11')),
    frame(3, 'TPOS', textUtf16Bom('1/2')),
    frame(3, 'APIC', apicBody({ type: 0, mime: 'image/png', data: PNG_BYTES })),
    frame(3, 'APIC', apicBody({ type: 3, mime: 'image/jpeg', desc: latin1Bytes('cover'), data: JPEG_BYTES })),
    zeros(64), // padding
  );
  const r = await readTags(blobOf(id3Tag(3, frames), mpegFrame()));
  assert.equal(r.format, 'mp3');
  assert.equal(r.title, 'テスト曲');
  assert.equal(r.artist, 'Fake Artist é');
  assert.equal(r.album, 'Fake Album');
  assert.equal(r.albumArtist, 'Fake Album Artist');
  assert.equal(r.track, 3);
  assert.equal(r.disc, 1);
  assert.equal(r.picture.mime, 'image/jpeg');
  assert.deepEqual(Array.from(r.picture.data), Array.from(JPEG_BYTES));
});

test('ID3v2.3: 沒有封面時用第一張圖；mime 寫成 jpg / image/jpg 會補全', async () => {
  let frames = cat(
    frame(3, 'APIC', apicBody({ type: 4, mime: 'jpg', data: JPEG_BYTES })),
    frame(3, 'APIC', apicBody({ type: 0, mime: 'image/png', data: PNG_BYTES })),
  );
  let r = await readTags(blobOf(id3Tag(3, frames), mpegFrame()));
  assert.equal(r.picture.mime, 'image/jpeg');
  assert.deepEqual(Array.from(r.picture.data), Array.from(JPEG_BYTES));

  frames = frame(3, 'APIC', apicBody({ type: 3, mime: 'image/jpg', data: JPEG_BYTES }));
  r = await readTags(blobOf(id3Tag(3, frames), mpegFrame()));
  assert.equal(r.picture.mime, 'image/jpeg');

  frames = frame(3, 'APIC', apicBody({ type: 3, mime: 'png', data: PNG_BYTES }));
  r = await readTags(blobOf(id3Tag(3, frames), mpegFrame()));
  assert.equal(r.picture.mime, 'image/png');
});

test('ID3v2.3: APIC 的 UTF-16 description 以「對齊」的雙 \\0 結尾', async () => {
  // 'A' 的 LE 是 41 00，U+4100 的 LE 是 00 41 → 中間出現不對齊的 00 00
  const desc = cat([0xff, 0xfe], utf16le('A䄀B'));
  const frames = frame(3, 'APIC', apicBody({ enc: 1, type: 3, desc, data: JPEG_BYTES }));
  const r = await readTags(blobOf(id3Tag(3, frames), mpegFrame()));
  assert.deepEqual(Array.from(r.picture.data), Array.from(JPEG_BYTES));
});

test('ID3v2.3: 壓縮/加密 frame 略過、grouping identity 跳過 1 byte、遇到 padding 停止', async () => {
  const frames = cat(
    frame(3, 'TIT2', textLatin1('Compressed'), 0x0080),
    frame(3, 'TPE1', textLatin1('Encrypted'), 0x0040),
    frame(3, 'TALB', cat([0x01], textLatin1('Grouped Album')), 0x0020),
    zeros(10),
    frame(3, 'TPE2', textLatin1('After Padding')),
  );
  const r = await readTags(blobOf(id3Tag(3, frames), mpegFrame()));
  assert.equal(r.title, null);
  assert.equal(r.artist, null);
  assert.equal(r.album, 'Grouped Album');
  assert.equal(r.albumArtist, null);
});

test('ID3v2.3: extended header（4-byte 一般整數、不含自身）', async () => {
  const ext = cat(u32be(6), [0, 0], u32be(0)); // size=6 → 後面 6 bytes
  const frames = cat(ext, frame(3, 'TIT2', textLatin1('With Ext')));
  const r = await readTags(blobOf(id3Tag(3, frames, { flags: 0x40 }), mpegFrame()));
  assert.equal(r.title, 'With Ext');
});

test('ID3v2.3: tag-level unsync（APIC 資料含 FF 00、文字含 FF）', async () => {
  const picData = cat([0xff, 0xd8, 0xff, 0x00, 0xff, 0x00, 0x00, 0xff, 0xe0, 0x11, 0x22, 0xff]);
  const frames = cat(
    frame(3, 'TIT2', textLatin1('ÿÿTitleÿ')), // ÿÿTitleÿ
    frame(3, 'APIC', apicBody({ type: 3, mime: 'image/jpeg', data: picData })),
    frame(3, 'TPE1', textLatin1('Fake Artist')),
  );
  const body = unsync(frames);
  assert.ok(body.length > frames.length, 'fixture 應該真的有被 unsync');
  const r = await readTags(blobOf(id3Tag(3, body, { flags: 0x80 }), mpegFrame()));
  assert.equal(r.title, 'ÿÿTitleÿ');
  assert.equal(r.artist, 'Fake Artist');
  assert.deepEqual(Array.from(r.picture.data), Array.from(picData));
});

test('ID3v2.3: frame 超出標籤範圍（損毀）時保留前面讀到的欄位', async () => {
  const good = frame(3, 'TIT2', textLatin1('Good Title'));
  const bad = cat('TPE1', u32be(5000), [0, 0], textLatin1('x'));
  const r = await readTags(blobOf(id3Tag(3, cat(good, bad)), mpegFrame()));
  assert.equal(r.title, 'Good Title');
  assert.equal(r.artist, null);
});

// ===========================================================================
// ID3v2.4
// ===========================================================================

test('ID3v2.4: syncsafe frame size（超過 127 bytes）、UTF-8、UTF-16BE、多值取第一個', async () => {
  const bigPic = cat(JPEG_BYTES, zeros(300)); // frame 大小 > 127，syncsafe 與一般整數編碼不同
  const apic = frame(4, 'APIC', apicBody({ enc: 3, type: 3, desc: utf8('封面'), data: bigPic }));
  assert.notDeepEqual(Array.from(apic.subarray(4, 8)), u32be(apic.length - 10));
  const frames = cat(
    frame(4, 'TIT2', textUtf8('テスト曲')),
    frame(4, 'TPE1', cat([3], utf8('Fake Artist'), [0], utf8('Second Artist'))),
    frame(4, 'TALB', textUtf16Be('Fake Album')),
    frame(4, 'TPE2', cat([1, 0xff, 0xfe], utf16le('Fake Album Artist'), [0, 0], [0xff, 0xfe], utf16le('Other'))),
    frame(4, 'TRCK', textUtf8('3/11')),
    frame(4, 'TPOS', textUtf8('2')),
    apic,
  );
  const r = await readTags(blobOf(id3Tag(4, frames), mpegFrame()));
  assert.equal(r.format, 'mp3');
  assert.equal(r.title, 'テスト曲');
  assert.equal(r.artist, 'Fake Artist');
  assert.equal(r.album, 'Fake Album');
  assert.equal(r.albumArtist, 'Fake Album Artist');
  assert.equal(r.track, 3);
  assert.equal(r.disc, 2);
  assert.equal(r.picture.mime, 'image/jpeg');
  assert.deepEqual(Array.from(r.picture.data), Array.from(bigPic));
});

test('ID3v2.4: per-frame unsync + data length indicator', async () => {
  const picData = cat([0xff, 0x00, 0xff, 0xd8, 0xff, 0xe1, 0xff]);
  const original = apicBody({ type: 3, mime: 'image/jpeg', data: picData });
  const unsynced = unsync(original);
  assert.ok(unsynced.length > original.length);
  const apic = frame(4, 'APIC', cat(syncsafe(original.length), unsynced), 0x0003);

  const titleOriginal = textLatin1('ÿàFake');
  const title = frame(4, 'TIT2', unsync(titleOriginal), 0x0002); // 只有 unsync，沒有 DLI
  const artist = frame(4, 'TPE1', cat(syncsafe(titleOriginal.length), textLatin1('Fake Artist')), 0x0001); // 只有 DLI

  const r = await readTags(blobOf(id3Tag(4, cat(title, artist, apic)), mpegFrame()));
  assert.equal(r.title, 'ÿàFake');
  assert.equal(r.artist, 'Fake Artist');
  assert.deepEqual(Array.from(r.picture.data), Array.from(picData));
});

test('ID3v2.4: tag-level unsync 旗標表示所有 frame 都 unsync', async () => {
  const titleOriginal = textLatin1('ÿÿ');
  const frames = cat(
    frame(4, 'TIT2', unsync(cat(titleOriginal, 'x'))),
    frame(4, 'TPE1', textLatin1('Fake Artist')),
  );
  const r = await readTags(blobOf(id3Tag(4, frames, { flags: 0x80 }), mpegFrame()));
  assert.equal(r.title, 'ÿÿx');
  assert.equal(r.artist, 'Fake Artist');
});

test('ID3v2.4: extended header（syncsafe、含自身）與 footer；duration 從 footer 之後開始算', async () => {
  const ext = cat(syncsafe(6), [1, 0]); // 6 bytes 含自身
  const frames = cat(ext, frame(4, 'TIT2', textUtf8('With Ext')));
  const tag = id3Tag(4, frames, { flags: 0x40 | 0x10 });
  const audio = cat(mpegFrame({ bitrate: 128 }), zeros(100000));
  const r = await readTags(blobOf(tag, audio));
  assert.equal(r.title, 'With Ext');
  approx(r.duration, (audio.length * 8) / 128000);
});

test('ID3v2.4: frame 大小寫成一般整數（含 >= 0x80 的 byte）也能讀', async () => {
  // 讓 frame 大小的低 byte >= 0x80，這樣的值不可能是合法 syncsafe
  let bigPic = cat(JPEG_BYTES, zeros(300));
  while ((apicBody({ type: 3, mime: 'image/jpeg', data: bigPic }).length & 0xff) < 0x80) {
    bigPic = cat(bigPic, [0]);
  }
  const body = apicBody({ type: 3, mime: 'image/jpeg', data: bigPic });
  assert.ok(u32be(body.length).some((x) => x >= 0x80));
  const apic = cat('APIC', u32be(body.length), [0, 0], body); // 非 syncsafe 寫法
  const frames = cat(apic, frame(4, 'TIT2', textUtf8('After Big')));
  const r = await readTags(blobOf(id3Tag(4, frames), mpegFrame()));
  assert.equal(r.title, 'After Big');
  assert.deepEqual(Array.from(r.picture.data), Array.from(bigPic));
});

test('ID3v2.4: 一般整數寫的 frame 大小（所有 byte < 0x80，例如 300 bytes 的 COMM）後面接 TIT2', async () => {
  // 300 = 00 00 01 2C：照 syncsafe 讀會得到 172，落在 COMM 內容中間
  for (const fill of [0x41, 0x00, 0x20, 0x7f]) {
    const commBody = cat([3], 'eng', [0], new Uint8Array(295).fill(fill));
    assert.equal(commBody.length, 300);
    const comm = cat('COMM', u32be(commBody.length), [0, 0], commBody); // 一般整數寫法
    const frames = cat(
      frame(4, 'TALB', textUtf8('アルバム')),
      comm,
      cat('TIT2', u32be(textUtf8('タイトル').length), [0, 0], textUtf8('タイトル')), // textUtf8 已含編碼 byte
    );
    const r = await readTags(blobOf(id3Tag(4, frames), mpegFrame()));
    assert.equal(r.title, 'タイトル', `fill=${fill}`);
    assert.equal(r.album, 'アルバム', `fill=${fill}`);
  }
});

test('ID3v2.4: 一般整數寫的大 frame 是最後一個 frame（後面剛好是標籤結尾或 padding）', async () => {
  const commBody = cat([3], 'eng', [0], new Uint8Array(295).fill(0x41));
  const comm = cat('COMM', u32be(commBody.length), [0, 0], commBody);
  const title = frame(4, 'TIT2', textUtf8('タイトル'));

  let r = await readTags(blobOf(id3Tag(4, cat(title, comm)), mpegFrame()));
  assert.equal(r.title, 'タイトル');

  r = await readTags(blobOf(id3Tag(4, cat(comm, title, zeros(50))), mpegFrame()));
  assert.equal(r.title, 'タイトル');
});

test('ID3v2.4: 正常的 syncsafe 大 frame 不受影響（含填充 0x41 / 0x00 的內容與結尾 padding）', async () => {
  for (const fill of [0x41, 0x00, 0x7f]) {
    for (const len of [128, 300, 1000, 20000]) {
      const commBody = cat([3], 'eng', [0], new Uint8Array(len - 5).fill(fill));
      const comm = frame(4, 'COMM', commBody);
      assert.equal(commBody.length, len);
      const frames = cat(
        frame(4, 'TALB', textUtf8('アルバム')),
        comm,
        frame(4, 'TIT2', textUtf8('タイトル')),
        comm,
        frame(4, 'TPE1', textUtf8('Fake Artist')),
        comm,
        zeros(40),
      );
      const r = await readTags(blobOf(id3Tag(4, frames), mpegFrame()));
      assert.equal(r.album, 'アルバム', `fill=${fill} len=${len}`);
      assert.equal(r.title, 'タイトル', `fill=${fill} len=${len}`);
      assert.equal(r.artist, 'Fake Artist', `fill=${fill} len=${len}`);
    }
  }
});

// ===========================================================================
// ID3v2.2
// ===========================================================================

test('ID3v2.2: TT2 TP1 TAL TP2 TRK TPA PIC', async () => {
  const frames = cat(
    frame(2, 'TT2', textUtf16Bom('テスト曲')),
    frame(2, 'TP1', textLatin1('Fake Artist')),
    frame(2, 'TAL', textLatin1('Fake Album')),
    frame(2, 'TP2', textLatin1('Fake Album Artist')),
    frame(2, 'TRK', textLatin1('3/11')),
    frame(2, 'TPA', textLatin1('1/2')),
    frame(2, 'PIC', cat([0], 'PNG', [0], 'desc', [0], PNG_BYTES)),
  );
  const r = await readTags(blobOf(id3Tag(2, frames), mpegFrame()));
  assert.equal(r.format, 'mp3');
  assert.equal(r.title, 'テスト曲');
  assert.equal(r.artist, 'Fake Artist');
  assert.equal(r.album, 'Fake Album');
  assert.equal(r.albumArtist, 'Fake Album Artist');
  assert.equal(r.track, 3);
  assert.equal(r.disc, 1);
  assert.equal(r.picture.mime, 'image/png');
  assert.deepEqual(Array.from(r.picture.data), Array.from(PNG_BYTES));
});

test('ID3v2.2: JPG 轉成 image/jpeg，type 3 優先', async () => {
  const frames = cat(
    frame(2, 'PIC', cat([0], 'PNG', [0], [0], PNG_BYTES)),
    frame(2, 'PIC', cat([0], 'JPG', [3], [0], JPEG_BYTES)),
  );
  const r = await readTags(blobOf(id3Tag(2, frames), mpegFrame()));
  assert.equal(r.picture.mime, 'image/jpeg');
  assert.deepEqual(Array.from(r.picture.data), Array.from(JPEG_BYTES));
});

// ===========================================================================
// MP3 duration
// ===========================================================================

test('Xing: MPEG1 Layer III stereo，frames × 1152 / 44100', async () => {
  const tag = id3Tag(3, frame(3, 'TIT2', textLatin1('Fake')));
  const r = await readTags(blobOf(tag, xingFrame({ frames: 1000 }), zeros(5000)));
  approx(r.duration, (1000 * 1152) / 44100);
});

test('Xing/Info: MPEG2 Layer III mono（side info 9）、MPEG2 stereo（17）、MPEG2.5', async () => {
  let r = await readTags(blobOf(xingFrame({ version: 2, bitrate: 64, sampleRate: 22050, mono: true, frames: 1000 })));
  approx(r.duration, (1000 * 576) / 22050);

  r = await readTags(blobOf(xingFrame({ tag: 'Info', version: 2, bitrate: 64, sampleRate: 24000, frames: 500 })));
  approx(r.duration, (500 * 576) / 24000);

  r = await readTags(blobOf(xingFrame({ version: 2.5, bitrate: 32, sampleRate: 11025, mono: true, frames: 100 })));
  approx(r.duration, (100 * 576) / 11025);
});

test('Xing: MPEG1 mono（side info 17）、有 CRC 的 frame、Info 標記', async () => {
  let r = await readTags(blobOf(xingFrame({ tag: 'Info', mono: true, sampleRate: 48000, frames: 2000 })));
  approx(r.duration, (2000 * 1152) / 48000);

  r = await readTags(blobOf(xingFrame({ crc: true, frames: 3000 })));
  approx(r.duration, (3000 * 1152) / 44100);
});

test('Xing: Layer II 用 1152、Layer I 用 384 samples/frame', async () => {
  let r = await readTags(blobOf(xingFrame({ layer: 2, bitrate: 128, frames: 1000 })));
  approx(r.duration, (1000 * 1152) / 44100);

  r = await readTags(blobOf(xingFrame({ layer: 1, bitrate: 128, frames: 1000 })));
  approx(r.duration, (1000 * 384) / 44100);
});

test('VBRI: frames 在 VBRI 起點 +14', async () => {
  const r = await readTags(blobOf(id3Tag(3, frame(3, 'TIT2', textLatin1('Fake'))), vbriFrame({ frames: 2000 }), zeros(4000)));
  approx(r.duration, (2000 * 1152) / 44100);
});

test('Xing 沒有 frames 欄位 → 退回 CBR 估算', async () => {
  const frameBytes = xingFrame({ flags: 0x0002 });
  const bytes = cat(frameBytes, zeros(200000));
  const r = await readTags(blobOf(bytes));
  approx(r.duration, (bytes.length * 8) / 128000);
});

test('CBR 估算：(檔案大小 − 音訊起點) × 8 / bitrate', async () => {
  const tag = id3Tag(3, cat(frame(3, 'TIT2', textLatin1('Fake')), zeros(100)));
  const audio = cat(mpegFrame({ bitrate: 192, sampleRate: 48000 }), zeros(300000));
  const r = await readTags(blobOf(tag, audio));
  assert.equal(r.format, 'mp3');
  approx(r.duration, (audio.length * 8) / 192000);
});

test('CBR 估算：有 ID3v1 時扣掉 128 bytes', async () => {
  const tag = id3Tag(3, frame(3, 'TIT2', textLatin1('Fake')));
  const audio = cat(mpegFrame({ bitrate: 128 }), zeros(100000));
  const r = await readTags(blobOf(tag, audio, id3v1({ title: 'V1 Title' })));
  assert.equal(r.title, 'Fake'); // 有 ID3v2 時以 v2 為準
  approx(r.duration, (audio.length * 8) / 128000);
});

test('沒有 ID3v2：開頭是 MPEG frame sync 也算 mp3', async () => {
  const audio = cat(mpegFrame({ bitrate: 128 }), zeros(50000));
  const r = await readTags(blobOf(audio));
  assert.deepEqual({ ...r, duration: null }, { format: 'mp3', ...EMPTY });
  approx(r.duration, (audio.length * 8) / 128000);
});

test('ID3v2 標籤後有多餘 padding 資料時，從第一個 frame sync 起算', async () => {
  const tag = id3Tag(3, frame(3, 'TIT2', textLatin1('Fake')));
  const audio = cat(zeros(37), mpegFrame({ bitrate: 128 }), zeros(100000));
  const r = await readTags(blobOf(tag, audio));
  approx(r.duration, ((audio.length - 37) * 8) / 128000);
});

// ===========================================================================
// ID3v1
// ===========================================================================

test('只有 ID3v1：取 title/artist/album/track（latin1）', async () => {
  const bytes = cat(mpegFrame({ bitrate: 128 }), zeros(20000), id3v1({ title: 'Fake Title', artist: 'Fake Artist é', album: 'Fake Album', track: 5 }));
  const r = await readTags(blobOf(bytes));
  assert.equal(r.format, 'mp3');
  assert.equal(r.title, 'Fake Title');
  assert.equal(r.artist, 'Fake Artist é');
  assert.equal(r.album, 'Fake Album');
  assert.equal(r.albumArtist, null);
  assert.equal(r.track, 5);
  assert.equal(r.disc, null);
  assert.equal(r.picture, null);
  approx(r.duration, ((bytes.length - 128) * 8) / 128000);
});

test('只有 ID3v1、開頭不是 MPEG frame：仍視為 mp3，duration 為 null', async () => {
  const r = await readTags(blobOf(zeros(500), id3v1({ title: 'Fake Title' })));
  assert.equal(r.format, 'mp3');
  assert.equal(r.title, 'Fake Title');
  assert.equal(r.track, null);
  assert.equal(r.duration, null);
});

// ===========================================================================
// unknown / 空 / 損毀
// ===========================================================================

test('unknown 格式', async () => {
  const r = await readTags(blobOf('RIFF', u32le(100), 'WAVEfmt ', zeros(100)));
  assert.deepEqual(r, { format: 'unknown', ...EMPTY });
});

test('AAC ADTS（FF F1）不算 mp3', async () => {
  const r = await readTags(blobOf([0xff, 0xf1, 0x50, 0x80], zeros(500)));
  assert.equal(r.format, 'unknown');
});

test('空 blob 與太短的 blob', async () => {
  assert.deepEqual(await readTags(new Blob([])), { format: 'unknown', ...EMPTY });
  assert.deepEqual(await readTags(blobOf('fLa')), { format: 'unknown', ...EMPTY });
  assert.deepEqual(await readTags(blobOf('ID3')), { format: 'unknown', ...EMPTY });
});

test('ID3 標頭損毀（size 不是 syncsafe）→ 不當成 ID3', async () => {
  const r = await readTags(blobOf('ID3', [3, 0, 0, 0xff, 0xff, 0xff, 0xff], zeros(100)));
  assert.deepEqual(r, { format: 'unknown', ...EMPTY });
});

test('ID3 標籤宣告的 size 超過檔案：不丟例外，回傳已讀到的欄位', async () => {
  const bytes = cat('ID3', [3, 0, 0], syncsafe(100000), frame(3, 'TIT2', textLatin1('Fake Title')));
  const r = await readTags(blobOf(bytes));
  assert.equal(r.format, 'mp3');
  assert.equal(r.title, 'Fake Title');
  assert.equal(r.duration, null);
});

test('讀取丟例外時不往外丟，回傳 unknown', async () => {
  const broken = {
    size: 1000,
    slice() {
      return {
        arrayBuffer() {
          return Promise.reject(new Error('io error'));
        },
      };
    },
  };
  assert.deepEqual(await readTags(broken), { format: 'unknown', ...EMPTY });
  assert.deepEqual(await readTags(null), { format: 'unknown', ...EMPTY });
  assert.deepEqual(await readTags({}), { format: 'unknown', ...EMPTY });
});

// ===========================================================================
// 只分段讀取
// ===========================================================================

const MB = 1024 * 1024;
const READ_LIMIT = 256 * 1024;

test('分段讀取：FLAC（metadata 很小、後面接數 MB 音訊；大 PADDING / 大非封面圖片不讀）', async () => {
  const bigOtherPic = new Uint8Array(2 * MB).fill(0xaa);
  const smallCover = cat(JPEG_BYTES, new Uint8Array(40 * 1024).fill(0x55));
  const bytes = flacFile(
    [
      [0, streamInfo({ sampleRate: 44100, totalSamples: 44100 * 180 })],
      [1, zeros(2 * MB)], // 大 PADDING
      [3, new Uint8Array(1 * MB)], // 大 SEEKTABLE
      [6, flacPicture({ type: 0, mime: 'image/png', data: bigOtherPic })], // 大的非封面圖片
      [4, vorbisComment(['TITLE=テスト曲', 'ARTIST=Fake Artist', 'ALBUM=Fake Album', 'TRACKNUMBER=3/11'])],
      [6, flacPicture({ type: 3, mime: 'image/jpeg', data: smallCover })],
      [1, zeros(1 * MB)],
    ],
    new Uint8Array(4 * MB).fill(0xa5), // 假音訊
  );
  assert.ok(bytes.length > 9 * MB);

  const { blob, state } = countingBlob(bytes);
  const r = await readTags(blob);
  assert.equal(r.format, 'flac');
  assert.equal(r.title, 'テスト曲');
  assert.equal(r.track, 3);
  approx(r.duration, 180);
  assert.equal(r.picture.mime, 'image/jpeg');
  assert.equal(r.picture.data.length, smallCover.length);
  assert.equal(state.wholeFileCalls, 0);
  assert.ok(state.bytesRead < READ_LIMIT, `read ${state.bytesRead} bytes`);
});

test('分段讀取：FLAC 沒有 PICTURE 時讀完所有 block header 就停，仍不讀音訊', async () => {
  const bytes = flacFile(
    [
      [0, streamInfo({ totalSamples: 44100 * 60 })],
      [4, vorbisComment(['TITLE=テスト曲'])],
      [1, zeros(3 * MB)],
    ],
    new Uint8Array(3 * MB).fill(0xa5),
  );
  const { blob, state } = countingBlob(bytes);
  const r = await readTags(blob);
  assert.equal(r.title, 'テスト曲');
  assert.equal(state.wholeFileCalls, 0);
  assert.ok(state.bytesRead < 4096, `read ${state.bytesRead} bytes`);
});

test('分段讀取：MP3 ID3v2.3 + CBR（後面接數 MB 假音訊）', async () => {
  const tag = id3Tag(
    3,
    cat(
      frame(3, 'TIT2', textUtf16Bom('テスト曲')),
      frame(3, 'TPE1', textLatin1('Fake Artist')),
      frame(3, 'APIC', apicBody({ type: 3, data: cat(JPEG_BYTES, new Uint8Array(30 * 1024).fill(0x33)) })),
      zeros(2048),
    ),
  );
  const bytes = cat(tag, mpegFrame({ bitrate: 128 }), new Uint8Array(5 * MB), id3v1({ title: 'x' }));
  const { blob, state } = countingBlob(bytes);
  const r = await readTags(blob);
  assert.equal(r.format, 'mp3');
  assert.equal(r.title, 'テスト曲');
  assert.equal(r.artist, 'Fake Artist');
  assert.equal(r.picture.mime, 'image/jpeg');
  approx(r.duration, ((bytes.length - tag.length - 128) * 8) / 128000);
  assert.equal(state.wholeFileCalls, 0);
  assert.ok(state.bytesRead < READ_LIMIT, `read ${state.bytesRead} bytes`);
});

test('分段讀取：MP3 沒有 ID3v2、有 Xing', async () => {
  const bytes = cat(xingFrame({ frames: 9000 }), new Uint8Array(5 * MB));
  const { blob, state } = countingBlob(bytes);
  const r = await readTags(blob);
  assert.equal(r.format, 'mp3');
  approx(r.duration, (9000 * 1152) / 44100);
  assert.equal(state.wholeFileCalls, 0);
  assert.ok(state.bytesRead < READ_LIMIT, `read ${state.bytesRead} bytes`);
});

test('分段讀取：unknown 檔案只讀極少 bytes', async () => {
  const bytes = new Uint8Array(5 * MB).fill(0x11);
  const { blob, state } = countingBlob(bytes);
  const r = await readTags(blob);
  assert.equal(r.format, 'unknown');
  assert.equal(state.wholeFileCalls, 0);
  assert.ok(state.bytesRead < 1024, `read ${state.bytesRead} bytes`);
});

// ===========================================================================
// 選項 { picture: false }
// ===========================================================================

test('picture:false：FLAC 回傳 picture null，其他欄位不變；預設與 picture:true 行為不變', async () => {
  const bytes = flacFile([
    [0, streamInfo({ totalSamples: 44100 * 90 })],
    [6, flacPicture({ type: 0, mime: 'image/png', data: PNG_BYTES })],
    [4, vorbisComment(['TITLE=テスト曲', 'ARTIST=Fake Artist', 'ALBUM=Fake Album', 'TRACKNUMBER=3/11'])],
    [6, flacPicture({ type: 3, mime: 'image/jpeg', data: JPEG_BYTES })],
  ]);
  const withPic = await readTags(blobOf(bytes));
  assert.deepEqual(Array.from(withPic.picture.data), Array.from(JPEG_BYTES));
  const explicitTrue = await readTags(blobOf(bytes), { picture: true });
  assert.deepEqual(explicitTrue, withPic);
  assert.deepEqual(await readTags(blobOf(bytes), {}), withPic);

  const noPic = await readTags(blobOf(bytes), { picture: false });
  assert.equal(noPic.picture, null);
  assert.deepEqual({ ...noPic, picture: null }, { ...withPic, picture: null });
  assert.equal(noPic.title, 'テスト曲');
  assert.equal(noPic.track, 3);
  approx(noPic.duration, 90);
});

test('picture:false：FLAC 的讀取位元組數不含圖片大小（PICTURE block 只跳過不讀）', async () => {
  const hugeCover = new Uint8Array(3 * MB).fill(0x77);
  const bytes = flacFile(
    [
      [0, streamInfo({ totalSamples: 44100 * 120 })],
      [6, flacPicture({ type: 3, mime: 'image/jpeg', data: hugeCover })], // 封面排在 VORBIS_COMMENT 前面
      [4, vorbisComment(['TITLE=テスト曲', 'ARTIST=Fake Artist'])],
      [6, flacPicture({ type: 0, mime: 'image/png', data: new Uint8Array(1 * MB).fill(0x22) })],
      [1, zeros(1 * MB)],
    ],
    new Uint8Array(2 * MB).fill(0xa5),
  );

  const off = countingBlob(bytes);
  const r = await readTags(off.blob, { picture: false });
  assert.equal(r.picture, null);
  assert.equal(r.title, 'テスト曲');
  assert.equal(r.artist, 'Fake Artist');
  approx(r.duration, 120);
  assert.equal(off.state.wholeFileCalls, 0);
  assert.ok(off.state.bytesRead < 4096, `picture:false read ${off.state.bytesRead} bytes`);

  const on = countingBlob(bytes);
  const r2 = await readTags(on.blob);
  assert.equal(r2.picture.data.length, hugeCover.length);
  assert.ok(on.state.bytesRead >= hugeCover.length, `picture:true read ${on.state.bytesRead} bytes`);
  assert.ok(on.state.bytesRead - off.state.bytesRead >= hugeCover.length);
});

test('picture:false：ID3v2.2 / 2.3 / 2.4 回傳 picture null，其他欄位不變', async () => {
  const cases = [
    id3Tag(
      2,
      cat(
        frame(2, 'PIC', cat([0], 'JPG', [3], [0], JPEG_BYTES)),
        frame(2, 'TT2', textLatin1('Fake Title')),
        frame(2, 'TP1', textLatin1('Fake Artist')),
      ),
    ),
    id3Tag(
      3,
      cat(
        frame(3, 'APIC', apicBody({ type: 3, data: JPEG_BYTES })),
        frame(3, 'TIT2', textUtf16Bom('テスト曲')),
        frame(3, 'TPE1', textLatin1('Fake Artist')),
        frame(3, 'TRCK', textLatin1('3/11')),
      ),
    ),
    id3Tag(
      4,
      cat(
        frame(4, 'TIT2', textUtf8('テスト曲')),
        frame(4, 'APIC', apicBody({ type: 3, data: cat(JPEG_BYTES, zeros(400)) })),
        frame(4, 'TPE1', textUtf8('Fake Artist')),
        frame(4, 'TRCK', textUtf8('3/11')),
      ),
    ),
  ];
  for (const tag of cases) {
    const bytes = cat(tag, mpegFrame({ bitrate: 128 }), zeros(50000));
    const withPic = await readTags(blobOf(bytes));
    assert.ok(withPic.picture, 'fixture 應該有圖片');
    const noPic = await readTags(blobOf(bytes), { picture: false });
    assert.equal(noPic.picture, null);
    assert.ok(noPic.title !== null && noPic.artist !== null);
    assert.deepEqual({ ...noPic, picture: null }, { ...withPic, picture: null });
  }
});

test('picture:false：沒有圖片或 unknown 格式時行為相同', async () => {
  assert.deepEqual(await readTags(new Blob([]), { picture: false }), { format: 'unknown', ...EMPTY });
  const r = await readTags(blobOf(flacFile([[4, vorbisComment(['TITLE=テスト曲'])]])), { picture: false });
  assert.equal(r.title, 'テスト曲');
  assert.equal(r.picture, null);
});
