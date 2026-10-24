// 圖示：24px 網格、線寬 2、圓角端點與轉角。
//
// 標註 [Lucide] 的圖形取自 Lucide 1.61.0（https://lucide.dev），ISC License：
//   Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
//   All other copyright (c) for Lucide are held by Lucide Contributors 2022.
//   Permission to use, copy, modify, and/or distribute this software for any purpose with or
//   without fee is hereby granted, provided that the above copyright notice and this permission
//   notice appear in all copies. THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL
//   WARRANTIES WITH REGARD TO THIS SOFTWARE.
// 標註 [自繪] 的圖形為本專案自行繪製（打 CALL 螢光棒、連結／移除音訊、沒有歌詞），沿用同一套網格與線寬。
//
// 每個圖形是字串陣列：一般字串是 path 的 d；'c:cx,cy,r' 是圓；'r:x,y,w,h,rx' 是圓角矩形；
// 前綴 'f:' 代表該圖形以 currentColor 填滿（啟用狀態用）。

export const ICON = {
  // [Lucide] list-music
  library: ['M16 5H3', 'M11 12H3', 'M11 19H3', 'M21 16V5', 'c:18,16,3'],
  // [Lucide] skip-back（三角形填滿）
  prev: ['f:M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z', 'M3 20V4'],
  // [Lucide] skip-forward（三角形填滿）
  next: ['M21 4v16', 'f:M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z'],
  // [Lucide] x
  close: ['M18 6 6 18', 'm6 6 12 12'],
  // [Lucide] file-plus：加入檔案
  addFiles: ['M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z', 'M14 2v5a1 1 0 0 0 1 1h5', 'M9 15h6', 'M12 18v-6'],
  // [Lucide] file-text：歌詞檔
  lyricFile: ['M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z', 'M14 2v5a1 1 0 0 0 1 1h5', 'M10 9H8', 'M16 13H8', 'M16 17H8'],
  // [Lucide] file-music：音檔
  audioFile: ['M11.65 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v10.35', 'M14 2v5a1 1 0 0 0 1 1h5', 'M8 20v-7l3 1.474', 'c:6,20,2'],
  // [Lucide] music-2：已連結音訊
  audio: ['m19 6-5.2-3.9a.5.5 0 0 0-.8.4V18', 'c:9,18,4'],
  // [自繪] 連結音訊：音符＋加號（以 Lucide music-2 為底）
  linkAudio: ['m17 6-4.2-3.9a.5.5 0 0 0-.8.4V17', 'c:8,17,4', 'M19.5 14v6', 'M16.5 17h6'],
  // [自繪] 移除連結的音訊：音符＋減號（與連結音訊成對）
  unlinkAudio: ['m17 6-4.2-3.9a.5.5 0 0 0-.8.4V17', 'c:8,17,4', 'M16.5 17h6'],
  // [Lucide] file-minus：移除匯入的歌詞（與加入檔案 file-plus 成對）
  removeLyrics: ['M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z', 'M14 2v5a1 1 0 0 0 1 1h5', 'M9 15h6'],
  // [Lucide] pencil：編輯歌曲庫
  edit: ['M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z', 'm15 5 4 4'],
  // [Lucide] undo-2：復原
  undo: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11'],
  // [Lucide] log-out：再按一次返回鍵離開
  leave: ['m16 17 5-5-5-5', 'M21 12H9', 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'],
  // [Lucide] loader-circle：匯入中
  busy: ['M21 12a9 9 0 1 1-6.219-8.56'],
  // [Lucide] volume-x：歌詞模式（沒有音訊，依時間軸推進）
  clockMode: ['M11 4.702a.7.7 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.7.7 0 0 0 11 19.298z', 'm16.5 14.5 5-5', 'm16.5 9.5 5 5'],
  // [Lucide] timer-off：尚未對時
  untimed: ['M10 2h4', 'M4.6 11a8 8 0 0 0 1.7 8.7 8 8 0 0 0 8.7 1.7', 'M7.4 7.4a8 8 0 0 1 10.3 1 8 8 0 0 1 .9 10.2', 'm2 2 20 20', 'M12 12v-2'],
  // [Lucide] timer：歌詞有時間標記（與 timer-off 成對）
  timed: ['M10 2h4', 'M12 14l3-3', 'c:12,14,8'],
  // [自繪] 沒有歌詞：歌詞行＋叉號
  noLyrics: ['M3 6h12', 'M3 12h7', 'M3 18h5', 'm15 13 6 6', 'm21 13-6 6'],
  // [自繪] 打 CALL：螢光棒（本體＋握把）
  penlight: ['r:9,2,6,13,3', 'M10.5 15v4.5a1.5 1.5 0 0 0 3 0V15'],
  // [Lucide] arrow-up-to-line：回到目前位置（線＝目前行；目前行在下方時上下翻轉）
  recenter: ['M5 3h14', 'm18 13-6-6-6 6', 'M12 7v14'],
  // [Lucide] a-arrow-down / a-arrow-up：字級
  textSmaller: ['m14 12 4 4 4-4', 'M18 16V7', 'm2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16', 'M3.304 13h6.392'],
  textLarger: ['m14 11 4-4 4 4', 'M18 16V7', 'm2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16', 'M3.304 13h6.392'],
  // [Lucide] coffee：播放時螢幕常亮（Android「咖啡因」慣例）
  wake: ['M10 2v2', 'M14 2v2', 'M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1', 'M6 2v2'],
  // [Lucide] languages
  language: ['m5 8 6 6', 'm4 14 6-6 2-3', 'M2 5h12', 'M7 2h1', 'm22 22-5-10-5 10', 'M14 18h6'],
  // [Lucide] triangle-alert
  warning: ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01'],
  // [Lucide] check
  check: ['M20 6 9 17l-5-5'],
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function shape(spec) {
  let filled = false;
  let s = spec;
  if (s.startsWith('f:')) {
    filled = true;
    s = s.slice(2);
  }
  let node;
  if (s.startsWith('c:')) {
    const [cx, cy, r] = s.slice(2).split(',');
    node = document.createElementNS(SVG_NS, 'circle');
    node.setAttribute('cx', cx);
    node.setAttribute('cy', cy);
    node.setAttribute('r', r);
  } else if (s.startsWith('r:')) {
    const [x, y, w, hgt, rx] = s.slice(2).split(',');
    node = document.createElementNS(SVG_NS, 'rect');
    node.setAttribute('x', x);
    node.setAttribute('y', y);
    node.setAttribute('width', w);
    node.setAttribute('height', hgt);
    node.setAttribute('rx', rx || '0');
  } else {
    node = document.createElementNS(SVG_NS, 'path');
    node.setAttribute('d', s);
  }
  if (filled) node.setAttribute('class', 'is-filled');
  return node;
}

export function icon(name, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls ? `icon ${cls}` : 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const spec of ICON[name] || []) svg.append(shape(spec));
  return svg;
}

