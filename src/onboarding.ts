import "./onboarding.css";

/** 位置情報が使えなかった理由。 */
export type LocateFail = "denied" | "unavailable" | "timeout" | "outside" | "unsupported";

const FLAG = "safewalk.intro.seen";
const NO_NAME = "駅名や住所を入れれば、現在地なしでも使えます。";
const PRIVACY = "現在地は経路の計算にだけ使い、送信も保存もしません。";

/** 例の経路（三宮駅→北野）。位置情報なしで出る。 */
export const EXAMPLE_URL = `?from=34.6939,135.1924&fromName=${encodeURIComponent("三宮駅")}&to=34.7000,135.1870&toName=${encodeURIComponent("北野")}&period=day`;

let memorySeen = false;

function readSeen(): boolean {
  try {
    return localStorage.getItem(FLAG) === "1";
  } catch {
    return memorySeen;
  }
}

function writeSeen(): void {
  memorySeen = true;
  try {
    localStorage.setItem(FLAG, "1");
  } catch {
    /* 保存できなくても動く */
  }
}

/** LINE・X・Instagram・Facebook などのアプリ内ブラウザらしいか。控えめに判定する。 */
export function inAppBrowser(ua: string = navigator.userAgent): boolean {
  return /\bLine\/|FBAN|FBAV|Instagram|Twitter|MicroMessenger|KAKAOTALK|; wv\)/i.test(ua);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---- 位置情報のメモ（自動では消えない。閉じるボタンで閉じる） ----

let note: HTMLElement | null = null;
let noteDone: (() => void) | null = null;

function closeNote(): void {
  note?.remove();
  note = null;
  const done = noteDone;
  noteDone = null;
  done?.();
}

function openNote(role: "status" | "alert", build: (box: HTMLElement) => void): void {
  closeNote();
  const box = el("section", "card locate-note");
  box.setAttribute("role", role);
  const close = el("button", "icon plain note-close", "✕");
  close.type = "button";
  close.setAttribute("aria-label", "閉じる");
  close.addEventListener("click", closeNote);
  box.append(close);
  build(box);
  document.body.append(box);
  note = box;
}

const para = (text: string, cls?: string) => el("p", cls, text);

/** 位置情報を求める前の一言。「使う」なら true。 */
export function confirmLocate(): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (v: boolean) => {
      if (answered) return;
      answered = true;
      resolve(v);
    };
    openNote("status", (box) => {
      box.append(para(PRIVACY));
      box.append(para("このあと、ブラウザが位置情報の許可を聞いてきます。", "note-sub"));
      const row = el("div", "note-actions");
      const ok = el("button", "primary", "現在地を使う");
      ok.type = "button";
      ok.addEventListener("click", () => {
        answer(true);
        closeNote();
      });
      const no = el("button", "secondary", "やめる");
      no.type = "button";
      no.addEventListener("click", () => {
        answer(false);
        closeNote();
      });
      row.append(ok, no);
      box.append(row);
      queueMicrotask(() => ok.focus());
    });
    noteDone = () => answer(false);
  });
}

