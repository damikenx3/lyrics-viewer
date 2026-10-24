// 返回鍵：面板開著時只關面板；面板沒開時先提示，約 2 秒內再按一次才離開頁面。
//
// history 堆疊：base → guard → sheet。
// Chrome 會讓返回鍵略過「沒有使用者操作就 pushState」加進來的項目，所以：
// - guard 只在使用者操作（觸控放開、按鍵、滑鼠按下）時放上去，不能在 popstate 裡立刻重推；
// - 同一次操作已經放過 guard、接著又要開面板時，不再多推一個項目，而是把 guard 改寫成
//   「guard＋面板」（replaceState），避免第二個項目被當成沒有使用者操作。
// 目前項目的種類記在 top：'base' | 'guard' | 'sheet'（疊在 guard 上）| 'merged'（guard 兼面板）

// 一次實體操作只算一次：滑鼠看 pointerdown，觸控與觸控筆看 pointerup（不另聽 touchend、mousedown，
// 觸控後瀏覽器補發的相容滑鼠事件也不會被算成第二次操作）
const ACTIVATION_EVENTS = ['pointerdown', 'pointerup', 'keydown'];

function isActivation(e) {
  if (!e.isTrusted) return false;
  if (e.type === 'keydown') return e.key !== 'Escape' && !e.repeat;
  if (e.type === 'pointerdown') return e.pointerType === 'mouse';
  return e.pointerType !== 'mouse';
}

function state() {
  try { return history.state; } catch { return null; }
}

export class BackGuard {
  // isSheetOpen()、closeSheet()：面板；warn() 顯示「再按一次離開」並回傳收起提示的函式
  constructor({ isSheetOpen, closeSheet, warn, warnFor = 2000 }) {
    this.isSheetOpen = isSheetOpen;
    this.closeSheet = closeSheet;
    this.warn = warn;
    this.warnFor = warnFor;
    this.top = 'base';
    this.fresh = false;       // 上次放入項目之後，使用者有沒有新的操作
    this.pendingBacks = 0;    // 自己呼叫 history.back() 還沒收到的 popstate
    this.warning = null;      // { dismiss, timer }

    // 重新整理後 history.state 還在：沿用。停在面板項目上時面板其實沒開，退回 guard。
    const st = state();
    if (st && st.lvSheet && st.lvGuard) {
      this.replace({ lvGuard: true }, 'guard');
    } else if (st && st.lvSheet) {
      this.top = 'guard';
      this.back();
    } else if (st && st.lvGuard) {
      this.top = 'guard';
    }

    const onActivation = (e) => this.activated(e);
    for (const type of ACTIVATION_EVENTS) window.addEventListener(type, onActivation, true);
    window.addEventListener('popstate', (e) => this.popped(e));
  }

  activated(e) {
    if (!isActivation(e)) return;
    this.fresh = true;
    // 提示期間使用者繼續操作：不打算離開了，收起提示並重新放回 guard
    if (this.warning) this.endWarning(true);
    if (this.top === 'base') this.push({ lvGuard: true }, 'guard');
  }

  push(st, top) {
    try {
      history.pushState(st, '');
      this.top = top;
      this.fresh = false;
      return true;
    } catch {
      return false;
    }
  }

  replace(st, top) {
    try {
      history.replaceState(st, '');
      this.top = top;
      return true;
    } catch {
      return false;
    }
  }

  back() {
    try {
      this.pendingBacks++;
      history.back();
    } catch {
      this.pendingBacks--;
    }
  }

  // 面板打開時呼叫
  pushSheet() {
    if (this.top === 'guard') {
      if (this.fresh) this.push({ lvSheet: true }, 'sheet');
      else this.replace({ lvGuard: true, lvSheet: true }, 'merged');
    } else if (this.top === 'base' && this.fresh) {
      this.push({ lvGuard: true, lvSheet: true }, 'merged');
    }
  }

  // 面板由介面關閉（不是返回鍵）時呼叫：拿掉面板項目，回到 guard
  popSheet() {
    if (this.top === 'sheet') {
      this.top = 'guard';
      this.back();
    } else if (this.top === 'merged') {
      this.replace({ lvGuard: true }, 'guard');
    }
  }

  popped(e) {
    const st = e.state || null;
    if (this.pendingBacks > 0) {
      // 自己呼叫的 history.back() 到了：快速關了又開時可能晚到，狀態以 top 為準
      this.pendingBacks--;
      return;
    }
    const prev = this.top;
    if (st && st.lvSheet) {
      this.top = st.lvGuard ? 'merged' : 'sheet';
      return;
    }
    if (st && st.lvGuard) {
      this.top = 'guard';
      if (this.isSheetOpen()) this.closeSheet();
      return;
    }
    this.top = 'base';
    if (this.isSheetOpen()) {
      // guard 兼面板的項目被返回鍵拿掉：只關面板，guard 等下一次操作再放回
      this.closeSheet();
      return;
    }
    if (prev === 'guard') this.startWarning();
  }

  startWarning() {
    this.endWarning(true);
    const dismiss = this.warn();
    const timer = setTimeout(() => this.endWarning(false), this.warnFor);
    this.warning = { dismiss, timer };
  }

  endWarning(dismissToast) {
    const w = this.warning;
    if (!w) return;
    this.warning = null;
    clearTimeout(w.timer);
    if (dismissToast && w.dismiss) w.dismiss();
  }
}
