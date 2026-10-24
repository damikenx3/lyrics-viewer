// 傳輸層：音訊（<audio>）與虛擬時鐘實作同一介面，介面程式不需要知道差別。
// 事件：state（播放/暫停）、seek、ended、duration、buffer、kind、error、blocked
import { clamp, fileExt } from './dom.js';
import { t } from './i18n.js';

class ClockTransport {
  constructor(duration) {
    this.duration = duration;
    this.pos = 0;
    this.t0 = 0;
    this.paused = true;
  }
  // 用 Date.now()：performance.now() 在 Android 深度睡眠時會停，歌詞會落後
  get currentTime() {
    if (this.paused) return this.pos;
    return Math.min(this.duration, this.pos + Math.max(0, Date.now() - this.t0) / 1000);
  }
  play() {
    if (!this.paused) return;
    if (this.pos >= this.duration - 0.01) this.pos = 0;
    this.t0 = Date.now();
    this.paused = false;
  }
  pause() {
    if (this.paused) return;
    this.pos = this.currentTime;
    this.paused = true;
  }
  seek(t) {
    this.pos = clamp(t, 0, this.duration);
    this.t0 = Date.now();
  }
}

const MIME_BY_EXT = {
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg; codecs=opus',
  wav: 'audio/wav',
};

export function guessMime(name, type) {
  if (type && type !== 'application/octet-stream') return type;
  return MIME_BY_EXT[fileExt(name)] || '';
}

// 回傳 '' 代表瀏覽器明確表示不支援
export function canPlay(audio, name, type) {
  const mime = guessMime(name, type);
  if (!mime) return 'maybe';
  try {
    return audio.canPlayType(mime);
  } catch {
    return 'maybe';
  }
}

function formatLabel(name) {
  const ext = fileExt(name);
  return ext ? ext.toUpperCase() : '?';
}

// 回傳語言無關的錯誤描述；顯示時用 formatAudioError 轉成目前語言
export function describeAudioError(mediaError, source, audio) {
  const name = source && source.name ? source.name : '';
  const fmt = formatLabel(name);
  const supported = canPlay(audio, name, source && source.type);
  const code = mediaError ? mediaError.code : 0;
  let reason;
  if (supported === '') reason = 'errFormat';
  else if (code === 4) reason = 'errOpen';
  else if (code === 3) reason = 'errDecode';
  else if (code === 2) reason = 'errNetwork';
  else reason = 'errUnknown';
  return { name, fmt, reason };
}

// 修正建議依原因與格式而定：MP3 本身出問題時，不能再叫人換成 MP3
function fixKey(err) {
  if (err.reason === 'errFormat' || err.reason === 'errOpen') {
    if (err.fmt === 'MP3') return 'errFixReencode';
    if (err.fmt === 'M4A' || err.fmt === 'AAC') return 'errFixConvertMp3';
    return 'errFixConvert';
  }
  if (err.reason === 'errDecode') return 'errFixReencode';
  return 'errFixRetry';
}

// timed：這首歌有對時歌詞，才提示「仍可用歌詞模式」；句子之間用 sentenceGap（各語言空白不同）
export function formatAudioError(err, { timed } = {}) {
  const parts = [t(err.reason, { fmt: err.fmt }), t(fixKey(err))];
  if (timed) parts.push(t('errLyricsStill'));
  return {
    title: t('cantPlay', { name: err.name || '?' }),
    body: parts.join(t('sentenceGap')),
  };
}

