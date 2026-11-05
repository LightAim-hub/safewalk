import { VOICE_TIP } from "./voice";
import { track } from "./telemetry";
import { $, CURRENT, el, sheet as sheetEl, state } from "./app";
import { openDirections, renderStops, SAFETY_PAGE } from "./directions";
import { emergencyPanel, KOBAN_HEADING_HERE } from "./emergency";
import { voiceOn } from "./guide";
import { type KobanHit } from "./koban";
import { setBaseLayer, type BaseLayer } from "./map-ui";
import { openIntro } from "./onboarding";
import { type Place } from "./types";
import { copyLink } from "./url";
import { WALK_M_PER_MIN } from "./routes";
import { chosenVoiceName, onVoiceChange } from "./voice";
import "./menu.css";

/**
 * 地図の右側の「≡」から開く、下からの一覧。使う頻度の低い設定と説明をここにまとめる。
 * 昼夜の切り替えと免責は、経路の画面に置くのでここには入れない。
 */

const LAYER_CHOICES: [BaseLayer | "map", string][] = [
  ["map", "地図"],
  ["photo", "航空写真"],
  ["relief", "地形"],
];

/** データの出典（public/safety.html の「出典」と、地図の下の表示から要約した物）。 */
const SOURCES = [
  "交通事故: 警察庁「交通事故統計情報のオープンデータ」（2020〜2025年）を神戸市内で抜き出して加工",
  "ひったくり・車上ねらい・交番と警察署: 兵庫県警察のデータ（兵庫県オープンデータカタログ、CC BY 2.1 JP）を加工",
  "町丁目の境界・人口: 政府統計の総合窓口（e-Stat）、総務省統計局 2020年国勢調査 小地域を加工",
  "深夜の滞在人口: 国土交通省「全国の人流オープンデータ」（2019年）を加工して作成",
  "夜間光: 衛星 VIIRS 年平均（2023〜2025年、Earth Observation Group、CC BY 4.0）を加工して作成",
  "地図・道・店の営業時間: OpenStreetMap © contributors（OpenFreeMap 配信）",
  "航空写真・地形・住所・標高: 国土地理院",
  "何番何号の位置: 国土地理院「電子国土基本図（地名情報）住居表示住所」を加工して作成。号まで入れて探した時だけ、その区の分を読みます",
  "郵便番号から町名: zipcloud 郵便番号検索API（株式会社アイビス）。郵便番号を検索した時だけ使います",
  "#7119 の案内: 神戸市の救急安心センターのページ",
];

let layer: BaseLayer | "map" = "map";
let back: HTMLElement;
let sheet: HTMLElement;
let opener: HTMLElement | null = null;
/** メニューを開いた時刻。ダブルタップの2回目が背後の幕に当たって、すぐ閉じるのを防ぐ。 */
let openedAt = 0;
const TAP_GUARD_MS = 450;

const FOCUSABLE = 'a[href], button:not([disabled]), summary, input, [tabindex]:not([tabindex="-1"])';

function focusables(): HTMLElement[] {
  return [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
}

/** 開いている間だけ、Esc で閉じ、Tab を一覧の中に閉じ込める。 */
function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    return closeMenu();
  }
  if (e.key !== "Tab") return;
  const list = focusables();
  if (!list.length) return;
  const first = list[0];
  const last = list[list.length - 1];
  const active = document.activeElement;
  if (!sheet.contains(active)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

export function openMenu(): void {
  if (!back.hidden) return;
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : $("menu-open");
  refreshVoice();
  back.hidden = false;
  openedAt = Date.now();
  document.body.classList.add("menu-open");
  document.addEventListener("keydown", onKey, true);
  sheet.scrollTop = 0;
  sheet.querySelector<HTMLElement>(".menu-close")?.focus();
}

export function closeMenu(): void {
  if (back.hidden) return;
  back.hidden = true;
  document.body.classList.remove("menu-open");
  document.removeEventListener("keydown", onKey, true);
  // 緊急の枠は、次に開く時に位置を取り直すため畳む。
  const emg = $("menu-emg");
  emg.setAttribute("aria-expanded", "false");
  $("menu-emg-box").hidden = true;
  $("menu-emg-box").replaceChildren();
  const back2 = opener && opener.isConnected && opener.offsetParent !== null ? opener : $("menu-open");
  opener = null;
  back2.focus();
}

function refreshVoice(): void {
  const on = voiceOn;
  const button = $<HTMLButtonElement>("menu-voice");
  if (!("speechSynthesis" in window)) {
    button.textContent = "音声案内（この端末では使えません）";
    button.disabled = true;
    $("menu-voice-name").textContent = "";
    return;
  }
  button.textContent = on ? "音声案内 オン" : "音声案内 オフ";
  button.setAttribute("aria-pressed", String(on));
  const name = chosenVoiceName();
  $("menu-voice-name").textContent = `使っている声: ${name || "端末の既定の日本語"}`;
}

/** 現在地を、緊急の時にだけ使う。許可の前置きは挟まず、押した本人の操作をそのまま許可の求めにする。 */
function locateForEmergency(): Promise<Place | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ lat: coords.latitude, lon: coords.longitude, name: CURRENT }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  });
}

