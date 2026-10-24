// 介面字串（繁體中文／English／日本語）。介面以圖示為主，這裡只放 aria-label、tooltip、
// 錯誤原因、空狀態說明等非用文字不可的地方。歌詞、歌名等內容不經過這裡。

export const LANGS = [
  { code: 'zh', tag: 'zh-Hant' },
  { code: 'en', tag: 'en' },
  { code: 'ja', tag: 'ja' },
];

const S = {
  zh: {
    sep: '，',
    lyrics: '歌詞',
    library: '歌曲庫',
    unsorted: '未分類',
    openLibrary: '開啟歌曲庫',
    closeLibrary: '關閉歌曲庫',
    jumpAlbum: '跳到專輯',
    play: '播放',
    pause: '暫停',
    prev: '上一首',
    next: '下一首',
    calls: '打 CALL 標示',
    seek: '播放位置',
    seekValue: '{t}，共 {d}',
    spoken: '{m} 分 {s} 秒',
    recenter: '回到目前位置',
    clockMode: '歌詞模式：沒有音訊，依時間軸播放',
    addFiles: '加入檔案（.md 歌詞、音檔）',
    linkAudio: '連結音訊（選一次就會記住）',
    linkOtherAudio: '連結其他音檔',
    hasAudio: '已連結音訊',
    noAudio: '沒有音訊',
    timed: '歌詞有時間標記',
    untimed: '歌詞還沒有時間標記：在 .md 的行首加上 [分:秒.百分秒]',
    untimedShort: '沒有時間標記',
    noLyrics: '沒有歌詞：加入含這首歌的 .md 就會接上',
    noLyricsShort: '沒有歌詞',
    addLyrics: '加入歌詞檔',
    songCount: '{n} 首',
    fontSize: '歌詞字級',
    fontSmaller: '縮小歌詞',
    fontLarger: '放大歌詞',
    wake: '播放時螢幕常亮',
    language: '介面語言',
    empty: '加入 .md 歌詞檔與音檔就能開始；手機上長按可以一次選多個。',
    cantPlay: '無法播放「{name}」',
    errFormat: '這個瀏覽器不支援 {fmt} 格式。',
    errOpen: '瀏覽器打不開這個 {fmt} 檔，可能是編碼方式不受支援。',
    errDecode: '解碼到一半失敗，檔案可能已損毀。',
    errNetwork: '讀取檔案時中斷。',
    errUnknown: '瀏覽器回報了無法辨識的錯誤。',
    sentenceGap: '',
    errFixConvert: '換成 MP3 或 M4A 再連結一次。',
    errFixConvertMp3: '換成 MP3 再連結一次。',
    errFixReencode: '重新轉檔，或改用另一個檔案再連結一次。',
    errFixRetry: '再連結一次；仍然失敗就改用另一個檔案。',
    errLyricsStill: '歌詞仍可用歌詞模式播放。',
    importFailed: '「{name}」沒有加入：{why}',
    whyNoSongs: '找不到以「# 」開頭的歌名行。',
    whyUnreadable: '讀不到檔案內容。',
    whyParse: '格式無法解析（{msg}）。',
    importSkipped: '略過 {n} 個檔案：只能加入 .md 歌詞檔與音檔。',
    importSummary: '加入歌詞檔 {lyrics} 個、音檔 {audio} 個',
    linked: '已連結「{name}」',
    storageVolatile: '這個瀏覽器不允許儲存：設定與加入的檔案只在這次開啟有效。',
    storageQuota: '儲存空間不足：這次加入的檔案可以使用，下次開啟需要重新加入。',
    embeddedBroken: '內嵌的歌詞庫讀取失敗：重新建置，或用加入檔案載入 .md。',
    blocked: '瀏覽器擋下了自動播放，按播放鍵開始。',
    backAgain: '再按一次返回鍵離開',
    importSkippedDup: '略過「{name}」：同一首歌已有音質較好的「{kept}」。',
    importing: '加入中：{done}/{total}',
    editLibrary: '編輯歌曲庫',
    removeAudio: '移除連結的音訊（{title}）',
    removeLyricsRevert: '移除匯入的歌詞，恢復內建版本（{title}）',
    removeLyricsDrop: '移除匯入的歌詞（{title}）',
    removedAudio: '已移除「{title}」的音訊',
    removedLyrics: '已移除「{title}」匯入的歌詞',
    undo: '復原',
  },
  en: {
    sep: ', ',
    lyrics: 'Lyrics',
    library: 'Library',
    unsorted: 'Unsorted',
    openLibrary: 'Open library',
    closeLibrary: 'Close library',
    jumpAlbum: 'Jump to album',
    play: 'Play',
    pause: 'Pause',
    prev: 'Previous song',
    next: 'Next song',
    calls: 'Highlight calls',
    seek: 'Playback position',
    seekValue: '{t} of {d}',
    spoken: '{m} min {s} sec',
    recenter: 'Back to the current line',
    clockMode: 'Lyrics only: no audio, following the timing',
    addFiles: 'Add files (.md lyrics, audio)',
    linkAudio: 'Link an audio file (remembered next time)',
    linkOtherAudio: 'Link a different audio file',
    hasAudio: 'Audio linked',
    noAudio: 'No audio',
    timed: 'Lyrics are timed',
    untimed: 'Lyrics aren’t timed yet: add [mm:ss.xx] at the start of lines in the .md',
    untimedShort: 'not timed',
    noLyrics: 'No lyrics: add an .md that includes this song',
    noLyricsShort: 'no lyrics',
    addLyrics: 'Add a lyric file',
    songCount: 'Songs: {n}',
    fontSize: 'Lyric size',
    fontSmaller: 'Smaller lyrics',
    fontLarger: 'Larger lyrics',
    wake: 'Keep the screen on while playing',
    language: 'Language',
    empty: 'Add .md lyric files and audio to start. On a phone, long-press to pick several at once.',
    cantPlay: 'Can’t play “{name}”',
    errFormat: 'This browser doesn’t support {fmt}.',
    errOpen: 'The browser couldn’t open this {fmt} file; its encoding may not be supported.',
    errDecode: 'Decoding failed partway; the file may be damaged.',
    errNetwork: 'Reading the file was interrupted.',
    errUnknown: 'The browser reported an unknown error.',
    sentenceGap: ' ',
    errFixConvert: 'Convert it to MP3 or M4A and link it again.',
    errFixConvertMp3: 'Convert it to MP3 and link it again.',
    errFixReencode: 'Re-encode it, or link a different file.',
    errFixRetry: 'Link it again; if it still fails, use a different file.',
    errLyricsStill: 'Lyrics still play in lyrics-only mode.',
    importFailed: '“{name}” wasn’t added: {why}',
    whyNoSongs: 'there’s no song title line starting with “# ”.',
    whyUnreadable: 'the file couldn’t be read.',
    whyParse: 'the format couldn’t be parsed ({msg}).',
    importSkipped: 'Only .md lyric files and audio can be added; skipped {n}.',
    importSummary: 'Lyric files added: {lyrics}. Audio files added: {audio}.',
    linked: 'Linked “{name}”',
    storageVolatile: 'This browser won’t save data: settings and added files last only for this session.',
    storageQuota: 'Storage is full: added files work now but must be added again next time.',
    embeddedBroken: 'The built-in library couldn’t be read. Rebuild it, or add .md files.',
    blocked: 'The browser blocked playback. Press play to start.',
    backAgain: 'Press back again to leave',
    importSkippedDup: 'Skipped “{name}”: “{kept}” is better quality for the same song.',
    importing: 'Adding files: {done} of {total}',
    editLibrary: 'Edit library',
    removeAudio: 'Remove linked audio ({title})',
    removeLyricsRevert: 'Remove imported lyrics and restore the built-in version ({title})',
    removeLyricsDrop: 'Remove imported lyrics ({title})',
    removedAudio: 'Removed the audio for “{title}”',
    removedLyrics: 'Removed the imported lyrics for “{title}”',
    undo: 'Undo',
  },
  ja: {
    sep: '、',
    lyrics: '歌詞',
    library: 'ライブラリ',
    unsorted: '未分類',
    openLibrary: 'ライブラリを開く',
    closeLibrary: 'ライブラリを閉じる',
    jumpAlbum: 'アルバムへ移動',
    play: '再生',
    pause: '一時停止',
    prev: '前の曲',
    next: '次の曲',
    calls: 'コールを色分け',
    seek: '再生位置',
    seekValue: '{t}／{d}',
    spoken: '{m}分{s}秒',
    recenter: '現在の行に戻る',
    clockMode: '歌詞モード：音声なしでタイミングどおりに進みます',
    addFiles: 'ファイルを追加（.md 歌詞・音声）',
    linkAudio: '音声ファイルを紐づける（次回も自動で使います）',
    linkOtherAudio: '別の音声ファイルを紐づける',
    hasAudio: '音声あり',
    noAudio: '音声なし',
    timed: 'タイミングあり',
    untimed: 'タイミング未設定：.md の行頭に [分:秒.xx] を付けてください',
    untimedShort: 'タイミングなし',
    noLyrics: '歌詞なし：この曲を含む .md を追加すると紐づきます',
    noLyricsShort: '歌詞なし',
    addLyrics: '歌詞ファイルを追加',
    songCount: '{n} 曲',
    fontSize: '歌詞の大きさ',
    fontSmaller: '歌詞を小さく',
    fontLarger: '歌詞を大きく',
    wake: '再生中は画面をつけたままにする',
    language: '表示言語',
    empty: '.md の歌詞ファイルと音声を追加して始めましょう。スマホでは長押しで複数選べます。',
    cantPlay: '「{name}」を再生できません',
    errFormat: 'このブラウザは {fmt} 形式に対応していません。',
    errOpen: 'この {fmt} ファイルを開けませんでした。エンコード方式が未対応の可能性があります。',
    errDecode: '途中でデコードに失敗しました。ファイルが壊れている可能性があります。',
    errNetwork: 'ファイルの読み込みが中断されました。',
    errUnknown: 'ブラウザが不明なエラーを報告しました。',
    sentenceGap: '',
    errFixConvert: 'MP3 か M4A に変換して紐づけ直してください。',
    errFixConvertMp3: 'MP3 に変換して紐づけ直してください。',
    errFixReencode: '変換し直すか、別のファイルを紐づけてください。',
    errFixRetry: 'もう一度紐づけてください。それでも失敗する場合は別のファイルを使ってください。',
    errLyricsStill: '歌詞は歌詞モードで再生できます。',
    importFailed: '「{name}」は追加されませんでした：{why}',
    whyNoSongs: '「# 」で始まる曲名の行がありません。',
    whyUnreadable: 'ファイルを読み込めませんでした。',
    whyParse: '形式を解析できませんでした（{msg}）。',
    importSkipped: '{n} 件をスキップしました。追加できるのは .md 歌詞ファイルと音声だけです。',
    importSummary: '歌詞ファイル {lyrics} 件、音声 {audio} 件を追加しました',
    linked: '「{name}」を紐づけました',
    storageVolatile: 'このブラウザは保存を許可していません。設定と追加したファイルは今回だけ有効です。',
    storageQuota: '保存容量が足りません。追加したファイルは今は使えますが、次回は追加し直してください。',
    embeddedBroken: '内蔵ライブラリを読み込めませんでした。再ビルドするか、.md を追加してください。',
    blocked: '再生がブロックされました。再生ボタンを押してください。',
    backAgain: 'もう一度「戻る」で終了します',
    importSkippedDup: '「{name}」をスキップしました。同じ曲に音質の良い「{kept}」があります。',
    importing: '追加中：{done}/{total}',
    editLibrary: 'ライブラリを編集',
    removeAudio: '紐づけた音声を削除（{title}）',
    removeLyricsRevert: '取り込んだ歌詞を削除して内蔵版に戻す（{title}）',
    removeLyricsDrop: '取り込んだ歌詞を削除（{title}）',
    removedAudio: '「{title}」の音声を削除しました',
    removedLyrics: '「{title}」の取り込んだ歌詞を削除しました',
    undo: '元に戻す',
  },
};

