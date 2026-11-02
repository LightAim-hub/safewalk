import maplibregl, {
  type ExpressionSpecification,
  type GeoJSONSource,
  type LngLatLike,
  type Map as MapLibre,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { Graph, metres, type LatLon } from "./graph";
import { AccidentIndex, findRoutes, minutesFor, type Accidents, type Meta, type Period, type Route } from "./routes";

type Place = LatLon & { name: string; kind?: string; ward?: string };
type PlaceRow = [string, number, number, string, string, string];
type IndexedPlace = Place & { kind: string; ward: string; n: string; y: string };
type End = "from" | "to";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const qInput = $<HTMLInputElement>("q");
const fromInput = $<HTMLInputElement>("from");
const toInput = $<HTMLInputElement>("to");
const searchbar = $<HTMLFormElement>("searchbar");
const directions = $<HTMLFormElement>("directions");
const sheet = $("sheet");
const toastEl = $("toast");

const KOBE_CENTER: [number, number] = [135.17, 34.7];
const MAX_SNAP_M = 500;
const COLORS = { good: "#188038", mid: "#b06000", bad: "#c5221f", route: "#1a73e8", other: "#9aa0a6" };
const CURRENT = "現在地";

const state = {
  mode: "browse" as "browse" | "directions",
  picked: null as Place | null,
  from: null as Place | null,
  to: null as Place | null,
  period: (new Date().getHours() >= 18 || new Date().getHours() < 6 ? "night" : "day") as Period,
  routes: [] as Route[],
  selected: 0,
};

let graph: Graph;
let accidents: AccidentIndex;
let meta: Meta;
let places: IndexedPlace[] = [];
let names: string[] = [];

const map: MapLibre = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/liberty",
  center: KOBE_CENTER,
  zoom: 11,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl(), "bottom-right");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

const markers = {
  picked: new maplibregl.Marker({ color: COLORS.bad }),
  from: new maplibregl.Marker({ color: COLORS.good }),
  to: new maplibregl.Marker({ color: COLORS.bad }),
  me: new maplibregl.Marker({ element: Object.assign(document.createElement("div"), { className: "me" }) }),
};

let toastTimer = 0;
function toast(text: string): void {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 3500);
}

function scoreColor(score: number): string {
  return score >= 70 ? COLORS.good : score >= 50 ? COLORS.mid : COLORS.bad;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

async function loadData(): Promise<void> {
  const [bin, acc, m, rows, roadNames] = await Promise.all([
    fetch("/data/graph.bin").then((r) => r.arrayBuffer()),
    fetch("/data/accidents.json").then((r) => r.json() as Promise<Accidents>),
    fetch("/data/graph.meta.json").then((r) => r.json() as Promise<Meta>),
    fetch("/data/places.json").then((r) => r.json() as Promise<PlaceRow[]>),
    fetch("/data/names.json").then((r) => r.json() as Promise<string[]>),
  ]);
  graph = new Graph(bin);
  accidents = new AccidentIndex(acc);
  meta = m;
  names = roadNames;
  places = rows.map(([raw, lat, lon, kind, reading, ward]) => {
    // OpenStreetMap の駅名は「灘」のように「駅」が付かないことがある。
    const name = kind === "駅" && !raw.endsWith("駅") ? `${raw}駅` : raw;
    return { name, lat, lon, kind, ward, n: normalize(name), y: normalize(reading) };
  });
}

/** 地図の文字を日本語だけにする。 */
function useJapaneseLabels(): void {
  const label: ExpressionSpecification = ["coalesce", ["get", "name:ja"], ["get", "name"]];
  for (const layer of map.getStyle().layers) {
    if (layer.type !== "symbol") continue;
    const field = map.getLayoutProperty(layer.id, "text-field");
    if (field !== undefined && JSON.stringify(field).includes("name")) {
      map.setLayoutProperty(layer.id, "text-field", label);
    }
  }
}

function addLayers(): void {
  useJapaneseLabels();
  map.addSource("kobe", { type: "geojson", data: "/data/kobe.geojson" });
  map.addSource("accidents", { type: "geojson", data: emptyCollection() });
  map.addSource("routes", { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "kobe-line",
    type: "line",
    source: "kobe",
    paint: { "line-color": "#5f6368", "line-width": 1.2, "line-opacity": 0.55, "line-dasharray": [3, 2] },
  });
  map.addLayer({
    id: "route-casing",
    type: "line",
    source: "routes",
    layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["case", ["get", "selected"], 1, 0] },
    paint: { "line-color": "#ffffff", "line-width": ["case", ["get", "selected"], 10, 7] },
  });
  map.addLayer({
    id: "route-line",
    type: "line",
    source: "routes",
    layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["case", ["get", "selected"], 1, 0] },
    paint: {
      "line-color": ["case", ["get", "selected"], COLORS.route, COLORS.other],
      "line-width": ["case", ["get", "selected"], 6, 4],
    },
  });
  map.addLayer({
    id: "accident-dots",
    type: "circle",
    source: "accidents",
    paint: {
      "circle-radius": ["case", [">", ["get", "dead"], 0], 7, 5],
      "circle-color": ["case", ["==", ["get", "ped"], 1], COLORS.bad, COLORS.mid],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.5,
    },
  });
  map.on("click", "route-line", (e) => {
    const index = e.features?.[0]?.properties?.index;
    if (typeof index === "number") selectRoute(index);
    e.preventDefault();
  });
  map.on("click", (e) => {
    if (e.defaultPrevented) return;
    const { x, y } = e.point;
    const labelled = map
      .queryRenderedFeatures([
        [x - 6, y - 6],
        [x + 6, y + 6],
      ])
      .find((f) => f.layer.type === "symbol" && f.properties.name);
    const name = labelled ? String(labelled.properties["name:ja"] ?? labelled.properties.name) : "地図で選んだ地点";
    onMapPick({ lat: e.lngLat.lat, lon: e.lngLat.lng, name }, labelled !== undefined);
  });
  map.on("mouseenter", "route-line", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "route-line", () => (map.getCanvas().style.cursor = ""));
}

