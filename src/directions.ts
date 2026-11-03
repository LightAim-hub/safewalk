import * as maplibregl from "maplibre-gl";
import { type GeoJSONSource } from "maplibre-gl";
import { metres, type LatLon } from "./graph";
import { findRoutes, joinRoutes, minutesFor, type Period, type Route } from "./routes";
import { showAccidents, accidentDetail } from "./accidents-ui";
import { $, qInput, fromInput, toInput, searchbar, directions, sheet, COLORS, CURRENT, GENRES, state, map, markers, stopMarkers, toast, announce, modality, el } from "./app";
import { graph, accidents, meta, places, names, emptyCollection, snap, safety, agentContext } from "./data";
import { runAgent, SITUATION_MAX, FIXED, type AgentResult } from "./agent";
import { assess, SAFETY_DISCLAIMER, SAFETY_RULES, type Assessment, type Tier } from "./safety";
import { startGuide, stopGuide } from "./guide";
import { popup } from "./place";
import { placeRows, showResultDots, clearGenre, bindSuggest, focusQuietly } from "./search";
import { locateMe, SHEET_STOPS } from "./map-ui";
import { type Place, type Genre, type End } from "./types";
import { detectDisaster, detectEmergency, disasterPanel, bosaiLink, DISASTER_NOTICE, emergencyPanel } from "./emergency";
import type { KobanHit } from "./koban";
import "./directions.css";
import { replaceUrl, pushUrl, renderPeriod, shareRoute, inServiceArea } from "./url";

export function openDirections(ends: Partial<Record<End, Place>>): void {
  // 押した物（経路ボタン・場所の「経路」）がこの後に消える時は、焦点を出発地の欄へ移す。
  const pressed = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  state.mode = "directions";
  fromMissing = false;
  document.body.classList.add("routing");
  searchbar.hidden = true;
  directions.hidden = false;
  sheet.hidden = true;
  markers.picked.remove();
  clearGenre();
  if (ends.from) setEnd("from", ends.from, false);
  if (ends.to) setEnd("to", ends.to, false);
  if (state.from && state.to) search();
  // 出発地が空なら現在地を入れる。出発地へは焦点を当てない（候補の一覧が目的地欄・昼夜ボタンを覆うため）。
  else if (!state.to) toInput.focus();
  if (!state.from) fillCurrentFrom();
  if (modality.keyboard && pressed && !directions.contains(document.activeElement) && (!pressed.isConnected || pressed.getClientRects().length === 0)) {
    focusQuietly(fromInput);
  }
}

/** 結果の見出し（経路の一覧）へ焦点を移す。案内を終えた後など、押した物が消えた時の行き先。 */
export function focusResultHeading(): void {
  const heading = sheet.querySelector<HTMLElement>("[data-result-heading]");
  if (heading && !sheet.hidden) heading.focus({ preventScroll: true });
  else if (modality.keyboard) focusQuietly(fromInput);
}

let locating = 0;

/** 出発地・目的地の既定は現在地。取れない・神戸市外の時は何も出さず空のままにする（知らせで目的地欄を覆わない）。 */
function fillCurrentFrom(): void {
  fillCurrent("from");
}

/** 送られてきた経路を開いたのに、現在地が使えない時の理由（出発地が空のままだと何も出ないため）。 */
function sharedWithoutPlace(reason: string, offerCurrent = false): void {
  if (state.mode !== "directions" || state.routes.length) return;
  if (pending?.banner) return clearRoutes(`送られてきた経路です。${reason}`, offerCurrent);
  // 目的地だけ入っていて出発地が空の時、何も起きないように見えない。理由と「現在地を使う」を出す。
  fromMissing = true;
  if (state.to && !state.from) clearRoutes(reason, offerCurrent);
}

/** 現在地を出発地に入れられなかった（目的地が入ったら、理由を出す）。 */
let fromMissing = false;

/**
 * 現在地を、空の出発地（または目的地）に入れる。url.ts が「to=me」を開く時にも使う。
 * 位置情報を許可済みの時だけ自動で入れる。許可を黙って求めない（それ以外は空のまま。「現在地を使う」で入れる）。
 */
export function fillCurrent(which: End): void {
  const mine = ++locating;
  const input = which === "from" ? fromInput : toInput;
  const ask = navigator.permissions?.query({ name: "geolocation" }).then((s) => s.state, () => "unknown");
  if (!navigator.geolocation || !ask) return sharedWithoutPlace("出発地を入れるか、「現在地を使う」を選んでください。", true);
  void ask.then((permission) => {
    if (mine !== locating) return;
    if (permission !== "granted") return sharedWithoutPlace("出発地を入れるか、「現在地を使う」を選んでください。", true);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        // 待つ間に、経路の画面を閉じた・地点を選んだ・文字を打った時は、何もしない。
        if (mine !== locating || state.mode !== "directions" || state[which] || input.value.trim()) return;
        const place: Place = { lat: coords.latitude, lon: coords.longitude, name: CURRENT };
        if (snap(place) === null) return sharedWithoutPlace("現在地が神戸市の外です。出発地を入れてください。");
        setEnd(which, place);
      },
      () => {
        if (mine === locating) sharedWithoutPlace("現在地を取得できませんでした。出発地を入れてください。");
      },
      { timeout: 8000, maximumAge: 60000 },
    );
  });
}

export function closeDirections(): void {
  locating++;
  pending = arrived = null;
  emergencyNode = null;
  restoreSheetHeight();
  setFolded(false);
  resetAgent();
  stopGuide();
  popup?.remove();
  state.mode = "browse";
  document.body.classList.remove("routing");
  state.from = state.to = null;
  state.stops = [];
  renderStops();
  fromInput.value = toInput.value = "";
  markers.from.remove();
  markers.to.remove();
  directions.hidden = true;
  searchbar.hidden = false;
  clearRoutes();
}

/** 現在地を出発地に入れるボタン（位置情報の許可をここで求める）。 */
function useCurrentButton(): HTMLButtonElement {
  const button = el("button", "primary use-current", "現在地を使う");
  button.type = "button";
  button.addEventListener("click", () => {
    button.disabled = true;
    void locateMe().then((me) => {
      button.disabled = false;
      if (me && state.mode === "directions" && !state.from) setEnd("from", me);
    });
  });
  return button;
}

/** エラー・空の画面にも、免責を下端に固定で出す（経路の画面と同じ）。 */
function disclaimerBar(): HTMLElement {
  const bar = el("div", "start-bar");
  bar.append(el("p", "disclaimer", DISCLAIMER_LINE));
  return bar;
}

/** 表示中の経路を消す。経路を出せない時は、古い経路を残さず理由を出す。offerCurrent は「現在地を使う」ボタンを添える。 */
export function clearRoutes(message = "", offerCurrent = false): void {
  resetAgent();
  periodSwitched = false;
  state.routes = [];
  timeTags.splice(0).forEach((tag) => tag.remove());
  (map.getSource("routes") as GeoJSONSource).setData(emptyCollection());
  (map.getSource("accidents") as GeoJSONSource).setData(emptyCollection());
  const shown = !!message || !!emergencyNode;
  sheet.replaceChildren(
    ...(emergencyNode ? [emergencyNode] : []),
    ...(message ? [el("p", "empty-note", message)] : []),
    ...(message && offerCurrent && !state.from ? [useCurrentButton()] : []),
    ...(shown ? [disclaimerBar()] : []),
  );
  sheet.hidden = !shown;
  if (message) announce(message);
}

/** 案内中か。案内中は、地図や一覧の操作で出発地・経路を替えない（案内が古い経路のまま進むのを防ぐ）。 */
export const isGuiding = (): boolean => document.body.classList.contains("guiding");

/** force は案内そのもの（探し直し・終了）が出発地を替える時だけ使う。 */
export function setEnd(which: End, place: Place | null, run = true, force = false): void {
  if (isGuiding() && !force) return;
  periodSwitched = false;
  state[which] = place;
  const input = which === "from" ? fromInput : toInput;
  input.value = place?.name ?? "";
  if (place) markers[which].setLngLat([place.lon, place.lat]).addTo(map);
  else markers[which].remove();
  if (run && state.from && state.to) search();
  else if (run && which === "to" && place && !state.from && fromMissing && state.mode === "directions") {
    clearRoutes("出発地を入れるか、「現在地を使う」を選んでください。", true);
  }
}