let lang = 'en';
const listeners = new Set();

export function detectLang() {
  const list = (typeof navigator !== 'undefined' && (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language])) || [];
  for (const l of list) {
    const v = String(l || '').toLowerCase();
    if (v.startsWith('ja')) return 'ja';
    if (v.startsWith('zh')) return 'zh';
    if (v) return 'en';
  }
  return 'en';
}

export function langTag(code = lang) {
  const found = LANGS.find((l) => l.code === code);
  return found ? found.tag : 'en';
}

export function setLang(code) {
  const next = S[code] ? code : 'en';
  lang = next;
  if (typeof document !== 'undefined') document.documentElement.lang = langTag(next);
  for (const fn of listeners) fn(next);
}

export function onLangChange(fn) {
  listeners.add(fn);
}

export function t(key, params) {
  const table = S[lang] || S.en;
  let str = table[key];
  if (str == null) str = S.en[key];
  if (str == null) return key;
  if (params) str = str.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
  return str;
}

// 套用到靜態 DOM：data-i18n-label → aria-label 與 tooltip；data-i18n-aria → 只有 aria-label（容器用）；
// data-i18n → 文字
export function applyStatic(root = document) {
  for (const el of root.querySelectorAll('[data-i18n-label]')) {
    const s = t(el.dataset.i18nLabel);
    el.setAttribute('aria-label', s);
    el.dataset.tip = s;
  }
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
}
