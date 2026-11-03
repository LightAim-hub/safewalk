/**
 * 音声案内の「声の選び方」「読み上げ用の文の整え方」「読み上げの順番」。
 * ブラウザ標準の speechSynthesis だけを使う(外部の音声合成は使わない)。
 * guide.ts の speak から呼ぶ。画面に出す文はそのままにして、読ませる文だけをここで作る。
 */

// ---------------------------------------------------------------- 声の選び方

export type VoiceLike = Pick<SpeechSynthesisVoice, "name" | "lang" | "voiceURI" | "localService" | "default">;

/**
 * 速さ・高さ。実機での聞き比べはまだしていないので、動かさない値にした。
 * 拡張・Premium・Neural の声は標準の速さ(1.0)・高さ(1.0)で調整されており、
 * 変えると抑揚が崩れる。道案内は短い文なので、遅くして間延びさせる必要も無い。
 * 実機で聞き取りにくければ、この2つだけを直せばよい。
 */
export const RATE = 1;
export const PITCH = 1;
/** Android の Chrome は長い文の途中で止まることがあるので、1回に読む文の長さを抑える(文字数)。 */
const MAX_CHUNK = 36;

const isJapanese = (v: VoiceLike) => /^ja([-_]|$)/i.test(v.lang) || /japan|日本/i.test(v.name);

/**
 * 日本語の声の点数。日本語でなければ -1。高いほど自然な声。
 *   Microsoft の Online (Natural)(Edge)   +100  ニューラル。端末にあれば最良
 *   Premium / プレミアム(iPhone・Mac)      +90
 *   Siri(iPhone)                          +80
 *   Enhanced / 拡張(iPhone・Mac)           +70
 *   Google 日本語(Chrome・Android)         +60
 *   上のどれでもない日本語の声               +10
 *   compact(iPhone の軽い声)              -20
 * 同じ程度なら、通信が要らない端末内の声(localService)を +15 で選ぶ。歩いている間は電波が弱い事があり、
 * 通信の声は読み始めが遅れたり黙ったりするため。
 */
export function scoreVoice(v: VoiceLike): number {
  if (!isJapanese(v)) return -1;
  const id = `${v.name} ${v.voiceURI}`;
  let score = 10;
  if (/natural|online/i.test(id)) score = 100;
  else if (/premium|プレミアム/i.test(id)) score = 90;
  else if (/siri/i.test(id)) score = 80;
  else if (/enhanced|拡張/i.test(id)) score = 70;
  else if (/google/i.test(id)) score = 60;
  if (/compact/i.test(id)) score -= 20;
  if (v.localService) score += 15;
  if (v.default) score += 3;
  return score;
}

/** 端末の声の一覧から使う声を選ぶ。日本語の声が無ければ null(既定の ja-JP に任せる)。 */
export function pickVoice<T extends VoiceLike>(voices: readonly T[]): T | null {
  let best: T | null = null;
  let bestScore = -1;
  for (const v of voices) {
    const s = scoreVoice(v);
    if (s > bestScore || (s === bestScore && best !== null && v.name < best.name)) {
      best = v;
      bestScore = s;
    }
  }
  return best;
}

let chosen: SpeechSynthesisVoice | null = null;
let voiceReady: Promise<void> | null = null;
const voiceListeners: (() => void)[] = [];

/** 選んだ声の名前。選べていない間は空。 */
export function chosenVoiceName(): string {
  return chosen ? chosen.name : "";
}

/** 声が決まった(または一覧が変わった)時に呼ぶ関数を登録する。ボタンの title の更新に使う。 */
export function onVoiceChange(fn: () => void): void {
  voiceListeners.push(fn);
}

function refreshVoice(): void {
  const before = chosen;
  chosen = pickVoice(speechSynthesis.getVoices());
  if (chosen !== before) voiceListeners.forEach((fn) => fn());
}

/** 声の一覧を読み込む。多くのブラウザは最初 getVoices() が空で、voiceschanged の後に入る。 */
export function loadVoices(): Promise<void> {
  if (voiceReady) return voiceReady;
  if (!("speechSynthesis" in window)) return (voiceReady = Promise.resolve());
  voiceReady = new Promise<void>((resolve) => {
    refreshVoice();
    if (chosen) return resolve();
    // iPhone は voiceschanged が来ない事があるため、数秒だけ読み直す。
    let tries = 0;
    const timer = window.setInterval(() => {
      refreshVoice();
      if (chosen || ++tries >= 10) {
        window.clearInterval(timer);
        resolve();
      }
    }, 300);
  });
  speechSynthesis.addEventListener?.("voiceschanged", refreshVoice);
  return voiceReady;
}

// ---------------------------------------------------------------- 読み上げ用の文の整え方