function showEmergency(origin: Place | null): void {
  track("emergency", "メニュー");
  const box = $("menu-emg-box");
  const onRoute = (k: KobanHit) => {
    if (!origin) return;
    closeMenu();
    // 交番へは経由地を回らず、まっすぐ向かう。
    state.stops = [];
    renderStops();
    openDirections({ from: origin, to: { name: k.name, lat: k.lat, lon: k.lon, kind: "警察" } });
  };
  const panel = emergencyPanel(origin, onRoute, undefined, origin?.name === CURRENT ? KOBAN_HEADING_HERE : undefined);
  if (!origin) {
    const near = panel.querySelector(".emg-near");
    const find = el("button", "primary menu-find", "いまいる場所から近い交番を探す");
    find.type = "button";
    const note = el("p", "emg-hint", "位置情報の許可を聞かれたら、許可してください。");
    near?.replaceChildren(find, note);
    find.addEventListener("click", async () => {
      find.disabled = true;
      note.textContent = "いまの場所を調べています…";
      const here = await locateForEmergency();
      if (box.hidden) return;
      if (here) showEmergency(here);
      else {
        find.disabled = false;
        note.textContent = "いまの場所が分かりませんでした。上の番号に電話してください。";
      }
    });
  }
  box.replaceChildren(panel);
}

/** 位置情報が許可済みの時だけ（許可の確認を新しく出さない）、現在地から近い順に出し直す。 */
async function upgradeToCurrent(box: HTMLElement): Promise<void> {
  try {
    const status = await navigator.permissions?.query({ name: "geolocation" });
    if (status?.state !== "granted") return;
  } catch {
    return;
  }
  const here = await locateForEmergency();
  if (here && !box.hidden) showEmergency(here);
}

function toggleEmergency(): void {
  const button = $("menu-emg");
  const open = button.getAttribute("aria-expanded") !== "true";
  button.setAttribute("aria-expanded", String(open));
  const box = $("menu-emg-box");
  box.hidden = !open;
  if (!open) return void box.replaceChildren();
  // 経路の画面では出発地を先に出し、現在地が使える（許可済み）なら現在地から探し直す。
  // 決まっていなければ、「いまいる場所から近い交番を探す」を押した時に探す。
  showEmergency(state.from);
  box.scrollIntoView({ block: "nearest" });
  if (state.mode === "directions" && state.from && state.from.name !== CURRENT) void upgradeToCurrent(box);
}

async function shareApp(button: HTMLButtonElement): Promise<void> {
  const url = location.origin + location.pathname;
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title: "SafeWalk", text: "神戸市の徒歩の地図。経路ごとに交通事故の記録と夜の歩きやすさの目安を出します。", url });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
  }
  await copyLink(button, url, "リンクをコピーしました");
}

function section(title: string, ...body: HTMLElement[]): HTMLElement {
  const s = el("section", "menu-sec");
  s.append(el("h3", "", title), ...body);
  return s;
}