export const MAX_STOPS = 3;

/** 経由地の入力欄と印を作り直す。 */
export function drawStopMarkers(): void {
  stopMarkers.splice(0).forEach((marker) => marker.remove());
  for (const stop of state.stops) {
    if (stop) stopMarkers.push(new maplibregl.Marker({ color: COLORS.mid }).setLngLat([stop.lon, stop.lat]).addTo(map));
  }
}

export function renderStops(): void {
  drawStopMarkers();
  $("stops").replaceChildren(
    ...state.stops.map((stop, i) => {
      const row = el("div", "stop-row");
      const field = el("div", "field");
      const input = el("input");
      input.placeholder = "経由地";
      input.setAttribute("aria-label", `経由地${i + 1}`);
      input.value = stop?.name ?? "";
      field.append(input);
      const remove = el("button", "icon plain", "✕");
      remove.type = "button";
      remove.setAttribute("aria-label", `経由地${i + 1}を外す`);
      remove.addEventListener("click", () => {
        state.stops.splice(i, 1);
        renderStops();
        if (state.from && state.to) search();
      });
      row.append(field, remove);
      input.addEventListener("blur", () => {
        input.value = state.stops[i]?.name ?? "";
      });
      bindSuggest(
        input,
        (place) => {
          state.stops[i] = place;
          renderStops();
          if (state.from && state.to) search();
        },
        {
          onEdit: (value) => {
            if (value || !state.stops[i]) return;
            state.stops[i] = null;
            drawStopMarkers();
            if (state.from && state.to) search();
          },
        },
      );
      return row;
    }),
  );
  $<HTMLButtonElement>("add-stop").hidden = state.stops.length >= MAX_STOPS;
}

export function addStop(place: Place): void {
  if (state.stops.filter(Boolean).length >= MAX_STOPS) {
    toast(`経由地は${MAX_STOPS}か所までです。`);
    return;
  }
  const empty = state.stops.indexOf(null);
  if (empty >= 0) state.stops[empty] = place;
  else state.stops.push(place);
  showResultDots([]);
  renderStops();
  if (state.from && state.to) search();
}

export function searchThrough(): Route | null {
  const points = [state.from!, ...state.stops.filter((s): s is Place => s !== null), state.to!];
  const anchors = points.map(snap);
  if (anchors.some((a) => a === null)) return null;
  const parts = anchors.slice(1).map((a, i) => {
    const options = findRoutes(graph, anchors[i]!, a!, state.period, accidents, meta, names);
    return options[0];
  });
  if (parts.some((part) => !part)) return null;
  return joinRoutes(parts, points.slice(1, -1).map((p) => p.name));
}

export function search(): void {
  if (isGuiding()) return;
  // 先に畳んでから経路を収める（上の欄の高さが変わるため）。経路が出なかった時は開いたままにする。
  const fold = canFold();
  if (fold) setFolded(true);
  runSearch();
  if (fold && !state.routes.length) setFolded(false);
}

// ---------------------------------------------------------------- 上の入力欄（目的地が決まったら1行に畳む）

const dirSummary = $<HTMLButtonElement>("dir-summary");

/** 出発地・目的地が決まっていて、入力中の経由地が無い時だけ畳める。 */
function canFold(): boolean {
  return !!state.from && !!state.to && !state.stops.includes(null);
}

export function setFolded(folded: boolean): void {
  let wasEditing: HTMLElement | null = null;
  if (folded) {
    const active = document.activeElement;
    if (active instanceof HTMLElement && directions.contains(active)) wasEditing = active;
    wasEditing?.blur();
    const via = state.stops.filter(Boolean).length;
    dirSummary.textContent = `${state.from?.name ?? ""} → ${state.to?.name ?? ""}${via ? `（経由${via}）` : ""}`;
  }
  directions.classList.toggle("folded", folded);
  dirSummary.hidden = !folded;
  dirSummary.setAttribute("aria-expanded", String(!folded));
  // 入力していた欄が畳まれて消える時、焦点が背景に落ちないよう、畳んだ1行（押すと開く）へ移す。
  if (folded && wasEditing && modality.keyboard && document.activeElement === document.body) dirSummary.focus({ preventScroll: true });
}

function runSearch(): void {
  resetAgent();
  arrived = null;
  const start = snap(state.from!);
  const goal = snap(state.to!);
  showResultDots([]);
  if (start === null || goal === null) {
    // 神戸市から大きく外れた地点は、そう言う。それ以外は、どちらが市の外（または道から遠い）かを名指しする。
    const away = (p: Place) => !inServiceArea(p.lat, p.lon);
    const out = [start === null && away(state.from!) ? "出発地" : "", goal === null && away(state.to!) ? "目的地" : ""].filter(Boolean);
    if (out.length) return clearRoutes(`${out.join("と")}が神戸市の外です。SafeWalk は神戸市の中だけで使えます。神戸市内の場所を入れてください。`);
    const far = [start === null ? `出発地（${state.from!.name}）` : "", goal === null ? `目的地（${state.to!.name}）` : ""].filter(Boolean);
    return clearRoutes(`${far.join("と")}の近くに、神戸市内の歩ける道がありません。神戸市の外か、道から遠い場所です。`);
  }
  if (state.stops.some(Boolean)) {
    const through = searchThrough();
    if (!through) return clearRoutes("経由地を通る経路が見つかりませんでした。");
    state.routes = [through];
    return showRoutes();
  }
  const [sx, sy] = start.point;
  const [gx, gy] = goal.point;
  if (metres({ lat: sy, lon: sx }, { lat: gy, lon: gx }) < 5) {
    return clearRoutes("出発地と目的地が近すぎるため、経路を出せません。");
  }
  state.routes = findRoutes(graph, start, goal, state.period, accidents, meta, names);
  if (!state.routes.length) return clearRoutes("歩いて行ける経路が見つかりませんでした。");
  showRoutes();
}

export function showRoutes(): void {
  if (isGuiding()) return;
  for (const route of state.routes) connectEnds(route, state.from!, state.to!);
  replaceUrl();
  // 昼も夜も Google マップと同じく最短を選ぶ。送られてきた経路を開いた時だけ、送り主が選んだ経路を選ぶ。
  let first = 0;
  if (pending) {
    const found = findShared(pending);
    first = found.index;
    arrived = pending.banner ? found : null;
    pending = null;
  }
  selectRoute(first);
  fitRoutes(500);
  announce(`経路が${state.routes.length}本出ました`);
}

// ---------------------------------------------------------------- 経路を人に送る（選んだ経路を開いた側で再現する）

/** 送られてきた経路の、再現に使う情報。r は経路の番号、rp は他の経路から一番離れた地点。 */
type Pending = { r: number; rp: LatLon[]; banner: boolean };
let pending: Pending | null = null;
/** 送られてきた経路を開いた時の、画面の知らせ。経路を出し直したら消す。 */
let arrived: { index: number; exact: boolean } | null = null;

export function setSharedRoute(info: Pending | null): void {
  pending = info;
  arrived = null;
}

