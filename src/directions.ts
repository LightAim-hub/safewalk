import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import { metres, type LatLon } from "./graph";
import { findRoutes, joinRoutes, minutesFor, type Period, type Route } from "./routes";
import { showAccidents, accidentDetail } from "./accidents-ui";
import { $, qInput, fromInput, toInput, searchbar, directions, sheet, COLORS, GENRES, state, map, markers, stopMarkers, toast, scoreColor, el, mapPadding } from "./app";
import { graph, accidents, meta, places, names, emptyCollection, snap } from "./data";
import { startGuide, stopGuide } from "./guide";
import { popup } from "./place";
import { placeRows, showResultDots, clearGenre, bindSuggest } from "./search";
import { type Place, type Genre, type End } from "./types";
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
  else (state.from ? toInput : fromInput).focus();
}

export function closeDirections(): void {
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
    return options[state.period === "night" ? safestIndex(options) : 0];
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
  // 昼は Google マップと同じく最短を選び、夜は最も安全な経路を選ぶ。
  selectRoute(state.period === "night" ? safestIndex(state.routes) : 0);
  const all = state.routes.flatMap((r) => r.coords);
  const bounds = all.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(all[0], all[0]));
  map.fitBounds(bounds, { padding: mapPadding(), duration: 500 });
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

/** 他の経路や札からいちばん離れた地点を、札の置き場所にする。 */
export function tagPosition(index: number): [number, number] {
  const coords = state.routes[index].coords;
  const others = state.routes.flatMap((route, i) => {
    if (i === index) return [];
    const stride = Math.max(1, Math.floor(route.coords.length / 80));
    return route.coords.filter((_, k) => k % stride === 0);
  });
  const placed = timeTags.map((tag) => tag.getLngLat().toArray() as [number, number]);
  const stride = Math.max(1, Math.floor(coords.length / 80));
  let best = coords[Math.floor(coords.length / 2)];
  let bestScore = -1;
  for (let i = stride; i < coords.length - stride; i += stride) {
    const [lon, lat] = coords[i];
    const near = (list: [number, number][], weight: number) =>
      list.reduce((min, [x, y]) => Math.min(min, metres({ lat, lon }, { lat: y, lon: x }) * weight), Infinity);
    const score = Math.min(near(others, 1), near(placed, 0.5));
    if (score > bestScore) {
      bestScore = score;
      best = coords[i];
    }
  }
  return best;
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
    timeTags.push(new maplibregl.Marker({ element: tag }).setLngLat(tagPosition(i)).addTo(map));
  });
}

export function routeList(): HTMLOListElement {
  const list = el("ol", "routes");
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
  start.addEventListener("click", () => startGuide(index));
  sheet.replaceChildren(
    routeList(),
    ...routeWarnings(route),
    start,
    stepList(route),
    elevationDetail(route),
    alongDetail(route),
    accidentDetail(route),
    el("p", "note", "安全度は公開データから計算した目安で、その道の安全を保証するものではありません。"),
  );
  sheet.hidden = false;
  sheet.querySelector(".routes [aria-current]")?.scrollIntoView({ block: "nearest" });
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
  wrap.append(el("summary", "", `曲がる場所の案内 ${route.steps.length}か所`));
  const list = el("ol", "steps");
  for (const step of route.steps) {
    const li = el("li");
    const button = el("button");
    button.type = "button";
    button.append(el("span", "", step.text), el("span", "dist", formatMetres(step.metres)));
    button.addEventListener("click", () => map.flyTo({ center: step.at, zoom: 17, padding: mapPadding() }));
    li.append(button);
    list.append(li);
  }
  wrap.append(list);
  return wrap;
}


export function bindDirectionsUi(): void {
  const clearEnd = (which: End) => (value: string) => {
    if (!value && state[which]) {
      setEnd(which, null);
      clearRoutes();
    }
  };
  bindSuggest(fromInput, (p) => setEnd("from", p), { offerCurrent: true, onEdit: clearEnd("from") });
  bindSuggest(toInput, (p) => setEnd("to", p), { offerCurrent: true, onEdit: clearEnd("to") });
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
