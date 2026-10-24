// Android 整合：Media Session（通知列／藍牙按鍵）與 Screen Wake Lock。

const ms = typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : null;

function setAction(action, fn) {
  try { ms.setActionHandler(action, fn); } catch { /* 瀏覽器不支援這個動作 */ }
}

// 上一首／下一首不在這裡設：由呼叫端依目前能移動的範圍呼叫 setMediaTrackHandlers
export function setupMediaSession(handlers) {
  if (!ms) return;
  setAction('play', () => handlers.play());
  setAction('pause', () => handlers.pause());
  setAction('seekto', (d) => { if (d && Number.isFinite(d.seekTime)) handlers.seek(d.seekTime); });
  setAction('seekbackward', (d) => handlers.skip(-((d && d.seekOffset) || 5)));
  setAction('seekforward', (d) => handlers.skip((d && d.seekOffset) || 5));
}

// prev、next：函式或 null；null 代表這個方向沒有歌可移動，通知列就不顯示該按鈕
export function setMediaTrackHandlers({ prev, next } = {}) {
  if (!ms) return;
  setAction('previoustrack', typeof prev === 'function' ? prev : null);
  setAction('nexttrack', typeof next === 'function' ? next : null);
}

export function setMediaMetadata({ title, artist, album, artwork }) {
  if (!ms || typeof MediaMetadata !== 'function') return;
  try {
    ms.metadata = new MediaMetadata({ title: title || '', artist: artist || '', album: album || '', artwork: artwork || [] });
  } catch {
    try { ms.metadata = new MediaMetadata({ title: title || '', artist: artist || '', album: album || '' }); } catch { /* 忽略 */ }
  }
}

export function setMediaPlaying(playing) {
  if (!ms) return;
  try { ms.playbackState = playing ? 'playing' : 'paused'; } catch { /* 忽略 */ }
}

export function setMediaPosition(duration, position) {
  if (!ms || !ms.setPositionState) return;
  try {
    if (!(duration > 0) || !Number.isFinite(duration)) {
      ms.setPositionState();
      return;
    }
    ms.setPositionState({ duration, playbackRate: 1, position: Math.min(Math.max(0, position), duration) });
  } catch { /* 忽略 */ }
}

// 播放中保持螢幕常亮；回到前景時重新取得。
// 瀏覽器不支援或拒絕（例如從檔案管理員開啟的 content://）時標記為無法使用，通知一次，不再重試。
export class ScreenWake {
  constructor(onUnavailable) {
    this.onUnavailable = onUnavailable;
    this.supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
    this.unavailable = false;
    this.enabled = true;
    this.playing = false;
    this.lock = null;
    this.pending = false;
    if (!this.supported) {
      this.markUnavailable();
    } else if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'screen-wake-lock' })
        .then((st) => { if (st.state === 'denied') this.markUnavailable(); })
        .catch(() => {});
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.sync();
    });
  }

  markUnavailable() {
    if (this.unavailable) return;
    this.unavailable = true;
    this.release();
    if (this.onUnavailable) queueMicrotask(() => this.onUnavailable());
  }

  setEnabled(on) {
    this.enabled = on;
    this.sync();
  }

  setPlaying(on) {
    this.playing = on;
    this.sync();
  }

  async sync() {
    if (!this.supported || this.unavailable) return;
    const want = this.enabled && this.playing && document.visibilityState === 'visible';
    if (want && !this.lock && !this.pending) {
      this.pending = true;
      try {
        const lock = await navigator.wakeLock.request('screen');
        this.lock = lock;
        lock.addEventListener('release', () => { if (this.lock === lock) this.lock = null; });
      } catch (err) {
        this.lock = null;
        if (err && err.name === 'NotAllowedError' && document.visibilityState === 'visible') this.markUnavailable();
      } finally {
        this.pending = false;
      }
      if (!(this.enabled && this.playing) && this.lock) this.release();
    } else if (!want && this.lock) {
      this.release();
    }
  }

  release() {
    const l = this.lock;
    this.lock = null;
    if (l) l.release().catch(() => {});
  }
}