export class Player extends EventTarget {
  constructor(audio) {
    super();
    this.audio = audio;
    this.kind = 'none';
    this.clock = null;
    this.song = null;
    this.source = null;
    this.objectUrl = null;   // <audio> 正在用（或載入中）的 blob URL
    this.retired = [];       // 已換掉、等新來源載入完成才 revoke 的 blob URL
    this.cancelLoad = null;  // 取消進行中的 loadUrl
    this.token = 0;
    this.fallbackDuration = 0;
    this.metaReady = false;

    const forward = (type, as) => {
      audio.addEventListener(type, () => {
        if (this.kind === 'audio') this.emit(as || type);
      });
    };
    forward('play', 'state');
    forward('pause', 'state');
    forward('ended');
    forward('durationchange', 'duration');
    forward('progress', 'buffer');
    forward('seeked', 'seek');
    // 播放途中才失敗（解碼錯誤、慢速載入逾時後才報錯）：退回歌詞模式並停在同一個位置
    // 換來源期間 metaReady 為 false，舊來源殘留的 pause／abort／emptied／error 都不會走到這裡
    audio.addEventListener('error', () => {
      if (this.kind !== 'audio' || !this.metaReady) return;
      const err = describeAudioError(audio.error, this.source, audio);
      if (this.source && this.source.kind === 'url') err.silent = true;
      const at = audio.currentTime || 0;
      this.fallback(this.song);
      if (this.clock) this.clock.seek(at);
      this.emit('error', err);
    });
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  get currentTime() {
    if (this.kind === 'audio') return this.audio.currentTime || 0;
    if (this.kind === 'clock') return this.clock.currentTime;
    return 0;
  }

  get duration() {
    if (this.kind === 'audio') {
      const d = this.audio.duration;
      return Number.isFinite(d) && d > 0 ? d : this.fallbackDuration;
    }
    if (this.kind === 'clock') return this.clock.duration;
    return this.fallbackDuration;
  }

  get paused() {
    if (this.kind === 'audio') return this.audio.paused;
    if (this.kind === 'clock') return this.clock.paused;
    return true;
  }

  get canPlay() {
    return this.kind !== 'none';
  }

  buffered() {
    if (this.kind !== 'audio') return [];
    const out = [];
    const b = this.audio.buffered;
    for (let i = 0; i < b.length; i++) out.push({ start: b.start(i), end: b.end(i) });
    return out;
  }

  // 載入歌曲。source：{ kind:'blob', blob, name, type } | { kind:'url', url, name } | null
  // 回傳 { ok:true } 或 { ok:false, error }；stale=true 代表已被下一次載入取代。
  async load(song, source) {
    const token = ++this.token;
    if (this.cancelLoad) this.cancelLoad();
    this.song = song;
    this.fallbackDuration = song && song.timed && Number.isFinite(song.duration) ? song.duration + 3 : 0;

    if (!source) {
      this.fallback(song);
      return { ok: true };
    }

    // 音訊換音訊：不清空 <audio>（清空會讓 Android 的媒體通知消失），暫停後直接換 src
    if (this.kind === 'audio') this.retire();
    else this.teardown();
    this.source = source;
    let url;
    if (source.kind === 'blob') {
      url = this.objectUrl = URL.createObjectURL(source.blob);
    } else {
      url = source.url;
    }
    this.kind = 'audio';
    // 同步呼叫到設好 src 為止，之後 duration／buffered() 讀到的才是新來源
    const loading = this.loadUrl(url);
    // load() 會清掉排隊中的 pause 事件，這裡主動通知一次
    this.emit('state');
    this.emit('buffer');
    this.emit('kind');
    this.emit('duration');
    const ok = await loading;
    if (token !== this.token) return { ok: false, stale: true };
    if (ok) {
      this.metaReady = true;
      this.revokeRetired();
      this.emit('duration');
      this.emit('buffer');
      return { ok: true };
    }
    const error = describeAudioError(this.audio.error, source, this.audio);
    this.fallback(song);
    return { ok: false, error };
  }

  // 退回虛擬時鐘或沒有音訊：這時才清空 <audio>
  fallback(song) {
    this.teardown();
    this.source = null;
    if (song && song.timed) {
      this.kind = 'clock';
      this.clock = new ClockTransport(this.fallbackDuration);
    } else {
      this.kind = 'none';
      this.clock = null;
    }
    this.emit('kind');
    this.emit('duration');
    this.emit('buffer');
    this.emit('state');
  }

  loadUrl(url) {
    const a = this.audio;
    return new Promise((resolve) => {
      let timer = 0;
      const done = (ok) => {
        a.removeEventListener('loadedmetadata', onOk);
        a.removeEventListener('error', onErr);
        clearTimeout(timer);
        if (this.cancelLoad === cancel) this.cancelLoad = null;
        resolve(ok);
      };
      const onOk = () => done(true);
      const onErr = () => done(false);
      // 被下一次 load() 取代：收掉監聽與計時器，結果由 token 判定為過期
      const cancel = () => done(null);
      this.cancelLoad = cancel;
      a.addEventListener('loadedmetadata', onOk);
      a.addEventListener('error', onErr);
      // 慢速網路下不無限等；之後若真的失敗，error 事件仍會回報
      timer = setTimeout(() => done(true), 20000);
      a.src = url;
      try { a.load(); } catch { done(false); }
    });
  }

  // 音訊換音訊的前置：暫停舊來源但不動 src；舊 blob URL 記下來，等新來源載入完成才 revoke
  // metaReady 先歸 false，舊來源殘留的事件不會被當成播放途中的錯誤
  retire() {
    this.metaReady = false;
    try { this.audio.pause(); } catch { /* 忽略 */ }
    if (this.objectUrl) {
      this.retired.push(this.objectUrl);
      this.objectUrl = null;
    }
  }

  revokeRetired() {
    for (const u of this.retired) URL.revokeObjectURL(u);
    this.retired = [];
  }

  // 清空 <audio>，同時 revoke 所有 blob URL（此時沒有東西在用它們）
  teardown() {
    const a = this.audio;
    const wasAudio = this.kind === 'audio';
    this.kind = 'none';
    this.metaReady = false;
    try {
      a.pause();
      if (wasAudio || a.getAttribute('src')) {
        a.removeAttribute('src');
        a.load();
      }
    } catch { /* 忽略 */ }
    this.revokeRetired();
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.clock = null;
  }

  play() {
    if (this.kind === 'audio') {
      const p = this.audio.play();
      if (p && p.catch) {
        p.catch((err) => {
          if (err && err.name === 'NotAllowedError') this.emit('blocked');
          else if (err && err.name !== 'AbortError') this.emit('error', describeAudioError(this.audio.error, this.source, this.audio));
        });
      }
    } else if (this.kind === 'clock') {
      this.clock.play();
      this.emit('state');
    }
  }

  pause() {
    if (this.kind === 'audio') this.audio.pause();
    else if (this.kind === 'clock' && !this.clock.paused) {
      this.clock.pause();
      this.emit('state');
    }
  }

  toggle() {
    if (this.paused) this.play();
    else this.pause();
  }

  seek(t) {
    const d = this.duration;
    const to = clamp(t, 0, d > 0 ? d : t);
    if (this.kind === 'audio') {
      try { this.audio.currentTime = to; } catch { /* 尚未可 seek */ }
    } else if (this.kind === 'clock') {
      this.clock.seek(to);
    }
    this.emit('seek');
  }

  // 每格呼叫：虛擬時鐘到尾端時停住
  tick() {
    if (this.kind === 'clock' && !this.clock.paused && this.clock.currentTime >= this.clock.duration) {
      this.clock.pause();
      this.clock.pos = this.clock.duration;
      this.emit('state');
      this.emit('ended');
    }
  }
}
