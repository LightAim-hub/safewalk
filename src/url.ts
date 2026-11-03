import { type LatLon } from "./graph";
import { $, qInput, sheet, CURRENT, GENRES, state, map, markers, toast, mapPadding } from "./app";
import { openDirections, closeDirections, renderStops, fillCurrent, setSharedRoute, distinguishingPoints, formatMinutes, MAX_STOPS } from "./directions";
import { matchPlace, showPlace } from "./place";
import { clearGenre, searchGenre } from "./search";
import { syncClearButton } from "./map-ui";
import { type Place } from "./types";

/** アドレスに載せる・アドレスから読む地点名の長さの上限。 */
const MAX_NAME = 40;

/** 地点名をアドレスに載せる形にする。経由地の区切り「|」を含まず、長すぎない。 */
function cleanName(name: string | null | undefined): string {
  return (name ?? "").replace(/[|\r\n]/g, " ").trim().slice(0, MAX_NAME);
}

/** ボタンごとの「コピーしました」を元に戻すタイマー。 */
const copiedTimers = new WeakMap<HTMLButtonElement, number>();

export async function copyLink(button: HTMLButtonElement, text = location.href, done = "コピーしました"): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    const original = button.dataset.label ?? button.textContent ?? "";
    button.dataset.label = original;
    button.textContent = done;
    clearTimeout(copiedTimers.get(button));
    copiedTimers.set(
      button,
      window.setTimeout(() => {
        button.textContent = original;
      }, 2500),
    );
    // ボタンの文字が画面の外にある・見落とす時のため、画面の下にも出す。
    toast(`${done}。送りたい相手に貼り付けてください。`);
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

