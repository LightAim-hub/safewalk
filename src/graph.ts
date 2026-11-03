export type LatLon = { lat: number; lon: number };

/** 人家から離れた道 */
export const REMOTE = 1;
/** 神戸市の外の道。事故データがない。 */
export const OUTSIDE = 2;

/** 道の途中の地点。辺の両端までの距離を持つ。 */
export type Anchor = {
  edge: number;
  /** 辺の点の列で、この地点の直前にある点の番号 */
  index: number;
  point: [number, number];
  toU: number;
  toV: number;
  /** 元の地点から道までの距離(m) */
  metres: number;
};

export type Path = { edges: number[]; from: number; to: number };

/** pipeline/02_graph.py が書き出す graph.bin を読み、経路探索できる形にする。 */
export class Graph {
  readonly nNodes: number;
  readonly nEdges: number;
  readonly nodeLat: Int32Array;
  readonly nodeLon: Int32Array;
  readonly edgeU: Uint32Array;
  readonly edgeV: Uint32Array;
  readonly length: Float32Array;
  readonly riskDay: Float32Array;
  readonly riskNight: Float32Array;
  readonly climbForward: Float32Array;
  readonly climbBackward: Float32Array;
  readonly nameId: Uint32Array;
  readonly flags: Uint32Array;
  /** 夜の費用に足す割合(1000分の1)。pipeline/05_crime.py が graph.bin の末尾に付ける。無ければ 0。 */
  readonly nightExtra: Uint8Array;
  private readonly geomStart: Uint32Array;
  private readonly geomLat: Int32Array;
  private readonly geomLon: Int32Array;
  private readonly adjStart: Uint32Array;
  private readonly adjEdge: Uint32Array;
  /** 格子ごとの、その中に点を持つ辺 */
  private readonly grid = new Map<number, number[]>();

  constructor(buf: ArrayBuffer) {
    const [n, m, k] = new Uint32Array(buf, 0, 3);
    this.nNodes = n;
    this.nEdges = m;
    let off = 12;
    const take = <T>(make: new (b: ArrayBuffer, o: number, l: number) => T, len: number, size: number): T => {
      const arr = new make(buf, off, len);
      off += len * size;
      return arr;
    };
    this.nodeLat = take(Int32Array, n, 4);
    this.nodeLon = take(Int32Array, n, 4);
    this.edgeU = take(Uint32Array, m, 4);
    this.edgeV = take(Uint32Array, m, 4);
    this.length = take(Float32Array, m, 4);
    this.riskDay = take(Float32Array, m, 4);
    this.riskNight = take(Float32Array, m, 4);
    this.climbForward = take(Float32Array, m, 4);
    this.climbBackward = take(Float32Array, m, 4);
    this.nameId = take(Uint32Array, m, 4);
    this.flags = take(Uint32Array, m, 4);
    this.geomStart = take(Uint32Array, m + 1, 4);
    this.geomLat = take(Int32Array, k, 4);
    this.geomLon = take(Int32Array, k, 4);
    this.nightExtra = buf.byteLength >= off + m ? new Uint8Array(buf, off, m) : new Uint8Array(m);

    const degree = new Uint32Array(n + 1);
    for (let e = 0; e < m; e++) {
      degree[this.edgeU[e]]++;
      degree[this.edgeV[e]]++;
    }
    this.adjStart = new Uint32Array(n + 1);
    for (let i = 0; i < n; i++) this.adjStart[i + 1] = this.adjStart[i] + degree[i];
    this.adjEdge = new Uint32Array(m * 2);
    const fill = this.adjStart.slice();
    for (let e = 0; e < m; e++) {
      this.adjEdge[fill[this.edgeU[e]]++] = e;
      this.adjEdge[fill[this.edgeV[e]]++] = e;
    }
    for (let e = 0; e < m; e++) {
      const add = (lat: number, lon: number) => {
        const key = cellOf(lat, lon);
        const list = this.grid.get(key);
        if (!list) this.grid.set(key, [e]);
        else if (list[list.length - 1] !== e) list.push(e);
      };
      for (let i = this.geomStart[e]; i < this.geomStart[e + 1]; i++) {
        const lat = this.geomLat[i] / 1e6;
        const lon = this.geomLon[i] / 1e6;
        add(lat, lon);
        if (i + 1 === this.geomStart[e + 1]) break;
        // 長い線分の途中の格子にも登録する。頂点だけだと線分の中ほどで別の道を拾う。
        const dLat = this.geomLat[i + 1] / 1e6 - lat;
        const dLon = this.geomLon[i + 1] / 1e6 - lon;
        const parts = Math.ceil(Math.max(Math.abs(dLat), Math.abs(dLon)) / (CELL_DEG / 2));
        for (let t = 1; t < parts; t++) add(lat + (dLat * t) / parts, lon + (dLon * t) / parts);
      }
    }
  }

