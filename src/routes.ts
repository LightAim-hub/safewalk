import { Graph, metres, OUTSIDE, REMOTE, type Anchor, type LatLon } from "./graph";

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
  /** 安全度の目安。評価できない道が多い時は null */
  safety: number | null;
  /** 人家から離れた道の長さ(m) */
  remoteMetres: number;
  /** いちばん長く通る道の名前 */
  via: string;
  /** 経路から 30m 以内の事故の添字 */
  accidents: number[];
};

/** 平地の歩く速さ。Google マップの徒歩経路4区間の実測(分速71〜73m)に合わせた。 */
export const WALK_M_PER_MIN = 72;
/** 上り 20m を 1 分として足す。三宮→有馬で Google の所要時間に合わせた(1区間の比較)。 */
const MINUTES_PER_CLIMB_M = 0.05;
/** 曲がり角 1 つを、安全重視の時に何 m の遠回りとみなすか。路地のジグザグを抑える。 */
const TURN_M = 25;
const NEAR_M = 30;
/** 事故の重み 1 を、何 m の遠回りに換算するか */
const METRES_PER_RISK = 30;
const SAFETY_WEIGHTS = [0, 1, 3, 8];
const MAX_DETOUR = 1.7;
const MAX_OVERLAP = 0.85;
/** 夜に人家から離れた道を、何倍の長さとして扱うか。他に道があれば通らない。 */
const REMOTE_NIGHT = 4;
/** 評価できない道がこの割合を超える経路は、安全度を「不明」にする。 */
const MAX_UNKNOWN = 0.3;

/** 安全を重く見る度合いを変えて経路を出し、似た経路を除く。 */
export function findRoutes(
  g: Graph,
  from: Anchor,
  to: Anchor,
  period: Period,
  acc: AccidentIndex,
  meta: Meta,
  names: string[],
): Route[] {
  const risk = period === "night" ? g.riskNight : g.riskDay;
  const reference = period === "night" ? meta.riskPerKmNight : meta.riskPerKmDay;
  const found: Route[] = [];
  const nightRemote = period === "night" ? REMOTE_NIGHT : 1;
  if (from.edge === to.edge) return [alongOneEdge(g, from, to, names, acc)];

  for (const weight of SAFETY_WEIGHTS) {
    const climbM = WALK_M_PER_MIN * MINUTES_PER_CLIMB_M;
    const path = g.shortestPath(from, to, (e, node) => {
      const length = g.length[e] * (g.flags[e] & REMOTE ? nightRemote : 1);
      return length + climbM * g.climb(e, node) + weight * METRES_PER_RISK * risk[e] + (weight > 0 ? TURN_M : 0);
    });
    if (!path) return [];
    const { edges } = path;
    const lead = g.toEnd(from, path.from);
    const tail = g.toEnd(to, path.to).reverse();
    const leadM = lengthOf(lead);
    const tailM = lengthOf(tail);
    const onRoads = edges.reduce((sum, e) => sum + g.length[e], 0);
    const total = onRoads + leadM + tailM;
    if (found.length && total > found[0].metres * MAX_DETOUR) continue;
    if (found.some((r) => overlap(g, r.edges, edges) > MAX_OVERLAP)) continue;
    const coords = [...lead, ...g.pathCoords(edges, path.from).slice(1), ...tail.slice(1)];
    const legs: Leg[] = [
      { pts: lead, metres: leadM, name: names[g.nameId[from.edge]] ?? "" },
      ...edgeLegs(g, edges, path.from, names),
      { pts: tail, metres: tailM, name: names[g.nameId[to.edge]] ?? "" },
    ];
    const { climb, steps, via } = walkThrough(legs);
    const measure = (mask: number) => edges.reduce((sum, e) => sum + (g.flags[e] & mask ? g.length[e] : 0), 0);
    const perKm = edges.reduce((sum, e) => sum + risk[e], 0) / (Math.max(onRoads, 1) / 1000);
    found.push({
      label: "",
      edges,
      coords,
      metres: total,
      minutes: minutesFor(total, climb),
      climb,
      steps,
      safety: measure(REMOTE | OUTSIDE) > total * MAX_UNKNOWN ? null : Math.round(100 / (1 + perKm / reference)),
      remoteMetres: measure(REMOTE),
      via,
      accidents: acc.near(coords),
    });
  }

  const known = found.filter((r) => r.safety !== null);
  const safest = known.reduce<Route | null>((a, b) => (!a || b.safety! > a.safety! ? b : a), null);
  found.forEach((r, i) => {
    r.label = i === 0 ? "最短" : r === safest ? "最も安全" : "別の道";
  });
  if (found.length === 1) found[0].label = "おすすめ";
  return found;
}