/** 点から経路の線までの距離(m)。 */
export function distanceToRoute(route: Route, p: LatLon): number {
  const kx = 111320 * Math.cos((p.lat * Math.PI) / 180);
  const ky = 110540;
  let best = Infinity;
  const c = route.coords;
  for (let i = 0; i + 1 < c.length; i++) {
    const ax = (c[i][0] - p.lon) * kx;
    const ay = (c[i][1] - p.lat) * ky;
    const bx = (c[i + 1][0] - p.lon) * kx;
    const by = (c[i + 1][1] - p.lat) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

const markCache = new WeakMap<Route[], Map<number, LatLon[]>>();

/**
 * 経路を言い当てる地点（多くて3つ）。他の経路それぞれから一番離れた、その経路の上の点。
 * 出発地・目的地の近く（300m以内）は選ばない。出発地が現在地でも、居場所が人に渡らないようにするため。
 * 経路が1本なら要らない。
 */
export function distinguishingPoints(routes: Route[], index: number): LatLon[] {
  if (routes.length < 2 || !routes[index]) return [];
  const cache = markCache.get(routes) ?? new Map<number, LatLon[]>();
  markCache.set(routes, cache);
  const hit = cache.get(index);
  if (hit) return hit;
  const route = routes[index];
  const first = route.coords[0];
  const last = route.coords[route.coords.length - 1];
  const apart = (c: [number, number], q: [number, number]) => metres({ lon: c[0], lat: c[1] }, { lon: q[0], lat: q[1] });
  const stride = Math.max(1, Math.floor(route.coords.length / 150));
  let samples = route.coords.filter((_, k) => k % stride === 0);
  const inside = samples.filter((c) => apart(c, first) > 300 && apart(c, last) > 300);
  if (inside.length) samples = inside;
  const points: LatLon[] = [];
  routes.forEach((other, j) => {
    if (j === index) return;
    let best = samples[0];
    let far = -1;
    for (const c of samples) {
      const d = distanceToRoute(other, { lon: c[0], lat: c[1] });
      if (d > far) {
        far = d;
        best = c;
      }
    }
    if (!points.some((p) => p.lon === best[0] && p.lat === best[1])) points.push({ lon: best[0], lat: best[1] });
  });
  // 多すぎると送るリンクが長くなる。一番離れている3つまで。
  const result = points.slice(0, 3);
  cache.set(index, result);
  return result;
}

/** 送られてきた経路が、いま出した経路のどれか。地点が1本の線にだけ近ければそれ。決まらなければ番号に従う。 */
function findShared(info: Pending): { index: number; exact: boolean } {
  const n = state.routes.length;
  if (n === 1) return { index: 0, exact: true };
  if (info.rp.length) {
    // 各経路について、地点までの距離の平均を比べる。
    const d = state.routes.map((r) => info.rp.reduce((sum, p) => sum + distanceToRoute(r, p), 0) / info.rp.length);
    const order = d.map((_, i) => i).sort((x, y) => d[x] - d[y]);
    if (d[order[0]] <= 30) {
      const tied = order.filter((i) => d[i] - d[order[0]] < 15);
      // 同じに見える経路が複数ある時は、送られた番号がその中にあればそれ。
      if (tied.length === 1) return { index: tied[0], exact: true };
      if (tied.includes(info.r)) return { index: info.r, exact: true };
    }
  }
  return { index: info.r < n ? info.r : 0, exact: false };
}

/** 経路の全体が、入力欄とシートを避けた見える範囲に収まるようにする。 */
export function fitRoutes(duration: number): void {
  if (!state.routes.length) return;
  const all = state.routes.flatMap((r) => r.coords);
  const bounds = all.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(all[0], all[0]));
  map.fitBounds(bounds, { padding: routePadding(), duration });
}

/** 交差点から実際の地点までの区間を、線と距離に足す。 */
export function connectEnds(route: Route, from: LatLon, to: LatLon): void {
  const [startLon, startLat] = route.coords[0];
  const [endLon, endLat] = route.coords[route.coords.length - 1];
  route.metres += metres(from, { lat: startLat, lon: startLon }) + metres(to, { lat: endLat, lon: endLon });
  route.minutes = minutesFor(route.metres, route.climb);
  route.coords = [[from.lon, from.lat], ...route.coords, [to.lon, to.lat]];
}

export function formatMinutes(min: number): string {
  return min < 60 ? `${min}分` : `${Math.floor(min / 60)}時間${min % 60 ? `${min % 60}分` : ""}`;
}

export const timeTags: maplibregl.Marker[] = [];

/** 画面の上に重なっている入力欄・一覧・シートを避けた、地図の見える範囲。 */
export function routePadding(): maplibregl.PaddingOptions {
  const MARK = 46; // 印の高さ。先端が地点で、上に伸びる
  const rect = (node: Element | null) => (node && !(node as HTMLElement).hidden ? node.getBoundingClientRect() : null);
  const form = rect(directions);
  const sh = rect(sheet);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // 横向きのスマホ: 左に入力欄と一覧、右に地図の2分割（directions.css）。経路は右の地図に収める。
  if (vh <= 520 && vw > vh) {
    const left = Math.max(form?.right ?? 0, sh?.right ?? 0) + 24;
    return { top: 16 + MARK, bottom: 24, left: Math.min(left, vw * 0.6), right: 56 };
  }
  if (vw <= 720) {
    const grip = document.querySelector(".grip");
    const gripBox = sh && grip && getComputedStyle(grip).display !== "none" ? grip.getBoundingClientRect() : null;
    const top = (form ? form.bottom : 0) + MARK + 8;
    const covered = sh ? vh - (gripBox ?? sh).top + 20 : 40;
    // 地図が狭くなり過ぎないよう、上下の余白を縮める。
    const scale = Math.min(1, (vh - 140) / Math.max(top + covered, 1));
    return { top: top * scale, bottom: covered * scale, left: 36, right: 36 };
  }
  const left = Math.max(form?.right ?? 0, sh?.right ?? 0) + 40;
  return { top: 24 + MARK, bottom: 60, left: Math.min(left, vw * 0.6), right: 60 };
}

type Box = { x1: number; y1: number; x2: number; y2: number };
const overlaps = (a: Box, b: Box, gap = 4) => a.x1 < b.x2 + gap && a.x2 > b.x1 - gap && a.y1 < b.y2 + gap && a.y2 > b.y1 - gap;

/** 印（出発地・目的地・経由地・現在地）の、画面上の範囲。 */
function pinBoxes(): Box[] {
  return [markers.from, markers.to, markers.me, ...stopMarkers].filter((m) => m.getLngLat()).map((m) => {
    const { x, y } = map.project(m.getLngLat());
    return { x1: x - 16, y1: y - 46, x2: x + 16, y2: y + 4 };
  });
}

/**
 * 札の置き場所を決める。他の経路から離れ、見える範囲の中にあり、
 * 他の札や印と重ならない地点を選ぶ。置く順は、選んでいる経路が先。
 */
export function layoutTimeTags(): void {
  if (timeTags.length !== state.routes.length || document.body.classList.contains("guiding")) return;
  const pad = routePadding();
  const width = map.getContainer().clientWidth;
  const height = map.getContainer().clientHeight;
  const visible = (x: number, y: number) =>
    x >= pad.left! && x <= width - pad.right! && y >= pad.top! && y <= height - pad.bottom!;
  const samples = state.routes.map((route) => {
    const stride = Math.max(1, Math.floor(route.coords.length / 120));
    return route.coords.filter((_, k) => k % stride === 0).map((c) => ({ c, ...map.project(c) }));
  });
  const placed: Box[] = pinBoxes();
  // 選んでいる番号が、経路を出し直した後の本数を超えていることがある。
  const order = [state.selected, ...state.routes.map((_, i) => i).filter((i) => i !== state.selected)].filter(
    (i) => i < timeTags.length,
  );
  for (const i of order) {
    const tag = timeTags[i].getElement();
    const w = (tag.offsetWidth || 46) / 2;
    const h = (tag.offsetHeight || 24) / 2;
    const others = samples.filter((_, k) => k !== i).flat();
    // 優先度: 重ならず見える範囲 > 重ならない > 見える範囲 > どこでも。その中で他の経路から遠い所。
    // 線の真上で足りない時は、線の横にずらして置く。
    const shifts: [number, number][] = [[0, 0], [0, -2 * h - 2], [0, 2 * h + 2], [2 * w + 4, 0], [-2 * w - 4, 0]];
    let best = { c: samples[i][0].c, shift: shifts[0], box: { x1: 0, y1: 0, x2: 0, y2: 0 }, rank: -1, score: -1 };
    for (const { c, x, y } of samples[i]) {
      for (const shift of shifts) {
        const [px, py] = [x + shift[0], y + shift[1]];
        const box = { x1: px - w, y1: py - h, x2: px + w, y2: py + h };
        const rank = (placed.some((p) => overlaps(p, box)) ? 0 : 2) + (visible(px, py) ? 1 : 0);
        const away = others.reduce((min, o) => Math.min(min, Math.hypot(o.x - px, o.y - py)), 120) - (shift[0] || shift[1] ? 30 : 0);
        if (rank > best.rank || (rank === best.rank && away > best.score)) best = { c, shift, box, rank, score: away };
      }
    }
    timeTags[i].setLngLat(best.c).setOffset(best.shift);
    placed.push(best.box);
  }
}

/** 地図上の経路に、所要時間の札を付ける。 */
export function drawTimeTags(): void {
  timeTags.splice(0).forEach((tag) => tag.remove());
  state.routes.forEach((route, i) => {
    const tag = el("div", i === state.selected ? "time-tag on" : "time-tag", formatMinutes(route.minutes));
    tag.addEventListener("click", (e) => {
      e.stopPropagation();
      selectRoute(i);
    });
    timeTags.push(new maplibregl.Marker({ element: tag }).setLngLat(route.coords[0]).addTo(map));
  });
  layoutTimeTags();
}

/** 経路画面の下端に、14px 以上で常に出す免責。 */
export const DISCLAIMER_LINE = "表示は目安で、安全を保証しません";

/** 一覧の上の説明の一行。文は src/safety.ts の SAFETY_DISCLAIMER に揃える。 */
export const SAFETY_MEANING = `${SAFETY_DISCLAIMER}。`;

/** 説明ページ(public/safety.html)。サブパスでも動くよう、ページの位置から求める。 */
export const SAFETY_PAGE = new URL("safety.html", document.baseURI).href;

const assessed = new WeakMap<Route, { period: Period; value: Assessment }>();

/** 経路の交通事故の記録の目安。経路と昼夜ごとに1回だけ計算する(経路の線は connectEnds の後に確定する)。 */
export function assessment(route: Route): Assessment {
  const hit = assessed.get(route);
  if (hit && hit.period === state.period) return hit.value;
  const value = assess(safety, route, state.period);
  assessed.set(route, { period: state.period, value });
  return value;
}

/** routes.ts が付ける旧い札。画面には出さない。 */
const OLD_BEST = "事故の記録が少ない道";

/** 経路の札。「記録が少ない道」と言えるのは、段階が「比較的記録が少ない」の時だけ。 */
export function routeLabel(route: Route, a: Assessment): string {
  if (route.label === OLD_BEST && a.accident.tier === "low") return OLD_BEST;
  // 「別の道」だけでは、どの道か分からない。主な道の名前があれば「◯◯経由」にする。
  if (route.label === OLD_BEST || route.label === "別の道") return route.via ? `${route.via}経由` : "別の道";
  return route.label;
}

/** 一覧に出す理由(2つまで)。段階が不明の時は理由を出し、夜は夜の歩きやすさの言葉を出す。 */
export function listReasons(a: Assessment): string[] {
  const lines: string[] = [];
  if (a.unknown) lines.push(a.unknown);
  else if (!a.night) lines.push(a.accident.reasons[1]);
  if (a.night) lines.push(...a.night.lines.slice(a.unknown && a.night.remoteMetres >= 100 ? 1 : 0));
  return lines.slice(0, 2);
}

/** 最短との差。最短そのもの・差が無い時は空。 */
export function diffFromShortest(route: Route, shortest: Route): string {
  const dm = route.metres - shortest.metres;
  const dmin = route.minutes - shortest.minutes;
  if (route === shortest || (Math.abs(dm) < 10 && dmin === 0)) return "";
  const sign = (n: number) => (n >= 0 ? "+" : "−");
  const parts = [`${sign(dm)}${formatMetres(Math.abs(dm))}`];
  if (dmin !== 0) parts.push(`${sign(dmin)}${formatMinutes(Math.abs(dmin))}`);
  return `最短より ${parts.join("・")}`;
}

/** 段階の記号。色だけに頼らず、記号と言葉を一緒に出す。 */
export const TIER_MARK: Record<Tier, string> = { attention: "▲", normal: "●", low: "○", unknown: "－" };

const routeLetter = (i: number) => "ABCDEFGH"[i] ?? String(i + 1);

/** 一覧の行に出す札。「事故の記録が少ない道」は長いので縮める。 */
function shortLabel(route: Route, a: Assessment): string {
  const label = routeLabel(route, a);
  return label === OLD_BEST ? "記録が少ない道" : label;
}

/** 複数の経路を比べた結果。一番少ない経路の番号と、どれもほぼ同じかどうか。 */
export type Comparison = { least: number | null; same: boolean };

export function compareRoutes(list: Assessment[]): Comparison {
  const known = list.map((a, i) => ({ a, i })).filter((x) => x.a.accident.tier !== "unknown");
  if (known.length < 2) return { least: null, same: false };
  const counts = known.map((x) => x.a.accident.count);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  const sameTier = known.every((x) => x.a.accident.tier === known[0].a.accident.tier);
  // 段階が同じで件数の差も小さい時は、差があるように見せない。
  if (sameTier && max - min < Math.max(3, max * 0.2)) return { least: null, same: true };
  const atMin = known.filter((x) => x.a.accident.count === min);
  return { least: atMin.length === 1 ? atMin[0].i : null, same: false };
}

/** 事故の記録の、数え方の説明（期間は記録の期間、夜は夜の記録だけ）。 */
function countBasis(): string {
  const [y0, y1] = safety.cautions.accidentPeriod;
  return `歩行者・自転車が関わる事故を、経路から30m以内で数えています（${y0}〜${y1}年${state.period === "night" ? "・夜の記録だけ" : ""}）。`;
}

/** 経路の記録の要約。「▲ 71件」。段階が出せない時は「－ 評価なし」。 */
function recordText(a: Assessment): string {
  return a.accident.tier === "unknown" ? `${TIER_MARK.unknown} 評価なし` : `${TIER_MARK[a.accident.tier]} ${a.accident.count}件`;
}

export function routeList(): HTMLOListElement {
  const list = el("ol", "routes");
  const assessed = state.routes.map(assessment);
  const cmp = compareRoutes(assessed);
  list.append(
    ...state.routes.map((route, i) => {
      const a = assessed[i];
      const li = el("li");
      const button = el("button", "route-row");
      button.type = "button";
      button.toggleAttribute("aria-current", i === state.selected);
      button.addEventListener("click", () => selectRoute(i));
      const mark = el("span", `rec tier-${a.accident.tier}`, recordText(a));
      if (cmp.least === i) mark.append(el("small", "", "記録が最少"));
      button.setAttribute(
        "aria-label",
        `経路${routeLetter(i)} ${formatMinutes(route.minutes)} ${shortLabel(route, a)} ${(route.metres / 1000).toFixed(1)}キロ ` +
          (a.accident.tier === "unknown" ? "事故の記録は評価できません" : `事故の記録${a.accident.count}件 ${a.accident.label}`) +
          (cmp.least === i ? " この中で記録が一番少ない" : ""),
      );
      button.append(
        el("span", "letter", routeLetter(i)),
        el("span", "time", formatMinutes(route.minutes)),
        el("span", "facts", `${shortLabel(route, a)}・${(route.metres / 1000).toFixed(1)}km`),
        mark,
      );
      li.append(button);
      return li;
    }),
  );
  return list;
}

/** 選んだ経路の近くの駅（100m以内。地図データにある駅だけ）。経由の道の名前だけでは場所が伝わらないため。 */
export function stationsNear(route: Route): string[] {
  const genre = GENRES.find((g) => g.label === "駅");
  if (!genre) return [];
  const names: string[] = [];
  for (const { place } of placesAlong(route, genre)) {
    // 同じ駅が運営会社ごとに並ぶので、名前が同じ物は1つにする。
    if (!names.includes(place.name)) names.push(place.name);
  }
  return names.slice(0, 3);
}

// ---------------------------------------------------------------- 開閉（開いた状態は覚える）

const OPEN_KEY = "safewalk.ui.open";
const openMemo: Record<string, boolean> = (() => {
  const memo: Record<string, boolean> = {};
  try {
    // 手で書き換えられた・古い形の値でも落ちないよう、真偽の値だけを取り出す。
    const saved: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      for (const [key, value] of Object.entries(saved)) if (typeof value === "boolean") memo[key] = value;
    }
  } catch {
    /* 読めなければ全部閉じた状態 */
  }
  return memo;
})();

