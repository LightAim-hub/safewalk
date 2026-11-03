"""注意書きと安全度の段階に使うデータ public/data/cautions.json を作る。

入力(data/raw/stats/ に置く。リポジトリには入れない):
  hittakuri/hyogo_<年>hittakuri.csv  兵庫県警 ひったくり 2018〜2025(町丁目単位。CC BY 2.1 JP)
  estat/<市区町村コード>/r2ka<コード>.shp  e-Stat 2020年国勢調査 小地域(町丁・字等)境界
  public/data/accidents.json  警察庁 本票 2020〜2025 を神戸市内で抜き出した物(01_accidents.py)
  public/data/graph.bin  02_graph.py が作った道(段階の境目を道の分布から決めるために読む)
  public/data/places.json  深夜も開いている店を取り出す

使わない物: 被害者の性別・年代、1件ごとの発生日時。町丁目ごとの件数だけを使う。
"""
import csv
import glob
import json
import re
import struct
import unicodedata
from collections import defaultdict
from pathlib import Path

import numpy as np
import shapefile
import shapely
from shapely.geometry import shape
from shapely.ops import unary_union

RAW = Path("data/raw/stats")
OUT = Path("public/data/cautions.json")
ACC = Path("public/data/accidents.json")
GRAPH = Path("public/data/graph.bin")
PLACES = Path("public/data/places.json")
WARDS = "28101 28102 28105 28106 28107 28108 28109 28110 28111".split()

REMOTE, OUTSIDE = 1, 2
NEAR_M = 30.0  # 経路の事故を数える距離(src/routes.ts の NEAR_M と同じ)
CELL_M = 1000.0  # 道の分布を取る時の単位。1km 四方の格子の中の道を歩いた時の事故の濃さ
MIN_CELL_M = 500.0  # これより道の短い格子は分布に入れない
HOT_RADIUS_M = 50.0
HOT_MIN = 3  # 記録の集まりとして残す最小件数(使う側の閾値は src/safety.ts)
HOT_SEPARATION_M = 120.0

LAT0 = 34.7
KX = 111320 * np.cos(np.radians(LAT0))
KY = 110940.0


def xy(lat, lon):
    return np.asarray(lon) * KX, np.asarray(lat) * KY


# ---------------------------------------------------------------- ひったくり
KANJI = "〇一二三四五六七八九"