/**
 * 読み仮名の辞書。道の名前・地名のうち、そのまま読ませると誤りやすい物。長い語を先に置き換える。
 * 読みの根拠:
 *   神戸市「道路愛称」一覧(city.kobe.lg.jp/a69673/kurashi/access/road/aisyo.html)に読みがある物: 乙仲通・走水通
 *   神戸市の英語表記入りの案内資料(Koikawa Suji)で確かめた物: 鯉川筋
 *   上以外は、神戸市の町名・区名・駅名として読みが定まっている語(辞書の語と同じ読みで駅名・町名の表記がある物)
 * 読みを確かめられなかった物は入れていない(西門筋・東門筋・柳筋・堀割筋・鎮台筋・穴門筋・六間道・生田新道。
 * 生田新道は資料により「しんどう」「しんみち」で割れた)。入れない物は端末の声の読みに任せる。
 */
export const READINGS: [string, string][] = [
  ["乙仲通", "おつなかどおり"],
  ["走水通", "はしうどどおり"],
  ["鯉川筋", "こいかわすじ"],
  ["山手幹線", "やまてかんせん"],
  ["三宮センター街", "さんのみやセンターがい"],
  ["元町高架下商店街", "もとまちこうかしたしょうてんがい"],
  ["高架下", "こうかした"],
  ["商店街", "しょうてんがい"],
  ["新長田", "しんながた"],
  ["異人館", "いじんかん"],
  ["旧居留地", "きゅうきょりゅうち"],
  ["旧西国街道", "きゅうさいごくかいどう"],
  ["西国街道", "さいごくかいどう"],
  ["水道筋", "すいどうすじ"],
  ["新開地", "しんかいち"],
  ["花隈", "はなくま"],
  ["磯上", "いそがみ"],
  ["元町", "もとまち"],
  ["三宮", "さんのみや"],
  ["北野", "きたの"],
  ["生田", "いくた"],
  ["栄町", "さかえまち"],
  ["湊川", "みなとがわ"],
  ["板宿", "いたやど"],
  ["鷹取", "たかとり"],
  ["御影", "みかげ"],
  ["住吉", "すみよし"],
  ["魚崎", "うおざき"],
  ["岡本", "おかもと"],
  ["六甲", "ろっこう"],
  ["摩耶", "まや"],
  ["灘", "なだ"],
  ["垂水", "たるみ"],
  ["舞子", "まいこ"],
  ["須磨", "すま"],
  ["長田", "ながた"],
  ["兵庫", "ひょうご"],
  ["神戸", "こうべ"],
  ["国体道路", "こくたいどうろ"],
  ["旧道", "きゅうどう"],
  ["歩道橋", "ほどうきょう"],
];

const READINGS_SORTED = [...READINGS].sort((a, b) => b[0].length - a[0].length);

/** 道の名前の語尾。「通」「筋」「坂」は単独だと読み違えやすいので、語尾のときだけ読みを足す。 */
function readRoad(name: string): string {
  let s = name;
  for (const [word, reading] of READINGS_SORTED) s = s.split(word).join(reading);
  return s
    .replace(/本通(?![りぁ-ん])/g, "ほんどおり")
    .replace(/([^\s])通$/, "$1どおり")
    .replace(/([^\s])筋$/, "$1すじ")
    .replace(/([^\s])坂$/, "$1ざか");
}

/** 括弧とその中(英字の併記・補足)を落とす。 */
function dropParens(s: string): string {
  return s
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[（(][^）)]*$/, "")
    .replace(/[）)]/g, "");
}

/** 数字と単位を読む形にし、記号を落とす。 */
function plain(text: string): string {
  return dropParens(text)
    .replace(/(\d)\s*[~〜～]\s*(\d)/g, "$1から$2")
    .replace(/(\d)\s*km\b/gi, "$1キロメートル")
    .replace(/(\d)\s*m\b/g, "$1メートル")
    .replace(/(\d)\s*分/g, "$1分")
    .replace(/[→←↑↓↗↖↘↙◎⚑※★☆■□●○▶▼▲◆◇]/g, "")
    .replace(/[「」『』【】［］\[\]<>＜＞"]/g, "")
    .replace(/[・/／|｜]/g, "、")
    .replace(/[~〜～]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 長い文を、読みやすい長さの文に分ける。句点で切り、まだ長ければ読点で切る。 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/(?<=[。！？!?])/)) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length <= MAX_CHUNK) {
      out.push(sentence);
      continue;
    }
    let chunk = "";
    for (const part of sentence.split(/(?<=、)/)) {
      if (chunk.length >= 10 && (chunk + part).length > MAX_CHUNK) {
        out.push(chunk);
        chunk = "";
      }
      chunk += part;
    }
    if (chunk) out.push(chunk);
  }
  return out;
}

/** 表示用の文を、読み上げる文(句点で終わる複数の文)にする。 */
export function prepareText(text: string): string[] {
  const cleaned = readRoad(plain(text)).replace(/、{2,}/g, "、").replace(/^、|、$/g, "");
  const sentences = splitSentences(cleaned.replace(/([^。！？!?])$/, "$1。"));
  return sentences.map((s) => s.replace(/、。/g, "。"));
}

