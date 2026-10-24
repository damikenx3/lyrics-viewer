// 時間字串與秒數互轉。所有時間在進入資料模型前都四捨五入到毫秒，
// 避免浮點誤差讓「相同時間點」比較失準（隱含結束時間依賴精確比較）。

export const TIME_EPSILON = 0.0005;

export function roundTime(sec) {
  return Math.round(sec * 1000) / 1000;
}

// 「mm:ss」「mm:ss.xx」「mm:ss.xxx」；分鐘可超過 59。小數點也接受 `:`（部分 LRC 工具的寫法）。
// 秒數與小數故意放寬成 1～2、1～3 位數再由 checkTimeParts 驗證，
// 這樣 [0:5.2]、[00:75.00] 這類手誤會被報錯，而不是默默當成一般文字顯示。
export const TIME_SOURCE = '(\\d{1,4}):(\\d{1,2})(?:[.:](\\d{1,3}))?';

// 回傳錯誤說明；格式正確時回傳 null。
export function checkTimeParts(min, sec, frac) {
  if (sec.length !== 2) return '秒數要寫兩位數';
  if (Number(sec) >= 60) return '秒數要小於 60';
  if (frac != null && frac.length === 1) return '小數要寫 2 或 3 位';
  return null;
}

export function timeFromParts(min, sec, frac) {
  let f = 0;
  if (frac != null && frac !== '') f = Number(frac) / Math.pow(10, frac.length);
  return roundTime(Number(min) * 60 + Number(sec) + f);
}

// 秒 → mm:ss.xx（毫秒不是 10 的倍數時寫三位小數）。用於訊息顯示。
export function formatTime(sec) {
  let ms = Math.round(Math.max(0, sec) * 1000);
  const min = Math.floor(ms / 60000);
  ms -= min * 60000;
  const s = Math.floor(ms / 1000);
  const frac = ms - s * 1000;
  const fracStr = frac % 10 === 0 ? String(frac / 10).padStart(2, '0') : String(frac).padStart(3, '0');
  return `${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}.${fracStr}`;
}
