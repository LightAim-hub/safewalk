import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import { metres, type LatLon } from "./graph";
import { findRoutes, joinRoutes, minutesFor, type Period, type Route } from "./routes";
import { showAccidents, accidentDetail } from "./accidents-ui";
import { $, qInput, fromInput, toInput, searchbar, directions, sheet, COLORS, CURRENT, GENRES, state, map, markers, stopMarkers, toast, scoreColor, el } from "./app";
import { graph, accidents, meta, places, names, emptyCollection, snap } from "./data";
import { startGuide, stopGuide } from "./guide";
import { popup } from "./place";
import { placeRows, showResultDots, clearGenre, bindSuggest } from "./search";
import { type Place, type Genre, type End } from "./types";
import "./directions.css";
import { replaceUrl, pushUrl, renderPeriod } from "./url";

export function openDirections(ends: Partial<Record<End, Place>>): void {
  state.mode = "directions";
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
}

let locating = 0;

/** 出発地の既定は現在地。取れない・神戸市外の時は何も出さず空のままにする（知らせで目的地欄を覆わない）。 */
function fillCurrentFrom(): void {
  if (!navigator.geolocation) return;
  const mine = ++locating;
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      // 待つ間に、経路の画面を閉じた・出発地を選んだ・文字を打った時は、何もしない。
      if (mine !== locating || state.mode !== "directions" || state.from || fromInput.value.trim()) return;
      const place: Place = { lat: coords.latitude, lon: coords.longitude, name: CURRENT };
      if (snap(place) === null) return;
      setEnd("from", place);
    },
    () => undefined,
    { timeout: 8000, maximumAge: 60000 },
  );
}

export function closeDirections(): void {
  locating++;
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

/** 表示中の経路を消す。経路を出せない時は、古い経路を残さず理由を出す。 */
export function clearRoutes(message = ""): void {
  state.routes = [];
  timeTags.splice(0).forEach((tag) => tag.remove());
  (map.getSource("routes") as GeoJSONSource).setData(emptyCollection());
  (map.getSource("accidents") as GeoJSONSource).setData(emptyCollection());
  sheet.replaceChildren(el("p", "", message));
  sheet.hidden = !message;
}

export function setEnd(which: End, place: Place | null, run = true): void {
  state[which] = place;
  const input = which === "from" ? fromInput : toInput;
  input.value = place?.name ?? "";
  if (place) markers[which].setLngLat([place.lon, place.lat]).addTo(map);
  else markers[which].remove();
  if (run && state.from && state.to) search();
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

export function safestIndex(routes: Route[]): number {
  return routes.reduce((a, b, i, all) => ((b.safety ?? -1) > (all[a].safety ?? -1) ? i : a), 0);
}

export function search(): void {
  const start = snap(state.from!);
  const goal = snap(state.to!);
  showResultDots([]);
  if (start === null || goal === null) return clearRoutes("出発地か目的地の近くに、神戸市内の歩ける道がありません。");
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
  for (const route of state.routes) connectEnds(route, state.from!, state.to!);
  replaceUrl();
  // 昼も夜も Google マップと同じく最短を選ぶ。「最も安全」などは一覧に並べたままにする。
  selectRoute(0);
  fitRoutes(500);
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

/** 安全度の数字の意味。出し方を変えたら、ここだけ直す。 */
export const SAFETY_MEANING = "安全度は、交通事故の記録から計算した目安です。高いほど記録が少ない道です。安全を保証するものではありません。";

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

export function routeList(): HTMLOListElement {
  const list = el("ol", "routes");
  const shortest = state.routes.reduce((a, b) => (b.metres < a.metres ? b : a), state.routes[0]);
  list.append(
    ...state.routes.map((route, i) => {
      const li = el("li");
      const button = el("button");
      button.type = "button";
      button.toggleAttribute("aria-current", i === state.selected);
      button.addEventListener("click", () => selectRoute(i));
      const safety = el("span", "safety", route.safety === null ? "不明" : `${route.safety}%`);
      safety.style.color = scoreColor(route.safety);
      safety.append(el("small", "", "安全度の目安"));
      button.append(
        el("span", "time", formatMinutes(route.minutes)),
        safety,
        el("span", "facts", `${route.label}・${(route.metres / 1000).toFixed(1)}km・上り${route.climb}m`),
        ...(route.via ? [el("span", "via", `${route.via} 経由`)] : []),
        ...(diffFromShortest(route, shortest) ? [el("span", "diff", diffFromShortest(route, shortest))] : []),
      );
      li.append(button);
      return li;
    }),
  );
  return list;
}

export function selectRoute(index: number): void {
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
  const start = el("button", "primary start", "案内を始める");
  start.type = "button";
  start.addEventListener("click", () => startGuide(state.selected));
  // 一覧が長くても届くよう、案内ボタンは一覧の上に置き、スクロールしても上端に残す。
  const startBar = el("div", "start-bar");
  startBar.append(start);
  sheet.replaceChildren(
    startBar,
    el("p", "safety-note", SAFETY_MEANING),
    routeList(),
    ...routeWarnings(route),
    stepList(route),
    elevationDetail(route),
    alongDetail(route),
    accidentDetail(route),
  );
  sheet.hidden = false;
  // 最短（先頭）の時は上端のまま。説明の行を半端に隠さない。
  if (index === 0) sheet.scrollTop = 0;
  else sheet.querySelector(".routes [aria-current]")?.scrollIntoView({ block: "nearest" });
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
  if (route.metres >= LONG_WALK_M) lines.push(`徒歩では長い距離です（${(route.metres / 1000).toFixed(1)}km）。`);
  if (route.climb >= BIG_CLIMB_M) lines.push(`上りの大きい経路です（上り${route.climb}m）。`);
  if (route.remoteMetres >= NOTE_REMOTE_M) {
    const km = (route.remoteMetres / 1000).toFixed(1);
    lines.push(
      state.period === "night"
        ? `人家から離れた道を${km}km通ります。夜は避けることをおすすめします。`
        : `人家から離れた道を${km}km通ります。`,
    );
  }
  if (route.safety === null) lines.push("事故データで評価できない道が多いため、安全度は不明です。");
  return lines.map((line) => el("p", "warn", line));
}

export function formatMetres(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`;
}

export function stepList(route: Route): HTMLElement {
  const wrap = el("details", "detail");
  wrap.append(el("summary", "", `道順の案内 ${route.steps.length}件`));
  const list = el("ol", "steps");
  for (const step of route.steps) {
    const li = el("li");
    const button = el("button");
    button.type = "button";
    button.append(el("span", "", step.text), el("span", "dist", formatMetres(step.metres)));
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
      state.period = b.dataset.period as Period;
      renderPeriod();
      if (state.from && state.to) search();
    });
  });
}
