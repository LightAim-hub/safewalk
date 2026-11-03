import { type LatLon } from "./graph";
import { qInput, sheet, CURRENT, GENRES, state, map, markers, toast, mapPadding } from "./app";
import { openDirections, closeDirections, renderStops } from "./directions";
import { matchPlace, showPlace } from "./place";
import { clearGenre, searchGenre } from "./search";
import { syncClearButton } from "./map-ui";
import { type Place } from "./types";

export async function copyLink(button: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(location.href);
    button.textContent = "コピーしました";
  } catch {
    toast("コピーできませんでした。アドレス欄のリンクをお使いください。");
  }
}

/** 一覧を出した時の地図の範囲（緯度,経度,ズーム）。場所を開いて動いても、一覧に戻る時はこの範囲で出す。 */
let genreView = "";

function currentView(): string {
  const c = map.getCenter();
  return `${c.lat.toFixed(4)},${c.lng.toFixed(4)},${map.getZoom().toFixed(1)}`;
}

export function urlForState(): string {
  const q = new URLSearchParams();
  if (state.mode === "directions" && state.from && state.to) {
    // 共有リンクに現在地の正確な座標を載せない。
    const coords = (p: Place) => {
      const digits = p.name === CURRENT ? 3 : 5;
      return `${p.lat.toFixed(digits)},${p.lon.toFixed(digits)}`;
    };
    const label = (p: Place) => (p.name === CURRENT ? "現在地の付近" : p.name);
    q.set("from", coords(state.from));
    q.set("to", coords(state.to));
    q.set("fromName", label(state.from));
    q.set("toName", label(state.to));
    const stops = state.stops.filter((stop): stop is Place => stop !== null);
    if (stops.length) q.set("via", stops.map((stop) => `${coords(stop)},${label(stop)}`).join("|"));
    q.set("period", state.period);
  } else if (state.mode === "directions") {
    q.set("mode", "directions");
  } else {
    // ジャンル検索の一覧と、そこから開いた場所。戻ると一覧に戻れるよう、探した範囲も残す。
    if (state.genre) {
      if (!state.picked) genreView = currentView();
      q.set("g", state.genre.label);
      if (genreView) q.set("gv", genreView);
    }
    if (state.picked) {
      q.set("place", `${state.picked.lat.toFixed(5)},${state.picked.lon.toFixed(5)}`);
      q.set("name", state.picked.name);
    }
  }
  const text = q.toString();
  return text ? `?${text}` : location.pathname;
}

export function replaceUrl(): void {
  history.replaceState(null, "", urlForState());
}

/** 画面が変わった時に履歴を積み、ブラウザの「戻る」で前の画面へ戻れるようにする。 */
export function pushUrl(): void {
  const url = urlForState();
  if (url !== location.search && url !== location.pathname + location.search) history.pushState(null, "", url);
}

export function parsePoint(text: string | null): LatLon | null {
  const [lat, lon] = (text ?? "").split(",").map(Number);
  return text && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/** URL の内容を画面に映す。起動時と「戻る」「進む」の時に使う。 */
export function applyUrl(): void {
  restoring = true;
  setTimeout(() => (restoring = false), 0);
  const q = new URLSearchParams(location.search);
  const from = parsePoint(q.get("from"));
  const to = parsePoint(q.get("to"));
  const place = parsePoint(q.get("place"));
  const period = q.get("period");
  if (period === "day" || period === "night") state.period = period;
  if (state.mode === "directions") closeDirections();
  markers.picked.remove();
  sheet.hidden = true;
  state.picked = null;
  qInput.value = "";
  clearGenre();
  state.stops = (q.get("via") ?? "")
    .split("|")
    .filter(Boolean)
    .map((text) => {
      const [lat, lon, ...name] = text.split(",");
      return { lat: Number(lat), lon: Number(lon), name: name.join(",") };
    })
    .filter((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lon));
  renderStops();
  if (from && to) {
    openDirections({
      from: { ...from, name: q.get("fromName") || "共有された地点" },
      to: { ...to, name: q.get("toName") || "共有された地点" },
    });
  } else if (q.get("mode") === "directions") {
    openDirections({});
  } else {
    const genre = GENRES.find((g) => g.label === q.get("g"));
    if (genre) {
      const [lat, lon, zoom] = (q.get("gv") ?? "").split(",").map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(zoom)) {
        map.jumpTo({ center: [lon, lat], zoom, padding: mapPadding() });
      }
      genreView = q.get("gv") ?? "";
      searchGenre(genre);
    }
    if (place) {
      const name = q.get("name") || "共有された地点";
      showPlace(matchPlace(name, place) ?? { ...place, name });
    }
  }
  renderPeriod();
  syncClearButton();
}

export function renderPeriod(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-period]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.period === state.period));
  });
}

/** applyUrl が画面を変えている間は、履歴を積み足さない（進む履歴が消えるため）。 */
let restoring = false;

export function bindUrl(): void {
  window.addEventListener("popstate", applyUrl);
  // 検索側のコードを変えずに、一覧・場所の画面が変わった時に履歴を積む。
  // 経路の画面は directions.ts が自分で積む。
  new MutationObserver(() => {
    if (!restoring && state.mode === "browse") pushUrl();
  }).observe(sheet, { childList: true, attributes: true, attributeFilter: ["hidden"] });
  // 一覧を見ている間は、地図を動かした範囲を今の履歴に上書きして覚える。
  map.on("moveend", () => {
    if (restoring || state.mode !== "browse" || !state.genre || state.picked) return;
    genreView = currentView();
    replaceUrl();
  });
}
