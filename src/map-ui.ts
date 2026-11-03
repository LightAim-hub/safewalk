import type maplibregl from "maplibre-gl";
import { type ExpressionSpecification, type GeoJSONSource } from "maplibre-gl";
import { type LatLon } from "./graph";
import { $, qInput, sheet, COLORS, CURRENT, state, map, markers, mapPadding } from "./app";
import { DATA_URL, emptyCollection, snap } from "./data";
import { addStop, selectRoute } from "./directions";
import { matchPlace, onMapPick, closePlace, showPlace } from "./place";
import { lastResults } from "./search";
import { type Place } from "./types";
import { pushUrl } from "./url";
import { confirmLocate, showLocateFail, type LocateFail } from "./onboarding";

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

/** 地図の文字（POI）の subclass / class から、種別を日本語で返す。分からない時は undefined。 */
const POI_KIND: Record<string, string> = {
  bus_stop: "バス停", bus_station: "バスターミナル", station: "駅", halt: "駅", subway_entrance: "地下鉄の出入口",
  tram_stop: "路面電車の停留所", ferry_terminal: "フェリーのりば", aerodrome: "空港", airport: "空港",
  convenience: "コンビニ", supermarket: "スーパー", mall: "ショッピングモール", department_store: "百貨店",
  cafe: "カフェ", restaurant: "飲食店", fast_food: "ファストフード", bakery: "パン屋", pub: "居酒屋", bar: "バー",
  pharmacy: "薬局", bank: "銀行", atm: "ATM", post_office: "郵便局", post_box: "ポスト",
  hospital: "病院", clinic: "診療所", doctors: "診療所", dentist: "歯科", police: "警察", fire_station: "消防署",
  toilets: "トイレ", telephone: "公衆電話", parking: "駐車場", bicycle_rental: "レンタサイクル",
  library: "図書館", books: "書店", museum: "博物館", artwork: "アート作品", art_gallery: "ギャラリー",
  attraction: "観光地", cinema: "映画館", theatre: "劇場", hotel: "ホテル", hostel: "ホステル", lodging: "宿泊",
  school: "学校", kindergarten: "幼稚園", college: "大学・専門学校", university: "大学", town_hall: "市役所",
  government: "官公庁", park: "公園", playground: "遊び場", place_of_worship: "寺社・教会", stadium: "スタジアム",
  fuel: "ガソリンスタンド", cosmetics: "化粧品店", travel_agency: "旅行代理店", beauty: "美容", hairdresser: "美容室・理容室",
  sports: "スポーツ用品店", clothing_store: "衣料品店", car: "自動車販売", car_repair: "自動車整備", office: "事務所",
  shop: "お店", grocery: "食料品店", zoo: "動物園", garden: "庭園", swimming_pool: "プール", fitness_centre: "フィットネス",
  sports_centre: "スポーツ施設", community_centre: "公民館", social_facility: "福祉施設", veterinary: "動物病院",
  laundry: "クリーニング", butcher: "精肉店", florist: "花屋", jewelry: "宝飾店", electronics: "家電店", furniture: "家具店",
  hardware: "ホームセンター", bicycle: "自転車店", optician: "眼鏡店", mobile_phone: "携帯ショップ", gift: "ギフトショップ",
  confectionery: "菓子店", ice_cream: "アイスクリーム", food_court: "フードコート", nightclub: "ナイトクラブ", karaoke_box: "カラオケ",
  amusement_arcade: "ゲームセンター", bus: "バス停", rail: "駅", railway: "駅", lodging_other: "宿泊",
};

export function poiKind(props: Record<string, unknown>): string | undefined {
  for (const key of ["subclass", "class"]) {
    const value = props[key];
    if (typeof value === "string" && POI_KIND[value]) return POI_KIND[value];
  }
  return undefined;
}

/**
 * 番号だけ・「〜号線」だけの道の名前（例: 生田北１２９号線）は読んで分からないので出さない。
 * 道の名前の層の filter に足す。
 */
