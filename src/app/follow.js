// 追蹤捲動：自訂 rAF 補間；使用者觸控拖曳、滾輪、鍵盤或拖捲軸時解除追蹤。
import { clamp, reducedMotion } from './dom.js';

const DURATION = 580;
const DRAG_THRESHOLD = 6;

function easeOut(p) {
  return 1 - Math.pow(1 - p, 3);
}

export class Follower {
  constructor(scroller, onChange) {
    this.scroller = scroller;
    this.onChange = onChange;
    this.following = true;
    this.raf = 0;
    this.touch = null;
    this.lastSet = null;   // 最後一次由程式設定的 scrollTop
    this.quietUntil = 0;   // 版面變動後的一小段時間不判定手動捲動

    scroller.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      this.touch = t ? { x: t.clientX, y: t.clientY, moved: false } : null;
    }, { passive: true });
    scroller.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      if (!this.touch || !t || this.touch.moved) return;
      if (Math.hypot(t.clientX - this.touch.x, t.clientY - this.touch.y) > DRAG_THRESHOLD) {
        this.touch.moved = true;
        this.release();
      }
    }, { passive: true });
    scroller.addEventListener('touchend', () => { this.touch = null; }, { passive: true });
    scroller.addEventListener('wheel', () => this.release(), { passive: true });
    // 滑鼠拖捲軸：按在內容寬度之外
    scroller.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.offsetX > scroller.clientWidth) this.release();
    });
    // 其他來源的捲動（捲軸拖曳、無障礙捲動等）：不是我們補間造成的位移就視為手動
    scroller.addEventListener('scroll', () => {
      if (this.raf || !this.following) return;
      const now = performance.now();
      if (now < this.quietUntil || this.lastSet == null) {
        this.lastSet = scroller.scrollTop;
        return;
      }
      if (Math.abs(scroller.scrollTop - this.lastSet) > 3) this.release();
    }, { passive: true });
    const quiet = () => this.quiet(400);
    window.addEventListener('resize', quiet);
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(quiet);
      ro.observe(scroller);
      if (scroller.firstElementChild) ro.observe(scroller.firstElementChild);
    }
  }

  // 版面即將變動（換歌、改字級、視窗大小）時呼叫，避免把瀏覽器自己的調整誤判為手動捲動
  quiet(ms = 400) {
    this.quietUntil = Math.max(this.quietUntil, performance.now() + ms);
  }

  // 立即設定位置（記錄下來，之後的 scroll 事件不會被當成手動）
  jump(y) {
    this.stop();
    this.scroller.scrollTop = y;
    this.lastSet = this.scroller.scrollTop;
  }

  // 使用者手動捲動
  release() {
    this.stop();
    if (this.following) {
      this.following = false;
      this.onChange(false);
    }
  }

  resume() {
    this.lastSet = this.scroller.scrollTop;
    if (!this.following) {
      this.following = true;
      this.onChange(true);
    }
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  scrollTo(y, { instant = false } = {}) {
    const sc = this.scroller;
    const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
    const to = clamp(Math.round(y), 0, max);
    this.stop();
    const from = sc.scrollTop;
    const dist = to - from;
    if (Math.abs(dist) < 1) {
      this.lastSet = from;
      return;
    }
    if (instant || reducedMotion()) {
      sc.scrollTop = to;
      this.lastSet = sc.scrollTop;
      return;
    }
    // 遠距離跳轉稍微拉長，但不超過 650ms
    const dur = Math.min(650, DURATION + Math.min(70, Math.abs(dist) / 40));
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      sc.scrollTop = from + dist * easeOut(p);
      this.lastSet = sc.scrollTop;
      this.raf = p < 1 ? requestAnimationFrame(step) : 0;
    };
    this.raf = requestAnimationFrame(step);
  }
}
