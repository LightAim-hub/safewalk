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
  /** 下りの合計(m) */
  descent: number;
  /** [出発からの距離(m), 出発地からの高さ(m)] */
  profile: [number, number][];
  steps: Step[];
  /** 旧い安全度(%)。画面が src/safety.ts の assess() に切り替わったら消す。評価できない道が多い時は null */
  safety: number | null;
  /** 人家から離れた道の長さ(m) */
  remoteMetres: number;
  /** 神戸市の外の道の長さ(m)。事故データが無く、段階を出せない。 */
  outsideMetres: number;
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
  let found: Route[] = [];
  const nightRemote = period === "night" ? REMOTE_NIGHT : 1;
  if (from.edge === to.edge) return [alongOneEdge(g, from, to, names, acc, risk, reference)];

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
    const { climb, descent, profile, steps, via, roads } = walkThrough(legs);
    const pieces: Piece[] = [
      [from.edge, leadM],
      ...edges.map((e): Piece => [e, g.length[e]]),
      [to.edge, tailM],
    ];
    const route: Route = {
      label: "",
      edges,
      coords,
      metres: total,
      minutes: minutesFor(total, climb),
      climb,
      descent,
      profile,
      steps,
      safety: safetyOf(g, pieces, risk, reference),
      remoteMetres: flaggedMetres(g, pieces, REMOTE),
      outsideMetres: flaggedMetres(g, pieces, OUTSIDE),
      via,
      accidents: acc.near(coords),
    };
    roadsOf.set(route, roads);
    found.push(route);
  }

  found = dropWorse(g, found, period, acc);
  const known = found.filter((r) => r.safety !== null);
  const safest = known.reduce<Route | null>((a, b) => (!a || b.safety! > a.safety! ? b : a), null);
  const shortestCount = countNear(found[0], period, acc);
  found.forEach((r, i) => {
    // 「事故の記録が少ない道」は、最短より記録が少ない時だけ名乗る。
    r.label = i === 0 ? "最短" : r === safest && countNear(r, period, acc) < shortestCount ? "事故の記録が少ない道" : "別の道";
  });
  if (found.length === 1) found[0].label = "おすすめ";
  distinctVias(found);
  return found;
}

/** 画面に出す事故の件数(歩行者・自転車が関わる記録。夜は夜間のみ)。src/safety.ts の assess と同じ数え方。 */
function countNear(route: Route, period: Period, acc: AccidentIndex): number {
  const d = acc.data;
  return route.accidents.filter((i) => (d.ped[i] || d.bike[i]) && (period !== "night" || d.night[i])).length;
}

/**
 * 一覧に出さない経路を除く。
 * - 別の経路が、距離・時間・事故の件数のどれも同じか良く、どれか一つは良い経路(負けている経路)。
 * - 距離・時間・件数が同じで、道の大半が重なる経路(ほぼ同じ経路)。
 * 先頭(最短・既定の経路)は、何があっても残す。
 */
function dropWorse(g: Graph, routes: Route[], period: Period, acc: AccidentIndex): Route[] {
  const count = routes.map((r) => countNear(r, period, acc));
  return routes.filter((r, i) => {
    if (i === 0) return true;
    return !routes.some((o, j) => {
      if (j === i) return false;
      const noWorse = o.metres <= r.metres && o.minutes <= r.minutes && count[j] <= count[i];
      if (!noWorse) return false;
      const same = o.metres === r.metres && o.minutes === r.minutes && count[j] === count[i];
      // 全部同じ値の時は、道が重なっていて、かつ先に出した方を残す。
      return same ? j < i && overlap(g, o.edges, r.edges) > 0.6 : true;
    });
  });
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

/** [辺, その辺を歩く長さ(m)] */
type Piece = [number, number];

function flaggedMetres(g: Graph, pieces: Piece[], mask: number): number {
  return pieces.reduce((sum, [e, m]) => sum + (g.flags[e] & mask ? m : 0), 0);
}

/** 通る長さの割合で事故の重みを数える。評価できない道が多い時は null。 */
function safetyOf(g: Graph, pieces: Piece[], risk: Float32Array, reference: number): number | null {
  const total = pieces.reduce((sum, [, m]) => sum + m, 0);
  if (flaggedMetres(g, pieces, REMOTE | OUTSIDE) > total * MAX_UNKNOWN) return null;
  const weight = pieces.reduce((sum, [e, m]) => sum + (risk[e] * m) / Math.max(g.length[e], 1), 0);
  return Math.round(100 / (1 + weight / (Math.max(total, 1) / 1000) / reference));
}

/** 経路を歩く時の1区間 */
type Leg = { pts: [number, number][]; metres: number; name: string; climb?: number; descent?: number };

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
    const next = g.edgeU[e] === node ? g.edgeV[e] : g.edgeU[e];
    const leg = {
      pts: g.edgeCoords(e, node),
      metres: g.length[e],
      name: names[g.nameId[e]] ?? "",
      climb: g.climb(e, node),
      descent: g.climb(e, next),
    };
    node = next;
    return leg;
  });
}

/** 同じ道の上の2点を結ぶ経路 */
function alongOneEdge(
  g: Graph,
  from: Anchor,
  to: Anchor,
  names: string[],
  acc: AccidentIndex,
  risk: Float32Array,
  reference: number,
): Route {
  const coords = g.between(from, to);
  const total = lengthOf(coords);
  const { steps, via, profile } = walkThrough([{ pts: coords, metres: total, name: names[g.nameId[from.edge]] ?? "" }]);
  const pieces: Piece[] = [[from.edge, total]];
  return {
    label: "おすすめ",
    edges: [],
    coords,
    metres: total,
    minutes: minutesFor(total, 0),
    climb: 0,
    descent: 0,
    profile,
    steps,
    safety: safetyOf(g, pieces, risk, reference),
    remoteMetres: flaggedMetres(g, pieces, REMOTE),
    outsideMetres: flaggedMetres(g, pieces, OUTSIDE),
    via,
    accidents: acc.near(coords),
  };
}

