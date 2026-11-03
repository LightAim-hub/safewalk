import { type ExpressionSpecification, type GeoJSONSource } from "maplibre-gl";
import { type LatLon } from "./graph";
import { $, qInput, sheet, COLORS, CURRENT, state, map, markers, toast, mapPadding } from "./app";
import { DATA_URL, emptyCollection, snap } from "./data";
import { addStop, selectRoute } from "./directions";
import { matchPlace, onMapPick, closePlace, showPlace } from "./place";
import { lastResults } from "./search";
import { type Place } from "./types";
import { pushUrl } from "./url";

/** 地図の文字を日本語だけにする。 */
export function useJapaneseLabels(): void {
  const label: ExpressionSpecification = ["coalesce", ["get", "name:ja"], ["get", "name"]];
  for (const layer of map.getStyle().layers) {
    if (layer.type !== "symbol") continue;
    const field = map.getLayoutProperty(layer.id, "text-field");
    if (field !== undefined && JSON.stringify(field).includes("name")) {
      map.setLayoutProperty(layer.id, "text-field", label);
    }
  }
}

/** 背景地図と航空写真が細かく表示できる範囲（国土地理院の航空写真は z18 まで）。これより寄ると無地になる。 */
export const MAX_ZOOM = 18;

/** 中くらいの拡大（z15〜16）でも出したい店・施設の種類。残りの種類は z17 から出す。 */
export const MAIN_POI_CLASSES = [
  "shop", "grocery", "fast_food", "cafe", "restaurant", "bakery", "clothing_store", "pharmacy", "bank", "atm",
  "post", "hospital", "doctors", "library", "museum", "attraction", "cinema", "theatre", "lodging", "police",
  "school", "college", "town_hall", "park", "place_of_worship", "stadium", "fuel",
];

/**
 * 背景地図は店や施設の層が z15 / z16 / z17 から出る作りで、少し拡大しただけでは駅とバス停しか見えない。
 * 主な種類は早い拡大から出し、バス停は z16 からにして、全体を読みやすく保つ。
 */
export function showMorePois(): void {
  const byId = (id: string) => map.getStyle().layers.find((l) => l.id === id);
  const mid = byId("poi_r7");
  const low = byId("poi_r20");
  const main: ExpressionSpecification = ["in", ["get", "class"], ["literal", MAIN_POI_CLASSES]];
  if (mid && mid.type === "symbol") map.setLayerZoomRange(mid.id, 15, 24);
  if (low && low.type === "symbol") {
    // 主な種類は z16 から。残りは複製した層で z17 から。
    map.addLayer({ ...low, id: "poi_r20_other", minzoom: 17, filter: ["all", low.filter as ExpressionSpecification, ["!", main]] }, low.id);
    map.setFilter(low.id, ["all", low.filter as ExpressionSpecification, main]);
    map.setLayerZoomRange(low.id, 16, 24);
  }
  for (const id of ["poi_r1", "poi_r7", "poi_r20", "poi_r20_other"]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "text-font", ["Noto Sans Regular"]);
  }
  const transit = byId("poi_transit");
  if (transit && transit.type === "symbol") {
    // バス停は多いので z16 から。駅は今まで通り。
    map.addLayer({ ...transit, id: "poi_bus", minzoom: 16, filter: ["==", ["get", "class"], "bus"] }, transit.id);
    map.setFilter(transit.id, ["match", ["get", "class"], ["airport", "rail"], true, false]);
  }
}

export function addLayers(): void {
  map.setMaxZoom(MAX_ZOOM);
  useJapaneseLabels();
  showMorePois();
  addBaseLayers();
  map.addSource("kobe", { type: "geojson", data: DATA_URL + "kobe.geojson" });
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
export const TOUCH = window.matchMedia("(pointer: coarse)").matches;
export const LONG_PRESS_MS = 550;
/** 長押しの後に来る click で、開いた場所を閉じないようにする。 */
export let longPressed = false;

/** 長押しで地点を選ぶ。指が動いたら地図の移動として扱う。 */
export function bindLongPress(): void {
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


export const LAYERS = {
  photo: { label: "航空写真", url: "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg", maxzoom: 18, opacity: 1 },
  relief: { label: "地形", url: "https://cyberjapandata.gsi.go.jp/xyz/hillshademap/{z}/{x}/{y}.png", maxzoom: 16, opacity: 0.55 },
};
export type BaseLayer = keyof typeof LAYERS;

/** 航空写真と地形を地図の文字の下に入れ、切り替えられるようにする。 */
export function addBaseLayers(): void {
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

export function setBaseLayer(choice: BaseLayer | "map"): void {
  for (const id of Object.keys(LAYERS)) map.setLayoutProperty(id, "visibility", id === choice ? "visible" : "none");
  document.querySelectorAll<HTMLButtonElement>("[data-layer]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.layer === choice));
  });
}

/** 現在地の誤差を円で表す。 */
export function showAccuracy(p: LatLon, radiusM: number): void {
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

export function locateMe(): Promise<Place | null> {
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

export const SHEET_STOPS = [0.2, 0.44, 0.82];

/** シートの高さを、つまみのドラッグで3段階に切り替える。 */
export function bindGrip(): void {
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

/** 幅が変わった時の後始末。スマホで動かしたシートの高さを PC 幅に持ち越さず、著作権表示は狭い画面で畳んだ状態にする。 */
function bindNarrowLayout(): void {
  const narrow = window.matchMedia("(max-width: 720px)");
  const collapseAttribution = () => {
    if (!narrow.matches) return;
    // maplibre は狭い画面で最初だけ全文を開く。3 行になり縮尺を覆うので、ⓘ の畳んだ表示から始める。
    document.querySelector(".maplibregl-ctrl-attrib.maplibregl-compact")?.classList.remove("maplibregl-compact-show");
  };
  narrow.addEventListener("change", () => {
    if (!narrow.matches) sheet.style.removeProperty("--sheet-h");
    // 幅の変更で maplibre が表示を作り直すので、その後で畳む。
    setTimeout(collapseAttribution, 0);
  });
  map.once("load", collapseAttribution);
}

/** 検索欄の ✕ は、欄に文字がある間だけ出す。 */
export function syncClearButton(): void {
  $("clear-q").hidden = !qInput.value;
}

export function bindMapUi(): void {
  // 検索欄を空にしたら、開いている場所・ジャンルの一覧とピンも閉じる。
  qInput.addEventListener("input", () => {
    if (!qInput.value.trim()) closePlace();
    syncClearButton();
  });
  $("clear-q").addEventListener("click", () => {
    qInput.value = "";
    closePlace();
    syncClearButton();
    qInput.focus();
  });
  new MutationObserver(syncClearButton).observe(sheet, { childList: true, attributes: true, attributeFilter: ["hidden"] });
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
  bindGrip();
  bindNarrowLayout();
  $("locate").addEventListener("click", async () => {
    const me = await locateMe();
    if (me) map.flyTo({ center: [me.lon, me.lat], zoom: 16, padding: mapPadding() });
  });
}
