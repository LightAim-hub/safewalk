export type LatLon = { lat: number; lon: number };

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
  private readonly geomStart: Uint32Array;
  private readonly geomLat: Int32Array;
  private readonly geomLon: Int32Array;
  private readonly adjStart: Uint32Array;
  private readonly adjEdge: Uint32Array;
  private readonly grid = new Map<string, number[]>();

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
    this.geomStart = take(Uint32Array, m + 1, 4);
    this.geomLat = take(Int32Array, k, 4);
    this.geomLon = take(Int32Array, k, 4);

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
    for (let i = 0; i < n; i++) {
      const key = cellKey(this.nodeLat[i] / 1e6, this.nodeLon[i] / 1e6);
      const list = this.grid.get(key);
      if (list) list.push(i);
      else this.grid.set(key, [i]);
    }
  }

  /** 指定地点にいちばん近い交差点。範囲外なら null。 */
  nearestNode(p: LatLon): number | null {
    const [cy, cx] = cell(p.lat, p.lon);
    let best: number | null = null;
    let bestD = Infinity;
    for (let radius = 0; radius <= 4; radius++) {
      for (let y = cy - radius; y <= cy + radius; y++) {
        for (let x = cx - radius; x <= cx + radius; x++) {
          if (Math.max(Math.abs(y - cy), Math.abs(x - cx)) !== radius) continue;
          for (const i of this.grid.get(`${y}:${x}`) ?? []) {
            const d = metres(p, { lat: this.nodeLat[i] / 1e6, lon: this.nodeLon[i] / 1e6 });
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
      if (best !== null) return best;
    }
    return null;
  }

  /** 辺ごとの費用で最短経路を求め、辺の列を返す。 */
  shortestPath(from: number, to: number, cost: (edge: number) => number): number[] | null {
    const dist = new Float64Array(this.nNodes).fill(Infinity);
    const prev = new Int32Array(this.nNodes).fill(-1);
    const heap = new MinHeap();
    dist[from] = 0;
    heap.push(0, from);
    while (heap.size > 0) {
      const [d, node] = heap.pop();
      if (d > dist[node]) continue;
      if (node === to) break;
      for (let a = this.adjStart[node]; a < this.adjStart[node + 1]; a++) {
        const e = this.adjEdge[a];
        const next = this.edgeU[e] === node ? this.edgeV[e] : this.edgeU[e];
        const nd = d + cost(e);
        if (nd < dist[next]) {
          dist[next] = nd;
          prev[next] = e;
          heap.push(nd, next);
        }
      }
    }
    if (dist[to] === Infinity) return null;
    const path: number[] = [];
    for (let n = to; n !== from; ) {
      const e = prev[n];
      path.push(e);
      n = this.edgeU[e] === n ? this.edgeV[e] : this.edgeU[e];
    }
    return path.reverse();
  }

  /** 辺の列を、歩く向きの座標列 [lon, lat] にする。 */
  pathCoords(path: number[], from: number): [number, number][] {
    const out: [number, number][] = [];
    let node = from;
    for (const e of path) {
      const pts: [number, number][] = [];
      for (let i = this.geomStart[e]; i < this.geomStart[e + 1]; i++) {
        pts.push([this.geomLon[i] / 1e6, this.geomLat[i] / 1e6]);
      }
      if (this.edgeU[e] !== node) pts.reverse();
      out.push(...(out.length ? pts.slice(1) : pts));
      node = this.edgeU[e] === node ? this.edgeV[e] : this.edgeU[e];
    }
    return out;
  }
}

const CELL_DEG = 0.002;

function cell(lat: number, lon: number): [number, number] {
  return [Math.floor(lat / CELL_DEG), Math.floor(lon / CELL_DEG)];
}

function cellKey(lat: number, lon: number): string {
  const [y, x] = cell(lat, lon);
  return `${y}:${x}`;
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
