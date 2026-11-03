import { Graph, type Anchor, type LatLon } from "./graph";
import { AccidentIndex, type Accidents, type Meta } from "./routes";
import { MAX_SNAP_M } from "./app";
import { normalize } from "./search";
import { loadCautions, createSafety, type Safety } from "./safety";
import type { AgentContext } from "./agent-tools";
import { type PlaceRow, type IndexedPlace } from "./types";

/** データの置き場所。サブパス（GitHub Pages の /safewalk/）でも動くよう、ページの位置から求める。 */
export const DATA_URL = new URL("data/", document.baseURI).href;

export let graph: Graph;
export let accidents: AccidentIndex;
export let meta: Meta;
/** 交通事故の記録の判定に使う索引(src/safety.ts)。loadData の後に使える。 */
export let safety: Safety;
export let places: IndexedPlace[] = [];
export let names: string[] = [];
export let kobeRings: [number, number][][] = [];

/** 取得に失敗した（200 でない）時は読み込み失敗として投げる。 */
function ok(r: Response): Response {
  if (!r.ok) throw new Error(`${r.url} ${r.status}`);
  return r;
}

/**
 * graph.bin の長さが、先頭の件数から求めた長さと一致するか確かめる。
 * Wi-Fi のログイン画面などが 200 で返ってきても、道が空のまま「歩ける道がありません」と出さないため。
 */
function checkGraph(buf: ArrayBuffer): ArrayBuffer {
  if (buf.byteLength < 12) throw new Error("graph.bin が短すぎます");
  const [n, m, k] = new Uint32Array(buf, 0, 3);
  const expected = 12 + n * 8 + m * 36 + (m + 1) * 4 + k * 8;
  // 末尾の m バイトは、夜の費用に足す値(pipeline/05_crime.py)。無くてもよい。
  if (!n || !m || (buf.byteLength !== expected && buf.byteLength !== expected + m)) throw new Error("graph.bin の形が正しくありません");
  return buf;
}

export async function loadData(): Promise<void> {
  const [bin, acc, m, rows, roadNames, kobe, cautions] = await Promise.all([
    fetch(DATA_URL + "graph.bin").then((r) => ok(r).arrayBuffer()).then(checkGraph),
    fetch(DATA_URL + "accidents.json").then((r) => ok(r).json() as Promise<Accidents>),
    fetch(DATA_URL + "graph.meta.json").then((r) => ok(r).json() as Promise<Meta>),
    fetch(DATA_URL + "places.json").then((r) => ok(r).json() as Promise<PlaceRow[]>),
    fetch(DATA_URL + "names.json").then((r) => ok(r).json() as Promise<string[]>),
    fetch(DATA_URL + "kobe.geojson").then((r) => ok(r).json() as Promise<GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>>),
    loadCautions(),
  ]);
  if (!Array.isArray(rows) || !Array.isArray(roadNames)) throw new Error("データの形が正しくありません");
  const shape = kobe.geometry;
  kobeRings = (shape.type === "Polygon" ? [shape.coordinates] : shape.coordinates).flat() as [number, number][][];
  graph = new Graph(bin);
  accidents = new AccidentIndex(acc);
  safety = createSafety(cautions, acc);
  meta = m;
  names = roadNames;
  places = rows.map(([raw, lat, lon, kind, reading, ward, hours, phone, web, address, operator]) => {
    // OpenStreetMap の駅名は「灘」のように「駅」が付かないことがある。
    const name = kind === "駅" && !raw.endsWith("駅") ? `${raw}駅` : raw;
    return { name, lat, lon, kind, ward, hours, phone, web, address, operator, n: normalize(name), y: normalize(reading) };
  });
}

export function emptyCollection(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

export function inKobe(p: LatLon): boolean {
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
export function snap(p: LatLon): Anchor | null {
  if (!inKobe(p)) return null;
  const road = graph.nearestRoad(p);
  return road && road.metres <= MAX_SNAP_M ? road : null;
}

/** Claude の道具(src/agent-tools.ts)に渡す文脈。loadData の後に呼ぶ。 */
export function agentContext(): AgentContext {
  return { graph, accidents, meta, names, safety, places, snap };
}
