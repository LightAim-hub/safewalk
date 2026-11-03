# SafeWalk

神戸市の徒歩専用の地図アプリです。場所の検索、場所の情報、徒歩の経路と歩きながらの案内に加えて、
経路ごとに、公開データから計算した交通事故の記録の目安と注意書きを表示します。車・電車の経路は扱いません。

Built with Claude: Japan 2026（テーマ2「本来、誰にでも届くべきものを。」）の参加作品です。
このリポジトリは 2026-11-02 のキックオフ後に新規作成しました。コードはすべてハッカソン期間中に書いています。

## なぜ作るのか

終電を逃して、夜の道を20km近く歩くことがあります。歩くのは好きですが、夜道は少し怖い。
遠くにいる恋人や子ども、親に「この道を通って」と安全な道を渡せたら、見守れない距離でも少し安心できます。

事故や犯罪の統計は公開されているのに、「どの道を歩けばいいか」には変換されていません。
SafeWalk はこの壁を取り払います。

## 安全度の扱い

「安全」「危険」の%や点数は出しません。出すのは次の2つと、注意書きです。
**交通事故の記録に基づく目安であり、安全を保証しません。**

- **交通事故の記録**: 経路の近く（30m以内）の、歩行者・自転車が関わる事故の記録を1kmあたりに直し、
  神戸市の道の分布と比べて「注意が要る」「ふつう」「比較的記録が少ない」の3段階で示します。
  人家から離れた区間が長い経路は、段階を出さず「不明」とし、理由を距離つきで示します。
- **夜の歩きやすさ**（夜のみ）: 人家から離れた区間の長さと、深夜も開いている店の数を、言葉で示します。
- **注意書き**: 経路の近くの事故の記録（自転車・歩行者）と、通る町丁目のひったくりの記録から、最大3つ。
  歩いている間に、記録のある地点・地区へ近づいたら画面と音声で知らせます。

犯罪（ひったくり以外の暴行・痴漢・声かけなど）、街灯、防犯カメラ、人通りは段階の計算に入れていません。
ひったくりも点数にはせず、注意書きと知らせの言葉にだけ使っています。
犯罪の側は町丁目単位の件数しか無く、道ごとの精度を検証できていません。
計算の方法・期間と単位・段階の境目の数字は、アプリの[説明ページ](public/safety.html)（`/safety.html`）にあります。

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
「経路」から徒歩の経路を出します。昼・夜を切り替えると、夜向けの経路と夜の歩きやすさの表示になります。

## 使っているデータ

ハッカソン期間中に各提供元から取得し、`pipeline/` で加工しています。

| データ | 提供元 | 利用条件 |
| --- | --- | --- |
| 交通事故（2020〜2025年） | [警察庁 交通事故統計情報のオープンデータ](https://www.npa.go.jp/publications/statistics/koutsuu/opendata/index_opendata.html) | 公共データ利用規約 PDL1.0 |
| ひったくり（2018〜2025年） | 兵庫県警察の犯罪発生状況、兵庫県オープンデータカタログ。町丁目ごとの件数に加工して利用しており、兵庫県が作成した物ではありません | [CC BY 2.1 JP](https://creativecommons.org/licenses/by/2.1/jp/deed.ja) |
| 町丁目の境界 | [総務省統計局 e-Stat](https://www.e-stat.go.jp/) 2020年国勢調査 小地域（町丁・字等）境界を加工 | 政府統計の総合窓口（e-Stat）の利用規約 |
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
`cautions.json` は、ひったくりの町丁目ごとの件数・町丁目の境界・事故の段階の境目・深夜営業の店の位置を加工した物です。
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
# 注意書きと段階の境目（ひったくり・町丁目境界を data/raw/stats に置いてから）
PYTHONPATH=pipeline .venv/Scripts/python pipeline/03_cautions.py
```
