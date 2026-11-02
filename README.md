# SafeWalk

出発地と目的地を入れると、経路が3〜4本出て、それぞれに安全度が付く歩行ナビです。
経路を選ぶと、その道で過去に何があったかを、公開データに基づいて確かめられます。

Built with Claude: Japan 2026（テーマ2「本来、誰にでも届くべきものを。」）の参加作品です。
このリポジトリは 2026-11-02 のキックオフ後に新規作成しました。コードはすべてハッカソン期間中に書いています。

## なぜ作るのか

終電を逃して、夜の道を20km近く歩くことがあります。歩くのは好きですが、夜道は少し怖い。
遠くにいる恋人や子ども、親に「この道を通って」と安全な道を渡せたら、見守れない距離でも少し安心できます。

事故や犯罪の統計は公開されているのに、「どの道を歩けばいいか」には変換されていません。
SafeWalk はこの壁を取り払います。

## 安全度の扱い

安全度は公開データから計算した**目安**です。その道の安全を保証するものではありません。
犯罪の公開データは町丁目単位までのため、「この道で犯罪が何件」とは表示しません。

## 使っているデータ

ハッカソン期間中に各提供元から取得し、`pipeline/` で加工しています。

| データ | 提供元 | 利用条件 |
| --- | --- | --- |
| 交通事故（2020〜2025年） | [警察庁 交通事故統計情報のオープンデータ](https://www.npa.go.jp/publications/statistics/koutsuu/opendata/index_opendata.html) | 公共データ利用規約 PDL1.0 |
| 道路網 | [OpenStreetMap](https://www.openstreetmap.org/copyright)（Geofabrik 抽出） | ODbL |
| 地名・神戸市の行政界 | [OpenStreetMap](https://www.openstreetmap.org/copyright) | ODbL |
| 背景地図 | [OpenFreeMap](https://openfreemap.org/) / OpenMapTiles / OpenStreetMap | 各提供元の条件 |
| 住所検索・地点の住所 | [国土地理院 住所検索](https://msearch.gsi.go.jp/) | 国土地理院コンテンツ利用規約 |
| 標高 | [国土地理院 標高タイル](https://maps.gsi.go.jp/development/demtile.html) | 国土地理院コンテンツ利用規約 |

## データの作り直し

```sh
python -m venv .venv && .venv/Scripts/pip install pandas osmium numpy shapely pillow pykakasi
# data/raw に事故データ(honhyo_年.csv)と kansai.osm.pbf を置いてから
PYTHONPATH=pipeline .venv/Scripts/python pipeline/00_kobe.py
PYTHONPATH=pipeline .venv/Scripts/python pipeline/01_accidents.py
PYTHONPATH=pipeline .venv/Scripts/python pipeline/02_graph.py
```

## 開発

```sh
npm install
npm run dev
```
