"""夜の経路の費用に小さく足す値(辺ごと)を作り、public/data/graph.bin の末尾に付ける。

考え方: 夜は「人通りと明かりの多い道」を少しだけ優先する。決め手が近い時に、犯罪の記録が差を付ける役。
画面には町名・件数・色・地図の印を出さない。経路の理由の言葉は src/safety.ts にある一般的な言い方だけ。

入力(data/raw/stats/ に置く。リポジトリには入れない。台帳 = data/raw/stats/SOURCES.md):
  1_crime/hyogo_police_theft/hyogo_<年>{hittakuri,syazyounerai}.csv  兵庫県警 町丁目単位 2018〜2025 (CC BY 2.1 JP)
  3_area/estat_2020/shp_<区コード>/r2ka<区コード>.shp                 e-Stat 2020年国勢調査 町丁目境界
  4_people/mlit_jinryu/28/2019/<月>/monthly_mdp_mesh1km.csv          国交省 全国の人流 深夜(1〜4時台)の滞在人口 1kmメッシュ
  5_light/viirs/vnl_<年>_kobe.tif                                    VIIRS 夜間光 年平均 2023〜2025
  public/data/graph.bin                                              02_graph.py が作った道

使わない物: 被害者の性別・年代・職業、1件ごとの発生日時、ひったくり・車上ねらい以外の手口(自転車盗・自販機ねらい・
部品ねらい・自動車盗・オートバイ盗)。町丁目ごとの8年合計の件数だけを使う。

作り方:
  1. 町丁目ごとに「ひったくり×3 + 車上ねらい」の8年合計(ひったくりは歩く人が直接の被害なので重く数える)。
     8年合計が MIN_TOTAL(5)件に満たない町丁目は使わない(0 とみなす)。
  2. 件数のままにしない。深夜の滞在人口(2019年・全日・深夜の月平均を、町丁目と重なる面積で按分)で割った率にする。
     人口が少なすぎる所で率が跳ねないよう、分母は FLOOR_POP(100人)を下限にする。
  3. 使える町丁目の中での順位(0〜1)にして、上位半分だけを 0〜1 に伸ばす(CRIME_FROM=0.5)。
  4. 町丁目→道: 辺の上を約 40m ごとに調べ、載っている町丁目の値の平均を辺の値にする。
  5. 人通りと明かり: 辺の中点の「深夜の滞在人口」と「夜間光(2023〜2025の平均)」を、神戸市内の辺の中での順位にし、
     少ないほど静か(quiet)とする。
  6. 辺ごとの足し分(長さに対する割合) = LIGHT_W×qT + CRIME_W×犯罪の値×(0.5+0.5×qT)。
     qT は quiet を 0〜1 に伸ばした値。最大で CAP(0.20)。0.001 刻みの 0〜200 で graph.bin に入れる。
     神戸市の外の辺は 0。src/routes.ts が、夜の「最短ではない」候補にだけ 長さ×この割合 を足す。

graph.bin の形: 先頭〜geomLon までは 02_graph.py と同じ。その後ろに Uint8[nEdges] を1本足す。
作り直しても同じ結果になる。02_graph.py を作り直した後は、この 05_crime.py を必ず実行し直すこと。
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
from PIL import Image
from shapely.geometry import box, shape
from shapely.strtree import STRtree

RAW = Path("data/raw/stats")
GRAPH = Path("public/data/graph.bin")
META = Path("public/data/graph.meta.json")
WARDS = "28101 28102 28105 28106 28107 28108 28109 28110 28111".split()
YEARS = range(2018, 2026)

MIN_TOTAL = 5
SNATCH_W = 3.0
FLOOR_POP = 100.0
CRIME_FROM = 0.5
LIGHT_W = 0.12
CRIME_W = 0.08
CAP = 0.20
QUIET_FROM = 0.25
SAMPLE_M = 40.0
OUTSIDE = 2

LAT0 = 34.7
KX = 111320 * np.cos(np.radians(LAT0))
KY = 110940.0

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


# ---------------------------------------------------------------- 犯罪(町丁目×8年合計)
def read_rows(path: Path):
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "cp932"):
        try:
            return list(csv.reader(raw.decode(enc).splitlines()))[1:]
        except UnicodeDecodeError:
            continue
    raise ValueError(path)


def load_counts(kind: str):
    """(市区町村, 町丁目) -> 8年合計。神戸市内で町丁目が空でない行だけ。1件ごとの日時・被害者の列は読まない。"""
    counts = defaultdict(int)
    for y in YEARS:
        for r in read_rows(RAW / "1_crime/hyogo_police_theft" / f"hyogo_{y}{kind}.csv"):
            if len(r) < 8 or "神戸市" not in r[6] or not r[7].strip():
                continue
            counts[(unicodedata.normalize("NFKC", r[6]), norm_town(r[7]))] += 1
    return counts


# ---------------------------------------------------------------- 町丁目の境界
def load_towns():
    polys, keys, resident = [], [], []
    for w in WARDS:
        r = shapefile.Reader(str(RAW / f"3_area/estat_2020/shp_{w}" / f"r2ka{w}.shp"), encoding="cp932")
        for rec, sh in zip(r.iterRecords(), r.iterShapes()):
            g = shape(sh.__geo_interface__)
            if g.is_empty or not rec["S_NAME"]:
                continue
            polys.append(g)
            keys.append((unicodedata.normalize("NFKC", rec["CITY_NAME"]), norm_town(rec["S_NAME"])))
            resident.append(rec["JINKO"] or 0)
    return polys, keys, np.array(resident, dtype=float)


# ---------------------------------------------------------------- 深夜の滞在人口(1kmメッシュ)
def mesh_box(code: str):
    p, u, q, v, r, w = int(code[0:2]), int(code[2:4]), int(code[4]), int(code[5]), int(code[6]), int(code[7])
    lat = p / 1.5 + q / 12 + r / 120
    lon = 100 + u + v / 8 + w / 80
    return lat, lon, lat + 1 / 120, lon + 1 / 80


def load_night_pop():
    """メッシュ番号 -> 深夜(timezone=1)・全日(dayflag=2)の月平均(人)。2019年(コロナ禍の前)。"""
    total, n = defaultdict(float), defaultdict(int)
    for f in sorted(glob.glob(str(RAW / "4_people/mlit_jinryu/28/2019/*/monthly_mdp_mesh1km.csv"))):
        with open(f, encoding="utf-8", newline="") as fh:
            for r in csv.DictReader(fh):
                if r["dayflag"] == "2" and r["timezone"] == "1":
                    total[r["mesh1kmid"]] += float(r["population"])
                    n[r["mesh1kmid"]] += 1
    return {k: total[k] / 12 for k in total}


# ---------------------------------------------------------------- 夜間光
class Light:
    def __init__(self):
        arrs = []
        for y in (2023, 2024, 2025):
            im = Image.open(RAW / f"5_light/viirs/vnl_{y}_kobe.tif")
            sx, sy = im.tag_v2[33550][:2]
            _, _, _, self.lon0, self.lat0, _ = im.tag_v2[33922]
            self.sx, self.sy = sx, sy
            arrs.append(np.clip(np.nan_to_num(np.array(im, dtype=float)), 0, None))
        self.a = np.mean(arrs, axis=0)

    def at(self, lat, lon):
        col = np.clip(((lon - self.lon0) / self.sx).astype(int), 0, self.a.shape[1] - 1)
        row = np.clip(((self.lat0 - lat) / self.sy).astype(int), 0, self.a.shape[0] - 1)
        return self.a[row, col]


# ---------------------------------------------------------------- 道
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
    return buf[:off], m, length, flags, start, g_lat, g_lon


def edge_samples(m, length, start, g_lat, g_lon):
    """辺ごとに、約 SAMPLE_M ごとの点(必ず中点を含む)。(辺の添字, 緯度, 経度, 中点か) の配列を返す。"""
    ei, la, lo, mid = [], [], [], []
    for e in range(m):
        a, b = start[e], start[e + 1]
        lat, lon = g_lat[a:b], g_lon[a:b]
        seg = np.hypot((lon[1:] - lon[:-1]) * KX, (lat[1:] - lat[:-1]) * KY)
        cum = np.concatenate([[0], np.cumsum(seg)])
        total = cum[-1]
        n = max(1, int(total // SAMPLE_M))
        ts = (np.arange(n) + 0.5) / n * total
        plat = np.interp(ts, cum, lat)
        plon = np.interp(ts, cum, lon)
        mi = int(np.argmin(np.abs(ts - total / 2)))
        for j in range(n):
            ei.append(e)
            la.append(plat[j])
            lo.append(plon[j])
            mid.append(j == mi)
    return np.array(ei), np.array(la), np.array(lo), np.array(mid)


def rank01(values, ref):
    """values が ref の中でどの順位か(0〜1)。同じ値は真ん中の順位。"""
    s = np.sort(ref)
    lo = np.searchsorted(s, values, side="left")
    hi = np.searchsorted(s, values, side="right")
    return (lo + hi) / 2 / len(s)


def main():
    head, m, length, flags, start, g_lat, g_lon = read_graph()
    print("辺", m)

    # 町丁目
    polys, keys, resident = load_towns()
    print("町丁目の境界", len(polys))
    snatch, car = load_counts("hittakuri"), load_counts("syazyounerai")
    key_index = defaultdict(list)
    for i, k in enumerate(keys):
        key_index[k].append(i)
    score = np.zeros(len(polys))
    total = np.zeros(len(polys))
    missed = 0
    for counts, w in ((snatch, SNATCH_W), (car, 1.0)):
        for k, c in counts.items():
            idx = key_index.get(k)
            if not idx:
                missed += c
                continue
            # 同じ名前の区域が複数ある時は、数を均等に割る(件数の合計は変えない)
            for i in idx:
                score[i] += w * c / len(idx)
                total[i] += c / len(idx)
    print(f"ひったくり {sum(snatch.values())}件・車上ねらい {sum(car.values())}件 (境界に結べなかった {missed}件)")

    # 深夜の滞在人口を町丁目に按分
    night = load_night_pop()
    meshes = [(code, box(mesh_box(code)[1], mesh_box(code)[0], mesh_box(code)[3], mesh_box(code)[2]), pop) for code, pop in night.items()]
    mtree = STRtree([b for _, b, _ in meshes])
    town_pop = np.zeros(len(polys))
    for i, g in enumerate(polys):
        for j in mtree.query(g):
            code, b, pop = meshes[j]
            inter = g.intersection(b).area
            if inter > 0:
                town_pop[i] += pop * inter / b.area
    print(f"深夜の滞在人口の合計 {town_pop.sum():.0f}人 (町丁目の国勢調査人口の合計 {resident.sum():.0f}人)")

    # 率と順位(8年合計が MIN_TOTAL 未満の町丁目は使わない)
    ok = total >= MIN_TOTAL
    rate = score / np.maximum(town_pop, FLOOR_POP)
    crime = np.zeros(len(polys))
    r_ok = rate[ok]
    crime[ok] = np.clip((rank01(r_ok, r_ok) - CRIME_FROM) / (1 - CRIME_FROM), 0, 1)
    print(f"使える町丁目 {int(ok.sum())} / {len(polys)}  (率が正の町丁目 {int((crime > 0).sum())})")

    # 辺へ
    ei, la, lo, mid = edge_samples(m, length, start, g_lat, g_lon)
    print("標本点", len(ei))
    tree = STRtree(polys)
    pi, ti = tree.query(shapely.points(lo, la), predicate="within")
    town_of = np.full(len(ei), -1)
    town_of[pi[::-1]] = ti[::-1]  # 境界上で重なる時は先に見つかった方
    val = np.where(town_of >= 0, crime[np.maximum(town_of, 0)], 0.0)
    crime_edge = np.bincount(ei, weights=val, minlength=m) / np.maximum(np.bincount(ei, minlength=m), 1)

    # 人通りと明かり(辺の中点)
    mlat = np.zeros(m)
    mlon = np.zeros(m)
    mlat[ei[mid]], mlon[ei[mid]] = la[mid], lo[mid]
    light_v = Light().at(mlat, mlon)
    pop_v = np.zeros(m)
    for code, b, pop in meshes:
        x0, y0, x1, y1 = mesh_box(code)[1], mesh_box(code)[0], mesh_box(code)[3], mesh_box(code)[2]
        sel = (mlon >= x0) & (mlon < x1) & (mlat >= y0) & (mlat < y1)
        pop_v[sel] = pop
    inner = (flags & OUTSIDE) == 0
    light_rank = rank01(light_v, light_v[inner])
    pop_rank = rank01(pop_v, pop_v[inner])
    quiet = 1 - 0.5 * light_rank - 0.5 * pop_rank
    qT = np.clip((quiet - QUIET_FROM) / (1 - QUIET_FROM), 0, 1)

    factor = LIGHT_W * qT + CRIME_W * crime_edge * (0.5 + 0.5 * qT)
    factor = np.where(inner, np.minimum(factor, CAP), 0.0)
    extra = np.round(factor * 1000).astype(np.uint8)

    long_m = length.astype(float)
    w = long_m[inner]
    print("足し分(長さに対する割合)  市内の道 %.0fkm  長さ加重の平均 %.3f  90%%点 %.3f  最大 %.3f" % (
        w.sum() / 1000, np.average(factor[inner], weights=w), np.quantile(factor[inner], 0.9), factor.max()))
    print("犯罪の値が正の道 %.0fkm (市内の道の %.1f%%)" % (long_m[crime_edge > 0].sum() / 1000, 100 * long_m[crime_edge > 0].sum() / w.sum()))

    GRAPH.write_bytes(head + extra.tobytes())
    meta = json.loads(META.read_text(encoding="utf-8"))
    meta["nightExtra"] = 1
    META.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print("graph.bin", f"{GRAPH.stat().st_size / 1e6:.2f}MB")


if __name__ == "__main__":
    main()
