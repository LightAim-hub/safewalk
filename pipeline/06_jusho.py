"""住居表示住所（何丁目何番何号）の位置を、区ごとの小さな JSON にする。

出典: 国土地理院「電子国土基本図（地名情報）住居表示住所」（2025-07-31 版）を加工して作成
https://saigai.gsi.go.jp/jusho/download/index.html
生データ: data/raw/jusho/<市区町村コード>.zip（git の外）
出力: public/data/jusho/<区の名前>.json = {"町丁目": {"番": {"号": [経度, 緯度]}}}
住居表示が行われていない地域（地番の住所）は入っていない。
"""
import csv
import io
import json
import zipfile
from pathlib import Path

RAW = Path("data/raw/jusho")
OUT = Path("public/data/jusho")
WARDS = {"28101": "東灘区", "28102": "灘区", "28105": "兵庫区", "28106": "長田区", "28107": "須磨区",
         "28108": "垂水区", "28109": "北区", "28110": "中央区", "28111": "西区"}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    total = 0
    for code, ward in WARDS.items():
        z = zipfile.ZipFile(RAW / f"{code}.zip")
        name = next(n for n in z.namelist() if n.endswith(".csv"))
        rows = csv.reader(io.StringIO(z.read(name).decode("utf-8")))
        towns: dict[str, dict[str, dict[str, list[float]]]] = {}
        n = 0
        for r in rows:
            if len(r) < 8 or not r[6]:
                continue
            town, ban, go = r[1].strip(), r[2].strip(), r[3].strip()
            try:
                lon, lat = round(float(r[6]), 6), round(float(r[7]), 6)
            except ValueError:
                continue
            towns.setdefault(town, {}).setdefault(ban, {})[go] = [lon, lat]
            n += 1
        path = OUT / f"{ward}.json"
        path.write_text(json.dumps(towns, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        total += n
        print(f"{ward} {n}件 町丁目{len(towns)} -> {path} {path.stat().st_size/1e6:.2f}MB")
    print("合計", total)


if __name__ == "__main__":
    main()
