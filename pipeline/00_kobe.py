"""OpenStreetMap から神戸市の行政界と、検索に使う地名を取り出す。

出力:
  public/data/kobe.geojson  神戸市の行政界
  public/data/places.json   [名前, 緯度, 経度, 種別, 読み, 区, 営業時間, 電話, サイト, 住所, 運営] の配列
"""
import json
import math
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import osmium
import pykakasi
import shapely

from area import BBOX, BOUNDARY

PBF = "data/raw/kansai.osm.pbf"
PLACES = Path("public/data/places.json")
WARDS = ("東灘区", "灘区", "兵庫区", "長田区", "須磨区", "垂水区", "北区", "中央区", "西区")

KINDS = {
    "railway": {"station": "駅", "halt": "駅"},
    "amenity": {
        "school": "学校", "university": "大学", "college": "学校", "kindergarten": "幼稚園",
        "hospital": "病院", "clinic": "病院", "townhall": "役所", "library": "図書館",
        "police": "警察", "fire_station": "消防署", "community_centre": "公民館",
        "theatre": "劇場", "cinema": "映画館", "place_of_worship": "寺社", "post_office": "郵便局",
        "bank": "銀行", "restaurant": "飲食店", "cafe": "カフェ", "fast_food": "飲食店",
        "pharmacy": "薬局", "atm": "ATM", "toilets": "トイレ",
        # 駐車場・駐輪場・バス停は「施設」ではなく自分の種類にする。検索で駅や名所より下に並べるため。
        "parking": "駐車場", "parking_space": "駐車場", "parking_entrance": "駐車場", "motorcycle_parking": "駐輪場",
        "bicycle_parking": "駐輪場", "bus_station": "バス停",
    },
    "highway": {"bus_stop": "バス停"},
    "tourism": {"attraction": "名所", "museum": "博物館", "hotel": "宿泊", "zoo": "動物園", "viewpoint": "展望地"},
    "leisure": {"park": "公園", "stadium": "競技場", "sports_centre": "体育施設"},
    "shop": {
        "mall": "商業施設", "department_store": "百貨店", "supermarket": "スーパー", "convenience": "コンビニ",
        "chemist": "薬局",
    },
    "place": {"suburb": "地区", "neighbourhood": "地区", "quarter": "地区", "village": "地区"},
}


# 名前のない施設でも探せるよう、種別の呼び名を付ける。
UNNAMED = {"トイレ": "公衆トイレ", "ATM": "ATM"}

# 上の表に無いものも、名前が付いていれば検索に出す。
GENERAL = {"shop": "店", "amenity": "施設", "tourism": "観光", "office": "事業所", "leisure": "施設", "historic": "史跡"}


# 種類が「施設」「店」のような総称にとどまる物は、名前から駐車場・駐輪場・バス停を見分ける。
GENERIC = {"施設", "店", "事業所", "観光", "史跡"}
NAME_KINDS = (
    (re.compile(r"駐車場|パーキング|自動車整理場|駐車スペース"), "駐車場"),
    (re.compile(r"駐輪|自転車置場|自転車置き場|バイク置場"), "駐輪場"),
    (re.compile(r"バス(停|のりば|乗り場|乗場|ターミナル|発着)|バス停|(乗り場|乗場|のりば)$"), "バス停"),
)


def kind_of(tags) -> str | None:
    found = None
    for key, values in KINDS.items():
        found = values.get(tags.get(key, ""))
        if found:
            break
    if not found:
        for key, kind in GENERAL.items():
            if key in tags:
                found = kind
                break
    if found in GENERIC:
        name = tags.get("name:ja") or tags.get("name") or ""
        for pattern, kind in NAME_KINDS:
            if pattern.search(name):
                return kind
    return found


def details(tags) -> list[str]:
    """場所の画面に出す情報。OpenStreetMap に記録がある時だけ入る。"""
    address = tags.get("addr:full") or "".join(
        tags.get(key, "") for key in ("addr:province", "addr:city", "addr:quarter", "addr:neighbourhood", "addr:block_number", "addr:housenumber")
    )
    return [
        tags.get("opening_hours", ""),
        tags.get("phone") or tags.get("contact:phone", ""),
        tags.get("website") or tags.get("contact:website", ""),
        address,
        tags.get("operator", "") if tags.get("railway") else "",
    ]


ALIAS_KEYS = ("old_name", "alt_name", "short_name", "official_name", "name")