def norm_town(text: str) -> str:
    t = unicodedata.normalize("NFKC", text).replace(" ", "").replace("　", "")

    def kanji(m):
        n = int(m.group(1))
        s = ""
        if n >= 10:
            s += ("" if n // 10 == 1 else KANJI[n // 10]) + "十"
        if n % 10:
            s += KANJI[n % 10]
        return s + "丁目"

    t = re.sub(r"(\d+)丁目", kanji, t)
    return t.replace("ケ", "ヶ")


def load_hittakuri():
    counts = defaultdict(int)
    for f in sorted((glob.glob(str(RAW / "hittakuri" / "hyogo_*hittakuri.csv")) or glob.glob(str(RAW / "1_crime" / "hyogo_police_theft" / "hyogo_*hittakuri.csv")))):
        enc = "utf-8-sig" if "2024" in f else "cp932"
        with open(f, encoding=enc, newline="") as fh:
            rows = list(csv.reader(fh))[1:]
        for r in rows:
            if "神戸市" not in r[6] or not r[7].strip():
                continue
            counts[(r[6], norm_town(r[7]), unicodedata.normalize("NFKC", r[7]).replace(" ", ""))] += 1
    return counts


def town_polygons():
    polys = defaultdict(list)
    for w in WARDS:
        r = shapefile.Reader(str(estat_shp(w)), encoding="cp932")
        for rec, sh in zip(r.iterRecords(), r.iterShapes()):
            polys[(rec["CITY_NAME"], norm_town(rec["S_NAME"]))].append(shape(sh.__geo_interface__))
    return polys


# ひったくりの注意を出す町丁目の下限（8年合計）。src/safety.ts はこの一覧にある町を通る時だけ注意を出す。
TOWN_MIN = 2


def estat_shp(w):
    """町丁目の境界。README の置き方(estat/<区>/)と、取得時のフォルダ(3_area/estat_2020/shp_<区>/)のどちらでも読む。"""
    for p in (RAW / "estat" / w / f"r2ka{w}.shp", RAW / "3_area" / "estat_2020" / f"shp_{w}" / f"r2ka{w}.shp"):
        if p.exists():
            return p
    raise FileNotFoundError(f"r2ka{w}.shp が data/raw/stats にありません")


def towns():
    counts = load_hittakuri()
    polys = town_polygons()
    merged = defaultdict(lambda: [0, ""])
    for (city, key, label), n in counts.items():
        merged[(city, key)][0] += n
        merged[(city, key)][1] = label
    out, missed = [], []
    for (city, key), (n, label) in sorted(merged.items()):
        geoms = polys.get((city, key))
        if not geoms:
            missed.append((city, key, n))
            continue
        g = unary_union(geoms).simplify(0.00004, preserve_topology=True)
        parts = list(g.geoms) if g.geom_type == "MultiPolygon" else [g]
        rings = [[[round(x, 5), round(y, 5)] for x, y in p.exterior.coords] for p in parts if not p.is_empty]
        out.append({"n": n, "rings": rings})
    print("ひったくり", sum(c for c in counts.values()), "件 町丁目", len(merged), "うち境界に結べた", len(out))
    for m in missed:
        print("  結べなかった", m)
    total = sum(t["n"] for t in out)
    # 公開するデータに町名・区・件数・件数の順位を残さない（町の危険度を示さないため）。
    # 8年で TOWN_MIN 件以上の町丁目の形だけを、位置の順に並べて出す。
    out = [{"rings": t["rings"]} for t in out if t["n"] >= TOWN_MIN]
    out.sort(key=lambda t: (t["rings"][0][0][0], t["rings"][0][0][1]))
    return out, total, missed


# ---------------------------------------------------------------- 交通事故
def load_accidents():
    a = json.loads(ACC.read_text(encoding="utf-8"))
    return {k: np.array(v) for k, v in a.items()}


def hotspots(acc, kind: str):
    """同じ種類の事故が 50m 以内に HOT_MIN 件以上ある地点を、件数の多い順に 120m 離して選ぶ。"""
    sel = np.where(acc[kind] == 1)[0]
    x, y = xy(acc["lat"][sel], acc["lon"][sel])
    night = acc["night"][sel]
    cell = HOT_RADIUS_M
    grid = defaultdict(list)
    for i, (px, py) in enumerate(zip(x, y)):
        grid[(int(px // cell), int(py // cell))].append(i)
    n_all = np.zeros(len(sel), dtype=int)
    n_night = np.zeros(len(sel), dtype=int)
    for i, (px, py) in enumerate(zip(x, y)):
        cx, cy = int(px // cell), int(py // cell)
        near = [j for dx in (-1, 0, 1) for dy in (-1, 0, 1) for j in grid.get((cx + dx, cy + dy), ())]
        near = np.array(near)
        d = np.hypot(x[near] - px, y[near] - py)
        ok = near[d <= HOT_RADIUS_M]
        n_all[i] = len(ok)
        n_night[i] = int(night[ok].sum())
    order = [i for i in np.argsort(-n_all, kind="stable") if n_all[i] >= HOT_MIN]
    taken = []
    tgrid = defaultdict(list)
    sep = HOT_SEPARATION_M
    for i in order:
        cx, cy = int(x[i] // sep), int(y[i] // sep)
        if any(np.hypot(x[j] - x[i], y[j] - y[i]) < sep for dx in (-1, 0, 1) for dy in (-1, 0, 1) for j in tgrid.get((cx + dx, cy + dy), ())):
            continue
        taken.append(i)
        tgrid[(cx, cy)].append(i)
    rows = [[round(float(acc["lat"][sel][i]), 5), round(float(acc["lon"][sel][i]), 5), int(n_all[i]), int(n_night[i])] for i in taken]
    print(kind, "事故", len(sel), "記録の集まり(>=%d件)" % HOT_MIN, len(rows))
    return rows


def read_graph():
    buf = GRAPH.read_bytes()
    n, m, k = struct.unpack_from("<III", buf, 0)
    off = 12

    def take(dtype, count):
        nonlocal off
        arr = np.frombuffer(buf, dtype=dtype, count=count, offset=off)
        off += arr.nbytes
        return arr

    take("<i4", n), take("<i4", n)
    take("<u4", m), take("<u4", m)
    length = take("<f4", m)
    for _ in range(4):
        take("<f4", m)
    take("<u4", m)
    flags = take("<u4", m)
    start = take("<u4", m + 1)
    g_lat = take("<i4", k) / 1e6
    g_lon = take("<i4", k) / 1e6
    return length, flags, start, g_lat, g_lon


def weighted_quantiles(values, weights, qs):
    order = np.argsort(values)
    v, w = values[order], weights[order]
    c = np.cumsum(w) / w.sum()
    return [float(v[min(np.searchsorted(c, q), len(v) - 1)]) for q in qs]


def tier_thresholds(acc):
    """神戸市内の人家のある道を 1km 四方の格子ごとに、歩行者・自転車の事故が 1km あたり何件かの分布を取る。"""
    length, flags, start, g_lat, g_lon = read_graph()
    inner = np.where((flags & (REMOTE | OUTSIDE)) == 0)[0]
    pts_x, pts_y, pts_w = [], [], []
    for e in inner:
        a, b = start[e], start[e + 1]
        gx, gy = xy(g_lat[a:b], g_lon[a:b])
        for i in range(len(gx) - 1):
            seg = float(np.hypot(gx[i + 1] - gx[i], gy[i + 1] - gy[i]))
            n = max(1, int(seg // 20))
            t = (np.arange(n) + 0.5) / n
            pts_x.append(gx[i] + (gx[i + 1] - gx[i]) * t)
            pts_y.append(gy[i] + (gy[i + 1] - gy[i]) * t)
            pts_w.append(np.full(n, seg / n))
    px, py, pw = np.concatenate(pts_x), np.concatenate(pts_y), np.concatenate(pts_w)
    cell_id = (np.floor(px / CELL_M).astype(np.int64) * 100000 + np.floor(py / CELL_M).astype(np.int64))
    cells, inv = np.unique(cell_id, return_inverse=True)
    cell_len = np.bincount(inv, weights=pw)
    # 事故の近くにある道の点が、どの格子にあるか
    grid = defaultdict(list)
    for i, (x, y) in enumerate(zip(px, py)):
        grid[(int(x // NEAR_M), int(y // NEAR_M))].append(i)
    result = {}
    for name, mask in (("all", np.ones(len(acc["lat"]), bool)), ("night", acc["night"] == 1)):
        sel = np.where(((acc["ped"] == 1) | (acc["bike"] == 1)) & mask)[0]
        ax, ay = xy(acc["lat"][sel], acc["lon"][sel])
        count = np.zeros(len(cells))
        for x, y in zip(ax, ay):
            cx, cy = int(x // NEAR_M), int(y // NEAR_M)
            idx = [j for dx in (-1, 0, 1) for dy in (-1, 0, 1) for j in grid.get((cx + dx, cy + dy), ())]
            if not idx:
                continue
            idx = np.array(idx)
            ok = idx[np.hypot(px[idx] - x, py[idx] - y) <= NEAR_M]
            for c in np.unique(inv[ok]):
                count[c] += 1
        keep = cell_len >= MIN_CELL_M
        density = count[keep] / (cell_len[keep] / 1000)
        w = cell_len[keep]
        qs = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
        qv = weighted_quantiles(density, w, qs)
        result[name] = {
            "accidents": int(len(sel)),
            "cells": int(keep.sum()),
            "roadKm": round(float(w.sum() / 1000), 1),
            "zeroShare": round(float(w[density == 0].sum() / w.sum()), 3),
            "quantiles": {str(int(q * 100)): round(v, 2) for q, v in zip(qs, qv)},
            "lo": round(qv[1], 2),
            "hi": round(qv[7], 2),
        }
        print(name, result[name])
    return result


# ---------------------------------------------------------------- 深夜に開いている店
DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]


def parse_span(s):
    a, b = s.split("-")

    def mins(t):
        h, m = t.split(":")
        return int(h) * 60 + int(m)

    x, y = mins(a), mins(b)
    return x, (y if y > x else y + 1440)


def day_in(part, day):
    if "-" in part:
        a, b = (DAYS.index(d) for d in part.split("-"))
        return a <= day <= b if a <= b else day >= a or day <= b
    return DAYS.index(part) == day


def open_at(hours: str, day: int, clock: int):
    """src/place.ts の isOpen と同じ読み方。読めない時は None。"""
    if hours.strip() == "24/7":
        return True
    rules = []
    for rule in [r.strip() for r in hours.split(";") if r.strip()]:
        m = re.match(r"^(?:((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:[-,](?:Mo|Tu|We|Th|Fr|Sa|Su))*)\s+)?(off|closed|\d{1,2}:\d{2}-\d{1,2}:\d{2}(?:,\d{1,2}:\d{2}-\d{1,2}:\d{2})*)$", rule)
        if not m:
            return None
        spans = [] if m.group(2) in ("off", "closed") else [parse_span(s) for s in m.group(2).split(",")]
        rules.append((m.group(1), spans))

    def spans_on(d):
        hit = [s for days, s in rules if not days or any(day_in(p, d) for p in days.split(","))]
        return hit[-1] if hit else []

    return any(a <= clock < b for a, b in spans_on(day)) or any(a <= clock + 1440 < b for a, b in spans_on((day + 6) % 7))


def late_shops():
    """水曜と土曜の午前1時に開いていると営業時間に書いてある店。書いていない・読めない店は数えない。"""
    rows = json.loads(PLACES.read_text(encoding="utf-8"))
    out = []
    for r in rows:
        hours = r[6]
        if not hours or r[3] in ("駅", "バス停"):
            continue
        if open_at(hours, 3, 60) is True and open_at(hours, 6, 60) is True:
            out.append([round(r[1], 5), round(r[2], 5)])
    print("深夜1時に開いている店", len(out))
    return out


def main():
    acc = load_accidents()
    t, t_total, missed = towns()
    data = {
        "accidentPeriod": [2020, 2025],
        "hittakuriPeriod": [2018, 2025],
        "tiers": tier_thresholds(acc),
        "hot": {"bike": hotspots(acc, "bike"), "ped": hotspots(acc, "ped")},
        "towns": t,
        "late": late_shops(),
    }
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"-> {OUT} {OUT.stat().st_size/1e3:.0f}KB")


if __name__ == "__main__":
    main()