export function minutesFor(metres: number, climb: number): number {
  return Math.ceil(metres / WALK_M_PER_MIN + climb * MINUTES_PER_CLIMB_M);
}

const STEP_MIN_M = 25;
const RENAME_MIN_M = 100;

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

/** 経路を歩く時の1区間 */
type Leg = { pts: [number, number][]; metres: number; name: string; climb?: number };

function lengthOf(coords: [number, number][]): number {
  let total = 0;
  for (let i = 0; i + 1 < coords.length; i++) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[i + 1];
    total += metres({ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 });
  }
  return total;
}

function edgeLegs(g: Graph, edges: number[], from: number, names: string[]): Leg[] {
  let node = from;
  return edges.map((e) => {
    const leg = { pts: g.edgeCoords(e, node), metres: g.length[e], name: names[g.nameId[e]] ?? "", climb: g.climb(e, node) };
    node = g.edgeU[e] === node ? g.edgeV[e] : g.edgeU[e];
    return leg;
  });
}

/** 同じ道の上の2点を結ぶ経路 */
function alongOneEdge(g: Graph, from: Anchor, to: Anchor, names: string[], acc: AccidentIndex): Route {
  const coords = g.between(from, to);
  const total = lengthOf(coords);
  const { steps, via } = walkThrough([{ pts: coords, metres: total, name: names[g.nameId[from.edge]] ?? "" }]);
  const remote = g.flags[from.edge] & REMOTE;
  return {
    label: "おすすめ",
    edges: [],
    coords,
    metres: total,
    minutes: minutesFor(total, 0),
    climb: 0,
    steps,
    safety: null,
    remoteMetres: remote ? total : 0,
    via,
    accidents: acc.near(coords),
  };
}

/** 区間の列をたどり、上りの合計と曲がる場所ごとの案内を作る。 */
function walkThrough(legs: Leg[]): { climb: number; steps: Step[]; via: string } {
  let climb = 0;
  let heading: number | null = null;
  const steps: (Step & { road: string })[] = [];
  const byRoad = new Map<string, number>();
  for (const leg of legs) {
    if (leg.metres < 1 || leg.pts.length < 2) continue;
    climb += leg.climb ?? 0;
    const pts = leg.pts;
    const road = displayName(leg.name);
    if (road) byRoad.set(road, (byRoad.get(road) ?? 0) + leg.metres);
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
    current.metres += leg.metres;
    if (!current.road) current.road = road;
    heading = bearing(pts[pts.length - 2], pts[pts.length - 1]);
  }
  // 短い橋などで道路名が変わるだけの区間は、案内に出さず前の手順へまとめる。
  for (let i = steps.length - 1; i > 0; i--) {
    if (steps[i].text === "道なりに進む" && steps[i].metres < RENAME_MIN_M) {
      steps[i - 1].metres += steps[i].metres;
      steps.splice(i, 1);
    }
  }
  const via = [...byRoad].reduce((a, b) => (b[1] > a[1] ? b : a), ["", 0] as [string, number])[0];
  return {
    climb: Math.round(climb),
    steps: steps.map(({ text, metres, at, road }) => ({ text: road ? `${text}（${road}）` : text, metres, at })),
    via,
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
  return total ? shared / total : 1;
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