/** 文字ラベル付きの開閉。押せる高さは 44px 以上（directions.css の .fold > summary）。開いた状態は次の描き直しでも覚える。 */
export function fold(key: string, label: string, body: Node[], className = ""): HTMLDetailsElement {
  const box = el("details", `fold ${className}`.trim());
  box.open = !!openMemo[key];
  box.append(el("summary", "", label), ...body);
  box.addEventListener("toggle", () => {
    openMemo[key] = box.open;
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(openMemo));
    } catch {
      /* 覚えられないだけ */
    }
  });
  return box;
}

/** 昼夜を切り替えた直後だけ、一覧の下に出す一行（件数も本数も変わるため）。経路や出発地・目的地を替えたら消す。 */
const PERIOD_NOTE = "夜は夜の事故だけを数えます。昼と夜の件数は比べられません。本数も変わることがあります。";
let periodSwitched = false;

/** 件数の意味（夜は夜の記録だけを数えている）。 */
const countMeaning = () => (state.period === "night" ? "夜の事故の記録" : "事故の記録");

/** 選んだ経路の注意（長い距離・家が少ない道を先に、事故の記録からの注意をその後ろに）。 */
function cautionTexts(route: Route, a: Assessment): { text: string; kind: string }[] {
  // 事故の注意の件数は、1種類だけを経路から50m以内で数える。一覧の件数（歩行者と自転車・30m以内）と別の数だと書く。
  const range = (c: { kind: string }) =>
    `（${c.kind === "bike" ? "自転車" : "歩行者"}の事故だけ・経路から${SAFETY_RULES.cautionNearM}m以内で数えた件数です。一覧の${
      a.accident.tier === "unknown" ? "件数" : `${a.accident.count}件`
    }は歩行者と自転車を30m以内で数えています）`;
  return [
    ...routeWarnings(route).map((p) => ({ text: p.textContent ?? "", kind: "warn" })),
    ...a.cautions.map((c) => ({ text: c.kind === "snatch" ? c.text : `${c.text}${range(c)}`, kind: `caution-${c.kind}` })),
  ];
}