/** 位置情報が使えなかった理由を、消えない案内で出す。 */
export function showLocateFail(kind: LocateFail): void {
  openNote("alert", (box) => {
    const steps = (title: string, lines: string[]) => {
      const d = el("div", "note-steps");
      d.append(el("strong", undefined, title));
      d.append(para(lines.join(" ＞ ")));
      return d;
    };
    if (kind === "denied") {
      box.append(para("現在地の使用が許可されていません。", "note-title"));
      box.append(para("許可を出し直すと使えます。"));
      box.append(steps("iPhone", ["設定", "プライバシーとセキュリティ", "位置情報サービス", "Safari の Web サイト（Chrome などは、そのアプリ）", "「このWebサイトの使用中のみ」など"]));
      box.append(steps("Android（Chrome）", ["Chrome のメニュー", "設定", "サイトの設定", "位置情報", "このサイトを許可"]));
    } else if (kind === "unavailable") {
      box.append(para("いまの場所を調べられませんでした。", "note-title"));
      box.append(para("端末の位置情報（位置情報サービス）がオフになっているか、電波が届きにくい場所かもしれません。iPhone は「設定 ＞ プライバシーとセキュリティ ＞ 位置情報サービス」でオンにできます。"));
    } else if (kind === "timeout") {
      box.append(para("時間内に現在地が取れませんでした。", "note-title"));
      box.append(para("建物の中や地下では取れにくいことがあります。外や窓の近くで、もう一度「現在地」を押してください。"));
    } else if (kind === "outside") {
      box.append(para("現在地が神戸市の外のようです。", "note-title"));
      box.append(para("このアプリは神戸市の中の道だけを案内します。"));
    } else {
      box.append(para("この端末のブラウザでは、現在地を取得できません。", "note-title"));
    }
    box.append(para(NO_NAME, "note-strong"));
    if (inAppBrowser()) box.append(para("いまのアプリ内ブラウザが原因かもしれません。Safari や Chrome で開くと使えることがあります。"));
  });
}

// ---- 初回の説明 ----

let intro: HTMLElement | null = null;
let introReturn: HTMLElement | null = null;

function closeIntro(): void {
  intro?.remove();
  intro = null;
  document.body.classList.remove("intro-open");
  introReturn?.focus();
  introReturn = null;
}

export function openIntro(): void {
  if (intro) return;
  introReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const wrap = el("div", "intro-back");
  const box = el("div", "card intro");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-labelledby", "intro-title");
  const h = el("h2", undefined, "SafeWalk へようこそ");
  h.id = "intro-title";
  box.append(
    h,
    para("神戸市の、歩いて行くための地図です。道ごとに、むかしの交通事故の記録と、夜の歩きやすさを見られます。"),
    para("安全を保証するものではありません。歩くときは、まわりをよく見てください。", "intro-warn"),
  );
  if (inAppBrowser()) box.append(para("LINE や X などのアプリの中では、現在地がうまく使えないことがあります。Safari や Chrome で開くと確実です。", "intro-app"));
  const row = el("div", "note-actions");
  const ex = el("button", "secondary", "例を見る（三宮駅→北野）");
  ex.type = "button";
  ex.addEventListener("click", () => {
    writeSeen();
    location.assign(location.pathname + EXAMPLE_URL);
  });
  const go = el("button", "primary", "使ってみる");
  go.type = "button";
  go.addEventListener("click", () => {
    writeSeen();
    closeIntro();
  });
  row.append(go, ex);
  box.append(row);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      writeSeen();
      closeIntro();
    }
  });
  wrap.append(box);
  document.body.append(wrap);
  document.body.classList.add("intro-open");
  intro = wrap;
  go.focus();
}

function bannerForInApp(): void {
  if (!inAppBrowser()) return;
  const bar = el("div", "inapp-bar");
  bar.setAttribute("role", "status");
  bar.append(el("span", undefined, "このアプリの中では現在地がうまく使えないことがあります。Safari や Chrome で開くと確実です。"));
  const x = el("button", "icon plain note-close", "✕");
  x.type = "button";
  x.setAttribute("aria-label", "閉じる");
  x.addEventListener("click", () => bar.remove());
  bar.append(x);
  document.body.append(bar);
}

/** 起動時に呼ぶ。初めてなら説明を出し、「使い方」ボタンで開き直せるようにする。 */
export function bindOnboarding(): void {
  const help = document.createElement("button");
  help.id = "help";
  help.type = "button";
  help.className = "locate help";
  help.setAttribute("aria-label", "使い方");
  help.title = "使い方";
  help.textContent = "?";
  help.addEventListener("click", openIntro);
  document.body.append(help);
  bannerForInApp();
  const q = new URLSearchParams(location.search);
  // 共有された地点や経路を開いた時、intro=0 の時は出さない。
  const shared = location.search.length > 1;
  if (!readSeen() && !shared && q.get("intro") !== "0") openIntro();
}