function emptyCollection(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

/** 歩ける道の近くなら、その交差点の番号を返す。 */
function snap(p: LatLon): number | null {
  const node = graph.nearestNode(p);
  if (node === null) return null;
  const at = { lat: graph.nodeLat[node] / 1e6, lon: graph.nodeLon[node] / 1e6 };
  return metres(p, at) <= MAX_SNAP_M ? node : null;
}

const WARD_BY_CODE: Record<string, string> = {
  "28101": "東灘区",
  "28102": "灘区",
  "28105": "兵庫区",
  "28106": "長田区",
  "28107": "須磨区",
  "28108": "垂水区",
  "28109": "北区",
  "28110": "中央区",
  "28111": "西区",
};

/** 国土地理院の逆ジオコーダーで、地点の住所を引く。取れない時は null。 */
async function addressOf(p: LatLon): Promise<string | null> {
  const url = `https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${p.lat}&lon=${p.lon}`;
  try {
    const { results } = (await fetch(url).then((r) => r.json())) as { results?: { muniCd: string; lv01Nm: string } };
    const ward = results && WARD_BY_CODE[results.muniCd];
    if (!ward) return null;
    const town = results.lv01Nm && results.lv01Nm !== "－" ? results.lv01Nm : "";
    return `神戸市${ward}${town}`;
  } catch {
    return null;
  }
}

let popup: maplibregl.Popup | null = null;

/** 出発地と目的地が埋まっている時は、どちらに使うかを選んでもらう。 */
function askWhichEnd(place: Place): void {
  popup?.remove();
  const box = el("div", "popup-actions");
  for (const [end, label] of [
    ["from", "ここを出発地にする"],
    ["to", "ここを目的地にする"],
  ] as [End, string][]) {
    const button = el("button", "", label);
    button.type = "button";
    button.addEventListener("click", () => {
      popup?.remove();
      setEnd(end, place);
    });
    box.append(button);
  }
  popup = new maplibregl.Popup({ closeButton: false, maxWidth: "220px" })
    .setLngLat([place.lon, place.lat])
    .setDOMContent(box)
    .addTo(map);
}

async function onMapPick(place: Place, labelled: boolean): Promise<void> {
  if (snap(place) === null) {
    toast("この地点の近くに、神戸市内の歩ける道がありません。");
    return;
  }
  if (!labelled) place.name = (await addressOf(place)) ?? place.name;
  if (state.mode === "browse") {
    showPlace(place);
    pushUrl();
    return;
  }
  const empty: End | null = !state.from ? "from" : !state.to ? "to" : null;
  if (empty) setEnd(empty, place);
  else askWhichEnd(place);
}

/* ---- 検索 ---- */

/** 全角半角と大小を揃え、カタカナはひらがなに寄せて比べる。 */
const normalize = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const KIND_ORDER = ["駅", "地区", "名所", "商業施設", "百貨店", "公園", "大学", "病院", "役所", "博物館", "動物園"];

function searchPlaces(query: string): Place[] {
  const q = normalize(query);
  if (!q) return [];
  const rank = (name: string, kind: string) => {
    const k = KIND_ORDER.indexOf(kind);
    const match = name === q ? 0 : name.startsWith(q) ? 100 : 200;
    return match + (k < 0 ? 50 : k) + name.length / 100;
  };
  const sortKey = (p: IndexedPlace) => (p.n.startsWith(q) || !p.y.startsWith(q) ? p.n : p.y);
  const seen = new Set<string>();
  return places
    .filter((p) => p.n.includes(q) || p.y.includes(q))
    .sort((a, b) => rank(sortKey(a), a.kind) - rank(sortKey(b), b.kind))
    .filter((p) => {
      // 同じ駅が路線ごとに重なるのを1つにする。チェーン店は別の店なので残す。
      const key = `${p.name}:${p.kind}:${Math.round(p.lat * 200)}:${Math.round(p.lon * 200)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 7)
    .map(({ name, lat, lon, kind, ward }) => ({ name, lat, lon, kind, ward }));
}

/** 国土地理院の住所検索。神戸市内の住所だけを採る。 */
async function searchAddress(query: string): Promise<Place[]> {
  const url = `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(query)}`;
  try {
    const rows: { geometry: { coordinates: [number, number] }; properties: { title: string } }[] = await fetch(url).then(
      (r) => r.json(),
    );
    return rows
      .filter((r) => r.properties.title.includes("神戸市"))
      .slice(0, 4)
      .map((r) => ({
        name: r.properties.title,
        lat: r.geometry.coordinates[1],
        lon: r.geometry.coordinates[0],
        kind: "住所",
      }));
  } catch {
    return [];
  }
}

function locateMe(): Promise<Place | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      toast("この端末では現在地を取得できません。");
      return resolve(null);
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const place: Place = { lat: coords.latitude, lon: coords.longitude, name: CURRENT };
        if (snap(place) === null) {
          toast("現在地が神戸市の外のようです。");
          return resolve(null);
        }
        markers.me.setLngLat([place.lon, place.lat]).addTo(map);
        resolve(place);
      },
      () => {
        toast("現在地を取得できませんでした。位置情報の許可を確かめてください。");
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });
}

/** 入力欄に候補の一覧を付ける。Enter で候補を確定する。 */
function bindSuggest(
  input: HTMLInputElement,
  onPick: (p: Place) => void,
  offerCurrent = false,
  onEdit?: (value: string) => void,
): void {
  const field = input.parentElement as HTMLElement;
  const list = el("ul", "suggest");
  list.hidden = true;
  field.append(list);
  let items: Place[] = [];
  let active = -1;
  let token = 0;
  let timer = 0;

  const close = () => {
    token++;
    list.hidden = true;
    active = -1;
  };

  const choose = async (place: Place) => {
    close();
    if (place.name === CURRENT && place.lat === 0) {
      const me = await locateMe();
      if (me) onPick(me);
      return;
    }
    onPick(place);
  };

  const render = () => {
    list.replaceChildren(
      ...items.map((p, i) => {
        const li = el("li");
        const button = el("button");
        button.type = "button";
        button.setAttribute("aria-selected", String(i === active));
        button.append(el("span", "", p.name), el("span", "kind", [p.kind, p.ward].filter(Boolean).join("・")));
        button.addEventListener("mousedown", (e) => {
          e.preventDefault();
          choose(p);
        });
        li.append(button);
        return li;
      }),
    );
    if (!items.length && input.value.trim()) {
      list.replaceChildren(el("li", "empty", "神戸市内で見つかりません（SafeWalk は神戸市内のみ対応です）"));
      list.hidden = false;
      return;
    }
    list.hidden = items.length === 0;
  };

  const refresh = async () => {
    const mine = ++token;
    const value = input.value.trim();
    const local = searchPlaces(value);
    const head: Place[] = offerCurrent && !value ? [{ name: CURRENT, lat: 0, lon: 0, kind: "位置情報" }] : [];
    items = [...head, ...local];
    active = -1;
    render();
    if (value.length < 2) return;
    const addresses = await searchAddress(value);
    if (mine !== token) return;
    items = [...head, ...local, ...addresses].slice(0, 9);
    render();
  };

  input.addEventListener("input", () => {
    onEdit?.(input.value);
    clearTimeout(timer);
    timer = window.setTimeout(refresh, 120);
  });
  input.addEventListener("focus", () => {
    input.select();
    refresh();
  });
  input.addEventListener("blur", close);
  const submit = async () => {
    clearTimeout(timer);
    if (active < 0) await refresh();
    const pick = items[Math.max(active, 0)];
    if (pick) await choose(pick);
    else toast(`「${input.value.trim()}」を神戸市内で見つけられませんでした。`);
  };

  input.addEventListener("keydown", (e) => {
    // 日本語入力の変換を確定する Enter は、検索の確定にしない。
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") return close();
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (!items.length) return;
    active = (active + (e.key === "ArrowDown" ? 1 : items.length - 1 + (active < 0 ? 1 : 0))) % items.length;
    render();
  });
}

/* ---- 場所の表示 ---- */

function showPlace(place: Place): void {
  state.picked = place;
  qInput.value = place.name;
  markers.picked.setLngLat([place.lon, place.lat]).addTo(map);

  const wrap = el("div", "place");
  const facts = place.name.startsWith("神戸市")
    ? "地図で選んだ地点"
    : [place.kind, place.ward ? `神戸市${place.ward}` : "神戸市"].filter(Boolean).join("・");
  const go = el("button", "primary", "経路");
  go.type = "button";
  go.addEventListener("click", () => {
    openDirections({ to: place });
    pushUrl();
  });
  const start = el("button", "secondary", "ここから出発");
  start.type = "button";
  start.addEventListener("click", () => {
    openDirections({ from: place });
    pushUrl();
  });
  const actions = el("div", "actions");
  actions.append(go, start);
  wrap.append(el("h2", "", place.name), el("p", "", facts), actions);
  sheet.replaceChildren(wrap);
  sheet.hidden = false;
  map.flyTo({ center: [place.lon, place.lat], zoom: Math.max(map.getZoom(), 15), padding: mapPadding(), duration: 600 });
}

function mapPadding() {
  const narrow = window.innerWidth <= 720;
  return narrow
    ? { top: 150, bottom: window.innerHeight * 0.46, left: 30, right: 30 }
    : { top: 60, bottom: 60, left: 430, right: 60 };
}

/* ---- 経路 ---- */

function openDirections(ends: Partial<Record<End, Place>>): void {
  state.mode = "directions";
  document.body.classList.add("routing");
  searchbar.hidden = true;
  directions.hidden = false;
  sheet.hidden = true;
  markers.picked.remove();
  if (ends.from) setEnd("from", ends.from, false);
  if (ends.to) setEnd("to", ends.to, false);
  if (state.from && state.to) search();
  else (state.from ? toInput : fromInput).focus();
}

function closeDirections(): void {
  stopGuide();
  popup?.remove();
  state.mode = "browse";
  document.body.classList.remove("routing");
  state.from = state.to = null;
  fromInput.value = toInput.value = "";
  markers.from.remove();
  markers.to.remove();
  directions.hidden = true;
  searchbar.hidden = false;
  clearRoutes();
}

/** 表示中の経路を消す。経路を出せない時は、古い経路を残さず理由を出す。 */
function clearRoutes(message = ""): void {
  state.routes = [];
  timeTags.splice(0).forEach((tag) => tag.remove());
  (map.getSource("routes") as GeoJSONSource).setData(emptyCollection());
  (map.getSource("accidents") as GeoJSONSource).setData(emptyCollection());
  sheet.replaceChildren(el("p", "", message));
  sheet.hidden = !message;
}

function setEnd(which: End, place: Place | null, run = true): void {
  state[which] = place;
  const input = which === "from" ? fromInput : toInput;
  input.value = place?.name ?? "";
  if (place) markers[which].setLngLat([place.lon, place.lat]).addTo(map);
  else markers[which].remove();
  if (run && state.from && state.to) search();
}

function search(): void {
  const start = snap(state.from!);
  const goal = snap(state.to!);
  if (start === null || goal === null) return clearRoutes("出発地か目的地の近くに、神戸市内の歩ける道がありません。");
  if (start === goal) return clearRoutes("出発地と目的地が近すぎるため、経路を出せません。");
  state.routes = findRoutes(graph, start, goal, state.period, accidents, meta, names);
  if (!state.routes.length) return clearRoutes("歩いて行ける経路が見つかりませんでした。");
  for (const route of state.routes) connectEnds(route, state.from!, state.to!);
  replaceUrl();
  const best = state.routes.reduce((a, b, i, all) => (b.safety > all[a].safety ? i : a), 0);
  selectRoute(best);
  const all = state.routes.flatMap((r) => r.coords);
  const bounds = all.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(all[0], all[0]));
  map.fitBounds(bounds, { padding: mapPadding(), duration: 500 });
}

/** 交差点から実際の地点までの区間を、線と距離に足す。 */
function connectEnds(route: Route, from: LatLon, to: LatLon): void {
  const [startLon, startLat] = route.coords[0];
  const [endLon, endLat] = route.coords[route.coords.length - 1];
  route.metres += metres(from, { lat: startLat, lon: startLon }) + metres(to, { lat: endLat, lon: endLon });
  route.minutes = minutesFor(route.metres, route.climb);
  route.coords = [[from.lon, from.lat], ...route.coords, [to.lon, to.lat]];
}

function formatMinutes(min: number): string {
  return min < 60 ? `${min}分` : `${Math.floor(min / 60)}時間${min % 60 ? `${min % 60}分` : ""}`;
}

const timeTags: maplibregl.Marker[] = [];

/** 他の経路や札からいちばん離れた地点を、札の置き場所にする。 */
function tagPosition(index: number): [number, number] {
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
function drawTimeTags(): void {
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

function routeList(): HTMLOListElement {
  const list = el("ol", "routes");
  list.append(
    ...state.routes.map((route, i) => {
      const li = el("li");
      const button = el("button");
      button.type = "button";
      button.toggleAttribute("aria-current", i === state.selected);
      button.addEventListener("click", () => selectRoute(i));
      const safety = el("span", "safety", `${route.safety}%`);
      safety.style.color = scoreColor(route.safety);
      safety.append(el("small", "", "安全度の目安"));
      button.append(
        el("span", "time", formatMinutes(route.minutes)),
        safety,
        el("span", "facts", `${route.label}・${(route.metres / 1000).toFixed(1)}km・上り${route.climb}m`),
      );
      li.append(button);
      return li;
    }),
  );
  return list;
}

function selectRoute(index: number): void {
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
  showAccidents(route);
  drawTimeTags();
  const start = el("button", "primary start", "案内を始める");
  start.type = "button";
  start.addEventListener("click", () => startGuide(index));
  sheet.replaceChildren(
    routeList(),
    start,
    stepList(route),
    accidentDetail(route),
    el("p", "note", "安全度は公開データから計算した目安で、その道の安全を保証するものではありません。"),
  );
  sheet.hidden = false;
}

function formatMetres(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`;
}

function stepList(route: Route): HTMLElement {
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

/* ---- 歩きながらの案内 ---- */

const OFF_ROUTE_M = 60;
const STEP_REACHED_M = 20;
let watchId: number | null = null;
let rerouting = false;

function distanceToRoute(p: LatLon, route: Route): number {
  let best = Infinity;
  for (const [lon, lat] of route.coords) best = Math.min(best, metres(p, { lat, lon }));
  return best;
}

function remainingFrom(p: LatLon, route: Route): { next: Route["steps"][number] | null; metresLeft: number } {
  let nearest = 0;
  let bestD = Infinity;
  route.coords.forEach(([lon, lat], i) => {
    const d = metres(p, { lat, lon });
    if (d < bestD) {
      bestD = d;
      nearest = i;
    }
  });
  let metresLeft = 0;
  for (let i = nearest; i + 1 < route.coords.length; i++) {
    const [lon1, lat1] = route.coords[i];
    const [lon2, lat2] = route.coords[i + 1];
    metresLeft += metres({ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 });
  }
  const rest = route.steps.filter((step) => route.coords.findIndex(([x, y]) => x === step.at[0] && y === step.at[1]) > nearest);
  return { next: rest.find((s) => metres(p, { lat: s.at[1], lon: s.at[0] }) > STEP_REACHED_M) ?? null, metresLeft };
}

function updateGuide(p: LatLon): void {
  const route = state.routes[state.selected];
  if (!route) return;
  markers.me.setLngLat([p.lon, p.lat]).addTo(map);
  map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 17), duration: 500 });
  if (distanceToRoute(p, route) > OFF_ROUTE_M && !rerouting) {
    rerouting = true;
    toast("経路を外れたので、現在地から探し直します。");
    setEnd("from", { ...p, name: CURRENT });
    rerouting = false;
    return;
  }
  const end = route.coords[route.coords.length - 1];
  if (metres(p, { lat: end[1], lon: end[0] }) <= STEP_REACHED_M) {
    $("guide-next").textContent = "目的地に着きました";
    $("guide-rest").textContent = "";
    return;
  }
  const { next, metresLeft } = remainingFrom(p, route);
  $("guide-next").textContent = next
    ? `${formatMetres(metres(p, { lat: next.at[1], lon: next.at[0] }))}先、${next.text}`
    : "このまま目的地へ進む";
  $("guide-rest").textContent = `残り ${formatMetres(metresLeft)}・約${minutesFor(metresLeft, 0)}分`;
}