/** 区間の列をたどり、上りの合計と曲がる場所ごとの案内を作る。 */
function walkThrough(legs: Leg[]): {
  climb: number;
  descent: number;
  profile: [number, number][];
  steps: Step[];
  via: string;
  roads: Map<string, number>;
} {
  let climb = 0;
  let descent = 0;
  let walked = 0;
  const profile: [number, number][] = [[0, 0]];
  let heading: number | null = null;
  const steps: (Step & { road: string; entry: number | null })[] = [];
  const byRoad = new Map<string, number>();
  for (const leg of legs) {
    if (leg.metres < 1 || leg.pts.length < 2) continue;
    climb += leg.climb ?? 0;
    descent += leg.descent ?? 0;
    walked += leg.metres;
    profile.push([walked, climb - descent]);
    const pts = leg.pts;
    const road = displayName(leg.name);
    if (road) byRoad.set(road, (byRoad.get(road) ?? 0) + leg.metres);
    const start = bearing(pts[0], pts[1]);
    const last = steps[steps.length - 1];
    if (!last) {
      steps.push({ text: `${compass(start)}へ歩き始める`, metres: 0, at: pts[0], road, entry: null });
    } else {
      const delta = ((start - heading! + 540) % 360) - 180;
      const turn = turnWord(delta);
      const renamed = road !== "" && last.road !== "" && road !== last.road;
      if (turn && last.metres >= STEP_MIN_M) steps.push({ text: turn, metres: 0, at: pts[0], road, entry: heading });
      else if (turn && last.entry === null) last.text = `${compass(start)}へ歩き始める`;
      else if (turn) {
        // 短い区間の直後に曲がる時は、その手前からの向きの変化を1つの案内にする。
        last.text = turnWord(((start - last.entry! + 540) % 360) - 180) ?? "道なりに進む";
      } else if (renamed && last.metres >= STEP_MIN_M) {
        steps.push({ text: "道なりに進む", metres: 0, at: pts[0], road, entry: heading });
      }
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
  const result = {
    climb: Math.round(climb),
    descent: Math.round(descent),
    profile,
    steps: steps.map(({ text, metres, at, road }) => ({ text: stepText(text, road), metres, at })),
    via,
    roads: byRoad,
  };
  return result;
}

/** 道の名前がある時は名前を添え、無い時は「次の角を」のように位置で言う。 */
function stepText(text: string, road: string): string {
  if (road) return `${text}（${road}）`;
  if (text.endsWith("歩き始める") || text === "道なりに進む") return text;
  if (text.startsWith("やや")) return `次の分かれ道で${text}`;
  return `次の角を${text}`;
}

/** 経路ごとの、道の名前と通る長さ。経由名を経路どうしで区別するために使う。 */
const roadsOf = new WeakMap<object, Map<string, number>>();

/** 「〜経由」の名前を、他の経路と見分けがつく道から選ぶ。 */
function distinctVias(routes: Route[]): void {
  const roads = routes.map((r) => roadsOf.get(r) ?? new Map<string, number>());
  const taken = new Set<string>();
  const order = routes.map((_, i) => i);
  // 他の経路と重ならない長い道を持つ経路から決める。
  const unique = (i: number) =>
    [...roads[i]]
      .filter(([name, len]) => len >= UNIQUE_MIN_M && roads.every((o, j) => j === i || (o.get(name) ?? 0) < len * 0.25))
      .sort((a, b) => b[1] - a[1]);
  order.sort((a, b) => (unique(b)[0]?.[1] ?? 0) - (unique(a)[0]?.[1] ?? 0));
  for (const i of order) {
    const pick =
      unique(i).find(([n]) => !taken.has(n)) ??
      [...roads[i]].sort((a, b) => b[1] - a[1]).find(([n]) => !taken.has(n));
    routes[i].via = pick ? pick[0] : "";
    if (pick) taken.add(pick[0]);
  }
}
const UNIQUE_MIN_M = 150;

/** 経由地で区切った経路を、1本の経路につなぐ。 */
export function joinRoutes(parts: Route[], stopNames: string[]): Route {
  const head = parts[0];
  const route: Route = { ...head, label: "経由地あり", accidents: [...head.accidents], steps: [...head.steps], coords: [...head.coords] };
  let longest = head;
  parts.slice(1).forEach((part, i) => {
    const at = part.coords[0];
    const shift = route.metres;
    const rise = route.profile[route.profile.length - 1][1];
    route.steps.push({ text: `経由地「${stopNames[i]}」`, metres: 0, at }, ...part.steps);
    route.coords.push(...part.coords.slice(1));
    route.edges = [...route.edges, ...part.edges];
    route.profile = [...route.profile, ...part.profile.map(([d, h]): [number, number] => [d + shift, h + rise])];
    route.metres += part.metres;
    route.climb += part.climb;
    route.descent += part.descent;
    route.remoteMetres += part.remoteMetres;
    route.outsideMetres += part.outsideMetres;
    route.accidents.push(...part.accidents);
    if (part.metres > longest.metres) longest = part;
  });
  const known = parts.every((part) => part.safety !== null);
  const weighted = parts.reduce((sum, part) => sum + (part.safety ?? 0) * part.metres, 0);
  route.safety = known ? Math.round(weighted / route.metres) : null;
  route.via = longest.via;
  route.accidents = [...new Set(route.accidents)];
  route.minutes = minutesFor(route.metres, route.climb);
  return route;
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