  /** 指定地点にいちばん近い道の上の点。範囲外なら null。 */
  nearestRoad(p: LatLon): Anchor | null {
    const row = Math.floor(p.lat / CELL_DEG);
    const col = Math.floor(p.lon / CELL_DEG);
    const seen = new Set<number>();
    let best = null as Anchor | null;
    for (let radius = 0; radius <= 12; radius++) {
      for (let y = row - radius; y <= row + radius; y++) {
        for (let x = col - radius; x <= col + radius; x++) {
          if (Math.max(Math.abs(y - row), Math.abs(x - col)) !== radius) continue;
          for (const e of this.grid.get(y * ROW + x) ?? []) {
            if (seen.has(e)) continue;
            seen.add(e);
            const found = this.closestOnEdge(e, p);
            if (!best || found.metres < best.metres) best = found;
          }
        }
      }
      // 外側の輪により近い道が残っていないと言える時だけ止める。
      if (best && best.metres <= radius * CELL_MIN_M) return best;
    }
    return best;
  }

  private closestOnEdge(edge: number, p: LatLon): Anchor {
    const start = this.geomStart[edge];
    const count = this.geomStart[edge + 1] - start;
    const k = Math.cos((p.lat * Math.PI) / 180);
    let walked = 0;
    let best = { d: Infinity, along: 0, index: 0, point: [0, 0] as [number, number] };
    for (let i = 0; i + 1 < count; i++) {
      const a = { lat: this.geomLat[start + i] / 1e6, lon: this.geomLon[start + i] / 1e6 };
      const b = { lat: this.geomLat[start + i + 1] / 1e6, lon: this.geomLon[start + i + 1] / 1e6 };
      const dx = (b.lon - a.lon) * k;
      const dy = b.lat - a.lat;
      const size = dx * dx + dy * dy;
      const t = size ? Math.max(0, Math.min(1, (((p.lon - a.lon) * k) * dx + (p.lat - a.lat) * dy) / size)) : 0;
      const on = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
      const d = metres(p, on);
      const span = metres(a, b);
      if (d < best.d) best = { d, along: walked + span * t, index: i, point: [on.lon, on.lat] };
      walked += span;
    }
    return { edge, index: best.index, point: best.point, toU: best.along, toV: walked - best.along, metres: best.d };
  }

  /** 道の途中の点から、辺の端までの座標列。端が近い順ではなく、点から端へ向かう順に返す。 */
  toEnd(a: Anchor, node: number): [number, number][] {
    const pts = this.edgeCoords(a.edge, this.edgeU[a.edge]);
    const toward = this.edgeU[a.edge] === node ? pts.slice(0, a.index + 1).reverse() : pts.slice(a.index + 1);
    return distinct([a.point, ...toward]);
  }

  /** 同じ辺の上の2点の間の座標列 */
  between(a: Anchor, b: Anchor): [number, number][] {
    const pts = this.edgeCoords(a.edge, this.edgeU[a.edge]);
    if (a.toU <= b.toU) return distinct([a.point, ...pts.slice(a.index + 1, b.index + 1), b.point]);
    return distinct([a.point, ...pts.slice(b.index + 1, a.index + 1).reverse(), b.point]);
  }