/** 周辺の事故の記録（車どうしも含む全部）の開閉。一覧の件数と別の数だと分かる題にし、右の印と折り返さない形にする。 */
function accidentDetailView(route: Route): HTMLElement {
  const node = accidentDetail(route);
  const summary = node.querySelector("summary");
  const title = summary?.querySelector("span");
  const note = summary?.querySelector("small");
  if (summary && title) {
    title.textContent = `参考: 周辺の事故すべて ${route.accidents.length}件`;
    const text = el("div", "sum-text");
    text.append(title, ...(note ? [note] : []));
    summary.replaceChildren(text);
  }
  return node;
}

/** 「くわしく」の中身。理由・出典・集計の条件・経由・道順・周辺の事故の記録。 */
function detailBody(route: Route, a: Assessment, shortest: Route): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  if (a.accident.tier === "unknown") nodes.push(el("p", "basis", a.unknown ?? ""));
  else {
    nodes.push(el("h4", "", "この段階になった理由"));
    const list = el("ul", "night-lines");
    for (const line of a.accident.reasons) list.append(el("li", "", line));
    nodes.push(list);
  }
  if (a.night) {
    nodes.push(el("h4", "", "夜の道"));
    const list = el("ul", "night-lines");
    for (const line of a.night.lines) list.append(el("li", "", line));
    nodes.push(list, el("p", "basis", "店は、地図データに営業時間がある店だけです。"));
  }
  if (a.accident.tier !== "unknown") {
    nodes.push(el("h4", "", "集計の条件・出典"), el("p", "basis", `${countBasis()}出典は警察庁オープンデータです。`));
    nodes.push(el("p", "basis", "段階は神戸市の道との比較です。街灯と人通りのデータは入っていません。"));
  }
  const stations = stationsNear(route);
  const where = [route.via ? `${route.via} 経由` : "", stations.length ? `近くの駅 ${stations.join("・")}` : ""].filter(Boolean);
  if (where.length) nodes.push(el("p", "where", where.join("　")));
  const diff = diffFromShortest(route, shortest);
  if (diff) nodes.push(el("p", "diff", diff));
  nodes.push(stepList(route), elevationDetail(route), alongDetail(route), accidentDetailView(route), safetyNote());
  return nodes;
}

export const DETOUR_TEXT = "歩行者が通れない車道や登山道を避けるため、遠回りになっています。登山・ランニングのコースには向きません";

/** 経路が出発地と目的地の直線の1.8倍を超え、直線が2kmを超える時（歩行者が通れない道を避けた遠回り）。 */
export function isDetour(route: Route): boolean {
  if (!state.from || !state.to) return false;
  const straight = metres(state.from, state.to);
  return straight > 2000 && route.metres > straight * 1.8;
}

/** 選んだ経路の中身。常に見せるのは要約だけ。理由・出典・道順などは「くわしく」にしまう。 */
function routePanel(route: Route, index: number, cmp: Comparison, shortest: Route): HTMLElement {
  const a = assessment(route);
  const panel = el("section", "route-panel");
  panel.setAttribute("aria-label", `経路${routeLetter(index)}の詳しい内容`);

  const tier = el("p", `tierline tier-${a.accident.tier}`);
  if (a.accident.tier === "unknown") {
    tier.append(el("strong", "", `${TIER_MARK.unknown} 記録の段階は出せません`));
    if (a.unknown) tier.append(el("span", "meaning", `理由: ${a.unknown}`));
  } else {
    tier.append(
      el("strong", "", `${TIER_MARK[a.accident.tier]} ${a.accident.label}`),
      ` ${a.accident.count}件`,
      el("span", "meaning", countMeaning()),
    );
    if (cmp.least === index) tier.append(el("span", "best", "この中で記録が一番少ない"));
    else if (cmp.same) tier.append(el("span", "same", "ほかの経路とほぼ同じ"));
  }
  panel.append(tier);
  if (isDetour(route)) panel.append(el("p", "detour", DETOUR_TEXT));

  const cautions = cautionTexts(route, a);
  if (cautions.length) {
    panel.append(el("p", `caution ${cautions[0].kind}`, cautions[0].text));
    if (cautions.length > 1) {
      const rest = el("ul", "cautions");
      for (const c of cautions.slice(1)) rest.append(el("li", `caution ${c.kind}`, c.text));
      panel.append(fold("cautions", `ほかの注意 ${cautions.length - 1}つ`, [rest], "more-cautions"));
    }
  }
  panel.append(fold("detail", "くわしく", detailBody(route, a, shortest), "more-detail"));
  panel.append(el("p", "note", "階段を通ることがあります。段差は考えていません。ベビーカーや車いすの方は、現地で確かめてください。"));
  return panel;
}

/** 「経路を送る」で何がリンクに入るか。自宅などの名前つきの地点は位置と名前が入り、現在地は入らない。 */
export function sendNoteText(from: Place | null, to: Place | null, stops: (Place | null)[] = []): string {
  const short = (n: string) => (n.length > 16 ? `${n.slice(0, 16)}…` : n);
  // リンクに入る地点は、出発地・経由地・目的地（url.ts）。現在地は位置を入れない。
  const points: [string, Place | null][] = [
    ["出発地", from],
    ...stops.filter((s): s is Place => s !== null).map((s): [string, Place] => ["経由地", s]),
    ["目的地", to],
  ];
  const named = points.filter((x): x is [string, Place] => !!x[1] && x[1].name !== CURRENT);
  const current = points.some(([, p]) => p?.name === CURRENT);
  if (!named.length) return "「経路を送る」のリンクには、現在地の位置は入りません。";
  const list = named.map(([role, p]) => `${role}「${short(p.name)}」`).join("・");
  return `「経路を送る」のリンクには、${list}の位置と名前が入ります。${current ? "現在地は入りません。" : "自宅などの場合は、送る相手を確かめてください。"}`;
}

/** 経路を送る前の確認。何がリンクに入るかをここで見せる（自前の画面。confirm() は使わない）。 */
function confirmSend(button: HTMLButtonElement): void {
  document.getElementById("send-confirm")?.remove();
  const back = el("div", "confirm-back");
  back.id = "send-confirm";
  const box = el("div", "card confirm");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-labelledby", "send-confirm-title");
  const title = el("h3", "", "この経路を送ります");
  title.id = "send-confirm-title";
  const ok = el("button", "primary", "送る");
  ok.type = "button";
  const cancel = el("button", "secondary", "やめる");
  cancel.type = "button";
  const actions = el("div", "confirm-actions");
  actions.append(cancel, ok);
  box.append(title, el("p", "", sendNoteText(state.from, state.to, state.stops)), actions);
  back.append(box);
  const close = () => {
    back.remove();
    if (button.isConnected) button.focus();
  };
  cancel.addEventListener("click", close);
  back.addEventListener("click", (e) => {
    if (e.target === back) close();
  });
  ok.addEventListener("click", () => {
    close();
    void shareRoute(button);
  });
  back.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      // 後ろの画面へ出ないよう、2つのボタンの間で回す。
      e.preventDefault();
      (document.activeElement === ok ? cancel : ok).focus();
    }
  });
  document.body.append(back);
  ok.focus();
}