export function hideNumberedRoads(): void {
  const name: ExpressionSpecification = ["to-string", ["coalesce", ["get", "name:ja"], ["get", "name"], ""]];
  const numbered: ExpressionSpecification = [
    "any",
    ["!=", ["to-number", name, -1], -1],
    ["all", [">=", ["index-of", "号線", name], 0], ["==", ["index-of", "号線", name], ["-", ["length", name], 2]]],
  ];
  for (const id of ["highway-name-path", "highway-name-minor", "highway-name-major"]) {
    const layer = map.getStyle().layers.find((l) => l.id === id);
    if (!layer || layer.type !== "symbol") continue;
    map.setFilter(id, layer.filter ? ["all", layer.filter as ExpressionSpecification, ["!", numbered]] : ["!", numbered]);
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

/** 式の中の ["get", 名前] を、無い物でも数として読める形（無ければ既定の数）にする。 */
function withNumberDefault(expr: unknown, defaults: Record<string, number>): unknown {
  if (!Array.isArray(expr)) return expr;
  if (expr.length === 2 && expr[0] === "get" && typeof expr[1] === "string" && expr[1] in defaults) {
    return ["coalesce", ["get", expr[1]], defaults[expr[1]]];
  }
  return expr.map((e) => withNumberDefault(e, defaults));
}

/**
 * 背景地図の層の filter は、数のはずの rank・ref_length が無い点で「数のはずが null」の警告を出し続ける。
 * 無い時の数は、今まで（警告のうえで外れていた）と同じ結果になる値にする
 * （rank は >=1 に入らない 0、ref_length は <=6 に入らない 99）。
 * 絵（sprite）に無い種類（atm・office・gate など）の店の層は、警告の代わりに小さな点で代える。
 */
export function quietPoiLayers(): void {
  const defaults = { rank: 0, ref_length: 99 };
  for (const layer of map.getStyle().layers) {
    if (layer.type !== "symbol") continue;
    if (layer.filter && /"(rank|ref_length)"/.test(JSON.stringify(layer.filter))) {
      map.setFilter(layer.id, withNumberDefault(layer.filter, defaults) as ExpressionSpecification);
    }
    const icon = layer.layout?.["icon-image"];
    if (icon && /^poi_r\d+$/.test(layer.id)) {
      map.setLayoutProperty(layer.id, "icon-image", ["coalesce", ["image", icon as ExpressionSpecification], ["image", "dot_11"]]);
    }
  }
}

/** 建物の高さが無い建物でも、数として読めるようにする（無ければ 0）。 */
export function quietBuildings(): void {
  const layer = map.getStyle().layers.find((l) => l.id === "building-3d");
  if (!layer || layer.type !== "fill-extrusion") return;
  for (const prop of ["fill-extrusion-height", "fill-extrusion-base"] as const) {
    const value = layer.paint?.[prop];
    if (value) map.setPaintProperty("building-3d", prop, withNumberDefault(value, { render_height: 0, render_min_height: 0 }));
  }
}

export function addLayers(): void {
  map.setMaxZoom(MAX_ZOOM);
  useJapaneseLabels();
  showMorePois();
  hideNumberedRoads();
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
    if (guiding()) return void e.preventDefault();
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
    if (guiding()) return void e.preventDefault();
    const index = e.features?.[0]?.properties?.index;
    if (typeof index === "number") selectRoute(index);
    e.preventDefault();
  });
  // ダブルクリックは拡大だけにする。1回目のクリックはしばらく待ち、2回目が来たら地点を開かない。
  let pendingClick = 0;
  map.on("dblclick", () => {
    clearTimeout(pendingClick);
    pendingClick = 0;
  });
  map.on("click", (e) => {
    if (guiding()) return;
    if (e.defaultPrevented || longPressed) {
      longPressed = false;
      return;
    }
    if (pendingClick) {
      clearTimeout(pendingClick);
      pendingClick = 0;
      return;
    }
    pendingClick = window.setTimeout(() => {
      pendingClick = 0;
      pickAt(e);
    }, DOUBLE_CLICK_MS);
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

/** 案内中は、地図の操作で出発地・目的地・経路を替えない。 */
function guiding(): boolean {
  return document.body.classList.contains("guiding");
}

/** この時間内に2回目のクリックが来たら、ダブルクリック（拡大）として扱う。 */
export const DOUBLE_CLICK_MS = 260;

/** 地図を1回押した時の処理。文字（駅・店など）の上なら、その種別とアイコンの位置で地点を開く。 */
function pickAt(e: maplibregl.MapMouseEvent): void {
  const { x, y } = e.point;
  const labelled = map
    .queryRenderedFeatures([
      [x - 6, y - 6],
      [x + 6, y + 6],
    ])
    .find((f) => f.layer.type === "symbol" && f.properties.name);
  if (!labelled && TOUCH && state.mode === "browse") return closePlace();
  const name = labelled ? String(labelled.properties["name:ja"] ?? labelled.properties.name) : "地図で選んだ地点";
  // ピンは押した位置でなく、そのアイコンの位置に立てる（道の名前など線の文字は押した位置のまま）。
  const at =
    labelled && labelled.geometry.type === "Point"
      ? { lat: labelled.geometry.coordinates[1], lon: labelled.geometry.coordinates[0] }
      : { lat: e.lngLat.lat, lon: e.lngLat.lng };
  const kind = labelled && labelled.sourceLayer === "poi" ? poiKind(labelled.properties) : undefined;
  onMapPick(labelled ? (matchPlace(name, at) ?? { ...at, name, ...(kind && { kind }) }) : { ...at, name }, labelled !== undefined);
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
      if (guiding()) return;
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

/** 現在地の取得結果。失敗の理由を区別して返す。 */
export type LocateResult = { ok: true; place: Place } | { ok: false; reason: LocateFail | "cancelled" };

/** 許可がまだ決まっていない（または状態を調べられない）時だけ true。許可済み・拒否済みの時は一言を挟まない。 */
async function needsNotice(): Promise<boolean> {
  try {
    const st = await navigator.permissions.query({ name: "geolocation" });
    return st.state === "prompt";
  } catch {
    return true;
  }
}

/**
 * 利用者が「現在地」を押した時に呼ぶ。許可を求める前に一言を出し、失敗の理由（拒否・取れない・時間切れ・市外）を返す。
 * 失敗の案内は消えない形で出す（showLocateFail）。
 */
export async function locateMeDetailed(): Promise<LocateResult> {
  if (!navigator.geolocation) {
    showLocateFail("unsupported");
    return { ok: false, reason: "unsupported" };
  }
  if ((await needsNotice()) && !(await confirmLocate())) return { ok: false, reason: "cancelled" };
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const place: Place = { lat: coords.latitude, lon: coords.longitude, name: CURRENT };
        if (snap(place) === null) {
          showLocateFail("outside");
          return resolve({ ok: false, reason: "outside" });
        }
        markers.me.setLngLat([place.lon, place.lat]).addTo(map);
        showAccuracy(place, coords.accuracy);
        resolve({ ok: true, place });
      },
      (err) => {
        const reason: LocateFail = err.code === 1 ? "denied" : err.code === 3 ? "timeout" : "unavailable";
        showLocateFail(reason);
        resolve({ ok: false, reason });
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });
}

/** 従来どおり、取れた時は地点、取れない時は null。理由が要る時は locateMeDetailed を使う。 */
export async function locateMe(): Promise<Place | null> {
  const r = await locateMeDetailed();
  return r.ok ? r.place : null;
}

export const SHEET_STOPS = [0.2, 0.44, 0.82];

/** シート本体の上端、この高さ（px）の帯もドラッグで高さを変えられる。中の一覧のスクロールとは干渉しない。 */
export const SHEET_DRAG_ZONE_PX = 36;

/** いちばん近い段の番号。 */
function nearestStop(heightPx: number): number {
  const now = heightPx / window.innerHeight;
  return SHEET_STOPS.reduce((best, stop, i) => (Math.abs(stop - now) < Math.abs(SHEET_STOPS[best] - now) ? i : best), 0);
}

/** シートの高さを、つまみのドラッグで3段階に切り替える。つまみを押すと1段ずつ縮み、いちばん低い段からは最大に戻る。 */
export function bindGrip(): void {
  const grip = $("grip");
  let startY = 0;
  let startH = 0;
  let moved = false;
  const setHeight = (px: number) => sheet.style.setProperty("--sheet-h", `${px}px`);
  const drag = (clientY: number) => {
    if (Math.abs(clientY - startY) > 4) moved = true;
    setHeight(Math.min(window.innerHeight * 0.9, Math.max(60, startH + startY - clientY)));
  };
  const release = () => {
    const index = nearestStop(sheet.getBoundingClientRect().height);
    const target = moved ? index : index === 0 ? SHEET_STOPS.length - 1 : index - 1;
    setHeight(SHEET_STOPS[target] * window.innerHeight);
  };
  const begin = (clientY: number) => {
    startY = clientY;
    startH = sheet.getBoundingClientRect().height;
    moved = false;
  };
  grip.addEventListener("pointerdown", (e) => {
    grip.setPointerCapture(e.pointerId);
    begin(e.clientY);
  });
  grip.addEventListener("pointermove", (e) => {
    if (grip.hasPointerCapture(e.pointerId)) drag(e.clientY);
  });
  grip.addEventListener("pointerup", release);

  // シート本体の上端付近の指のドラッグ。帯の外から始まった動きは一覧のスクロールに任せる。
  let dragging = false;
  sheet.addEventListener(
    "touchstart",
    (e) => {
      const touch = e.touches[0];
      dragging = e.touches.length === 1 && touch.clientY - sheet.getBoundingClientRect().top <= SHEET_DRAG_ZONE_PX && grip.offsetParent !== null;
      if (dragging) begin(touch.clientY);
    },
    { passive: true },
  );
  sheet.addEventListener(
    "touchmove",
    (e) => {
      if (!dragging) return;
      e.preventDefault();
      drag(e.touches[0].clientY);
    },
    { passive: false },
  );
  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (moved) release();
  };
  sheet.addEventListener("touchend", end);
  sheet.addEventListener("touchcancel", end);
}

const CONTROL_LABELS: [string, string][] = [
  [".maplibregl-ctrl-zoom-in", "拡大"],
  [".maplibregl-ctrl-zoom-out", "縮小"],
  [".maplibregl-ctrl-compass", "方位を北に戻す"],
  [".maplibregl-ctrl-attrib-button", "地図の出典を表示"],
];

/** MapLibre の部品の説明（title・aria-label）を日本語にする。部品が作り直されても追従する。 */
export function bindJapaneseControls(): void {
  const apply = () => {
    for (const [selector, label] of CONTROL_LABELS) {
      document.querySelectorAll<HTMLElement>(selector).forEach((node) => {
        if (node.title !== label) node.title = label;
        if (node.getAttribute("aria-label") !== label) node.setAttribute("aria-label", label);
      });
    }
  };
  apply();
  new MutationObserver(apply).observe(document.querySelector(".maplibregl-control-container")!, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["title", "aria-label"],
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

/**
 * 場所を開く時の flyTo / jumpTo の padding は、地図の中心の余白として残る。
 * その上に fitBounds の padding が足されて「Map cannot fit within canvas」になるので、
 * fitBounds には余白を渡す側の値だけを使わせる（残っている余白は 0 に戻す）。
 */
function fitWithoutStalePadding(): void {
  const fit = map.fitBounds.bind(map);
  map.fitBounds = ((bounds, options, eventData) => {
    if (options?.padding !== undefined) map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    return fit(bounds, options, eventData);
  }) as typeof map.fitBounds;
}

export function bindMapUi(): void {
  fitWithoutStalePadding();
  // 背景の style が読めたらすぐ（最初の描画の前に）、警告の元になる式を直す。
  map.once("style.load", () => {
    quietPoiLayers();
    quietBuildings();
  });
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
  // 北向きに戻すボタンは、地図を回した・傾けた時だけ出す。
  const syncRotated = () => document.body.classList.toggle("rotated", Math.abs(map.getBearing()) > 0.5 || map.getPitch() > 0.5);
  map.on("rotate", syncRotated);
  map.on("pitch", syncRotated);
  map.on("rotateend", syncRotated);
  map.on("pitchend", syncRotated);
  bindGrip();
  bindJapaneseControls();
  bindNarrowLayout();
  $("locate").addEventListener("click", async () => {
    const me = await locateMe();
    if (me) map.flyTo({ center: [me.lon, me.lat], zoom: 16, padding: mapPadding() });
  });
}