function startGuide(index: number): void {
  if (!navigator.geolocation) {
    toast("この端末では現在地を取得できません。");
    return;
  }
  selectRoute(index);
  document.body.classList.add("guiding");
  $("guide").hidden = false;
  $("guide-next").textContent = "現在地を確認しています…";
  $("guide-rest").textContent = "";
  watchId = navigator.geolocation.watchPosition(
    ({ coords }) => updateGuide({ lat: coords.latitude, lon: coords.longitude }),
    (error) => {
      // 立ち止まって更新が途切れただけでは案内を止めない。
      if (error.code !== error.PERMISSION_DENIED) return;
      toast("位置情報が許可されていないため、案内を終わります。");
      stopGuide();
    },
    { enableHighAccuracy: true, maximumAge: 2000 },
  );
}

function stopGuide(): void {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  document.body.classList.remove("guiding");
  $("guide").hidden = true;
}

function accidentLine(i: number): string {
  const a = accidents.data;
  const year = Math.floor(a.ym[i] / 100);
  const month = a.ym[i] % 100;
  const who = a.ped[i] ? "歩行者の事故" : a.bike[i] ? "自転車の事故" : "車両の事故";
  const harm = a.dead[i] ? `死者${a.dead[i]}人` : `負傷者${a.hurt[i]}人`;
  return `${year}年${month}月 ${a.hour[i]}時台 ${who}（${harm}）`;
}