export function selectRoute(index: number, force = false): void {
  // 案内中は経路を替えない。範囲外の番号も受けない。
  if (isGuiding() && !force) return;
  if (index < 0 || index >= state.routes.length) return;
  state.selected = index;
  (map.getSource("routes") as GeoJSONSource).setData({
    type: "FeatureCollection",
    features: state.routes.map((route, i) => ({
      type: "Feature",
      properties: { index: i, selected: i === index },
      geometry: { type: "LineString", coordinates: route.coords },
    })),
  });
  const route = state.routes[index];
  showAccidents(route, false);
  drawTimeTags();
  const a = assessment(route);
  // 「最短」の札が付いた経路を基準にする（札と「最短より+◯m」の基準をそろえる）。無ければ一番短い経路。
  const shortest = state.routes.find((r) => r.label === "最短") ?? state.routes.reduce((x, y) => (y.metres < x.metres ? y : x), state.routes[0]);
  const cmp = compareRoutes(state.routes.map(assessment));
  // 案内ボタンは画面の下に固定し、何を始めるのかを書く。
  const start = el("button", "primary start", `案内を始める（${formatMinutes(route.minutes)}・${shortLabel(route, a)}）`);
  start.type = "button";
  start.addEventListener("click", () => {
    startGuide(state.selected);
    // 押した「案内を始める」は案内の間は消える。焦点は案内の「終了」へ移す。
    if (!$("guide").hidden) $("guide-stop").focus({ preventScroll: true });
  });
  const send = el("button", "secondary send", "経路を送る");
  send.type = "button";
  send.setAttribute("aria-label", "選んだ経路を人に送る");
  send.addEventListener("click", () => confirmSend(send));
  // 免責は、固定の案内ボタンの上に常に出す。
  const startBar = el("div", "start-bar");
  const buttons = el("div", "start-buttons");
  buttons.append(start, send);
  startBar.append(el("p", "disclaimer", DISCLAIMER_LINE), buttons);
  const notes: HTMLElement[] = [];
  if (arrived) {
    const text = `送られてきた経路です。経路${routeLetter(arrived.index)}（${formatMinutes(state.routes[arrived.index]?.minutes ?? 0)}）。`;
    notes.push(el("p", "shared-note", text + (arrived.exact ? "" : "出発地などが違うため、近い経路を出しています。")));
  }
  // 経路の一覧の見出し。画面には出さず、案内を終えた後などの焦点の行き先にする。
  const heading = el("h2", "sr-only", "経路の一覧");
  heading.tabIndex = -1;
  heading.dataset.resultHeading = "";
  // 経路の行を押して一覧を描き直す時は、押した行（描き直した後の同じ行）に焦点を残す。
  const keepRowFocus = sheet.contains(document.activeElement) && document.activeElement?.classList.contains("route-row");
  sheet.replaceChildren(
    ...(emergencyNode ? [emergencyNode] : []),
    heading,
    ...notes,
    routeList(),
    el("p", "rec-meaning", `件数は、${countMeaning()}（歩行者・自転車が関わるもの）`),
    ...(periodSwitched ? [el("p", "rec-meaning period-note", PERIOD_NOTE)] : []),
    routePanel(route, index, cmp, shortest),
    agentSection(),
    startBar,
  );
  sheet.hidden = false;
  if (keepRowFocus) sheet.querySelector<HTMLElement>(".routes [aria-current]")?.focus({ preventScroll: true });
  // 最短（先頭）の時は上端のまま。説明の行を半端に隠さない。
  if (index === 0) sheet.scrollTop = 0;
  else sheet.querySelector(".routes [aria-current]")?.scrollIntoView({ block: "nearest" });
  // アドレス欄にも選んだ経路を残す（再読込・共有で同じ経路に戻れる）。
  replaceUrl();
}

// ---------------------------------------------------------------- Claude に事情を伝えて道を選んでもらう

/** 候補の事情。押すとそのまま送る。 */
export const AGENT_PRESETS = ["子どもが一人で帰る", "荷物が多い", "終電後に長く歩く", "坂が少ない道がいい"];

type AgentUi = { busy: boolean; progress: string; result: AgentResult | null; error: string; disaster: boolean };
const idleAgent = (): AgentUi => ({ busy: false, progress: "", result: null, error: "", disaster: false });
let agentUi: AgentUi = idleAgent();
/**
 * 緊急の枠。一度出したら、利用者が閉じる（または経路の画面を閉じる）まで、入れ替え・昼夜・再計算・交番への経路でも残す。
 * 一覧の一番上に出す（selectRoute / clearRoutes が描く）。災害の文は、Claude の相談欄の中に出す。
 */
let emergencyNode: HTMLElement | null = null;
let disasterNode: HTMLElement | null = null;

/** 緊急の枠を出す前のシートの高さ（--sheet-h）。枠を閉じたら戻す。null は手で動かしていない（既定の高さ）。 */
let sheetHeightBefore: string | null | undefined;

/** 緊急の枠が出たら、枠の中の交番の行が下の固定ボタンの裏に隠れないよう、シートを一番上の段まで上げる（スマホの縦向きだけ）。 */
function raiseSheetForEmergency(): void {
  const grip = document.querySelector(".grip");
  if (!grip || getComputedStyle(grip).display === "none") return;
  const target = Math.round(window.innerHeight * SHEET_STOPS[SHEET_STOPS.length - 1]);
  if (sheetHeightBefore === undefined) sheetHeightBefore = sheet.style.getPropertyValue("--sheet-h") || null;
  if (sheet.getBoundingClientRect().height < target) sheet.style.setProperty("--sheet-h", `${target}px`);
}

function restoreSheetHeight(): void {
  if (sheetHeightBefore === undefined) return;
  if (sheetHeightBefore) sheet.style.setProperty("--sheet-h", sheetHeightBefore);
  else sheet.style.removeProperty("--sheet-h");
  sheetHeightBefore = undefined;
}

function showEmergency(): void {
  emergencyNode = emergencyPanel(state.from, routeToKoban, dismissEmergency);
  raiseSheetForEmergency();
  if (state.routes.length) selectRoute(state.selected);
  else clearRoutes();
  sheet.scrollTop = 0;
}

function dismissEmergency(): void {
  emergencyNode?.remove();
  emergencyNode = null;
  restoreSheetHeight();
  if (!state.routes.length && !sheet.childElementCount) sheet.hidden = true;
}
/** 経路を出し直したら古い答えを捨てるための番号。待っている間に変わったら、返ってきた答えは使わない。 */
let agentRun = 0;
let agentNode: HTMLDetailsElement | null = null;
let agentInput: HTMLInputElement | null = null;
let agentOut: HTMLElement | null = null;
let agentButtons: HTMLButtonElement[] = [];

/** 道具の名前から、進み具合の文。 */
const TOOL_PROGRESS: Record<string, string> = {
  find_routes: "経路の記録を調べています…",
  assess_route: "経路ごとの事故の記録と注意書きを調べています…",
  places_along: "経路の沿いの場所を数えています…",
};

let agentAbort: AbortController | null = null;

function resetAgent(): void {
  agentRun++;
  agentAbort?.abort();
  agentAbort = null;
  agentUi = idleAgent();
  if (agentNode) renderAgent();
}

/** fetch を包み、Claude が呼んだ道具の名前を進み具合に出す。 */
function trackedFetch(run: number): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, init);
    try {
      const body = (await res.clone().json()) as { content?: { type: string; name?: string }[] };
      const tool = body.content?.find((b) => b.type === "tool_use");
      if (tool && run === agentRun) {
        agentUi.progress = TOOL_PROGRESS[tool.name ?? ""] ?? "記録を調べています…";
        renderAgent();
      }
    } catch {
      /* 進み具合が出せないだけ */
    }
    return res;
  };
}

/** 画面の経路(state.routes)が、Claude が調べた経路と同じ物か。 */
function sameRoutes(result: AgentResult): boolean {
  return (
    result.routes.length === state.routes.length &&
    result.routes.every((r, i) => {
      const mine = state.routes[i].coords;
      // どちらも先頭と末尾に実際の地点が足してある(connectEnds)ので、そのまま比べる。
      return r.coords.length === mine.length && r.coords[1][0] === mine[1][0] && r.coords[1][1] === mine[1][1];
    })
  );
}

