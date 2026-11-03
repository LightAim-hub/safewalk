"""近くの交番を出すためのデータ public/data/koban.json を作る。

入力(data/raw/stats/ に置く。リポジトリには入れない):
  6_safety_places/hyogo_police_koban/kobe_police_geocoded.csv
    兵庫県警察「警察署・交番・駐在所の所在地」(2026年9月1日時点、兵庫県オープンデータカタログ、CC BY 2.1 JP)の住所を、
    国土地理院の住所検索で座標にした物(UTF-8)。

出力: [名前, 種別, 緯度, 経度, 一致の度合い] の配列。
  - 座標が無い物(不一致)と、「町名まで」しか一致しない物(数百m以上ずれうる)は入れない。
  - 「丁目まで」の物は入れるが、一致の度合いを残す(画面で位置は目安と添える)。
  - 24時間人がいるのは警察署だけ。交番・駐在所は勤務員が不在の時間がある。
"""
import csv
import json
from pathlib import Path

SRC = Path("data/raw/stats/6_safety_places/hyogo_police_koban/kobe_police_geocoded.csv")
OUT = Path("public/data/koban.json")
DROP = ("町名まで一致", "不一致")


def main() -> None:
    rows = []
    dropped = []
    with SRC.open(encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            if not r["緯度"] or not r["経度"] or r["一致の度合い"].startswith(DROP):
                dropped.append(r["名前"])
                continue
            level = "丁目" if r["一致の度合い"].startswith("丁目") else "番"
            rows.append([r["名前"], r["種別"], round(float(r["緯度"]), 6), round(float(r["経度"]), 6), level])
    OUT.write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{OUT}: {len(rows)} か所 / 除いた {len(dropped)}: {', '.join(dropped)}")


if __name__ == "__main__":
    main()