function showAccidents(route: Route): void {
  const a = accidents.data;
  (map.getSource("accidents") as GeoJSONSource).setData({
    type: "FeatureCollection",
    features: route.accidents.map((i) => ({
      type: "Feature",
      properties: { ped: a.ped[i], dead: a.dead[i] },
      geometry: { type: "Point", coordinates: [a.lon[i], a.lat[i]] },
    })),
  });
}

function accidentDetail(route: Route): HTMLElement {
  const a = accidents.data;
  const list = route.accidents;
  const count = (test: (i: number) => boolean) => list.filter(test).length;
  const wrap = el("details", "detail");
  wrap.append(el("summary", "", `この経路の近くの事故 ${list.length}件`));
  wrap.append(
    el(
      "p",
      "",
      `経路から30m以内・2020〜2025年。歩行者の事故${count((i) => a.ped[i] === 1)}件、` +
        `夜の事故${count((i) => a.night[i] === 1)}件、死亡事故${count((i) => a.dead[i] > 0)}件。`,
    ),
  );
  const inPeriod = (i: number) => (a.night[i] === 1) === (state.period === "night");
  const severity = (i: number) => a.dead[i] * 100 + a.ped[i] * 10 + a.bike[i] * 2 + (inPeriod(i) ? 5 : 0);
  const items = el("ul");
  for (const i of [...list].sort((x, y) => severity(y) - severity(x)).slice(0, 5)) {
    const li = el("li");
    const button = el("button", "", accidentLine(i));
    button.type = "button";
    button.addEventListener("click", () => {
      const center: LngLatLike = [a.lon[i], a.lat[i]];
      map.flyTo({ center, zoom: 17, padding: mapPadding() });
    });
    li.append(button);
    items.append(li);
  }
  const share = el("button", "secondary", "この経路のリンクをコピー");
  share.type = "button";
  share.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      share.textContent = "コピーしました";
    } catch {
      toast("コピーできませんでした。アドレス欄のリンクをお使いください。");
    }
  });
  wrap.append(items, share);
  return wrap;
}