# OpenStreetMap に旧称の記録が無い物。改称は公表されている事実で、旧称でも探せるようにする。
OLD_NAMES = {"神戸須磨シーワールド": ["須磨海浜水族園"]}


def aliases(tags, name) -> tuple[list[str], list[str]]:
    """名前と別の呼び名（旧名・略称・ブランド名）と、そのうちの旧名。検索で引けるようにする。"""
    found, old = [], []
    for key in ALIAS_KEYS:
        for value in re.split(r"[;；]", tags.get(key, "")):
            value = value.strip()
            if value and value != name and value not in name and value not in found:
                found.append(value)
                if key == "old_name":
                    old.append(value)
    for value in OLD_NAMES.get(name, []):
        found.append(value)
        old.append(value)
    return found, old


class Reader(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.geojson = osmium.geom.GeoJSONFactory()
        self.boundary = None
        self.wards = []
        self.places = []

    def add(self, tags, lat, lon, ts=None):
        kind = kind_of(tags)
        name = tags.get("name:ja") or tags.get("name") or UNNAMED.get(kind)
        s, w, n, e = BBOX
        if name and kind and s <= lat <= n and w <= lon <= e:
            yomi = tags.get("name:ja-Hira") or tags.get("name:ja-Kana") or tags.get("name:ja_kana") or ""
            if kind == "バス停" and not NAME_KINDS[2][0].search(name):
                name += "バス停"
            # 記録が最後に直された年（OpenStreetMap の更新日時）。画面で「記録の古さ」として出す。
            year = ts.year if ts is not None else 0
            self.places.append((name, round(lat, 6), round(lon, 6), kind, yomi, details(tags), aliases(tags, name), year))

    def node(self, n):
        if n.location.valid():
            self.add(n.tags, n.location.lat, n.location.lon, n.timestamp)

    def area(self, a):
        tags = a.tags
        admin = tags.get("boundary") == "administrative"
        is_kobe = admin and tags.get("name") == "神戸市"
        is_ward = admin and tags.get("name") in WARDS
        if not is_kobe and not is_ward and not kind_of(tags):
            return
        try:
            geom = shapely.geometry.shape(json.loads(self.geojson.create_multipolygon(a)))
        except RuntimeError:
            return
        if is_kobe:
            self.boundary = geom
        elif is_ward:
            self.wards.append((tags.get("name"), geom))
        else:
            point = geom.representative_point()
            self.add(tags, point.y, point.x, a.timestamp)


PREFIX = re.compile(r"^(神戸市立|兵庫県立|県立|市立|国立|私立|神戸市営|神戸市)")
PRIORITY = {"駅": 0, "名所": 1, "動物園": 1, "博物館": 2, "公園": 2, "大学": 2, "展望地": 2}


def base_name(name: str) -> str:
    """「神戸市立王子動物園」と「王子動物園」を同じと見るための名前。"""
    n = unicodedata.normalize("NFKC", name)
    n = re.sub(r"[（(].*?[)）]", "", n)
    return re.sub(r"[\s・]", "", PREFIX.sub("", n))


def metres(a, b) -> float:
    dy = (a[1] - b[1]) * 111320
    dx = (a[2] - b[2]) * 111320 * math.cos(math.radians(a[1]))
    return math.hypot(dx, dy)


def merge_duplicates(rows, names):
    """同じ場所を指す重複を1つにする。

    近く(300m以内)で、名前が同じ(神戸市立などの頭を除く)なのに種類が違い、片方が「施設」のような総称なら同じ場所。
    例: 「新神戸駅」の駅と施設、「王子動物園」と「神戸市立王子動物園」、「メリケンパーク」の公園と施設。
    種類が強い方(駅 > 名所 > 公園…)を残し、記録の足りない所は相手で補う。
    同じ種類でも、40m 以内で名前がまったく同じなら重複とみなす（駅は路線ごとに別の物として残す）。
    チェーン店は名前が同じでも離れているので、まとめない。
    """
    groups = defaultdict(list)
    for i, row in enumerate(rows):
        groups[base_name(row[0])].append(i)
    drop = set()

    def rank(i):
        kind = rows[i][3]
        return PRIORITY.get(kind, 9 if kind in GENERIC else 3), -len(rows[i][0])

    for index in groups.values():
        if len(index) < 2:
            continue
        kept = []
        for i in sorted(index, key=rank):
            for k in kept:
                differ = rows[i][3] != rows[k][3] and (rows[i][3] in GENERIC or rows[k][3] in GENERIC)
                same = rows[i][3] == rows[k][3] != "駅" and rows[i][0] == rows[k][0] and metres(rows[i], rows[k]) <= 40
                if (differ and metres(rows[i], rows[k]) <= 300) or same:
                    for col in range(6, 11):
                        rows[k][col] = rows[k][col] or rows[i][col]
                    for extra in [rows[i][0], *names[i]]:
                        if extra not in rows[k][0] and extra not in names[k]:
                            names[k].append(extra)
                    drop.add(i)
                    break
            else:
                kept.append(i)
    keep = [i for i in range(len(rows)) if i not in drop]
    return [rows[i] for i in keep], [names[i] for i in keep]


DIRECTIONS = ("北", "北東", "東", "南東", "南", "南西", "西", "北西")


def tell_apart(rows) -> None:
    """同じ名前の店がいくつもある時、見分けられるよう「三宮駅の北東200m」のような手がかりを運営の欄に入れる。"""
    count = Counter(row[0] for row in rows)
    stations = [row for row in rows if row[3] == "駅"]
    districts = [row for row in rows if row[3] == "地区"]
    for row in rows:
        if count[row[0]] < 2 or row[10] or row[3] in ("駅", "地区"):
            continue
        near = min(stations, key=lambda s: metres(row, s), default=None)
        if near and metres(row, near) <= 400:
            dy = (row[1] - near[1]) * 111320
            dx = (row[2] - near[2]) * 111320 * math.cos(math.radians(row[1]))
            compass = DIRECTIONS[round(math.degrees(math.atan2(dx, dy)) / 45) % 8]
            row[10] = f"{near[0]}の{compass}{max(50, round(metres(row, near) / 50) * 50)}m"
            continue
        near = min(districts, key=lambda s: metres(row, s), default=None)
        if near and metres(row, near) <= 800:
            row[10] = f"{near[0]}付近"


def main():
    r = Reader()
    r.apply_file(PBF, locations=True, idx="flex_mem")
    if r.boundary is None:
        raise SystemExit("神戸市の行政界が見つかりません")

    BOUNDARY.parent.mkdir(parents=True, exist_ok=True)
    feature = {"type": "Feature", "properties": {}, "geometry": shapely.geometry.mapping(r.boundary.simplify(0.0002))}
    BOUNDARY.write_text(json.dumps(feature, separators=(",", ":")), encoding="utf-8")

    shapely.prepare(r.boundary)
    kks = pykakasi.kakasi()
    seen = set()
    rows = []
    names = []  # rows と同じ順の、別の呼び名
    for name, lat, lon, kind, yomi, extra, (alias, old), year in r.places:
        # OpenStreetMap の駅名は「灘」のように「駅」が付かないことがある。
        if kind == "駅" and not name.endswith("駅"):
            name += "駅"
        key = (name, round(lat, 3), round(lon, 3))
        if key not in seen and shapely.contains_xy(r.boundary, lon, lat):
            seen.add(key)
            reading = yomi or "".join(part["hira"] for part in kks.convert(name))
            row = [name, lat, lon, kind, reading, "", *extra, year]
            if old and kind != "駅":
                row[10] = row[10] or "旧 " + old[0]
            rows.append(row)
            names.append(alias)
    rows, names = merge_duplicates(rows, names)

    # 他の市にも同じ名前の区があるので、神戸市の中にある区だけを使う。
    lons = np.array([row[2] for row in rows])
    lats = np.array([row[1] for row in rows])
    for ward, geom in r.wards:
        inner = geom.representative_point()
        if not shapely.contains_xy(r.boundary, inner.x, inner.y):
            continue
        shapely.prepare(geom)
        for i in np.nonzero(shapely.contains_xy(geom, lons, lats))[0]:
            rows[i][5] = ward
    tell_apart(rows)
    for row, alias in zip(rows, names):
        if alias:
            row[4] = f"{row[4]}|{' '.join(alias)}"
    PLACES.write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        f"bounds={[round(v, 3) for v in r.boundary.bounds]} places={len(rows)} "
        f"wards={sum(1 for row in rows if row[5])} {PLACES.stat().st_size/1e6:.2f}MB boundary={BOUNDARY.stat().st_size/1e3:.0f}KB"
    )


if __name__ == "__main__":
    main()
