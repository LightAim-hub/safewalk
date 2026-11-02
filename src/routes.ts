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

/** 曲がる場所ごとの案内 */
export type Step = {
  text: string;
  metres: number;
  at: [number, number];
};

export type Route = {
  label: string;
  edges: number[];
  coords: [number, number][];
  metres: number;
  minutes: number;
  /** 上りの合計(m) */
  climb: number;
  steps: Step[];
  safety: number;
  /** 経路から 30m 以内の事故の添字 */
  accidents: number[];
};

/** 平地の歩く速さ。Google マップの徒歩経路4区間の実測(分速71〜73m)に合わせた。 */
export const WALK_M_PER_MIN = 72;
/** 上り 10m を 1 分として足す(ナイスミスの目安) */
const MINUTES_PER_CLIMB_M = 0.1;
/** 曲がり角 1 つを、安全重視の時に何 m の遠回りとみなすか。路地のジグザグを抑える。 */
const TURN_M = 25;
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
  names: string[],
): Route[] {
  const risk = period === "night" ? g.riskNight : g.riskDay;
  const reference = period === "night" ? meta.riskPerKmNight : meta.riskPerKmDay;
  const found: Route[] = [];

  for (const weight of SAFETY_WEIGHTS) {
    const climbM = WALK_M_PER_MIN * MINUTES_PER_CLIMB_M;
    const edges = g.shortestPath(
      from,
      to,
      (e, node) =>
        g.length[e] + climbM * g.climb(e, node) + weight * METRES_PER_RISK * risk[e] + (weight > 0 ? TURN_M : 0),
    );
    if (!edges) return [];
    const total = edges.reduce((sum, e) => sum + g.length[e], 0);
    if (found.length && total > found[0].metres * MAX_DETOUR) continue;
    if (found.some((r) => overlap(g, r.edges, edges) > MAX_OVERLAP)) continue;
    const riskSum = edges.reduce((sum, e) => sum + risk[e], 0);
    const perKm = riskSum / (total / 1000);
    const coords = g.pathCoords(edges, from);
    const { climb, steps } = walkThrough(g, edges, from, names);
    found.push({
      label: "",
      edges,
      coords,
      metres: total,
      minutes: minutesFor(total, climb),
      climb,
      steps,
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

export function minutesFor(metres: number, climb: number): number {
  return Math.ceil(metres / WALK_M_PER_MIN + climb * MINUTES_PER_CLIMB_M);
}

const STEP_MIN_M = 25;

/** 「葺合南１３４号線」のような市道の管理番号は、案内に出しても分からないので省く。 */
function displayName(name: string): string {
  return /[0-9０-９]号線/.test(name) ? "" : name;
}

function bearing(a: [number, number], b: [number, number]): number {
  const k = Math.cos((a[1] * Math.PI) / 180);
  return (Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180) / Math.PI;
}

function turnWord(delta: number): string | null {
  const size = Math.abs(delta);
  if (size < 35) return null;
  const side = delta < 0 ? "左" : "右";
  if (size < 60) return `やや${side}へ進む`;
  if (size < 135) return `${side}に曲がる`;
  return `大きく${side}へ曲がる`;
}

function compass(deg: number): string {
  const names = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
  return names[Math.round(((deg + 360) % 360) / 45) % 8];
}

/** 辺の列をたどり、上りの合計と曲がる場所ごとの案内を作る。 */
function walkThrough(g: Graph, edges: number[], from: number, names: string[]): { climb: number; steps: Step[] } {
  let node = from;
  let climb = 0;
  let heading: number | null = null;
  const steps: (Step & { road: string })[] = [];
  for (const e of edges) {
    climb += g.climb(e, node);
    const pts = g.edgeCoords(e, node);
    const road = displayName(names[g.nameId[e]] ?? "");
    const start = bearing(pts[0], pts[1]);
    const last = steps[steps.length - 1];
    if (!last) {
      steps.push({ text: `${compass(start)}へ歩き始める`, metres: 0, at: pts[0], road });
    } else {
      const delta = ((start - heading! + 540) % 360) - 180;
      const turn = turnWord(delta);
      const renamed = road !== "" && last.road !== "" && road !== last.road;
      if (turn && last.metres >= STEP_MIN_M) steps.push({ text: turn, metres: 0, at: pts[0], road });
      else if (renamed && last.metres >= STEP_MIN_M) steps.push({ text: "道なりに進む", metres: 0, at: pts[0], road });
    }
    const current = steps[steps.length - 1];
    current.metres += g.length[e];
    if (!current.road) current.road = road;
    heading = bearing(pts[pts.length - 2], pts[pts.length - 1]);
    node = g.edgeU[e] === node ? g.edgeV[e] : g.edgeU[e];
  }
  return {
    climb: Math.round(climb),
    steps: steps.map(({ text, metres, at, road }) => ({ text: road ? `${text}（${road}）` : text, metres, at })),
  };
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
