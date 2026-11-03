import { type LatLon } from "./graph";
import { $, qInput, sheet, CURRENT, GENRES, state, map, markers, toast, mapPadding } from "./app";
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
  if (state.mode === "directions") {
    // 出発地・目的地は、片方だけ決まった時も残す。再読込・共有で同じ画面へ戻れる。
    // 共有リンクに現在地の正確な座標を載せない。
    const coords = (p: Place) => {
      const digits = p.name === CURRENT ? 3 : 5;
      return `${p.lat.toFixed(digits)},${p.lon.toFixed(digits)}`;
    };
    const label = (p: Place) => (p.name === CURRENT ? "現在地の付近" : p.name);
    if (!state.from || !state.to) q.set("mode", "directions");
    if (state.from) {
      q.set("from", coords(state.from));
      q.set("fromName", label(state.from));
    }
    if (state.to) {
      q.set("to", coords(state.to));
      q.set("toName", label(state.to));
    }
    const stops = state.stops.filter((stop): stop is Place => stop !== null);
    if (stops.length) q.set("via", stops.map((stop) => `${coords(stop)},${label(stop)}`).join("|"));
    q.set("period", state.period);
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

/** 神戸市から大きく外れる地点は読まない（緯度 34.3〜35.1・経度 134.6〜135.7 の外）。 */
const BOUNDS = { south: 34.3, north: 35.1, west: 134.6, east: 135.7 };

function validNumber(text: string | undefined): number | null {
  // Number("") は 0 になるので、空・空白だけの文字は先に弾く。
  if (text === undefined || !text.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

export function inServiceArea(lat: number, lon: number): boolean {
  return (
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    lat >= BOUNDS.south &&
    lat <= BOUNDS.north &&
    lon >= BOUNDS.west &&
    lon <= BOUNDS.east
  );
}

export function parsePoint(text: string | null): LatLon | null {
  const parts = (text ?? "").split(",");
  if (parts.length !== 2) return null;
  const lat = validNumber(parts[0]);
  const lon = validNumber(parts[1]);
  return lat !== null && lon !== null && inServiceArea(lat, lon) ? { lat, lon } : null;
}

/** URL の内容を画面に映す。起動時と「戻る」「進む」の時に使う。 */
export function applyUrl(): void {
  restoring = true;
  setTimeout(() => (restoring = false), 0);
  const q = new URLSearchParams(location.search);
  // 読めない座標（空・文字・範囲外）は捨てて、通常の起動にする。
  let unreadable = false;
  const point = (key: string): LatLon | null => {
    if (!q.has(key)) return null;
    const parsed = parsePoint(q.get(key));
    if (!parsed) unreadable = true;
    return parsed;
  };
  const from = point("from");
  const to = point("to");
  const place = point("place");
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
      const point = parsePoint(`${lat},${lon}`);
      if (!point) unreadable = true;
      return point && { ...point, name: name.join(",") };
    })
    .filter((stop): stop is Place => stop !== null);
  renderStops();
  if (from || to || q.get("mode") === "directions") {
    // 出発地・目的地は片方だけでも開く。
    openDirections({
      ...(from && { from: { ...from, name: q.get("fromName") || "共有された地点" } }),
      ...(to && { to: { ...to, name: q.get("toName") || "共有された地点" } }),
    });
  } else {
    const genre = GENRES.find((g) => g.label === q.get("g"));
    if (genre) {
      const [latText, lonText, zoomText] = (q.get("gv") ?? "").split(",");
      const view = parsePoint(`${latText},${lonText}`);
      const zoom = validNumber(zoomText);
      if (view && zoom !== null && zoom >= 0 && zoom <= 22) {
        map.jumpTo({ center: [view.lon, view.lat], zoom, padding: mapPadding() });
        genreView = q.get("gv")!;
      } else {
        genreView = "";
      }
      searchGenre(genre);
    }
    if (place) {
      const name = q.get("name") || "共有された地点";
      showPlace(matchPlace(name, place) ?? { ...place, name });
    }
  }
  renderPeriod();
  syncClearButton();
  if (unreadable) {
    // アドレス欄から壊れた座標を外し、再読込しても同じ知らせが出続けないようにする。
    toast("共有された地点を読めませんでした。");
    replaceUrl();
  }
}

export function renderPeriod(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-period]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.period === state.period));
  });
}

/** applyUrl が画面を変えている間は、履歴を積み足さない（進む履歴が消えるため）。 */
let restoring = false;

/** 経路の画面で出発地・目的地・昼夜・経由地が変わったら、アドレス欄を追従させる（directions.ts を変えずに済ませる）。 */
function followDirectionsState(): void {
  let queued = false;
  const sync = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!restoring && state.mode === "directions") replaceUrl();
    });
  };
  for (const key of ["from", "to", "period"] as const) {
    let value: unknown = state[key];
    Object.defineProperty(state, key, {
      enumerable: true,
      configurable: true,
      get: () => value as never,
      set: (next) => {
        value = next;
        sync();
      },
    });
  }
  // 経由地の欄は作り直されるたびに中身の子要素が入れ替わる。
  new MutationObserver(sync).observe($("stops"), { childList: true });
}

export function bindUrl(): void {
  followDirectionsState();
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