function buildMenu(): void {
  back = el("div", "menu-back");
  back.hidden = true;
  sheet = el("section", "card menu-sheet");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-labelledby", "menu-title");

  const head = el("div", "menu-head");
  const title = el("h2", "", "メニュー");
  title.id = "menu-title";
  const close = el("button", "menu-close", "閉じる");
  close.type = "button";
  close.addEventListener("click", closeMenu);
  head.append(title, close);

  const emg = el("button", "menu-emg", "緊急の時（110・119）");
  emg.id = "menu-emg";
  emg.type = "button";
  emg.setAttribute("aria-expanded", "false");
  emg.setAttribute("aria-controls", "menu-emg-box");
  emg.addEventListener("click", toggleEmergency);
  const emgBox = el("div", "menu-emg-box");
  emgBox.id = "menu-emg-box";
  emgBox.hidden = true;

  const seg = el("div", "menu-seg");
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "地図の種類");
  for (const [value, label] of LAYER_CHOICES) {
    const b = el("button", "", label);
    b.type = "button";
    b.dataset.layer = value;
    b.setAttribute("aria-pressed", String(value === layer));
    b.addEventListener("click", () => {
      layer = value;
      setBaseLayer(value);
      seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    });
    seg.append(b);
  }

  const voice = el("button", "menu-row");
  voice.id = "menu-voice";
  voice.type = "button";
  voice.addEventListener("click", () => {
    // 音声のオン・オフは案内の画面の「音声」ボタンが持っている。同じ状態を使うため、そのボタンを押す。
    $("guide-voice").click();
    refreshVoice();
  });
  const voiceName = el("p", "menu-note");
  voiceName.id = "menu-voice-name";
  onVoiceChange(refreshVoice);

  const detail = el("a", "menu-row", "計算のくわしい説明");
  detail.href = SAFETY_PAGE;
  detail.target = "_blank";
  detail.rel = "noopener";

  const sources = el("details", "menu-sources");
  sources.append(el("summary", "menu-row", "データの出典"));
  const list = el("ul");
  for (const text of SOURCES) list.append(el("li", "", text));
  sources.append(list, el("p", "menu-note", "くわしい出典は「計算のくわしい説明」にあります。"));

  const help = el("button", "menu-row", "使い方");
  help.type = "button";
  help.addEventListener("click", () => {
    closeMenu();
    openIntro();
  });

  const share = el("button", "menu-row", "このアプリを共有");
  share.type = "button";
  share.addEventListener("click", () => void shareApp(share));

  sheet.append(
    head,
    emg,
    emgBox,
    section("地図の種類", seg),
    section(
      "音声",
      voice,
      voiceName,
      el("p", "menu-note", "音が出ない時は、端末の音量とマナーモードを確かめてください。"),
      el("p", "menu-note", VOICE_TIP),
    ),
    section("所要時間", el("p", "menu-note", `分速${WALK_M_PER_MIN}m（時速${(WALK_M_PER_MIN * 0.06).toFixed(1)}km）で歩く計算です。上りは1mごとに3秒足しています。`)),
    section("このアプリについて", el("p", "menu-note", "SafeWalk は、誰もが守られて当たり前の世界をめざす SafeAll の、最初の一つです。")),
    section("説明", detail, sources, help, share),
  );
  back.append(sheet);
  back.addEventListener("click", (e) => {
    if (e.target === back && Date.now() - openedAt > TAP_GUARD_MS) closeMenu();
  });
  document.body.append(back);
}

/**
 * 経路の画面では、上の入力欄の下に ≡ を置く。入力欄の高さは入れ替えや折りたたみで変わるので、実測して CSS の変数に入れる。
 */
function trackDirectionsBottom(): void {
  const form = $("directions");
  const apply = () => {
    const bottom = form.hidden ? 0 : Math.round(form.getBoundingClientRect().bottom);
    document.documentElement.style.setProperty("--below-directions", `${bottom + 8}px`);
  };
  new ResizeObserver(apply).observe(form);
  new MutationObserver(apply).observe(form, { attributes: true, attributeFilter: ["hidden"] });
  window.addEventListener("resize", apply);
  apply();
}

/**
 * 下のシートを最大まで上げると、右側の丸いボタン（現在地・≡・?）がシートの上端に重なって、押すとシートの上の物を押してしまう。
 * シート（とつまみ）に重なったボタンは隠す（シートを下げれば戻る）。
 */
function trackSheetOverlap(): void {
  const grip = $("grip");
  const hits = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const apply = () => {
    const parts = [sheetEl, grip].filter((n) => !sheetEl.hidden && n.offsetParent !== null).map((n) => n.getBoundingClientRect());
    for (const button of document.querySelectorAll<HTMLElement>(".locate")) {
      if (getComputedStyle(button).display === "none") continue;
      const box = button.getBoundingClientRect();
      button.toggleAttribute("data-covered", parts.some((r) => hits(box, r)));
    }
  };
  const watch = new ResizeObserver(apply);
  watch.observe(sheetEl);
  watch.observe(grip);
  new MutationObserver(apply).observe(sheetEl, { attributes: true, attributeFilter: ["hidden", "style"], childList: true });
  new MutationObserver(apply).observe(document.body, { attributes: true, attributeFilter: ["class"], childList: true });
  window.addEventListener("resize", apply);
  apply();
}

export function bindMenu(): void {
  buildMenu();
  $("menu-open").addEventListener("click", openMenu);
  // ブラウザの「戻る」でも、開いているメニューを閉じる。
  window.addEventListener("popstate", closeMenu);
  trackDirectionsBottom();
  trackSheetOverlap();
}
