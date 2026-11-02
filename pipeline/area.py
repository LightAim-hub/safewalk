"""対象範囲。神戸市の行政界(pipeline/00_kobe.py が OpenStreetMap から作る)で判定する。"""
import json
from pathlib import Path

import shapely

# 神戸市全域を含む長方形 (南, 西, 北, 東)。行政界を読む前の絞り込みに使う。
BBOX = (34.55, 134.90, 34.95, 135.38)
BOUNDARY = Path("public/data/kobe.geojson")


def kobe() -> shapely.Geometry:
    data = json.loads(BOUNDARY.read_text(encoding="utf-8"))
    geom = shapely.geometry.shape(data["geometry"])
    shapely.prepare(geom)
    return geom