async function askClaude(text: string): Promise<void> {
  if (agentUi.busy || !state.from || !state.to || !state.routes.length) return;
  agentAbort?.abort();
  const run = ++agentRun;
  const abort = (agentAbort = new AbortController());
  const { from, to } = state;
  agentUi = { ...idleAgent(), busy: true, progress: "事情を Claude に伝えています…", disaster: detectDisaster(text) };
  disasterNode = agentUi.disaster ? disasterPanel() : null;
  if (agentNode) agentNode.open = true;
  if (detectEmergency(text)) showEmergency();
  else renderAgent();
  let result: AgentResult | null = null;
  try {
    result = await runAgent(
      {
        situation: text,
        from: state.from,
        to: state.to,
        period: state.period,
        // 一覧と同じ数字・同じ段階で調べさせる(一覧の経路は connectEnds で出発地・目的地までの区間を足してある)。
        ctx: { ...agentContext(), afterFind: (routes) => routes.forEach((r) => connectEnds(r, from, to)) },
      },
      { fetchImpl: trackedFetch(run), signal: abort.signal },
    );
  } catch {
    result = null;
  }
  if (run !== agentRun) return;
  agentAbort = null;
  const flags = { disaster: agentUi.disaster };
  if (!result) agentUi = { ...idleAgent(), ...flags, error: FIXED.failed };
  else if (!result.ok) agentUi = { ...idleAgent(), ...flags, error: result.error ?? FIXED.failed };
  else agentUi = { ...idleAgent(), ...flags, result };
  const chosen = agentUi.result?.declined ? null : agentUi.result?.chosenRouteIndex;
  if (agentUi.result && chosen != null && sameRoutes(agentUi.result)) selectRoute(chosen);
  else renderAgent();
  // 答えの先頭(まとめの文)が見えるようにする。
  (detectEmergency(text) && emergencyNode ? emergencyNode : agentNode)?.scrollIntoView({ block: "start" });
}

function agentResultView(result: AgentResult, disaster: boolean): HTMLElement[] {
  // 断った時は経路を選ばず、固定の文だけを出す。
  if (result.declined) return [el("p", "agent-summary", result.summary), el("p", "agent-disclaimer", `${result.disclaimer}。`)];
  const nodes: HTMLElement[] = [el("p", "agent-summary", result.summary)];
  const chosen = result.chosenRouteIndex;
  if (chosen != null && state.routes[chosen] && sameRoutes(result)) {
    nodes.push(el("p", "agent-chosen", `選んだ経路: 経路${routeLetter(chosen)}（${formatMinutes(state.routes[chosen].minutes)}）を地図で選びました。`));
  }
  nodes.push(el("p", "agent-hint", "経路A・Bは、上の一覧の上から順です。"));
  const reasons = el("ul", "agent-reasons");
  for (const r of result.reasons) {
    const li = el("li", "", r.text);
    if (r.evidence.length) {
      const d = el("details", "agent-evidence");
      d.append(el("summary", "", "根拠の記録"));
      const ul = el("ul");
      ul.append(...r.evidence.map((t) => el("li", "", t)));
      d.append(ul);
      li.append(d);
    }
    reasons.append(li);
  }
  nodes.push(el("h3", "", "理由"), reasons);
  // 災害の相談では、事故・ひったくりの注意書きを並べない。
  if (result.cautions.length && !disaster) {
    const ul = el("ul", "cautions");
    ul.append(...result.cautions.map((c) => el("li", "caution", c.text)));
    nodes.push(el("h3", "", "注意書き"), ul);
  }
  if (result.caveats) nodes.push(el("p", "agent-caveats", `記録の限界: ${result.caveats}`));
  if (result.replaced.length) nodes.push(el("p", "agent-hint", "確認を通らなかった一部の文は、固定の文に差し替えました。"));
  nodes.push(el("p", "agent-disclaimer", `${result.disclaimer}。`));
  return nodes;
}

/** 緊急の枠が今いる場所(出発地)から近い交番へ経路を出す。 */
function routeToKoban(k: KobanHit): void {
  toKoban(k);
  sheet.scrollTop = 0;
}

/** 交番へは、いちばん近い道で行く。経由地は外す（経由地を回ってから交番へ向かわない）。 */
export function toKoban(k: KobanHit): void {
  const place: Place = { name: k.name, lat: k.lat, lon: k.lon, kind: "警察" };
  if (state.stops.length) {
    state.stops = [];
    renderStops();
  }
  // 緊急の枠は経路を出し直しても残る。交番への経路が見える位置（一覧の上）へは routeToKoban が戻す。
  setEnd("to", place, true);
}

function renderAgent(): void {
  if (!agentNode || !agentOut || !agentInput) return;
  const blocked = state.stops.some(Boolean);
  agentButtons.forEach((b) => (b.disabled = agentUi.busy || blocked));
  agentInput.disabled = agentUi.busy || blocked;
  agentNode.setAttribute("aria-busy", String(agentUi.busy));
  if (blocked) return void agentOut.replaceChildren(el("p", "agent-hint", "経由地がある時は、Claude への相談は使えません。"));
  // 災害の文は、Claude の答えより上に固定で出す（緊急の枠は一覧の上に別に出す）。
  const fixed: HTMLElement[] = [];
  if (agentUi.disaster && disasterNode) fixed.push(disasterNode);
  const body = agentUi.busy
    ? [el("p", "agent-progress", agentUi.progress)]
    : agentUi.error
      ? [el("p", "agent-error", agentUi.error)]
      : agentUi.result
        ? agentResultView(agentUi.result, agentUi.disaster)
        : [];
  agentOut.replaceChildren(...fixed, ...body);
}

/** 「Claude に相談」入口と、答え。1行に畳み、開くと入力欄と候補。選び直しで作り直されても同じ物を返す。 */
export function agentSection(): HTMLElement {
  if (!agentNode) {
    agentNode = el("details", "agent fold");
    agentNode.open = !!openMemo.agent;
    agentNode.addEventListener("toggle", () => {
      openMemo.agent = agentNode!.open;
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(openMemo));
      } catch {
        /* 覚えられないだけ */
      }
    });
    const head = el("summary", "", "Claude に相談（例: 坂が少ない道がいい）");
    // 開いたら、入力欄が下の固定ボタンの裏に隠れないよう、見える所まで送る。
    head.addEventListener("click", () => {
      window.setTimeout(() => {
        if (agentNode?.open) agentNode.scrollIntoView({ block: "start", behavior: "auto" });
      }, 0);
    });
    agentNode.append(head);
    const presets = el("div", "chips inline");
    const form = el("form", "agent-form");
    const input = el("input");
    agentInput = input;
    input.type = "text";
    input.maxLength = SITUATION_MAX;
    input.placeholder = "例: 子どもが一人で帰る";
    input.setAttribute("aria-label", "歩く事情");
    const send = el("button", "primary", "相談する");
    send.type = "submit";
    form.append(input, send);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void askClaude(input.value);
    });
    agentButtons = [send];
    for (const text of AGENT_PRESETS) {
      const chip = el("button", "chip", text);
      chip.type = "button";
      chip.addEventListener("click", () => {
        input.value = text;
        void askClaude(text);
      });
      agentButtons.push(chip);
      presets.append(chip);
    }
    agentOut = el("div", "agent-out");
    agentOut.setAttribute("aria-live", "polite");
    // 入力欄の直下に常に出す。災害の文は開いた中に置く。
    const privacy = el("p", "agent-privacy", "氏名・住所・持病は入れないでください（入力した文と、出発地・目的地の名前が Claude に送られます）。");
    const scope = el("p", "agent-privacy", DISASTER_NOTICE);
    scope.append(" ", bosaiLink());
    agentNode.append(form, privacy, presets, scope, agentOut);
  }
  renderAgent();
  return agentNode;
}

export const FLAT_M = 10;