function urlForState(): string {
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
    q.set("period", state.period);
  } else if (state.mode === "directions") {
    q.set("mode", "directions");
  } else if (state.picked) {
    q.set("place", `${state.picked.lat.toFixed(5)},${state.picked.lon.toFixed(5)}`);
    q.set("name", state.picked.name);
  }
  const text = q.toString();
  return text ? `?${text}` : location.pathname;
}

function replaceUrl(): void {
  history.replaceState(null, "", urlForState());
}

/** 画面が変わった時に履歴を積み、ブラウザの「戻る」で前の画面へ戻れるようにする。 */
function pushUrl(): void {
  const url = urlForState();
  if (url !== location.search && url !== location.pathname + location.search) history.pushState(null, "", url);
}

function parsePoint(text: string | null): LatLon | null {
  const [lat, lon] = (text ?? "").split(",").map(Number);
  return text && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/** URL の内容を画面に映す。起動時と「戻る」「進む」の時に使う。 */
function applyUrl(): void {
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
  if (from && to) {
    openDirections({
      from: { ...from, name: q.get("fromName") || "共有された地点" },
      to: { ...to, name: q.get("toName") || "共有された地点" },
    });
  } else if (q.get("mode") === "directions") {
    openDirections({});
  } else if (place) {
    showPlace({ ...place, name: q.get("name") || "共有された地点" });
  }
  renderPeriod();
}

function renderPeriod(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-period]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.period === state.period));
  });
}

