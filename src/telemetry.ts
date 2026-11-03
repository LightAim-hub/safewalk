/**
 * 使われ方とエラーの記録（デモの集計用）。
 * 送るのは、決まった種類の出来事・短い説明・端末の種類だけ。現在地の座標・検索の文字・場所の名前は送らない。
 * 送れなくても、アプリの動きには関わらない（失敗は黙って捨てる）。
 */
// 相談の中継と同じ Worker の受け口(agent.ts の AGENT_ENDPOINT と同じ場所)。取り込みの循環を避けるため直接書く。
const LOG_URL = "https://safewalk-claude.matomaru-yotei.workers.dev/api/log";
const FLUSH_MS = 15000;
const MAX_QUEUE = 60;

type Ev = { type: string; detail: string; at: number };
let queue: Ev[] = [];
let timer = 0;

function sessionId(): string {
  try {
    const k = "safewalk-sid";
    let v = sessionStorage.getItem(k);
    if (!v) {
      v = Math.random().toString(36).slice(2, 12);
      sessionStorage.setItem(k, v);
    }
    return v;
  } catch {
    return "nostore";
  }
}
const SID = sessionId();

function device() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "その他";
  const br = /CriOS|Chrome/.test(ua) && !/Edg/.test(ua) ? "Chrome" : /Edg/.test(ua) ? "Edge" : /Firefox|FxiOS/.test(ua) ? "Firefox" : /Line\//.test(ua) ? "LINE" : /Safari/.test(ua) ? "Safari" : "その他";
  const app = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  return { os, br, w: window.innerWidth, h: window.innerHeight, app: !!app, ver: String(import.meta.env.VITE_APP_VER ?? "") };
}

/** 場所の名前などが混ざりうる文から、括弧の中身・座標らしい数字・URL の ? 以降を落とす。 */
export function scrub(text: string): string {
  return String(text)
    .replace(/[（(「『][^）)」』]*[）)」』]/g, "（…）")
    .replace(/\?[^\s"']*/g, "?…")
    .replace(/\d{2,3}\.\d{3,}/g, "#")
    .slice(0, 200);
}

export function track(type: string, detail = ""): void {
  if (!started) return;
  try {
    if (queue.length >= MAX_QUEUE) return;
    queue.push({ type, detail: scrub(detail), at: Date.now() });
    if (type === "js_error" || type === "load_error" || type === "consult_error") flush();
    else if (!timer) timer = window.setTimeout(flush, FLUSH_MS);
  } catch {
    // 記録の失敗は無視する。
  }
}

function flush(): void {
  window.clearTimeout(timer);
  timer = 0;
  if (!queue.length || !navigator.onLine) return;
  const body = JSON.stringify({ sid: SID, dev: device(), events: queue });
  queue = [];
  try {
    // text/plain にして、前もっての確認(preflight)を出さない。画面を閉じる時も送れる sendBeacon を先に使う。
    const blob = new Blob([body], { type: "text/plain" });
    if (!navigator.sendBeacon?.(LOG_URL, blob)) {
      fetch(LOG_URL, { method: "POST", body, keepalive: true, headers: { "content-type": "text/plain" } }).catch(() => {});
    }
  } catch {
    // 送れなかった分は捨てる。
  }
}

let started = false;
export function startTelemetry(): void {
  if (started || !import.meta.env.PROD) return;
  started = true;
  window.addEventListener("error", (e) => {
    const where = e.filename ? e.filename.split("/").pop() : "";
    track("js_error", `${e.message} @${where}:${e.lineno}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason as { message?: string } | undefined;
    track("js_error", `拒否: ${r?.message ?? String(e.reason)}`);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("pagehide", flush);
  track("open", navigator.onLine ? "" : "電波なし");
}
