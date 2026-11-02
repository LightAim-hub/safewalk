"""OpenStreetMap から神戸市の行政界と、検索に使う地名を取り出す。

出力:
  public/data/kobe.geojson  神戸市の行政界
  public/data/places.json   [名前, 緯度, 経度, 種別] の配列
"""
import json
from pathlib import Path

import osmium
import shapely

from area import BBOX, BOUNDARY

PBF = "data/raw/kansai.osm.pbf"
PLACES = Path("public/data/places.json")

KINDS = {
    "railway": {"station": "駅", "halt": "駅"},
    "amenity": {
        "school": "学校", "university": "大学", "college": "学校", "kindergarten": "幼稚園",
        "hospital": "病院", "clinic": "病院", "townhall": "役所", "library": "図書館",
        "police": "警察", "fire_station": "消防署", "community_centre": "公民館",
        "theatre": "劇場", "cinema": "映画館", "place_of_worship": "寺社", "post_office": "郵便局",
        "bank": "銀行", "restaurant": "飲食店", "cafe": "カフェ", "fast_food": "飲食店",
    },
    "tourism": {"attraction": "名所", "museum": "博物館", "hotel": "宿泊", "zoo": "動物園", "viewpoint": "展望地"},
    "leisure": {"park": "公園", "stadium": "競技場", "sports_centre": "体育施設"},
    "shop": {"mall": "商業施設", "department_store": "百貨店", "supermarket": "スーパー", "convenience": "コンビニ"},
    "place": {"suburb": "地区", "neighbourhood": "地区", "quarter": "地区", "village": "地区"},
}


def kind_of(tags) -> str | None:
    for key, values in KINDS.items():
        found = values.get(tags.get(key, ""))
        if found:
            return found
    return None


class Reader(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.geojson = osmium.geom.GeoJSONFactory()
        self.boundary = None
        self.places = []

    def add(self, tags, lat, lon):
        name = tags.get("name:ja") or tags.get("name")
        kind = kind_of(tags)
        s, w, n, e = BBOX
        if name and kind and s <= lat <= n and w <= lon <= e:
            self.places.append((name, round(lat, 6), round(lon, 6), kind))

    def node(self, n):
        if n.location.valid():
            self.add(n.tags, n.location.lat, n.location.lon)

    def area(self, a):
        tags = a.tags
        is_kobe = tags.get("boundary") == "administrative" and tags.get("name") == "神戸市"
        if not is_kobe and not kind_of(tags):
            return
        try:
            geom = shapely.geometry.shape(json.loads(self.geojson.create_multipolygon(a)))
        except RuntimeError:
            return
        if is_kobe:
            self.boundary = geom
        else:
            point = geom.representative_point()
            self.add(tags, point.y, point.x)


def main():
    r = Reader()
    r.apply_file(PBF, locations=True, idx="flex_mem")
    if r.boundary is None:
        raise SystemExit("神戸市の行政界が見つかりません")

    BOUNDARY.parent.mkdir(parents=True, exist_ok=True)
    feature = {"type": "Feature", "properties": {}, "geometry": shapely.geometry.mapping(r.boundary.simplify(0.0002))}
    BOUNDARY.write_text(json.dumps(feature, separators=(",", ":")), encoding="utf-8")

    shapely.prepare(r.boundary)
    seen = set()
    rows = []
    for name, lat, lon, kind in r.places:
        key = (name, round(lat, 3), round(lon, 3))
        if key not in seen and shapely.contains_xy(r.boundary, lon, lat):
            seen.add(key)
            rows.append([name, lat, lon, kind])
    PLACES.write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        f"bounds={[round(v, 3) for v in r.boundary.bounds]} places={len(rows)} "
        f"{PLACES.stat().st_size/1e6:.2f}MB boundary={BOUNDARY.stat().st_size/1e3:.0f}KB"
    )


if __name__ == "__main__":
    main()
