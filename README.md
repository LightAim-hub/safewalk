# SafeWalk

神戸市の徒歩専用の地図アプリです。場所の検索、場所の情報、徒歩の経路と歩きながらの案内に加えて、
経路ごとに、公開データから計算した安全度の目安を表示します。車・電車の経路は扱いません。

Built with Claude: Japan 2026（テーマ2「本来、誰にでも届くべきものを。」）の参加作品です。
このリポジトリは 2026-11-02 のキックオフ後に新規作成しました。コードはすべてハッカソン期間中に書いています。

## なぜ作るのか

終電を逃して、夜の道を20km近く歩くことがあります。歩くのは好きですが、夜道は少し怖い。
遠くにいる恋人や子ども、親に「この道を通って」と安全な道を渡せたら、見守れない距離でも少し安心できます。

事故や犯罪の統計は公開されているのに、「どの道を歩けばいいか」には変換されていません。
SafeWalk はこの壁を取り払います。

## 安全度の扱い

安全度は公開データから計算した**目安**です。その道の安全を保証するものではありません。
現在の計算に使っているのは交通事故のデータだけで、犯罪や道の明るさはまだ反映していません。

## 今の状態（2026-11-03）

開発中です。地図・検索・徒歩経路・案内はパソコンのブラウザで動作を確かめていますが、
スマートフォンで実際に歩いての確認はまだです。アプリの中で Claude を使う機能はこれから作ります。
実装した要素と状態は [docs/google-maps-elements.md](docs/google-maps-elements.md) にあります。

## 試し方

Node.js 18 以降で次を実行し、表示された URL（既定は <http://localhost:5173/>）を開きます。

```sh
npm install
npm run dev
```

検索欄に「三宮駅」「メリケンパーク」などを入れるか、地図をクリック（スマートフォンは長押し）して地点を選び、
「経路」から徒歩の経路を出します。昼・夜を切り替えると、夜向けの経路と安全度になります。

## 使っているデータ

ハッカソン期間中に各提供元から取得し、`pipeline/` で加工しています。

| データ | 提供元 | 利用条件 |
| --- | --- | --- |
| 交通事故（2020〜2025年） | [警察庁 交通事故統計情報のオープンデータ](https://www.npa.go.jp/publications/statistics/koutsuu/opendata/index_opendata.html) | 公共データ利用規約 PDL1.0 |
| 道路網 | [OpenStreetMap](https://www.openstreetmap.org/copyright)（Geofabrik 抽出） | ODbL |
| 地名・神戸市の行政界 | [OpenStreetMap](https://www.openstreetmap.org/copyright) | ODbL |
| 背景地図 | [OpenFreeMap](https://openfreemap.org/) / OpenMapTiles / OpenStreetMap | 各提供元の条件 |
| 住所検索 | [国土地理院 住所検索](https://msearch.gsi.go.jp/) | 国土地理院コンテンツ利用規約 |
| 郵便番号から町名 | [zipcloud 郵便番号検索API](https://zipcloud.ibsnet.co.jp/doc/api)（株式会社アイビス） | zipcloud 利用規約 |
| 地点の住所（逆ジオコーダー） | [国土地理院](https://mreversegeocoder.gsi.go.jp/) | 国土地理院コンテンツ利用規約 |
| 標高 | [国土地理院 標高タイル](https://maps.gsi.go.jp/development/demtile.html) | 国土地理院コンテンツ利用規約 |
| 航空写真・陰影起伏 | [国土地理院 地理院タイル](https://maps.gsi.go.jp/development/ichiran.html) | 国土地理院コンテンツ利用規約 |

`public/data/` の `graph.bin`・`names.json`・`places.json`・`kobe.geojson` は
OpenStreetMap から作った派生データで、© OpenStreetMap contributors、
[ODbL](https://opendatacommons.org/licenses/odbl/) の条件で提供します。
`accidents.json` は警察庁のデータを加工したものです
（出典: 警察庁「交通事故統計情報のオープンデータ」を加工して作成）。
個人を特定できる情報は含みません。

## Claude の使い方

このリポジトリのコードとデータ加工は、Claude Code を開発の中心に据えて書いています
（各コミットの `Co-Authored-By` を参照）。

## データの作り直し

```sh
python -m venv .venv && .venv/Scripts/pip install pandas osmium numpy shapely pillow pykakasi
# data/raw に事故データ(honhyo_年.csv)と kansai.osm.pbf を置いてから
PYTHONPATH=pipeline .venv/Scripts/python pipeline/00_kobe.py
PYTHONPATH=pipeline .venv/Scripts/python pipeline/01_accidents.py
PYTHONPATH=pipeline .venv/Scripts/python pipeline/02_graph.py
```
