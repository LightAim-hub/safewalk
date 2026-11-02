"""警察庁の交通事故オープンデータ(本票)から、対象範囲の事故を取り出す。

出典: 警察庁「交通事故統計情報のオープンデータ」(公共データ利用規約 PDL1.0)
https://www.npa.go.jp/publications/statistics/koutsuu/opendata/index_opendata.html
"""
import json
from pathlib import Path

import pandas as pd

from area import BBOX

RAW = Path("data/raw")
OUT = Path("public/data/accidents.json")
YEARS = range(2020, 2026)
HYOGO = "63"  # コード表: 都道府県コード 63 = 兵庫


def dms_to_deg(value: str, deg_digits: int) -> float | None:
    """度分秒の文字列(例: 344156240 = 34度41分56.240秒)を十進の度に直す。"""
    if not isinstance(value, str) or not value.strip().isdigit():
        return None
    v = value.strip()
    deg = int(v[: deg_digits])
    minute = int(v[deg_digits : deg_digits + 2])
    sec = int(v[deg_digits + 2 :]) / 1000
    return deg + minute / 60 + sec / 3600


def load_year(year: int) -> pd.DataFrame:
    df = pd.read_csv(RAW / f"honhyo_{year}.csv", encoding="cp932", dtype=str)
    df.columns = [c.replace("　", "") for c in df.columns]
    df = df[df["都道府県コード"] == HYOGO].copy()
    df["lat"] = df["地点緯度（北緯）"].map(lambda v: dms_to_deg(v, 2))
    df["lon"] = df["地点経度（東経）"].map(lambda v: dms_to_deg(v, 3))
    s, w, n, e = BBOX
    return df[df.lat.between(s, n) & df.lon.between(w, e)]


def main() -> None:
    df = pd.concat([load_year(y) for y in YEARS], ignore_index=True)

    a_col, b_col = "当事者種別（当事者A）", "当事者種別（当事者B）"
    records = {
        "lat": df.lat.round(6).tolist(),
        "lon": df.lon.round(6).tolist(),
        "ym": (df["発生日時年"].astype(int) * 100 + df["発生日時月"].astype(int)).tolist(),
        "hour": df["発生日時時"].astype(int).tolist(),
        # 昼夜: 11-13 が昼、21-23 が夜
        "night": df["昼夜"].str.startswith("2").astype(int).tolist(),
        # 事故類型: 01 = 人対車両
        "ped": (df["事故類型"] == "01").astype(int).tolist(),
        # 当事者種別: 51/52 = 自転車
        "bike": (df[a_col].isin(["51", "52"]) | df[b_col].isin(["51", "52"])).astype(int).tolist(),
        "dead": df["死者数"].astype(int).tolist(),
        "hurt": df["負傷者数"].astype(int).tolist(),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(records, separators=(",", ":")), encoding="utf-8")
    print(
        f"{len(df)}件 歩行者{sum(records['ped'])} 自転車{sum(records['bike'])} "
        f"夜{sum(records['night'])} 死者{sum(records['dead'])} -> {OUT} {OUT.stat().st_size/1e6:.1f}MB"
    )


if __name__ == "__main__":
    main()