/** 出発地からの高さの変化を線で描く。 */
export function elevationDetail(route: Route): HTMLElement {
  const wrap = el("details", "detail");
  const flat = route.climb < FLAT_M && route.descent < FLAT_M;
  wrap.append(el("summary", "", flat ? "高度: ほぼ平坦" : `高度: 上り${route.climb}m・下り${route.descent}m`));
  const heights = route.profile.map(([, h]) => h);
  const low = Math.min(...heights);
  const high = Math.max(...heights);
  const end = route.profile[route.profile.length - 1][0] || 1;
  const width = 340;
  const height = 80;
  const line = route.profile
    .map(([d, h]) => `${((d / end) * width).toFixed(1)},${(height - 6 - ((h - low) / Math.max(high - low, 20)) * (height - 12)).toFixed(1)}`)
    .join(" ");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "profile");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `高低差 ${Math.round(high - low)}m`);
  const area = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  area.setAttribute("points", `0,${height} ${line} ${width},${height}`);
  const stroke = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  stroke.setAttribute("points", line);
  svg.append(area, stroke);
  wrap.append(svg, el("p", "", `高低差 ${Math.round(high - low)}m・全長 ${formatMetres(end)}`));
  return wrap;
}

export const ALONG_M = 100;
export const ALONG_LIMIT = 12;

/** 経路の近くにある場所を、出発地に近い順に探す。 */
export function placesAlong(route: Route, genre: Genre): { place: Place; order: number }[] {
  const stride = Math.max(1, Math.floor(route.coords.length / 400));
  const points = route.coords.filter((_, i) => i % stride === 0);
  const lons = route.coords.map(([lon]) => lon);
  const lats = route.coords.map(([, lat]) => lat);
  const pad = 0.002;
  const [west, east] = [Math.min(...lons) - pad, Math.max(...lons) + pad];
  const [south, north] = [Math.min(...lats) - pad, Math.max(...lats) + pad];
  const hits: { place: Place; order: number }[] = [];
  for (const place of places) {
    if (!genre.kinds.includes(place.kind)) continue;
    if (place.lon < west || place.lon > east || place.lat < south || place.lat > north) continue;
    const order = points.findIndex(([lon, lat]) => metres(place, { lat, lon }) <= ALONG_M);
    if (order >= 0) hits.push({ place, order });
  }
  return hits.sort((a, b) => a.order - b.order).slice(0, ALONG_LIMIT);
}

export function alongDetail(route: Route): HTMLElement {
  const wrap = el("details", "detail");
  wrap.append(el("summary", "", "経路沿いを検索"));
  const chips = el("div", "chips inline");
  const results = el("div");
  chips.append(
    ...GENRES.slice(0, 6).map((genre) => {
      const chip = el("button", "chip", genre.label);
      chip.type = "button";
      chip.addEventListener("click", () => {
        const rows = placesAlong(route, genre).map(({ place }) => place);
        showResultDots(rows);
        results.replaceChildren(
          rows.length
            ? placeRows(rows, state.from!, addStop)
            : el("p", "", `経路から${ALONG_M}m以内に${genre.label}の記録がありません。`),
        );
      });
      return chip;
    }),
  );
  wrap.append(chips, results);
  return wrap;
}

/** 徒歩に向かない経路の注意。基準の距離と上りは仮の値。 */
export const LONG_WALK_M = 8000;
export const BIG_CLIMB_M = 300;
export const NOTE_REMOTE_M = 500;

export function routeWarnings(route: Route): HTMLElement[] {
  const lines: string[] = [];
  if (route.metres >= LONG_WALK_M) {
    lines.push(`長い距離です（${(route.metres / 1000).toFixed(1)}km）。休む場所とスマホの電池を考えてください。`);
  }
  if (route.climb >= BIG_CLIMB_M) lines.push(`上りの大きい経路です（上り${route.climb}m）。`);
  if (route.remoteMetres >= NOTE_REMOTE_M) {
    const km = (route.remoteMetres / 1000).toFixed(1);
    lines.push(
      state.period === "night"
        ? `家が少ない道を${km}km通ります。夜は避けることをおすすめします。`
        : `家が少ない道を${km}km通ります。`,
    );
  }
  return lines.map((line) => el("p", "warn", line));
}

/** 一覧の上の説明の一行と、説明ページへのリンク。 */
export function safetyNote(): HTMLElement {
  const note = el("p", "safety-note", SAFETY_MEANING);
  const link = el("a", "", "くわしい説明");
  link.href = SAFETY_PAGE;
  link.target = "_blank";
  link.rel = "noopener";
  note.append(" ", link);
  return note;
}

export function formatMetres(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`;
}

/** 長い直進の一行（「道なりに進む 2.0km」を「この先2.0kmは曲がりません」に）。長い直進でなければ null。道の名前の括弧は残す。 */
export const LONG_STRAIGHT_M = 500;
export function longStraight(step: { text: string; metres: number }): string | null {
  if (!step.text.startsWith("道なりに進む") || step.metres < LONG_STRAIGHT_M) return null;
  return `この先${formatMetres(step.metres)}は曲がりません${step.text.slice("道なりに進む".length)}`;
}

export function stepList(route: Route): HTMLElement {
  const wrap = el("details", "detail");
  wrap.append(el("summary", "", `道順の案内 ${route.steps.length}件`));
  const list = el("ol", "steps");
  for (const step of route.steps) {
    const li = el("li");
    const button = el("button");
    button.type = "button";
    const straight = longStraight(step);
    button.append(el("span", "", straight ?? step.text));
    if (!straight) button.append(el("span", "dist", formatMetres(step.metres)));
    button.addEventListener("click", () => map.flyTo({ center: step.at, zoom: 17, padding: routePadding() }));
    li.append(button);
    list.append(li);
  }
  wrap.append(list);
  return wrap;
}


export function bindDirectionsUi(): void {
  // 拡大・縮小で札どうしの距離が変わるので、置き直す。
  map.on("zoomend", layoutTimeTags);
  const clearEnd = (which: End) => (value: string) => {
    if (!value && state[which]) {
      setEnd(which, null);
      clearRoutes();
    }
  };
  bindSuggest(fromInput, (p) => setEnd("from", p), { offerCurrent: true, onEdit: clearEnd("from") });
  bindSuggest(toInput, (p) => setEnd("to", p), { offerCurrent: true, onEdit: clearEnd("to") });
  // 打ちかけて欄を離れた時は、今の地点の名前に戻す（経路と食い違わせない）。
  for (const [which, input] of [["from", fromInput], ["to", toInput]] as const) {
    input.addEventListener("blur", () => {
      input.value = state[which]?.name ?? "";
    });
  }
  // 画面の幅・向きが変わったら、経路を収め直し、札を置き直す。
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (state.mode !== "directions" || !state.routes.length || document.body.classList.contains("guiding")) return;
      map.resize();
      fitRoutes(0);
      layoutTimeTags();
    }, 200);
  });
  // 畳んだ1行を押すと開く。欄の外を押す・Esc で、また畳む。
  // 指で押した時は入力欄へ焦点を当てない（キーボードと候補の一覧が地図と経路を覆うため）。キーボード操作の時だけ目的地欄へ。
  dirSummary.addEventListener("click", (e) => {
    setFolded(false);
    if (e.detail === 0) toInput.focus();
  });
  document.addEventListener("pointerdown", (e) => {
    if (directions.hidden || directions.classList.contains("folded") || !canFold() || !state.routes.length) return;
    if (e.target instanceof Node && !directions.contains(e.target)) setFolded(true);
  });
  directions.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || directions.classList.contains("folded") || !canFold() || !state.routes.length) return;
    if (directions.querySelector(".suggest:not([hidden])")) return; // 候補を閉じる Esc は検索側が受ける
    setFolded(true);
  });
  $("open-directions").addEventListener("click", () => {
    openDirections(state.picked ? { to: state.picked } : {});
    pushUrl();
  });
  $("close-directions").addEventListener("click", () => {
    closeDirections();
    state.picked = null;
    markers.picked.remove();
    qInput.value = "";
    pushUrl();
  });
  $("swap").addEventListener("click", () => {
    const { from, to } = state;
    state.stops.reverse();
    renderStops();
    setEnd("from", to, false);
    setEnd("to", from);
  });
  $("add-stop").addEventListener("click", () => {
    state.stops.push(null);
    renderStops();
    $("stops").querySelector<HTMLInputElement>(".stop-row:last-child input")?.focus();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-period]").forEach((b) => {
    b.addEventListener("click", () => {
      if (state.period !== b.dataset.period && state.routes.length) periodSwitched = true;
      state.period = b.dataset.period as Period;
      renderPeriod();
      if (state.from && state.to) search();
    });
  });
}
