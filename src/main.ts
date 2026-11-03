import maplibregl, {
  type ExpressionSpecification,
  type GeoJSONSource,
  type LngLatLike,
  type Map as MapLibre,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { Graph, metres, type Anchor, type LatLon } from "./graph";
import {
  AccidentIndex,
  findRoutes,
  joinRoutes,
  minutesFor,
  type Accidents,
  type Meta,
  type Period,
  type Route,
} from "./routes";

type PlaceInfo = { hours?: string; phone?: string; web?: string; address?: string; operator?: string };
type Place = LatLon & PlaceInfo & { name: string; kind?: string; ward?: string; genre?: Genre };
type PlaceRow = [string, number, number, string, string, string, string, string, string, string, string];
type IndexedPlace = Place & { kind: string; ward: string; n: string; y: string };
type Genre = { label: string; kinds: string[] };
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
const GENRES: Genre[] = [
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
const GENRE_LIMIT = 30;

const state = {
  mode: "browse" as "browse" | "directions",
  picked: null as Place | null,
  from: null as Place | null,
  to: null as Place | null,
  /** 経由地。入力中の欄は null */
  stops: [] as (Place | null)[],
  period: (new Date().getHours() >= 18 || new Date().getHours() < 6 ? "night" : "day") as Period,
  routes: [] as Route[],
  selected: 0,
  genre: null as Genre | null,
};

let graph: Graph;
let accidents: AccidentIndex;
let meta: Meta;
let places: IndexedPlace[] = [];
let names: string[] = [];
let kobeRings: [number, number][][] = [];

const map: MapLibre = new maplibregl.Map({
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

const markers = {
  picked: new maplibregl.Marker({ color: COLORS.bad }),
  from: new maplibregl.Marker({ color: COLORS.good }),
  to: new maplibregl.Marker({ color: COLORS.bad }),
  me: new maplibregl.Marker({ element: meElement() }),
};
const stopMarkers: maplibregl.Marker[] = [];

function meElement(): HTMLElement {
  const dot = document.createElement("div");
  dot.className = "me";
  dot.append(Object.assign(document.createElement("i"), { className: "cone" }));
  return dot;
}

let toastTimer = 0;
function toast(text: string): void {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 3500);
}

function scoreColor(score: number | null): string {
  if (score === null) return COLORS.other;
  return score >= 70 ? COLORS.good : score >= 50 ? COLORS.mid : COLORS.bad;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

async function loadData(): Promise<void> {
  const [bin, acc, m, rows, roadNames, kobe] = await Promise.all([
    fetch("/data/graph.bin").then((r) => r.arrayBuffer()),
    fetch("/data/accidents.json").then((r) => r.json() as Promise<Accidents>),
    fetch("/data/graph.meta.json").then((r) => r.json() as Promise<Meta>),
    fetch("/data/places.json").then((r) => r.json() as Promise<PlaceRow[]>),
    fetch("/data/names.json").then((r) => r.json() as Promise<string[]>),
    fetch("/data/kobe.geojson").then((r) => r.json() as Promise<GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>>),
  ]);
  const shape = kobe.geometry;
  kobeRings = (shape.type === "Polygon" ? [shape.coordinates] : shape.coordinates).flat() as [number, number][][];
  graph = new Graph(bin);
  accidents = new AccidentIndex(acc);
  meta = m;
  names = roadNames;
  places = rows.map(([raw, lat, lon, kind, reading, ward, hours, phone, web, address, operator]) => {
    // OpenStreetMap の駅名は「灘」のように「駅」が付かないことがある。
    const name = kind === "駅" && !raw.endsWith("駅") ? `${raw}駅` : raw;
    return { name, lat, lon, kind, ward, hours, phone, web, address, operator, n: normalize(name), y: normalize(reading) };
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
  addBaseLayers();
  map.addSource("kobe", { type: "geojson", data: "/data/kobe.geojson" });
  map.addSource("results", { type: "geojson", data: emptyCollection() });
  map.addSource("accuracy", { type: "geojson", data: emptyCollection() });
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
  map.addLayer({
    id: "accuracy-fill",
    type: "fill",
    source: "accuracy",
    paint: { "fill-color": COLORS.route, "fill-opacity": 0.12 },
  });
  map.addLayer({
    id: "result-dots",
    type: "circle",
    source: "results",
    paint: { "circle-radius": 7, "circle-color": COLORS.bad, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 },
  });
  map.addLayer({
    id: "result-names",
    type: "symbol",
    source: "results",
    layout: {
      "text-field": ["get", "name"],
      "text-size": 12,
      "text-offset": [0, 1],
      "text-anchor": "top",
      "text-font": ["Noto Sans Regular"],
      "text-optional": true,
    },
    paint: { "text-color": COLORS.bad, "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
  });
  map.on("click", "result-dots", (e) => {
    const index = e.features?.[0]?.properties?.index;
    if (typeof index === "number") {
      if (state.mode === "directions") addStop(lastResults[index]);
      else {
        showPlace(lastResults[index]);
        pushUrl();
      }
    }
    e.preventDefault();
  });
  map.on("click", "route-line", (e) => {
    const index = e.features?.[0]?.properties?.index;
    if (typeof index === "number") selectRoute(index);
    e.preventDefault();
  });
  map.on("click", (e) => {
    if (e.defaultPrevented || longPressed) {
      longPressed = false;
      return;
    }
    const { x, y } = e.point;
    const labelled = map
      .queryRenderedFeatures([
        [x - 6, y - 6],
        [x + 6, y + 6],
      ])
      .find((f) => f.layer.type === "symbol" && f.properties.name);
    if (!labelled && TOUCH && state.mode === "browse") return closePlace();
    const name = labelled ? String(labelled.properties["name:ja"] ?? labelled.properties.name) : "地図で選んだ地点";
    const at = { lat: e.lngLat.lat, lon: e.lngLat.lng };
    onMapPick(labelled ? (matchPlace(name, at) ?? { ...at, name }) : { ...at, name }, labelled !== undefined);
  });
  bindLongPress();
  for (const layer of ["route-line", "result-dots"]) {
    map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
  }
  map.on("moveend", (e) => {
    if (state.genre && (e as { originalEvent?: Event }).originalEvent) $("research").hidden = false;
  });
}

/** 指が主な操作の端末では、何もない所の短いタップで地点を選ばない。 */
const TOUCH = window.matchMedia("(pointer: coarse)").matches;
const LONG_PRESS_MS = 550;
/** 長押しの後に来る click で、開いた場所を閉じないようにする。 */
let longPressed = false;

/** 長押しで地点を選ぶ。指が動いたら地図の移動として扱う。 */
function bindLongPress(): void {
  let timer = 0;
  const cancel = () => clearTimeout(timer);
  map.on("touchstart", (e) => {
    cancel();
    longPressed = false;
    if (e.originalEvent.touches.length !== 1) return;
    timer = window.setTimeout(() => {
      longPressed = true;
      onMapPick({ lat: e.lngLat.lat, lon: e.lngLat.lng, name: "地図で選んだ地点" }, false);
    }, LONG_PRESS_MS);
  });
  map.on("touchend", cancel);
  map.on("touchcancel", cancel);
  map.on("touchmove", cancel);
  map.on("movestart", cancel);
}

/** 地図の文字の名前から、詳しい情報を持つ場所を探す。 */
function matchPlace(name: string, at: LatLon): Place | null {
  const near = places.filter((p) => p.name === name && metres(p, at) <= 200);
  near.sort((a, b) => metres(a, at) - metres(b, at));
  return near[0] ?? null;
}

const LAYERS = {
  photo: { label: "航空写真", url: "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg", maxzoom: 18, opacity: 1 },
  relief: { label: "地形", url: "https://cyberjapandata.gsi.go.jp/xyz/hillshademap/{z}/{x}/{y}.png", maxzoom: 16, opacity: 0.55 },
};
type BaseLayer = keyof typeof LAYERS;

/** 航空写真と地形を地図の文字の下に入れ、切り替えられるようにする。 */
function addBaseLayers(): void {
  const firstSymbol = map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
  for (const [id, layer] of Object.entries(LAYERS)) {
    map.addSource(id, {
      type: "raster",
      tiles: [layer.url],
      tileSize: 256,
      maxzoom: layer.maxzoom,
      attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noreferrer">国土地理院</a>',
    });
    map.addLayer(
      { id, type: "raster", source: id, layout: { visibility: "none" }, paint: { "raster-opacity": layer.opacity } },
      firstSymbol,
    );
  }
}

function setBaseLayer(choice: BaseLayer | "map"): void {
  for (const id of Object.keys(LAYERS)) map.setLayoutProperty(id, "visibility", id === choice ? "visible" : "none");
  document.querySelectorAll<HTMLButtonElement>("[data-layer]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.layer === choice));
  });
}

/** 現在地の誤差を円で表す。 */
function showAccuracy(p: LatLon, radiusM: number): void {
  const steps = 48;
  const k = Math.cos((p.lat * Math.PI) / 180);
  const ring = Array.from({ length: steps + 1 }, (_, i) => {
    const a = (i / steps) * 2 * Math.PI;
    return [p.lon + ((radiusM / 111320) * Math.cos(a)) / k, p.lat + (radiusM / 110940) * Math.sin(a)];
  });
  (map.getSource("accuracy") as GeoJSONSource).setData({
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [ring] },
  });
}

function emptyCollection(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function inKobe(p: LatLon): boolean {
  let inside = false;
  for (const ring of kobeRings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[j];
      if (y1 > p.lat !== y2 > p.lat && p.lon < ((x2 - x1) * (p.lat - y1)) / (y2 - y1) + x1) inside = !inside;
    }
  }
  return inside;
}

/** 神戸市内で歩ける道の近くなら、道の上の点を返す。 */
function snap(p: LatLon): Anchor | null {
  if (!inKobe(p)) return null;
  const road = graph.nearestRoad(p);
  return road && road.metres <= MAX_SNAP_M ? road : null;
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
    .slice(0, 7);
}

/** 「コンビニ」のような言葉から、ジャンルを探す。 */
function matchGenres(query: string): Genre[] {
  const q = normalize(query);
  return q ? GENRES.filter((g) => normalize(g.label).startsWith(q)) : [];
}

const RECENT_KEY = "safewalk.recent";
const RECENT_LIMIT = 6;

function recentPlaces(): Place[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as Place[];
  } catch {
    return [];
  }
}

function remember(place: Place): void {
  if (place.name === CURRENT) return;
  const rest = recentPlaces().filter((p) => p.name !== place.name);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([place, ...rest].slice(0, RECENT_LIMIT)));
  } catch {
    // 履歴を残せない環境でも、検索はそのまま使える。
  }
}

let lastResults: Place[] = [];

function placeRows(rows: Place[], from: LatLon, onPick: (p: Place) => void): HTMLOListElement {
  const list = el("ol", "results");
  list.append(
    ...rows.map((place) => {
      const li = el("li");
      const button = el("button");
      button.type = "button";
      const open = openState(place);
      button.append(
        el("span", "name", place.name),
        el("span", "facts", [place.kind, formatMetres(metres(place, from)), open].filter(Boolean).join("・")),
      );
      button.addEventListener("click", () => onPick(place));
      li.append(button);
      return li;
    }),
  );
  return list;
}

function showResultDots(rows: Place[]): void {
  lastResults = rows;
  (map.getSource("results") as GeoJSONSource).setData({
    type: "FeatureCollection",
    features: rows.map((place, index) => ({
      type: "Feature",
      properties: { index, name: place.name },
      geometry: { type: "Point", coordinates: [place.lon, place.lat] },
    })),
  });
}

/** 今見ている範囲のジャンルの場所を、中心から近い順に出す。 */
function searchGenre(genre: Genre): void {
  state.genre = genre;
  state.picked = null;
  markers.picked.remove();
  qInput.value = genre.label;
  renderChips();
  $("research").hidden = true;
  const view = map.getBounds();
  const center = map.getCenter();
  const from = { lat: center.lat, lon: center.lng };
  const ofGenre = places.filter((p) => genre.kinds.includes(p.kind));
  const inView = ofGenre.filter((p) => view.contains([p.lon, p.lat]));
  const rows = (inView.length ? inView : ofGenre)
    .slice()
    .sort((a, b) => metres(a, from) - metres(b, from))
    .slice(0, GENRE_LIMIT);
  showResultDots(rows);
  const wrap = el("div");
  wrap.append(el("h2", "sheet-title", inView.length ? `この範囲の${genre.label}` : `近くの${genre.label}（この範囲にはありません）`));
  wrap.append(
    rows.length
      ? placeRows(rows, from, (place) => {
          showPlace(place);
          pushUrl();
        })
      : el("p", "", `${genre.label}の記録がありません。`),
  );
  sheet.replaceChildren(wrap);
  sheet.hidden = false;
  // 市全体を見ている時や範囲内に無い時は、結果が見える所まで寄る。
  if (rows.length && (!inView.length || map.getZoom() < 13)) {
    const all = rows.slice(0, 12).map((p): [number, number] => [p.lon, p.lat]);
    map.fitBounds(
      all.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(all[0], all[0])),
      { padding: mapPadding(), maxZoom: 16, duration: 500 },
    );
  }
}

function clearGenre(): void {
  state.genre = null;
  showResultDots([]);
  $("research").hidden = true;
  renderChips();
}

function renderChips(): void {
  $("chips").replaceChildren(
    ...GENRES.map((genre) => {
      const chip = el("button", "chip", genre.label);
      chip.type = "button";
      chip.setAttribute("aria-pressed", String(state.genre === genre));
      chip.addEventListener("click", () => searchGenre(genre));
      return chip;
    }),
  );
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
        showAccuracy(place, coords.accuracy);
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
  { offerCurrent = false, offerGenres = false, onEdit }: {
    offerCurrent?: boolean;
    offerGenres?: boolean;
    onEdit?: (value: string) => void;
  } = {},
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
    if (place.genre) return searchGenre(place.genre);
    remember({ ...place, genre: undefined });
    onPick(place);
  };

  const render = () => {
    list.replaceChildren(
      ...items.map((p, i) => {
        const li = el("li");
        const button = el("button");
        button.type = "button";
        button.setAttribute("aria-selected", String(i === active));
        const hint = [p.kind, p.operator, p.ward].filter(Boolean).join("・");
        button.append(el("span", "", p.name), el("span", "kind", hint));
        button.addEventListener("mousedown", (e) => {
          e.preventDefault();
          choose(p);
        });
        li.append(button);
        return li;
      }),
    );
    if (!items.length && input.value.trim()) {
      list.replaceChildren(el("li", "empty", "神戸市内で見つかりません（SafeWalk の検索は神戸市内のみです）"));
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
    if (!value) head.push(...recentPlaces().map((p) => ({ ...p, kind: "最近" })));
    if (offerGenres) {
      head.push(...matchGenres(value).map((genre) => ({ name: `${genre.label}を探す`, lat: 0, lon: 0, kind: "ジャンル", genre })));
    }
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

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

const MINUTES_PER_DAY = 1440;

/** 「Mo-Fr 09:00-18:00」形式の営業時間から、今開いているかを求める。読めない時は null。 */
function isOpen(hours: string, now = new Date()): boolean | null {
  if (/^24\/7$/.test(hours.trim())) return true;
  const rules: { days: string | undefined; spans: [number, number][] }[] = [];
  for (const rule of hours.split(";").map((r) => r.trim()).filter(Boolean)) {
    const m = rule.match(/^(?:((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:[-,](?:Mo|Tu|We|Th|Fr|Sa|Su))*)\s+)?(off|closed|\d{1,2}:\d{2}-\d{1,2}:\d{2}(?:,\d{1,2}:\d{2}-\d{1,2}:\d{2})*)$/);
    if (!m) return null;
    const spans = m[2] === "off" || m[2] === "closed" ? [] : m[2].split(",").map(parseSpan);
    rules.push({ days: m[1], spans });
  }
  // 同じ曜日に複数の決まりがある時は、後のものが優先される。
  const spansOn = (day: number) =>
    rules.filter((r) => !r.days || r.days.split(",").some((part) => dayInRange(part, day))).at(-1)?.spans ?? [];
  const clock = now.getHours() * 60 + now.getMinutes();
  const today = now.getDay();
  const yesterday = (today + 6) % 7;
  return (
    spansOn(today).some(([a, b]) => clock >= a && clock < b) ||
    spansOn(yesterday).some(([a, b]) => clock + MINUTES_PER_DAY >= a && clock + MINUTES_PER_DAY < b)
  );
}

/** 「22:00-02:00」のように日をまたぐ時間は、終わりを翌日の分で表す。 */
function parseSpan(span: string): [number, number] {
  const [a, b] = span.split("-").map((t) => {
    const [h, min] = t.split(":").map(Number);
    return h * 60 + min;
  });
  return [a, b > a ? b : b + MINUTES_PER_DAY];
}

function dayInRange(part: string, day: number): boolean {
  const [a, b] = part.split("-").map((d) => DAYS.indexOf(d));
  if (b === undefined) return a === day;
  return a <= b ? day >= a && day <= b : day >= a || day <= b;
}

function openState(place: Place): string {
  if (!place.hours) return "";
  const open = isOpen(place.hours);
  return open === null ? "" : open ? "営業中（記録上）" : "営業時間外（記録上）";
}

function japaneseHours(hours: string): string {
  const names: Record<string, string> = { Mo: "月", Tu: "火", We: "水", Th: "木", Fr: "金", Sa: "土", Su: "日", PH: "祝" };
  return hours
    .replace("24/7", "24時間営業")
    .replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH)\b/g, (d) => names[d])
    .replace(/\boff\b/g, "休み");
}

function infoRow(label: string, value: Node | string): HTMLElement {
  const row = el("div", "info");
  const body = el("span");
  body.append(value);
  row.append(el("span", "label", label), body);
  return row;
}

function closePlace(): void {
  if (!state.picked && !state.genre) return;
  state.picked = null;
  markers.picked.remove();
  qInput.value = "";
  sheet.hidden = true;
  clearGenre();
  pushUrl();
}

function externalLink(url: string): HTMLAnchorElement | null {
  if (!/^https?:\/\//.test(url)) return null;
  const link = el("a", "", url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""));
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function showPlace(place: Place): void {
  state.picked = place;
  qInput.value = place.name;
  markers.picked.setLngLat([place.lon, place.lat]).addTo(map);

  const wrap = el("div", "place");
  const facts = place.name.startsWith("神戸市")
    ? "地図で選んだ地点"
    : [place.kind, place.operator, place.ward ? `神戸市${place.ward}` : "神戸市"].filter(Boolean).join("・");
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
  const share = el("button", "secondary", "共有");
  share.type = "button";
  share.addEventListener("click", () => copyLink(share));
  const actions = el("div", "actions");
  actions.append(go, start, share);
  const address = infoRow("住所", place.address || "確認しています…");
  const info = el("div", "infos");
  info.append(address);
  if (!place.address) {
    addressOf(place).then((text) => {
      address.lastElementChild!.textContent = text ?? "記録がありません";
    });
  }
  if (place.hours) {
    const now = openState(place);
    info.append(infoRow("営業時間", [now, japaneseHours(place.hours)].filter(Boolean).join(" ")));
  }
  if (place.phone) {
    const call = el("a", "", place.phone);
    call.href = `tel:${place.phone.replace(/[^0-9+]/g, "")}`;
    info.append(infoRow("電話", call));
  }
  const web = place.web ? externalLink(place.web) : null;
  if (web) info.append(infoRow("サイト", web));
  const nearby = el("div", "chips inline");
  nearby.append(
    ...GENRES.slice(0, 6).map((genre) => {
      const chip = el("button", "chip", genre.label);
      chip.type = "button";
      chip.addEventListener("click", () => {
        map.jumpTo({ center: [place.lon, place.lat], zoom: Math.max(map.getZoom(), 16), padding: mapPadding() });
        searchGenre(genre);
      });
      return chip;
    }),
  );
  wrap.append(el("h2", "", place.name), el("p", "", facts), actions, info, el("p", "sub-title", "付近を検索"), nearby);
  if (place.hours || place.phone || place.web) wrap.append(el("p", "note", "営業時間などは OpenStreetMap の記録で、最新とは限りません。"));
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
  clearGenre();
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

const MAX_STOPS = 3;

/** 経由地の入力欄と印を作り直す。 */
function drawStopMarkers(): void {
  stopMarkers.splice(0).forEach((marker) => marker.remove());
  for (const stop of state.stops) {
    if (stop) stopMarkers.push(new maplibregl.Marker({ color: COLORS.mid }).setLngLat([stop.lon, stop.lat]).addTo(map));
  }
}

function renderStops(): void {
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

function addStop(place: Place): void {
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

function searchThrough(): Route | null {
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

function safestIndex(routes: Route[]): number {
  return routes.reduce((a, b, i, all) => ((b.safety ?? -1) > (all[a].safety ?? -1) ? i : a), 0);
}

function search(): void {
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

function showRoutes(): void {
  for (const route of state.routes) connectEnds(route, state.from!, state.to!);
  replaceUrl();
  // 昼は Google マップと同じく最短を選び、夜は最も安全な経路を選ぶ。
  selectRoute(state.period === "night" ? safestIndex(state.routes) : 0);
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

const FLAT_M = 10;

/** 出発地からの高さの変化を線で描く。 */
function elevationDetail(route: Route): HTMLElement {
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

const ALONG_M = 100;
const ALONG_LIMIT = 12;

/** 経路の近くにある場所を、出発地に近い順に探す。 */
function placesAlong(route: Route, genre: Genre): { place: Place; order: number }[] {
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

function alongDetail(route: Route): HTMLElement {
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
const LONG_WALK_M = 8000;
const BIG_CLIMB_M = 300;
const NOTE_REMOTE_M = 500;

function routeWarnings(route: Route): HTMLElement[] {
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
const ANNOUNCE_M = 40;
/** 次に歩く座標を探す範囲。GPS の跳びで先へ進み過ぎないようにする。 */
const GUIDE_WINDOW = 400;
let guideProgress = 0;
let watchId: number | null = null;
let rerouting = false;
let voiceOn = true;
let announced = "";
let wakeLock: WakeLockSentinel | null = null;

function speak(text: string): void {
  if (!voiceOn || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const line = new SpeechSynthesisUtterance(text);
  line.lang = "ja-JP";
  speechSynthesis.speak(line);
}

/** 案内中は画面が消えないようにする。対応しない端末ではそのまま続ける。 */
async function keepScreenOn(): Promise<void> {
  try {
    wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
    if (watchId === null) {
      wakeLock?.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}

function setHeading(deg: number): void {
  const me = markers.me.getElement();
  me.style.setProperty("--heading", `${deg}deg`);
  me.classList.add("facing");
}

type CompassEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };

function onCompass(e: CompassEvent): void {
  const deg = e.webkitCompassHeading ?? (e.absolute && e.alpha !== null ? 360 - e.alpha : null);
  if (deg !== null) setHeading(deg);
}

/** iPhone は方位の利用に許可が要る。許可を求められるのは操作の直後だけ。 */
function watchCompass(): void {
  const asking = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
  const start = () => {
    if (watchId === null) return;
    window.addEventListener("deviceorientationabsolute", onCompass as EventListener);
    window.addEventListener("deviceorientation", onCompass as EventListener);
  };
  if (asking.requestPermission) asking.requestPermission().then((answer) => answer === "granted" && start(), () => undefined);
  else start();
}

function stopCompass(): void {
  window.removeEventListener("deviceorientationabsolute", onCompass as EventListener);
  window.removeEventListener("deviceorientation", onCompass as EventListener);
  markers.me.getElement().classList.remove("facing");
}

/** 線分までの距離。長い直線の途中で経路外と誤判定しないよう、頂点だけで測らない。 */
function distanceToSegment(p: LatLon, a: [number, number], b: [number, number]): number {
  const k = Math.cos((p.lat * Math.PI) / 180);
  const dx = (b[0] - a[0]) * k;
  const dy = b[1] - a[1];
  const size = dx * dx + dy * dy;
  const t = size ? Math.max(0, Math.min(1, (((p.lon - a[0]) * k) * dx + (p.lat - a[1]) * dy) / size)) : 0;
  return metres(p, { lat: a[1] + (b[1] - a[1]) * t, lon: a[0] + (b[0] - a[0]) * t });
}

function distanceToRoute(p: LatLon, route: Route): number {
  let best = Infinity;
  for (let i = 0; i + 1 < route.coords.length; i++) best = Math.min(best, distanceToSegment(p, route.coords[i], route.coords[i + 1]));
  return best;
}

/** 経路の座標のうち、from より先で地点にいちばん近い番号。 */
function nearestIndex(p: LatLon, route: Route, from = 0, limit = route.coords.length): number {
  let nearest = from;
  let best = Infinity;
  const end = Math.min(route.coords.length, from + limit);
  for (let i = from; i < end; i++) {
    const [lon, lat] = route.coords[i];
    const d = metres(p, { lat, lon });
    if (d < best) {
      best = d;
      nearest = i;
    }
  }
  return nearest;
}

/** 案内の手順が、経路の座標の何番目にあるか。同じ道を往復しても順に求める。 */
function stepIndexes(route: Route): number[] {
  let at = 0;
  return route.steps.map((step) => {
    while (at < route.coords.length && (route.coords[at][0] !== step.at[0] || route.coords[at][1] !== step.at[1])) at++;
    return at;
  });
}

function remainingFrom(p: LatLon, route: Route): { next: Route["steps"][number] | null; metresLeft: number } {
  // 往復する経路で帰りを行きと取り違えないよう、進んだ所より先だけを見る。
  const nearest = nearestIndex(p, route, guideProgress, GUIDE_WINDOW);
  guideProgress = nearest;
  let metresLeft = 0;
  for (let i = nearest; i + 1 < route.coords.length; i++) {
    const [lon1, lat1] = route.coords[i];
    const [lon2, lat2] = route.coords[i + 1];
    metresLeft += metres({ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 });
  }
  const indexes = stepIndexes(route);
  const rest = route.steps.filter((_, i) => indexes[i] > nearest);
  return { next: rest.find((s) => metres(p, { lat: s.at[1], lon: s.at[0] }) > STEP_REACHED_M) ?? null, metresLeft };
}

/** 現在地から探し直す。探せない時は元の経路を残し、戻るように伝える。 */
function reroute(p: LatLon, route: Route): void {
  const saved = { from: state.from, stops: state.stops, routes: state.routes, selected: state.selected };
  const here = nearestIndex(p, route, guideProgress);
  rerouting = true;
  state.stops = state.stops.filter((stop) => stop !== null && nearestIndex(stop, route, here) > here);
  renderStops();
  guideProgress = 0;
  if (snap(p)) {
    toast("経路を外れたので、現在地から探し直します。");
    speak("経路を外れました。探し直します。");
    setEnd("from", { ...p, name: CURRENT });
  }
  rerouting = false;
  if (state.routes.length && snap(p)) return;
  state.stops = saved.stops;
  renderStops();
  state.routes = saved.routes;
  setEnd("from", saved.from, false);
  selectRoute(saved.selected);
  $("guide-next").textContent = "経路から離れています。元の経路へ戻ってください";
}

function updateGuide(p: LatLon, accuracy?: number): void {
  const route = state.routes[state.selected];
  if (!route) return;
  markers.me.setLngLat([p.lon, p.lat]).addTo(map);
  if (accuracy) showAccuracy(p, accuracy);
  map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 17), duration: 500 });
  if (distanceToRoute(p, route) > OFF_ROUTE_M && !rerouting) {
    reroute(p, route);
    return;
  }
  const end = route.coords[route.coords.length - 1];
  if (metres(p, { lat: end[1], lon: end[0] }) <= STEP_REACHED_M) {
    if ($("guide-next").textContent !== "目的地に着きました") speak("目的地に着きました");
    $("guide-next").textContent = "目的地に着きました";
    $("guide-rest").textContent = "";
    return;
  }
  const { next, metresLeft } = remainingFrom(p, route);
  if (next && metres(p, { lat: next.at[1], lon: next.at[0] }) <= ANNOUNCE_M) {
    const key = next.at.join(",");
    if (key !== announced) {
      announced = key;
      speak(`まもなく、${next.text.replace(/（.*）/, "")}`);
    }
  }
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
  announced = "";
  guideProgress = 0;
  watchId = navigator.geolocation.watchPosition(
    ({ coords }) => {
      updateGuide({ lat: coords.latitude, lon: coords.longitude }, coords.accuracy);
      if (coords.heading !== null && coords.heading !== undefined && (coords.speed ?? 0) > 0.5) setHeading(coords.heading);
    },
    (error) => {
      // 立ち止まって更新が途切れただけでは案内を止めない。
      if (error.code !== error.PERMISSION_DENIED) return;
      toast("位置情報が許可されていないため、案内を終わります。");
      stopGuide();
    },
    { enableHighAccuracy: true, maximumAge: 2000 },
  );
  keepScreenOn();
  watchCompass();
}

function stopGuide(): void {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  document.body.classList.remove("guiding");
  $("guide").hidden = true;
  stopCompass();
  wakeLock?.release();
  wakeLock = null;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

function accidentLine(i: number): string {
  const a = accidents.data;
  const year = Math.floor(a.ym[i] / 100);
  const month = a.ym[i] % 100;
  const who = a.ped[i] ? "歩行者の事故" : a.bike[i] ? "自転車の事故" : "車両の事故";
  const harm = a.dead[i] ? `死者${a.dead[i]}人` : `負傷者${a.hurt[i]}人`;
  return `${year}年${month}月 ${a.hour[i]}時台 ${who}（${harm}）`;
}

/** 事故の点は、一覧を開いている間だけ地図に出す。 */
function showAccidents(route: Route, visible: boolean): void {
  const a = accidents.data;
  (map.getSource("accidents") as GeoJSONSource).setData({
    type: "FeatureCollection",
    features: (visible ? route.accidents : []).map((i) => ({
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
  wrap.addEventListener("toggle", () => showAccidents(route, wrap.open));
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
  share.addEventListener("click", () => copyLink(share));
  wrap.append(items, share);
  return wrap;
}

async function copyLink(button: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(location.href);
    button.textContent = "コピーしました";
  } catch {
    toast("コピーできませんでした。アドレス欄のリンクをお使いください。");
  }
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
    const stops = state.stops.filter((stop): stop is Place => stop !== null);
    if (stops.length) q.set("via", stops.map((stop) => `${coords(stop)},${label(stop)}`).join("|"));
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
  } else if (place) {
    const name = q.get("name") || "共有された地点";
    showPlace(matchPlace(name, place) ?? { ...place, name });
  }
  renderPeriod();
}

function renderPeriod(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-period]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.period === state.period));
  });
}

/* ---- 画面の操作 ---- */

bindSuggest(
  qInput,
  (p) => {
    clearGenre();
    showPlace(p);
    pushUrl();
  },
  { offerGenres: true },
);
renderChips();
$("research").addEventListener("click", () => state.genre && searchGenre(state.genre));
$("layers").addEventListener("click", () => {
  const menu = $("layer-menu");
  menu.hidden = !menu.hidden;
});
document.querySelectorAll<HTMLButtonElement>("[data-layer]").forEach((b) => {
  b.addEventListener("click", () => {
    setBaseLayer(b.dataset.layer as BaseLayer | "map");
    $("layer-menu").hidden = true;
  });
});
const clearEnd = (which: End) => (value: string) => {
  if (!value && state[which]) {
    setEnd(which, null);
    clearRoutes();
  }
};
bindSuggest(fromInput, (p) => setEnd("from", p), { offerCurrent: true, onEdit: clearEnd("from") });
bindSuggest(toInput, (p) => setEnd("to", p), { offerCurrent: true, onEdit: clearEnd("to") });

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
$("guide-voice").addEventListener("click", () => {
  voiceOn = !voiceOn;
  $("guide-voice").setAttribute("aria-pressed", String(voiceOn));
  $("guide-voice").textContent = voiceOn ? "音声 オン" : "音声 オフ";
  if (voiceOn) speak("音声案内をオンにしました");
  else speechSynthesis?.cancel();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && watchId !== null) keepScreenOn();
});

/* ---- スマートフォンのシート ---- */

const SHEET_STOPS = [0.2, 0.44, 0.82];

/** シートの高さを、つまみのドラッグで3段階に切り替える。 */
function bindGrip(): void {
  const grip = $("grip");
  let startY = 0;
  let startH = 0;
  let moved = false;
  const setHeight = (px: number) => sheet.style.setProperty("--sheet-h", `${px}px`);
  grip.addEventListener("pointerdown", (e) => {
    grip.setPointerCapture(e.pointerId);
    startY = e.clientY;
    startH = sheet.getBoundingClientRect().height;
    moved = false;
  });
  grip.addEventListener("pointermove", (e) => {
    if (!grip.hasPointerCapture(e.pointerId)) return;
    if (Math.abs(e.clientY - startY) > 4) moved = true;
    setHeight(Math.max(60, startH + startY - e.clientY));
  });
  grip.addEventListener("pointerup", () => {
    const now = sheet.getBoundingClientRect().height / window.innerHeight;
    const nearest = SHEET_STOPS.reduce((a, b) => (Math.abs(b - now) < Math.abs(a - now) ? b : a));
    const index = SHEET_STOPS.indexOf(nearest);
    const target = moved ? nearest : SHEET_STOPS[(index + 1) % SHEET_STOPS.length];
    setHeight(target * window.innerHeight);
  });
}
bindGrip();
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
    $("loading").hidden = true;
    applyUrl();
  })
  .catch((err) => {
    console.error(err);
    $("loading").hidden = true;
    toast("データの読み込みに失敗しました。再読み込みしてください。");
  });
