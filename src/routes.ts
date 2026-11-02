import { Graph, metres, type LatLon } from "./graph";

export type Accidents = {
  lat: number[];
  lon: number[];
  ym: number[];
  hour: number[];
  night: number[];
  ped: number[];
  bike: number[];
  dead: number[];
  hurt: number[];
};

export type Meta = { riskPerKmDay: number; riskPerKmNight: number };

export type Period = "day" | "night";

export type Route = {
  label: string;
  edges: number[];
  coords: [number, number][];
  metres: number;
  minutes: number;
  safety: number;
  /** 経路から 30m 以内の事故の添字 */
  accidents: number[];
};

export const WALK_M_PER_MIN = 80;
const NEAR_M = 30;
/** 事故の重み 1 を、何 m の遠回りに換算するか */
const METRES_PER_RISK = 30;
const SAFETY_WEIGHTS = [0, 1, 3, 8];
const MAX_DETOUR = 1.7;
const MAX_OVERLAP = 0.85;

/** 安全を重く見る度合いを変えて経路を出し、似た経路を除く。 */
export function findRoutes(
  g: Graph,
  from: number,
  to: number,
  period: Period,
  acc: AccidentIndex,
  meta: Meta,
): Route[] {
  const risk = period === "night" ? g.riskNight : g.riskDay;
  const reference = period === "night" ? meta.riskPerKmNight : meta.riskPerKmDay;
  const found: Route[] = [];

  for (const weight of SAFETY_WEIGHTS) {
    const edges = g.shortestPath(from, to, (e) => g.length[e] + weight * METRES_PER_RISK * risk[e]);
    if (!edges) return [];
    const total = edges.reduce((sum, e) => sum + g.length[e], 0);
    if (found.length && total > found[0].metres * MAX_DETOUR) continue;
    if (found.some((r) => overlap(g, r.edges, edges) > MAX_OVERLAP)) continue;
    const riskSum = edges.reduce((sum, e) => sum + risk[e], 0);
    const perKm = riskSum / (total / 1000);
    const coords = g.pathCoords(edges, from);
    found.push({
      label: "",
      edges,
      coords,
      metres: total,
      minutes: Math.ceil(total / WALK_M_PER_MIN),
      safety: Math.round(100 / (1 + perKm / reference)),
      accidents: acc.near(coords),
    });
  }

  const safest = found.reduce((a, b) => (b.safety > a.safety ? b : a), found[0]);
  found.forEach((r, i) => {
    r.label = i === 0 ? "最短" : r === safest ? "最も安全" : "バランス";
  });
  if (found.length === 1) found[0].label = "おすすめ";
  return found;
}

function overlap(g: Graph, a: number[], b: number[]): number {
  const set = new Set(a);
  let shared = 0;
  let total = 0;
  for (const e of b) {
    total += g.length[e];
    if (set.has(e)) shared += g.length[e];
  }
  return shared / total;
}

/** 事故を格子に入れ、経路の近くの事故をすぐ引けるようにする。 */
export class AccidentIndex {
  private readonly grid = new Map<string, number[]>();
  private static readonly CELL = 0.0005;

  constructor(readonly data: Accidents) {
    data.lat.forEach((lat, i) => {
      const key = AccidentIndex.key(lat, data.lon[i]);
      const list = this.grid.get(key);
      if (list) list.push(i);
      else this.grid.set(key, [i]);
    });
  }

  private static key(lat: number, lon: number): string {
    return `${Math.floor(lat / AccidentIndex.CELL)}:${Math.floor(lon / AccidentIndex.CELL)}`;
  }

  near(coords: [number, number][]): number[] {
    const hit = new Set<number>();
    const c = AccidentIndex.CELL;
    for (const [lon, lat] of densify(coords)) {
      const p: LatLon = { lat, lon };
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const i of this.grid.get(AccidentIndex.key(lat + dy * c, lon + dx * c)) ?? []) {
            if (!hit.has(i) && metres(p, { lat: this.data.lat[i], lon: this.data.lon[i] }) <= NEAR_M) hit.add(i);
          }
        }
      }
    }
    return [...hit];
  }
}

function densify(coords: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < coords.length; i++) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[i + 1];
    const n = Math.max(1, Math.ceil(metres({ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 }) / 20));
    for (let t = 0; t < n; t++) out.push([lon1 + ((lon2 - lon1) * t) / n, lat1 + ((lat2 - lat1) * t) / n]);
  }
  out.push(coords[coords.length - 1]);
  return out;
}
