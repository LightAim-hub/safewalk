"""OpenStreetMap から歩ける道のグラフを作り、事故の重みを道に乗せる。

出力 public/data/graph.bin の形式(すべてリトルエンディアン):
  Uint32  nNodes, nEdges, nCoords
  Int32   nodeLat[nNodes], nodeLon[nNodes]   (度 x 1e6)
  Uint32  edgeU[nEdges], edgeV[nEdges]
  Float32 length[nEdges]                     (m)
  Float32 riskDay[nEdges], riskNight[nEdges]
  Float32 climbForward[nEdges], climbBackward[nEdges]  (m。U→V と V→U の上り)
  Uint32  nameId[nEdges]                     (public/data/names.json の添字)
  Uint32  geomStart[nEdges + 1]
  Int32   geomLat[nCoords], geomLon[nCoords] (度 x 1e6)
"""
import json
import math
import struct
from collections import defaultdict
from pathlib import Path

import numpy as np
import osmium
import shapely

from area import BBOX, kobe
from dem import Elevation

KOBE = kobe()
PBF = "data/raw/kansai.osm.pbf"
ACC = Path("public/data/accidents.json")
OUT = Path("public/data/graph.bin")
META = Path("public/data/graph.meta.json")
NAMES = Path("public/data/names.json")

WALKABLE = {
    "footway", "path", "pedestrian", "steps", "living_street", "residential", "service",
    "unclassified", "tertiary", "tertiary_link", "secondary", "secondary_link",
    "primary", "primary_link", "track", "cycleway", "corridor",
}
# 山道は徒歩ナビの経路に出さない。path と track は、舗装か街灯の記録がある時だけ通す。
TRAILS = {"path", "track"}
PAVED = {"asphalt", "concrete", "paved", "paving_stones", "sett", "concrete:plates", "concrete:lanes"}
SAMPLE_M = 30.0  # 標高を見る間隔
CLIMB_STEP_M = 2.0  # これ未満の標高差は標高データの揺れとして数えない
NEAR_M = 30.0  # 事故をこの距離まで道に結び付ける
SIGMA_M = 15.0  # 距離による減衰


