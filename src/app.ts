import * as maplibregl from "maplibre-gl";
import { type Map as MapLibre } from "maplibre-gl";
// 版6の maplibre は作業用の部品(worker)を、束ねた JS の隣から探す。束ねた後は無いので、
// 取り込み(?url)で assets/ に出し、その場所を教える(これが無いと地図が空になる)。
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { type Period, type Route } from "./routes";
import { type Place, type Genre } from "./types";
import { periodNow } from "./daylight";

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
export const qInput = $<HTMLInputElement>("q");
export const fromInput = $<HTMLInputElement>("from");
export const toInput = $<HTMLInputElement>("to");
export const searchbar = $<HTMLFormElement>("searchbar");
export const directions = $<HTMLFormElement>("directions");
export const sheet = $("sheet");
export const toastEl = $("toast");

export const KOBE_CENTER: [number, number] = [135.17, 34.7];
export const MAX_SNAP_M = 500;
export const COLORS = { good: "#188038", mid: "#b06000", bad: "#c5221f", route: "#1a73e8", other: "#9aa0a6" };
export const CURRENT = "現在地";
export const GENRES: Genre[] = [
  { label: "コンビニ", kinds: ["コンビニ"] },
  { label: "飲食店", kinds: ["飲食店"] },
  { label: "カフェ", kinds: ["カフェ"] },
  { label: "スーパー", kinds: ["スーパー"] },
  { label: "薬局", kinds: ["薬局"] },
  { label: "トイレ", kinds: ["トイレ"] },
  { label: "ATM", kinds: ["ATM", "銀行"] },
  { label: "駅", kinds: ["駅"] },
  { label: "病院", kinds: ["病院"] },
  { label: "交番", kinds: ["警察"] },
];
export const GENRE_LIMIT = 30;

export const state = {
  mode: "browse" as "browse" | "directions",
  picked: null as Place | null,
  from: null as Place | null,
  to: null as Place | null,
  /** 経由地。入力中の欄は null */
  stops: [] as (Place | null)[],
  period: periodNow() as Period,
  routes: [] as Route[],
  selected: 0,
  genre: null as Genre | null,
};

maplibregl.setWorkerUrl(workerUrl);

export const map: MapLibre = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/liberty",
  center: KOBE_CENTER,
  zoom: 11,
  attributionControl: {
    compact: true,
    customAttribution: [
      '交通事故: <a href="https://www.npa.go.jp/publications/statistics/koutsuu/opendata/index_opendata.html" target="_blank" rel="noopener">警察庁オープンデータ</a>を加工して作成',
      '住所・標高・航空写真: <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>',
    ],
  },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

export const markers = {
  picked: new maplibregl.Marker({ color: COLORS.bad }),
  from: new maplibregl.Marker({ color: COLORS.good }),
  to: new maplibregl.Marker({ color: COLORS.bad }),
  me: new maplibregl.Marker({ element: meElement() }),
};
export const stopMarkers: maplibregl.Marker[] = [];

export function meElement(): HTMLElement {
  const dot = document.createElement("div");
  dot.className = "me";
  dot.append(Object.assign(document.createElement("i"), { className: "cone" }));
  return dot;
}

export let toastTimer = 0;
export function toast(text: string): void {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 3500);
}

/**
 * 画面には出さず、読み上げにだけ一行を伝える（「経路が2本出ました」など）。
 * 同じ文でも、続けて呼ばれたらもう一度伝わるよう、いったん空にしてから入れ直す。
 */
/**
 * 直前の操作がキーボードか。入力欄へ焦点を移すと、指やマウスの人には画面の小さな入力キーボードや枠が出てしまうため、
 * 入力欄への焦点の移動はキーボードで操作している時だけにする。
 */
export const modality = { keyboard: false };
document.addEventListener("keydown", () => (modality.keyboard = true), true);
document.addEventListener("pointerdown", () => (modality.keyboard = false), true);

let announceTimer = 0;
export function announce(text: string): void {
  const node = document.getElementById("announce");
  if (!node) return;
  window.clearTimeout(announceTimer);
  node.textContent = "";
  announceTimer = window.setTimeout(() => (node.textContent = text), 60);
}

/**
 * 地図の印（出発地・目的地・現在地・所要時間の札）は、読み上げの対象にしない。
 * MapLibre は印に英語の名前（Map marker）を付けるが、同じ内容は経路の一覧と入力欄に文字であるため、隠す。
 */
const addMarkerTo = maplibregl.Marker.prototype.addTo;
maplibregl.Marker.prototype.addTo = function (this: maplibregl.Marker, target: MapLibre) {
  const result = addMarkerTo.call(this, target);
  const node = this.getElement();
  node.removeAttribute("aria-label");
  node.setAttribute("aria-hidden", "true");
  return result;
};

export function scoreColor(score: number | null): string {
  if (score === null) return COLORS.other;
  return score >= 70 ? COLORS.good : score >= 50 ? COLORS.mid : COLORS.bad;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function mapPadding() {
  const narrow = window.innerWidth <= 720;
  return narrow
    ? { top: 150, bottom: window.innerHeight * 0.46, left: 30, right: 30 }
    : { top: 60, bottom: 60, left: 430, right: 60 };
}