  /** 辺ごとの費用で、道の上の2点を結ぶ最短経路を求める。 */
  shortestPath(start: Anchor, goal: Anchor, cost: (edge: number, node: number) => number): Path | null {
    const dist = new Float64Array(this.nNodes).fill(Infinity);
    const prev = new Int32Array(this.nNodes).fill(-1);
    const heap = new MinHeap();
    const seed = (node: number, d: number) => {
      if (d >= dist[node]) return;
      dist[node] = d;
      heap.push(d, node);
    };
    seed(this.edgeU[start.edge], start.toU);
    seed(this.edgeV[start.edge], start.toV);
    const ends: [number, number][] = [
      [this.edgeU[goal.edge], goal.toU],
      [this.edgeV[goal.edge], goal.toV],
    ];
    let to = -1;
    let bestTotal = Infinity;
    while (heap.size > 0) {
      const [d, node] = heap.pop();
      if (d > dist[node]) continue;
      if (d >= bestTotal) break;
      for (const [end, rest] of ends) {
        if (end === node && d + rest < bestTotal) {
          bestTotal = d + rest;
          to = node;
        }
      }
      for (let a = this.adjStart[node]; a < this.adjStart[node + 1]; a++) {
        const e = this.adjEdge[a];
        const next = this.edgeU[e] === node ? this.edgeV[e] : this.edgeU[e];
        const nd = d + cost(e, node);
        if (nd < dist[next]) {
          dist[next] = nd;
          prev[next] = e;
          heap.push(nd, next);
        }
      }
    }
    if (to < 0) return null;
    const edges: number[] = [];
    let from = to;
    while (prev[from] >= 0) {
      const e = prev[from];
      edges.push(e);
      from = this.edgeU[e] === from ? this.edgeV[e] : this.edgeU[e];
    }
    return { edges: edges.reverse(), from, to };
  }

  /** 地点 node からこの辺を歩く時の上り(m) */
  climb(edge: number, node: number): number {
    return this.edgeU[edge] === node ? this.climbForward[edge] : this.climbBackward[edge];
  }

  /** 辺を node から歩く向きの座標列にする。 */
  edgeCoords(edge: number, node: number): [number, number][] {
    const pts: [number, number][] = [];
    for (let i = this.geomStart[edge]; i < this.geomStart[edge + 1]; i++) {
      pts.push([this.geomLon[i] / 1e6, this.geomLat[i] / 1e6]);
    }
    if (this.edgeU[edge] !== node) pts.reverse();
    return pts;
  }

  /** 辺の列を、歩く向きの座標列 [lon, lat] にする。 */
  pathCoords(path: number[], from: number): [number, number][] {
    const out: [number, number][] = [];
    let node = from;
    for (const e of path) {
      const pts = this.edgeCoords(e, node);
      out.push(...(out.length ? pts.slice(1) : pts));
      node = this.edgeU[e] === node ? this.edgeV[e] : this.edgeU[e];
    }
    return out;
  }
}

const CELL_DEG = 0.002;
/** 格子1マスの短い方の辺の長さ(神戸の緯度で経度方向 約183m) */
const CELL_MIN_M = 180;
/** 格子の行と列を1つの数にする時の桁 */
const ROW = 1_000_000;

function cellOf(lat: number, lon: number): number {
  return Math.floor(lat / CELL_DEG) * ROW + Math.floor(lon / CELL_DEG);
}

/** 同じ座標が続くと向きを求められないので、連続する重複を除く。 */
function distinct(coords: [number, number][]): [number, number][] {
  return coords.filter((c, i) => i === 0 || c[0] !== coords[i - 1][0] || c[1] !== coords[i - 1][1]);
}

export function metres(a: LatLon, b: LatLon): number {
  const x = ((b.lon - a.lon) * Math.PI) / 180 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const y = ((b.lat - a.lat) * Math.PI) / 180;
  return 6371000 * Math.hypot(x, y);
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, val: number): void {
    const { keys, vals } = this;
    let i = keys.length;
    keys.push(key);
    vals.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }

  pop(): [number, number] {
    const { keys, vals } = this;
    const top: [number, number] = [keys[0], vals[0]];
    const key = keys.pop()!;
    const val = vals.pop()!;
    const n = keys.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = key;
      vals[i] = val;
    }
    return top;
  }
}