class Ways(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways = []

    def way(self, w):
        tags = w.tags
        hw = tags.get("highway")
        if hw is None:
            return
        foot = tags.get("foot", "")
        if foot == "no":
            return
        allowed = hw in WALKABLE or (hw in ("trunk", "trunk_link") and foot in ("yes", "designated"))
        if not allowed:
            return
        if tags.get("access") in ("private", "no") and foot not in ("yes", "designated"):
            return
        if tags.get("area") == "yes":
            return
        if tags.get("sac_scale"):
            return
        # 有料道路と自動車専用道路は歩けない。
        if tags.get("motorroad") == "yes" or (tags.get("toll") == "yes" and foot not in ("yes", "designated")):
            return
        if hw in TRAILS and tags.get("surface") not in PAVED and tags.get("lit") != "yes":
            return
        s, west, n, e = BBOX
        pts = []
        for nd in w.nodes:
            if not nd.location.valid():
                continue
            pts.append((nd.ref, nd.location.lat, nd.location.lon))
        if len(pts) < 2 or not any(s <= p[1] <= n and west <= p[2] <= e for p in pts):
            return
        # 市内の点を1つでも持つ道を残す。市境の道が途中で切れないようにするため。
        if shapely.contains_xy(KOBE, [p[2] for p in pts], [p[1] for p in pts]).any():
            flat = tags.get("bridge", "no") != "no" or tags.get("tunnel", "no") != "no"
            self.ways.append((pts, tags.get("name") or tags.get("ref") or "", flat))


def metres(lat1, lon1, lat2, lon2):
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    y = math.radians(lat2 - lat1)
    return 6371000 * math.hypot(x, y)


class Edge(list):
    """点の列に、道路名と標高を見ない印を持たせたもの。"""

    name = ""
    flat = False


def new_edge(points, name, flat):
    edge = Edge(points)
    edge.name = name
    edge.flat = flat
    return edge


def split_edges(ways):
    use = defaultdict(int)
    for pts, _, _ in ways:
        for ref, _, _ in pts:
            use[ref] += 1
        use[pts[0][0]] += 1
        use[pts[-1][0]] += 1
    edges = []
    for pts, name, flat in ways:
        cur = [pts[0]]
        for p in pts[1:]:
            cur.append(p)
            if use[p[0]] > 1:
                edges.append(new_edge(cur, name, flat))
                cur = [p]
        if len(cur) > 1:
            edges.append(new_edge(cur, name, flat))
    return edges


def largest_component(edges):
    parent = {}

    def find(a):
        parent.setdefault(a, a)
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for e in edges:
        ra, rb = find(e[0][0]), find(e[-1][0])
        if ra != rb:
            parent[ra] = rb
    sizes = defaultdict(int)
    for e in edges:
        sizes[find(e[0][0])] += 1
    root = max(sizes, key=sizes.get)
    print("largest component", sizes[root], "of", len(edges), "edges")
    return [e for e in edges if find(e[0][0]) == root]


def point_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def accident_weight(ped, bike, dead):
    base = 3.0 if ped else 1.5 if bike else 0.4
    return base * (3.0 if dead else 1.0)


def attach_risk(edges):
    """事故を近くの道へ配る。歩行者の事故ほど、死亡事故ほど重く数える。"""
    a = json.loads(ACC.read_text(encoding="utf-8"))
    lat0 = (BBOX[0] + BBOX[2]) / 2
    kx = 111320 * math.cos(math.radians(lat0))
    ky = 110940
    cell = 60.0
    grid = defaultdict(list)
    for i, e in enumerate(edges):
        for (_, la1, lo1), (_, la2, lo2) in zip(e, e[1:]):
            n = max(1, int(metres(la1, lo1, la2, lo2) / cell))
            for t in range(n + 1):
                la = la1 + (la2 - la1) * t / n
                lo = lo1 + (lo2 - lo1) * t / n
                key = (int(lo * kx / cell), int(la * ky / cell))
                if not grid[key] or grid[key][-1] != i:
                    grid[key].append(i)
    day = np.zeros(len(edges), dtype=np.float32)
    night = np.zeros(len(edges), dtype=np.float32)
    for k in range(len(a["lat"])):
        px, py = a["lon"][k] * kx, a["lat"][k] * ky
        cx, cy = int(px / cell), int(py / cell)
        seen = set()
        for ix in range(cx - 1, cx + 2):
            for iy in range(cy - 1, cy + 2):
                seen.update(grid.get((ix, iy), ()))
        w = accident_weight(a["ped"][k], a["bike"][k], a["dead"][k])
        for i in seen:
            pts = edges[i]
            d = min(
                point_segment(px, py, p[2] * kx, p[1] * ky, q[2] * kx, q[1] * ky)
                for p, q in zip(pts, pts[1:])
            )
            if d > NEAR_M:
                continue
            v = w * math.exp(-((d / SIGMA_M) ** 2))
            if a["night"][k]:
                night[i] += v
                day[i] += 0.3 * v
            else:
                day[i] += v
                night[i] += 0.3 * v
    return day, night


def climbs(edges):
    """辺ごとに、両方向の上りの合計を標高タイルから求める。"""
    dem = Elevation(BBOX)
    forward = np.zeros(len(edges), dtype=np.float32)
    backward = np.zeros(len(edges), dtype=np.float32)
    for i, e in enumerate(edges):
        if e.flat:
            continue
        heights = []
        for (_, la1, lo1), (_, la2, lo2) in zip(e, e[1:]):
            n = max(1, int(metres(la1, lo1, la2, lo2) / SAMPLE_M))
            heights += [dem.at(la1 + (la2 - la1) * t / n, lo1 + (lo2 - lo1) * t / n) for t in range(n)]
        heights.append(dem.at(e[-1][1], e[-1][2]))
        last = heights[0]
        for h in heights[1:]:
            if abs(h - last) < CLIMB_STEP_M:
                continue
            if h > last:
                forward[i] += h - last
            else:
                backward[i] += last - h
            last = h
    return forward, backward


def main():
    h = Ways()
    h.apply_file(PBF, locations=True, idx="flex_mem")
    print("ways", len(h.ways))
    edges = largest_component(split_edges(h.ways))
    print("edges", len(edges))

    index = {}
    for e in edges:
        for p in (e[0], e[-1]):
            index.setdefault(p[0], (len(index), p[1], p[2]))
    n_lat = np.zeros(len(index), dtype=np.int32)
    n_lon = np.zeros(len(index), dtype=np.int32)
    for i, la, lo in index.values():
        n_lat[i], n_lon[i] = round(la * 1e6), round(lo * 1e6)

    u = np.array([index[e[0][0]][0] for e in edges], dtype=np.uint32)
    v = np.array([index[e[-1][0]][0] for e in edges], dtype=np.uint32)
    length = np.array(
        [sum(metres(p[1], p[2], q[1], q[2]) for p, q in zip(e, e[1:])) for e in edges],
        dtype=np.float32,
    )
    day, night = attach_risk(edges)
    climb_f, climb_b = climbs(edges)
    names = {"": 0}
    name_id = np.array([names.setdefault(e.name, len(names)) for e in edges], dtype=np.uint32)
    NAMES.write_text(json.dumps(list(names), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    start = np.zeros(len(edges) + 1, dtype=np.uint32)
    start[1:] = np.cumsum([len(e) for e in edges])
    g_lat = np.array([round(p[1] * 1e6) for e in edges for p in e], dtype=np.int32)
    g_lon = np.array([round(p[2] * 1e6) for e in edges for p in e], dtype=np.int32)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("wb") as f:
        f.write(struct.pack("<III", len(index), len(edges), len(g_lat)))
        for arr in (n_lat, n_lon, u, v, length, day, night, climb_f, climb_b, name_id, start, g_lat, g_lon):
            f.write(arr.tobytes())

    km = float(length.sum()) / 1000
    meta = {
        "bbox": BBOX,
        "nodes": len(index),
        "edges": len(edges),
        "km": round(km),
        "riskPerKmDay": round(float(day.sum()) / km, 4),
        "riskPerKmNight": round(float(night.sum()) / km, 4),
    }
    META.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(meta, f"{OUT.stat().st_size/1e6:.1f}MB")


if __name__ == "__main__":
    main()
