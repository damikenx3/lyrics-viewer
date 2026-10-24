// 多分頁：Chrome 每次從檔案 app 開啟都會多開一個分頁（共用同一份儲存）。
// 一個分頁開始播放時通知其他分頁暫停。用 localStorage 的 storage 事件；有 BroadcastChannel 就一併使用。
// 從 content:// 開啟時 origin 是 "null"，任何一個 API 都可能丟錯，所以全部包 try/catch。

const KEY = 'lyrics-viewer.playing';
const CHANNEL = 'lyrics-viewer';

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class TabSync {
  constructor(onOtherPlaying) {
    this.onOtherPlaying = onOtherPlaying;
    this.id = makeId();
    this.channel = null;
    try {
      if (typeof BroadcastChannel === 'function') {
        this.channel = new BroadcastChannel(CHANNEL);
        this.channel.onmessage = (e) => this.receive(e.data);
      }
    } catch {
      this.channel = null;
    }
    try {
      window.addEventListener('storage', (e) => {
        if (e.key !== KEY || !e.newValue) return;
        let msg = null;
        try { msg = JSON.parse(e.newValue); } catch { return; }
        this.receive(msg);
      });
    } catch { /* 忽略 */ }
  }

  receive(msg) {
    if (!msg || msg.type !== 'play' || msg.tab === this.id) return;
    // 兩個管道都可能送到同一則：重複呼叫無妨（已暫停就不會再動）
    try { this.onOtherPlaying(); } catch (err) { console.error('[lyrics-viewer]', err); }
  }

  announcePlay() {
    const msg = { type: 'play', tab: this.id, at: Date.now() };
    try { if (this.channel) this.channel.postMessage(msg); } catch { /* 忽略 */ }
    // 值每次都不同（at），storage 事件才會觸發
    try { window.localStorage.setItem(KEY, JSON.stringify(msg)); } catch { /* 忽略 */ }
  }
}
