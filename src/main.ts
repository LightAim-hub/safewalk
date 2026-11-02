import maplibregl, { type GeoJSONSource, type LngLatLike, type Map as MapLibre } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { Graph, type LatLon } from "./graph";
import { AccidentIndex, findRoutes, type Accidents, type Meta, type Period, type Route } from "./routes";

type Place = LatLon & { name: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fromInput = $<HTMLInputElement>("from");
const toInput = $<HTMLInputElement>("to");
const statusEl = $("status");
const routesEl = $<HTMLOListElement>("routes");
const detailEl = $("detail");

const COLORS = { good: "#1f8a5b", mid: "#c98a12", bad: "#c8452f", muted: "#8b95a1" };

const state = {
  from: null as Place | null,
  to: null as Place | null,
  period: (new Date().getHours() >= 18 || new Date().getHours() < 6 ? "night" : "day") as Period,
  routes: [] as Route[],
  selected: 0,
};

let graph: Graph;
let accidents: AccidentIndex;
let meta: Meta;

const map: MapLibre = new maplibregl.Map({
  container: "map",
  center: [135.195, 34.695],
  zoom: 13,
  attributionControl: { compact: true },
  style: {
    version: 8,
    sources: {
      base: {
        type: "raster",
        tiles: ["https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 18,
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>',
      },
    },
    layers: [{ id: "base", type: "raster", source: "base" }],
  },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

const markers = {
  from: new maplibregl.Marker({ color: COLORS.good }),
  to: new maplibregl.Marker({ color: COLORS.bad }),
};

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function scoreColor(score: number): string {
  return score >= 70 ? COLORS.good : score >= 50 ? COLORS.mid : COLORS.bad;
}

async function load(): Promise<void> {
  setStatus("道路と事故のデータを読み込んでいます…");
  const [bin, acc, m] = await Promise.all([
    fetch("/data/graph.bin").then((r) => r.arrayBuffer()),
    fetch("/data/accidents.json").then((r) => r.json() as Promise<Accidents>),
    fetch("/data/graph.meta.json").then((r) => r.json() as Promise<Meta>),
  ]);
  graph = new Graph(bin);
  accidents = new AccidentIndex(acc);
  meta = m;
  setStatus("");
}

function addLayers(): void {
  map.addSource("accidents", { type: "geojson", data: emptyCollection() });
  map.addSource("routes", { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "route-casing",
    type: "line",
    source: "routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-width": ["case", ["get", "selected"], 9, 6], "line-opacity": 0.9 },
  });
  map.addLayer({
    id: "route-line",
    type: "line",
    source: "routes",
    layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["case", ["get", "selected"], 1, 0] },
    paint: {
      "line-color": ["get", "color"],
      "line-width": ["case", ["get", "selected"], 6, 3.5],
      "line-opacity": ["case", ["get", "selected"], 1, 0.55],
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
    if (typeof index === "number") select(index);
    e.preventDefault();
  });
  map.on("click", (e) => {
    if (e.defaultPrevented) return;
    const place: Place = { lat: e.lngLat.lat, lon: e.lngLat.lng, name: "地図で選んだ地点" };
    if (!state.from) setPlace("from", place);
    else {
      setPlace("to", place);
      search();
    }
  });
}

function emptyCollection(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function setPlace(which: "from" | "to", place: Place): void {
  state[which] = place;
  (which === "from" ? fromInput : toInput).value = place.name;
  markers[which].setLngLat([place.lon, place.lat]).addTo(map);
}

/** 国土地理院の住所検索で地名を座標にする。範囲内の最初の候補を採る。 */
async function geocode(query: string): Promise<Place | null> {
  const url = `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(query)}`;
  const results: { geometry: { coordinates: [number, number] }; properties: { title: string } }[] = await fetch(
    url,
  ).then((r) => r.json());
  const inArea = results.find(({ geometry: { coordinates: [lon, lat] } }) => graph.nearestNode({ lat, lon }) !== null);
  if (!inArea) return null;
  const [lon, lat] = inArea.geometry.coordinates;
  return { lat, lon, name: query };
}

async function resolveInput(which: "from" | "to", input: HTMLInputElement): Promise<boolean> {
  const value = input.value.trim();
  if (state[which]?.name === value) return true;
  const place = value ? await geocode(value) : null;
  if (!place) {
    setStatus(`「${value || (which === "from" ? "出発地" : "目的地")}」を神戸市の市街地で見つけられませんでした。`);
    return false;
  }
  setPlace(which, place);
  return true;
}

async function search(): Promise<void> {
  if (!(await resolveInput("from", fromInput)) || !(await resolveInput("to", toInput))) return;
  const start = graph.nearestNode(state.from!);
  const goal = graph.nearestNode(state.to!);
  if (start === null || goal === null) {
    setStatus("この地点は対象範囲の外です。神戸市の市街地で選んでください。");
    return;
  }
  state.routes = findRoutes(graph, start, goal, state.period, accidents, meta);
  state.selected = 0;
  if (!state.routes.length) {
    setStatus("歩いて行ける経路が見つかりませんでした。");
    return;
  }
  setStatus("");
  writeUrl();
  const best = state.routes.reduce((a, b, i, all) => (b.safety > all[a].safety ? i : a), 0);
  renderRoutes();
  select(best);
  const all = state.routes.flatMap((r) => r.coords);
  const bounds = all.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(all[0], all[0]));
  map.fitBounds(bounds, { padding: 64, duration: 500 });
}

function renderRoutes(): void {
  routesEl.replaceChildren(
    ...state.routes.map((route, i) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.index = String(i);
      button.addEventListener("click", () => select(i));
      const score = document.createElement("span");
      score.className = "score";
      score.style.color = scoreColor(route.safety);
      score.textContent = `${route.safety}%`;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = route.label;
      const facts = document.createElement("span");
      facts.className = "facts";
      facts.textContent = `徒歩${route.minutes}分・${(route.metres / 1000).toFixed(1)}km`;
      button.append(score, name, facts);
      li.append(button);
      return li;
    }),
  );
}

function select(index: number): void {
  state.selected = index;
  routesEl.querySelectorAll("button").forEach((b) => {
    b.toggleAttribute("aria-current", Number(b.dataset.index) === index);
  });
  (map.getSource("routes") as GeoJSONSource).setData({
    type: "FeatureCollection",
    features: state.routes.map((route, i) => ({
      type: "Feature",
      properties: {
        index: i,
        selected: i === index,
        color: i === index ? scoreColor(route.safety) : COLORS.muted,
      },
      geometry: { type: "LineString", coordinates: route.coords },
    })),
  });
  renderDetail(state.routes[index]);
}

function accidentLine(i: number): string {
  const a = accidents.data;
  const year = Math.floor(a.ym[i] / 100);
  const month = a.ym[i] % 100;
  const who = a.ped[i] ? "歩行者の事故" : a.bike[i] ? "自転車の事故" : "車両の事故";
  const harm = a.dead[i] ? `死者${a.dead[i]}人` : `負傷者${a.hurt[i]}人`;
  return `${year}年${month}月 ${a.hour[i]}時台 ${who}（${harm}）`;
}

function renderDetail(route: Route): void {
  const a = accidents.data;
  const list = route.accidents;
  const count = (test: (i: number) => boolean) => list.filter(test).length;
  const ped = count((i) => a.ped[i] === 1);
  const night = count((i) => a.night[i] === 1);
  const dead = count((i) => a.dead[i] > 0);

  (map.getSource("accidents") as GeoJSONSource).setData({
    type: "FeatureCollection",
    features: list.map((i) => ({
      type: "Feature",
      properties: { ped: a.ped[i], dead: a.dead[i], text: accidentLine(i) },
      geometry: { type: "Point", coordinates: [a.lon[i], a.lat[i]] },
    })),
  });

  const heading = document.createElement("h2");
  heading.textContent = `この経路の近く（30m以内）で起きた事故 ${list.length}件`;
  const summary = document.createElement("p");
  summary.textContent = `2020〜2025年。歩行者の事故${ped}件・夜の事故${night}件・死亡事故${dead}件。`;

  const inPeriod = (i: number) => (a.night[i] === 1) === (state.period === "night");
  const severity = (i: number) => a.dead[i] * 100 + a.ped[i] * 10 + a.bike[i] * 2 + (inPeriod(i) ? 5 : 0);
  const top = [...list].sort((x, y) => severity(y) - severity(x)).slice(0, 5);
  const items = document.createElement("ul");
  for (const i of top) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = accidentLine(i);
    button.addEventListener("click", () => {
      const center: LngLatLike = [a.lon[i], a.lat[i]];
      map.flyTo({ center, zoom: 17 });
    });
    li.append(button);
    items.append(li);
  }

  const share = document.createElement("button");
  share.type = "button";
  share.className = "share";
  share.textContent = "この経路のリンクをコピー";
  share.addEventListener("click", async () => {
    await navigator.clipboard.writeText(location.href);
    share.textContent = "コピーしました";
  });

  detailEl.replaceChildren(heading, summary, items, share);
  detailEl.hidden = false;
}

function writeUrl(): void {
  const q = new URLSearchParams({
    from: `${state.from!.lat.toFixed(5)},${state.from!.lon.toFixed(5)}`,
    to: `${state.to!.lat.toFixed(5)},${state.to!.lon.toFixed(5)}`,
    fromName: state.from!.name,
    toName: state.to!.name,
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
  setPlace("from", from);
  setPlace("to", to);
  return true;
}

function renderPeriod(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-period]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.period === state.period));
  });
}

document.querySelectorAll<HTMLButtonElement>("[data-period]").forEach((b) => {
  b.addEventListener("click", () => {
    state.period = b.dataset.period as Period;
    renderPeriod();
    if (state.from && state.to) search();
  });
});

$<HTMLFormElement>("search").addEventListener("submit", (e) => {
  e.preventDefault();
  search();
});

renderPeriod();
const ready = Promise.all([load(), new Promise<void>((resolve) => map.on("load", () => resolve()))]);
ready
  .then(() => {
    addLayers();
    const shared = readUrl();
    renderPeriod();
    if (shared) search();
  })
  .catch((err) => {
    console.error(err);
    setStatus("データの読み込みに失敗しました。再読み込みしてください。");
  });