/** 案内の手順の文(例: 右に曲がる（西門筋）)と次の曲がり角までの距離から、読み上げる文を作る。 */
export function turnSpeech(stepText: string, metresToTurn: number | null): string {
  const road = readRoad((stepText.match(/[（(]([^）)]*)[）)]/)?.[1] ?? "").replace(/\s*[（(].*$/, "").trim());
  const main = dropParens(stepText).trim();
  if (main.startsWith("経由地")) {
    const stop = main.replace(/^経由地[「『]?/, "").replace(/[」』]$/, "");
    return `まもなく、経由地、${stop}です。`;
  }
  const verb = main
    .replace(/^次の角を/, "")
    .replace(/^次の分かれ道で/, "分かれ道で")
    .replace(/曲がる$/, "曲がります")
    .replace(/進む$/, "進みます")
    .replace(/始める$/, "始めます");
  const near = metresToTurn === null || metresToTurn < 30 ? "まもなく" : `${Math.round(metresToTurn / 10) * 10}メートル先`;
  const first = main.endsWith("歩き始める") ? `${verb}。` : `${near}、${verb}。`;
  if (!road) return first;
  if (/橋$/.test(road)) return `${first}${road}を渡ります。`;
  return main.endsWith("歩き始める") ? `${first}${road}を進みます。` : `${first}${road}に入ります。`;
}

// ---------------------------------------------------------------- 読み上げの順番

/**
 *   turn   曲がる案内・到着・経路を外れた等。今読んでいる物を切って、すぐ読む。
 *   notice 注意書きの知らせ。曲がる案内を切らない。読み上げ中なら1件だけ待たせ、待ちすぎたら捨てる。
 *   toggle 音声の切り替えの返事。今読んでいる物を切って読む。
 */
export type SayKind = "turn" | "notice" | "toggle";

/** 待たせた知らせを捨てるまでの時間(ms)。曲がり角の案内が済んだ頃には、場所が通り過ぎている事がある。 */
export const PENDING_MAX_MS = 15000;
/** 同じ文を続けて読まない間隔(ms)。曲がる案内は呼ぶ側でも重ねて出さないので短め。 */
export const REPEAT_MS: Record<SayKind, number> = { turn: 15000, notice: 60000, toggle: 0 };

type Current = { id: number; kind: SayKind; left: number };
let current: Current | null = null;
let pending: { text: string; at: number } | null = null;
let lastText = "";
let lastAt = 0;
let nextId = 0;
/** Chrome は参照の無い発話を回収して終了の通知が来なくなる事があるため、読み終えるまで持つ。 */
const alive = new Set<SpeechSynthesisUtterance>();

/** 実際に読ませた文の記録。確認用。 */
export const spoken: { text: string; kind: SayKind }[] = [];

function begin(text: string, kind: SayKind): void {
  const lines = prepareText(text);
  if (!lines.length) return;
  const id = ++nextId;
  current = { id, kind, left: lines.length };
  lastText = text;
  lastAt = Date.now();
  spoken.push({ text: lines.join(""), kind });
  for (const line of lines) {
    const u = new SpeechSynthesisUtterance(line);
    u.lang = "ja-JP";
    if (chosen) u.voice = chosen;
    u.rate = RATE;
    u.pitch = PITCH;
    const done = () => {
      alive.delete(u);
      if (!current || current.id !== id) return;
      if (--current.left <= 0) {
        current = null;
        flushPending();
      }
    };
    u.onend = done;
    u.onerror = done;
    alive.add(u);
    speechSynthesis.speak(u);
  }
}

function flushPending(): void {
  const p = pending;
  pending = null;
  if (p && Date.now() - p.at <= PENDING_MAX_MS) say(p.text, "notice");
}

/** 声を出す。種類ごとの重なり方は SayKind の説明のとおり。 */
export function say(text: string, kind: SayKind = "turn"): void {
  if (!("speechSynthesis" in window)) return;
  const now = Date.now();
  if (text === lastText && now - lastAt < REPEAT_MS[kind]) return;
  if (kind === "notice") {
    if (current) {
      if (text !== lastText) pending = { text, at: now };
      return;
    }
    begin(text, kind);
    return;
  }
  pending = null;
  if (current) {
    current = null;
    speechSynthesis.cancel();
  }
  begin(text, kind);
}

/** 読み上げを止める。 */
export function stopSpeaking(): void {
  current = null;
  pending = null;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

/** iPhone は最初の読み上げが画面の操作の直後でないと鳴らない。案内を始める操作の中で、音の無い発話を1つ出しておく。 */
export function primeVoice(): void {
  if (!("speechSynthesis" in window)) return;
  void loadVoices();
  const u = new SpeechSynthesisUtterance(" ");
  u.volume = 0;
  u.lang = "ja-JP";
  speechSynthesis.speak(u);
}

/** 履歴を空にする(確認用)。 */
export function resetVoiceState(): void {
  stopSpeaking();
  lastText = "";
  lastAt = 0;
  spoken.length = 0;
}