export function urlForState(opts: { share?: boolean } = {}): string {
  const q = new URLSearchParams();
  if (state.mode === "directions") {
    // 出発地・目的地は、片方だけ決まった時も残す。再読込・共有で同じ画面へ戻れる。
    // 現在地は座標をアドレスに載せず「me」とする（開いた人の現在地として扱う）。送り主の居場所が人に渡らない。
    const coords = (p: Place) => (p.name === CURRENT ? "me" : `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`);
    const label = (p: Place) => cleanName(p.name);
    if (!state.from || !state.to) q.set("mode", "directions");
    if (state.from) {
      q.set("from", coords(state.from));
      if (state.from.name !== CURRENT) q.set("fromName", label(state.from));
    }
    if (state.to) {
      q.set("to", coords(state.to));
      if (state.to.name !== CURRENT) q.set("toName", label(state.to));
    }
    // 選んだ経路。番号と、他の経路から一番離れた地点（番号は計算し直しで変わりうるため、地点で見分ける）。
    if (state.routes.length > 1 && state.routes[state.selected]) {
      q.set("r", String(state.selected));
      for (const rp of distinguishingPoints(state.routes, state.selected)) q.append("rp", `${rp.lat.toFixed(5)},${rp.lon.toFixed(5)}`);
    }
    if (opts.share) q.set("sh", "1");
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

/**
 * 出発地・目的地の座標。神戸市の外でも、地球上の座標として読めれば捨てない
 * （捨てて現在地に置き換えると、別の経路が出てしまう）。市の外かどうかは経路を探す時に知らせる。
 */
export function parseEndpoint(text: string | null): LatLon | null {
  const parts = (text ?? "").split(",");
  if (parts.length !== 2) return null;
  const lat = validNumber(parts[0]);
  const lon = validNumber(parts[1]);
  return lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

/** URL の内容を画面に映す。起動時と「戻る」「進む」の時に使う。 */
export function applyUrl(): void {
  restoring = true;
  setTimeout(() => (restoring = false), 0);
  const q = new URLSearchParams(location.search);
  // 読めない座標（空・文字・範囲外）は捨てて、通常の起動にする。
  let unreadable = false;
  const notes: string[] = [];
  const point = (key: string, anywhere = false): LatLon | null => {
    if (!q.has(key)) return null;
    const parsed = (anywhere ? parseEndpoint : parsePoint)(q.get(key));
    if (!parsed) unreadable = true;
    return parsed;
  };
  // 「me」は、開いた人の現在地。座標ではないので、読めない座標としては扱わない。
  const fromMe = q.get("from") === "me";
  const toMe = q.get("to") === "me";
  const from = fromMe ? null : point("from", true);
  const to = toMe ? null : point("to", true);
  const fromBroken = q.has("from") && !fromMe && !from;
  const toBroken = q.has("to") && !toMe && !to;
  const place = point("place");
  const period = q.get("period");
  if (period === "day" || period === "night") state.period = period;
  if (state.mode === "directions") closeDirections();
  markers.picked.remove();
  sheet.hidden = true;
  state.picked = null;
  qInput.value = "";
  clearGenre();
  const viaTexts = (q.get("via") ?? "").split("|").filter(Boolean);
  const tooManyStops = viaTexts.length > MAX_STOPS;
  state.stops = viaTexts
    .slice(0, MAX_STOPS)
    .map((text) => {
      const [lat, lon, ...name] = text.split(",");
      const point = parsePoint(`${lat},${lon}`);
      if (!point) unreadable = true;
      return point && { ...point, name: cleanName(name.join(",")) };
    })
    .filter((stop): stop is Place => stop !== null);
  renderStops();
  if (from || to || fromMe || toMe || q.get("mode") === "directions") {
    // 送られてきた経路・再読込で、選んだ経路を再現する。
    const index = Number(q.get("r"));
    const mark = q.getAll("rp").map(parsePoint).filter((p): p is LatLon => p !== null);
    const banner = q.get("sh") === "1";
    setSharedRoute(
      banner || mark.length || q.has("r")
        ? { r: Number.isInteger(index) && index >= 0 ? index : 0, rp: mark, banner }
        : null,
    );
    // 出発地・目的地は片方だけでも開く。
    openDirections({
      ...(from && { from: { ...from, name: cleanName(q.get("fromName")) || "共有された地点" } }),
      ...(to && { to: { ...to, name: cleanName(q.get("toName")) || "共有された地点" } }),
    });
    // 出発地と目的地の両方が現在地では、経路にならない。出発地だけを現在地にする。
    if (toMe && !fromMe && !state.to) fillCurrent("to");
    if (fromMe && toMe) notes.push("出発地と目的地の両方が現在地になっています。目的地を入れてください。");
    else if ((fromMe || toMe) && q.get("sh") !== "1") void explainCurrent(fromMe ? "出発地" : "目的地");
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
    notes.unshift(
      fromBroken ? "共有された出発地を読めませんでした。出発地を確かめてください。"
        : toBroken ? "共有された目的地を読めませんでした。目的地を確かめてください。"
        : "共有された地点を読めませんでした。",
    );
    replaceUrl();
  } else if (tooManyStops) {
    notes.push(`経由地は${MAX_STOPS}か所までです。それより後ろは外しました。`);
    replaceUrl();
  }
  if (notes.length) toast(notes[0]);
}

/** 「現在地」を入れられない時の理由を一言出す(許可の確認は新しく出さない)。 */
async function explainCurrent(what: string): Promise<void> {
  try {
    if (!navigator.geolocation) return toast("この端末では現在地を取得できません。");
    const status = await navigator.permissions?.query({ name: "geolocation" });
    if (status?.state === "denied") toast(`位置情報が許可されていないため、${what}に現在地を入れられません。${what}を入れてください。`);
    else if (status?.state === "prompt") toast(`${what}に現在地を入れるには、「現在地を使う」を押してください。`);
  } catch {
    // 許可の状態が分からない時は何も出さない。
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

/** 「戻る」「進む」を受け始める。データの読み込みが終わってから呼ぶ(読み込み前に画面を作らないため)。 */
export function listenHistory(): void {
  window.addEventListener("popstate", () => {
    // 案内中は、「戻る」で画面を変えない。履歴を積み直して、終え方を知らせる。
    if (document.body.classList.contains("guiding")) {
      history.pushState(null, "", urlForState());
      toast("案内を終えるには「終了」を押してください。");
      return;
    }
    applyUrl();
  });
}

export function bindUrl(): void {
  followDirectionsState();
  // 検索側のコードを変えずに、一覧・場所の画面が変わった時に履歴を積む。
  // 経路の画面は directions.ts が自分で積む。
  new MutationObserver(() => {
    if (!restoring && state.mode === "browse") pushUrl();
  }).observe(sheet, { childList: true, attributes: true, attributeFilter: ["hidden"] });
  // 案内を始めた時に履歴を1つ積む。共有リンクから直接開いた時は履歴が1つだけなので、積まないと「戻る」でアプリごと離れてしまう。
  // 積んだ後に「戻る」を押すと listenHistory の popstate が積み直して、終え方を知らせる。
  let wasGuiding = document.body.classList.contains("guiding");
  new MutationObserver(() => {
    const now = document.body.classList.contains("guiding");
    if (now && !wasGuiding && !restoring) history.pushState(null, "", urlForState());
    wasGuiding = now;
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  // 一覧を見ている間は、地図を動かした範囲を今の履歴に上書きして覚える。
  map.on("moveend", () => {
    if (restoring || state.mode !== "browse" || !state.genre || state.picked) return;
    genreView = currentView();
    replaceUrl();
  });
}

/**
 * 選んだ経路を人に送る。端末の共有（LINE・メッセージなど）があればそれを開き、無ければリンクをコピーする。
 * 送るリンクには、選んだ経路を見分ける地点を入れる。出発地が現在地の時は座標を入れず、受け取った人の現在地からになる。
 */
export async function shareRoute(button: HTMLButtonElement): Promise<void> {
  const route = state.routes[state.selected];
  if (!route || !state.from || !state.to) return;
  const url = new URL(urlForState({ share: true }), location.href).href;
  const name = (p: Place) => p.name;
  const text = `${name(state.from)}から${name(state.to)}まで、徒歩${formatMinutes(route.minutes)}の経路です。`;
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title: "SafeWalk 徒歩の経路", text, url });
      return;
    } catch (error) {
      // 送るのをやめた時は何もしない。共有が使えなかった時だけ、リンクのコピーに切り替える。
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
  }
  await copyLink(button, url, "リンクをコピーしました");
}
