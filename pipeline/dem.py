"""国土地理院の標高タイル(dem_png)から標高を引く。

出典: 国土地理院 標高タイル https://maps.gsi.go.jp/development/demtile.html
値 = (R*65536 + G*256 + B) * 0.01 m。海など値が無い画素は 0 m として扱う。
"""
import io
import math
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

CACHE = Path("data/raw/dem")
ZOOM = 14
TILE = "https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png"
NO_DATA = 8388608


def _pixel(lat: float, lon: float) -> tuple[float, float]:
    n = 2**ZOOM * 256
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def _fetch(key: tuple[int, int]) -> None:
    x, y = key
    path = CACHE / f"{x}_{y}.png"
    if path.exists():
        return
    try:
        with urllib.request.urlopen(TILE.format(z=ZOOM, x=x, y=y), timeout=30) as r:
            path.write_bytes(r.read())
    except urllib.error.HTTPError as e:
        if e.code != 404:  # 海だけのタイルは存在しない
            raise
        path.write_bytes(b"")


def _decode(path: Path) -> np.ndarray:
    data = path.read_bytes()
    if not data:
        return np.zeros((256, 256), dtype=np.float32)
    rgb = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"), dtype=np.int64)
    raw = rgb[..., 0] * 65536 + rgb[..., 1] * 256 + rgb[..., 2]
    raw = np.where(raw == NO_DATA, 0, raw)
    raw = np.where(raw > NO_DATA, raw - 2**24, raw)
    return (raw * 0.01).astype(np.float32)


class Elevation:
    def __init__(self, bbox: tuple[float, float, float, float]):
        s, w, n, e = bbox
        x0, y0 = _pixel(n, w)
        x1, y1 = _pixel(s, e)
        keys = [
            (x, y)
            for x in range(int(x0 // 256), int(x1 // 256) + 1)
            for y in range(int(y0 // 256), int(y1 // 256) + 1)
        ]
        CACHE.mkdir(parents=True, exist_ok=True)
        with ThreadPoolExecutor(8) as pool:
            list(pool.map(_fetch, keys))
        self.tiles = {k: _decode(CACHE / f"{k[0]}_{k[1]}.png") for k in keys}
        print("dem tiles", len(keys))

    def at(self, lat: float, lon: float) -> float:
        x, y = _pixel(lat, lon)
        tile = self.tiles.get((int(x // 256), int(y // 256)))
        return 0.0 if tile is None else float(tile[int(y) % 256, int(x) % 256])
