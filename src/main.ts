import maplibregl, {
  type ExpressionSpecification,
  type GeoJSONSource,
  type LngLatLike,
  type Map as MapLibre,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { Graph, metres, type LatLon } from "./graph";
import { AccidentIndex, WALK_M_PER_MIN, findRoutes, type Accidents, type Meta, type Period, type Route } from "./routes";

type Place = LatLon & { name: string; kind?: string };
type PlaceRow = [string, number, number, string, string];
type IndexedPlace = Place & { kind: string; n: string; y: string };
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

const map: MapLibre = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/liberty",
  center: KOBE_CENTER,
  zoom: 11,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

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
  const [bin, acc, m, rows] = await Promise.all([
    fetch("/data/graph.bin").then((r) => r.arrayBuffer()),
    fetch("/data/accidents.json").then((r) => r.json() as Promise<Accidents>),
    fetch("/data/graph.meta.json").then((r) => r.json() as Promise<Meta>),
    fetch("/data/places.json").then((r) => r.json() as Promise<PlaceRow[]>),
  ]);
  graph = new Graph(bin);
  accidents = new AccidentIndex(acc);
  meta = m;
  places = rows.map(([raw, lat, lon, kind, reading]) => {
    // OpenStreetMap の駅名は「灘」のように「駅」が付かないことがある。
    const name = kind === "駅" && !raw.endsWith("駅") ? `${raw}駅` : raw;
    return { name, lat, lon, kind, n: normalize(name), y: normalize(reading) };
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
    onMapPick({ lat: e.lngLat.lat, lon: e.lngLat.lng, name });
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

function onMapPick(place: Place): void {
  if (snap(place) === null) {
    toast("この地点の近くに、神戸市内の歩ける道がありません。");
    return;
  }
  if (state.mode === "browse") return showPlace(place);
  const empty: End | null = !state.from ? "from" : !state.to ? "to" : null;
  if (empty) setEnd(empty, place);
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
      const key = `${p.name}:${p.kind}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 7)
    .map(({ name, lat, lon, kind }) => ({ name, lat, lon, kind }));
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
function bindSuggest(input: HTMLInputElement, onPick: (p: Place) => void, offerCurrent = false): void {
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
        button.append(el("span", "", p.name), el("span", "kind", p.kind ?? ""));
        button.addEventListener("mousedown", (e) => {
          e.preventDefault();
          choose(p);
        });
        li.append(button);
        return li;
      }),
    );
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
  qInput.value = place.name === "地図で選んだ地点" ? "" : place.name;
  markers.picked.setLngLat([place.lon, place.lat]).addTo(map);

  const wrap = el("div", "place");
  const facts = place.kind ? `${place.kind}・神戸市` : "神戸市";
  const go = el("button", "primary", "経路");
  go.type = "button";
  go.addEventListener("click", () => openDirections({ to: place }));
  const start = el("button", "secondary", "ここから出発");
  start.type = "button";
  start.addEventListener("click", () => openDirections({ from: place }));
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
  (map.getSource("routes") as GeoJSONSource).setData(emptyCollection());
  (map.getSource("accidents") as GeoJSONSource).setData(emptyCollection());
  history.replaceState(null, "", location.pathname);
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
  state.routes = findRoutes(graph, start, goal, state.period, accidents, meta);
  if (!state.routes.length) return clearRoutes("歩いて行ける経路が見つかりませんでした。");
  for (const route of state.routes) connectEnds(route, state.from!, state.to!);
  writeUrl();
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
  route.minutes = Math.ceil(route.metres / WALK_M_PER_MIN);
  route.coords = [[from.lon, from.lat], ...route.coords, [to.lon, to.lat]];
}

function formatMinutes(min: number): string {
  return min < 60 ? `${min}分` : `${Math.floor(min / 60)}時間${min % 60 ? `${min % 60}分` : ""}`;
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
        el("span", "facts", `${route.label}・${(route.metres / 1000).toFixed(1)}km`),
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
  sheet.replaceChildren(
    routeList(),
    accidentDetail(route),
    el("p", "note", "安全度は公開データから計算した目安で、その道の安全を保証するものではありません。"),
  );
  sheet.hidden = false;
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

function writeUrl(): void {
  // 共有リンクに現在地の正確な座標を載せない。
  const coords = (p: Place) => {
    const digits = p.name === CURRENT ? 3 : 5;
    return `${p.lat.toFixed(digits)},${p.lon.toFixed(digits)}`;
  };
  const label = (p: Place) => (p.name === CURRENT ? "現在地の付近" : p.name);
  const q = new URLSearchParams({
    from: coords(state.from!),
    to: coords(state.to!),
    fromName: label(state.from!),
    toName: label(state.to!),
    period: state.period,
  });
  history.replaceState(null, "", `?${q}`);
}

function readUrl(): boolean {
  const q = new URLSearchParams(location.search);
  const parse = (key: string, name: string): Place | null => {
    const [lat, lon] = (q.get(key) ?? "").split(",").map(Number);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon, name: q.get(name) || "共有された地点" } : null;
  };
  const from = parse("from", "fromName");
  const to = parse("to", "toName");
  const period = q.get("period");
  if (period === "day" || period === "night") state.period = period;
  if (!from || !to) return false;
  openDirections({ from, to });
  return true;
}

function renderPeriod(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-period]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.period === state.period));
  });
}

/* ---- 画面の操作 ---- */

bindSuggest(qInput, showPlace);
bindSuggest(fromInput, (p) => setEnd("from", p), true);
bindSuggest(toInput, (p) => setEnd("to", p), true);

for (const form of [searchbar, directions]) form.addEventListener("submit", (e) => e.preventDefault());

$("open-directions").addEventListener("click", () => openDirections(state.picked ? { to: state.picked } : {}));
$("close-directions").addEventListener("click", closeDirections);
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
    readUrl();
    renderPeriod();
  })
  .catch((err) => {
    console.error(err);
    toast("データの読み込みに失敗しました。再読み込みしてください。");
  });
