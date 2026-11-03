import { Graph, type Anchor, type LatLon } from "./graph";
import { AccidentIndex, type Accidents, type Meta } from "./routes";
import { MAX_SNAP_M } from "./app";
import { normalize } from "./search";
import { type PlaceRow, type IndexedPlace } from "./types";

export let graph: Graph;
export let accidents: AccidentIndex;
export let meta: Meta;
export let places: IndexedPlace[] = [];
export let names: string[] = [];
export let kobeRings: [number, number][][] = [];

export async function loadData(): Promise<void> {
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