/* ---- 画面の操作 ---- */

bindSuggest(qInput, (p) => {
  showPlace(p);
  pushUrl();
});
const clearEnd = (which: End) => (value: string) => {
  if (!value && state[which]) {
    setEnd(which, null);
    clearRoutes();
  }
};
bindSuggest(fromInput, (p) => setEnd("from", p), true, clearEnd("from"));
bindSuggest(toInput, (p) => setEnd("to", p), true, clearEnd("to"));

for (const form of [searchbar, directions]) form.addEventListener("submit", (e) => e.preventDefault());

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
$("guide-stop").addEventListener("click", stopGuide);
window.addEventListener("popstate", applyUrl);
$("swap").addEventListener("click", () => {
  const { from, to } = state;
  setEnd("from", to, false);
  setEnd("to", from);
});
$("locate").addEventListener("click", async () => {
  const me = await locateMe();
  if (me) map.flyTo({ center: [me.lon, me.lat], zoom: 16, padding: mapPadding() });
});

document.querySelectorAll<HTMLButtonElement>("[data-period]").forEach((b) => {
  b.addEventListener("click", () => {
    state.period = b.dataset.period as Period;
    renderPeriod();
    if (state.from && state.to) search();
  });
});

// データが揃うまで操作を受けない。
const ui = document.querySelector<HTMLElement>(".ui")!;
const locateButton = $<HTMLButtonElement>("locate");
ui.inert = true;
locateButton.disabled = true;
renderPeriod();
Promise.all([loadData(), new Promise<void>((resolve) => map.on("load", () => resolve()))])
  .then(() => {
    addLayers();
    ui.inert = false;
    locateButton.disabled = false;
    applyUrl();
  })
  .catch((err) => {
    console.error(err);
    toast("データの読み込みに失敗しました。再読み込みしてください。");
  });
