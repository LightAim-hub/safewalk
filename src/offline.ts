/// <reference types="vite/client" />
/**
 * 電波が弱い・無い時の備え(Service Worker の登録と、オフライン表示)。
 * 中身は public/sw.js。使えない端末・プライベートブラウズ・開発中(vite dev)では何もせず、今まで通り通信で動く。
 */

const NOTE_TEXT = "電波がないため、前に読み込んだ地図とデータで表示しています";
const UPDATE_CHECK_MIN_MS = 10 * 60 * 1000;

let note: HTMLElement | null = null;

function showNote(): void {
  if (!note) {
    note = document.createElement("p");
    note.id = "offline-note";
    note.className = "toast";
    note.setAttribute("role", "status");
    // .toast は狭い画面で top を持つので、上下を両方決めないと縦に伸びて画面を覆う。
    // 上は検索欄の下に置き、押す操作は下の物へ通す。
    Object.assign(note.style, { top: "calc(env(safe-area-inset-top, 0px) + 64px)", bottom: "auto", height: "auto", pointerEvents: "none" });
    note.textContent = NOTE_TEXT;
    document.body.append(note);
  }
  note.hidden = false;
  // 出しっぱなしにすると候補やジャンルの列に重なるので、少しして畳む（電波が切れるたびにまた出す）。
  clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => {
    if (note) note.hidden = true;
  }, NOTE_MS);
}

const NOTE_MS = 6000;
let noteTimer = 0;

function hideNote(): void {
  if (note) note.hidden = true;
}

/** 電波が無い間は一行を出し、戻ったら消す。 */
function watchConnection(): void {
  if (!navigator.onLine) showNote();
  window.addEventListener("offline", showNote);
  window.addEventListener("online", hideNote);
}

export function bindOffline(): void {
  watchConnection();
  // 開発中は登録しない(古い物が残って、直した結果が見えなくなるため)。
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  try {
    const url = new URL("sw.js", document.baseURI).href;
    const start = () => {
      navigator.serviceWorker
        .register(url)
        .then((reg) => {
          // 長く開いたままの画面でも更新に気づけるよう、戻ってきた時に確かめる。
          let last = Date.now();
          document.addEventListener("visibilitychange", () => {
            if (document.visibilityState !== "visible" || Date.now() - last < UPDATE_CHECK_MIN_MS) return;
            last = Date.now();
            reg.update().catch(() => {});
          });
        })
        .catch((err) => console.warn("オフラインの備えを使えません", err));
      // 端末に残す量が多いので、消されにくくするよう頼む(断られても動作は変わらない)。
      navigator.storage?.persist?.().catch(() => {});
    };
    // 初回の読み込みと通信を取り合わないよう、画面が出た後に始める。
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start, { once: true });
  } catch (err) {
    console.warn("オフラインの備えを使えません", err);
  }
}
