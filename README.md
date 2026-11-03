# SafeWalk

神戸市の徒歩専用の地図アプリです。場所の検索、場所の情報、徒歩の経路と歩きながらの案内に加えて、
経路ごとに、公開データから計算した交通事故の記録の目安と注意書きを表示します。車・電車の経路は扱いません。

Built with Claude: Japan 2026（テーマ2「本来、誰にでも届くべきものを。」）の参加作品です。
このリポジトリは 2026-11-02 のキックオフ後に新規作成しました。コードはすべてハッカソン期間中に書いています。

## なぜ作るのか

終電を逃して、夜の道を20km近く歩くことがあります。歩くのは好きですが、夜道は少し怖い。
遠くにいる恋人や子ども、親に「この道を通って」と経路を渡せたら、見守れない距離でも、少し気持ちが楽になります。

事故や犯罪の統計は公開されているのに、「どの道を歩けばいいか」には変換されていません。
SafeWalk はこの壁を取り払います。

## 事故の記録の扱い

%や点数は出しません。出すのは次の2つと、注意書きです。
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

## 緊急の時・災害の時

「つけられている」「助けて」「倒れた」など緊急の言葉を事情に入れると、Claude の答えより上に、110・119・#7119（救急安心センター）と、
近くの交番を決まった文で出します。#7119 は神戸市の案内ページ（2026-11-03 確認）に基づきます。
地震・津波など災害の時の避難には使えません。自治体の避難情報に従ってください。特定の他人の行動を追う目的の相談は、Claude が断ります。

## 今の状態（2026-11-04）

完成版 v1（[v1.0.0](https://github.com/LightAim-hub/safewalk/releases/tag/v1.0.0)）を公開しています。
公開先: <https://lightaim-hub.github.io/safewalk/>（スマートフォンとパソコンのブラウザ。インストール不要）。

- 確かめたこと: 経路の一括検査（420組×昼夜＝840件）、模擬の利用者100通りの自動検査（端末・回線・使い方の違う台本。実在の利用者ではありません）、型検査、中継のテスト。
- 実機の iPhone で電波なしのまま開き直す動きは、まだ確かめていません。
- 不具合を見つけて直すため、使われ方とエラーの種類だけを記録しています（座標・検索の文字・IP は送りません。詳しくは[説明ページ](public/safety.html)）。
- 実装した要素と状態は [docs/google-maps-elements.md](docs/google-maps-elements.md) にあります。

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
| ひったくり・車上ねらい（2018〜2025年） | 兵庫県警察の犯罪発生状況、兵庫県オープンデータカタログ。町丁目ごとの件数を、人口あたりの率にして夜の経路の選び方に使うなど加工して利用しており、兵庫県が作成した物ではありません | [CC BY 2.1 JP](https://creativecommons.org/licenses/by/2.1/jp/deed.ja) |
| 交番・警察署・駐在所（2026年9月1日時点） | 兵庫県警察「警察署・交番・駐在所の所在地」、兵庫県オープンデータカタログ。住所を国土地理院の住所検索で座標に直して加工して利用しており、兵庫県・兵庫県警察が作成した物ではありません | [CC BY 2.1 JP](https://creativecommons.org/licenses/by/2.1/jp/deed.ja) |
| 町丁目の境界・人口 | [総務省統計局 e-Stat](https://www.e-stat.go.jp/) 2020年国勢調査 小地域（町丁・字等）境界を加工 | 政府統計の総合窓口（e-Stat）の利用規約 |
| 深夜の滞在人口（2019年） | [国土交通省 全国の人流オープンデータ](https://www.geospatial.jp/ckan/dataset/mlit-1km-fromto)（G空間情報センター）を加工して作成 | 全国の人流オープンデータ利用規約（CC BY 4.0 互換） |
| 夜間光（2023〜2025年） | 衛星 VIIRS 夜間光 年平均 V2.2（Earth Observation Group）を加工して作成 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.ja) |
| 道路網 | [OpenStreetMap](https://www.openstreetmap.org/copyright)（Geofabrik 抽出） | ODbL |
| 地名・神戸市の行政界 | [OpenStreetMap](https://www.openstreetmap.org/copyright) | ODbL |
| 背景地図 | [OpenFreeMap](https://openfreemap.org/) / OpenMapTiles / OpenStreetMap | 各提供元の条件 |
| 書体 | BIZ UDPゴシック（Morisawa / SIL OFL 1.1）。[Google Fonts の配布物](https://github.com/google/fonts/tree/main/ofl/bizudpgothic)から、使う文字だけに絞った woff2 を同梱（`public/fonts/`、全文 `public/fonts/OFL.txt`） | [SIL Open Font License 1.1](https://openfontlicense.org/) |
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

### 作る側の Claude Code（開発の進め方）

作者はコードを1行も書いていません。仕様の判断を作者がし、実装・検査・修正は Claude Code が行いました。
2026-11-02〜11-04 の3日間で、コミットは138本です（11/2: 13、11/3: 81、11/4: 44）。

- **役割で分けた並列のセッション**: 次の3つを別々のセッションで同時に動かしました。
  - 本体の開発
  - 公開データ集め（事故・ひったくり・交番などの出典と利用条件の台帳づくり）
  - ハッカソンのルールと表示の決まりの監査。監査役は作業をせず、違反や表現の誤りを本体の開発へ伝えます
    （例: 「利用者100人」と書かず「模擬の利用者100通り」と書く）。
- **サブエージェントの並列作業**: 調べる観点や直す場所ごとにサブエージェントへ分け、git の worktree で互いの作業を分けて同時に進め、結果を本体で確かめてから取り込みました。
- **自前の検査道具**: Claude Code に検査の道具そのものも作らせ、直すたびに回しています。
  - `tools/route_suite.mjs`: 経路 420組×昼夜。前回との差分で、遠回り・経路なしの増減を見ます。
  - `tools/persona_test.py`: 模擬の利用者100通り（高齢の方・観光客・電波が弱い・位置を断った・音声読み上げ・横向き など）をブラウザで動かし、詰まった所・画面の禁句・エラーを集めます。
  - `tools/check.py`、`worker/test/`: 画面の基本の動きと、中継の入力検査・上限。
- **立場を分けた議論**: 地図の方針や安全の表し方は、推進・反対・審査員の立場の Claude と別の AI に議論させ、
  裁定を作者が選びました（例: % の安全度をやめて「交通事故の記録」と「夜の歩きやすさ」の2つにする）。
- **作者の環境の hook と skill**: 返事の言葉づかい、出す前のレビュー、破壊的な操作の確認などを、作者の個人の Claude Code の設定（このリポジトリの外）で掛けています。

### 画面の中の Claude（経路の相談）

経路の画面の「事情を伝えて、道を選んでもらう」に、歩く事情（例: 子どもが一人で帰る）を入れると、Claude が経路の記録を道具で調べ、
どの経路が合うかを理由つきで答えます。答えは、`src/agent.ts` の照合を通った文だけを出します（禁止語・記録に無い数字・実在しない根拠は固定の文に差し替え）。
注意書きと免責は、Claude が書いた文ではなく `src/safety.ts` の固定の文です。経路の検索そのものは Claude を使わず、これまでどおり動きます。

- Claude を呼ぶ鍵はブラウザに無く、中継（`worker/`、Cloudflare Workers）の環境変数にあります。
- 中継の URL は `src/agent.ts` の `AGENT_ENDPOINT` の1か所です。deploy し直して URL が変わった時は、そこだけ書き換えます。
- 中継が使えない（未設定・回数の上限・通信の失敗）時は、「今は使えません」などの短い文を出し、経路の一覧はそのまま使えます。
- 経由地を入れている間は、相談は使えません。

## データの作り直し

`public/data/` の派生データは、公開データを `data/raw/`（git の外）に置いて `pipeline/` で作り直せます。
次はリポジトリの直下で実行します。Python 3.12 で動かしました（版は下の一覧）。

```sh
python -m venv .venv
.venv/Scripts/pip install pandas==3.1.0 numpy==2.5.4 osmium==4.3.2 shapely==2.2.0 pillow==13.0.0 pykakasi==2.3.0 pyshp==3.1.6
# macOS・Linux は .venv/bin/pip と .venv/bin/python
```

### 1. 生データを置く

取得日はいずれも 2026-11-02〜03 です。再取得すると中身が変わることがあります（OSM は日々更新、統計は年が増える）。

| 置き場所 | 中身 | 取得元 | 取得日 |
| --- | --- | --- | --- |
| `data/raw/honhyo_2020.csv` 〜 `honhyo_2025.csv` | 交通事故の本票（Shift_JIS） | <https://www.npa.go.jp/publications/statistics/koutsuu/opendata/index_opendata.html>（各年のページ） | 2026-11-02 |
| `data/raw/kansai.osm.pbf` | OpenStreetMap の関西の抽出 | Geofabrik <https://download.geofabrik.de/asia/japan/kansai.html> | 2026-11-02 |
| `data/raw/stats/hittakuri/hyogo_2018hittakuri.csv` 〜 `hyogo_2025hittakuri.csv` | 兵庫県警 ひったくり（町丁目単位） | 兵庫県オープンデータカタログ <https://web.pref.hyogo.lg.jp/kk26/johoseisaku/opendata.html> | 2026-11-03 |
| `data/raw/stats/estat/<区コード>/r2ka<区コード>.shp`（28101・28102・28105〜28111） | 2020年国勢調査 小地域（町丁・字等）境界 | e-Stat 統計地理情報システム <https://www.e-stat.go.jp/gis/statmap-search>（2020年国勢調査・小地域・世界測地系緯度経度のシェイプ形式。区ごとの取得先は `https://www.e-stat.go.jp/gis/statmap-search/data?dlserveyId=A002005212020&code=<区コード>&coordSys=1&format=shape&downloadType=5&datum=2011`） | 2026-11-03 |
| `data/raw/stats/6_safety_places/hyogo_police_koban/kobe_police_geocoded.csv` | 交番・警察署・駐在所（2026年9月1日時点）の住所に座標を付けた物（UTF-8） | 兵庫県警「警察署・交番・駐在所の所在地」（上の兵庫県のページの `r8-9-police.xlsx`）の住所を、国土地理院の住所検索 <https://msearch.gsi.go.jp/> で座標にした物。座標を付ける小さなスクリプトはこのリポジトリに無い | 2026-11-03 |
| `data/raw/dem/` | 標高タイルの置き場 | 国土地理院 標高タイル（02 が自動で取得して置く。<https://maps.gsi.go.jp/development/demtile.html>） | 実行時 |

`05_crime.py` は、上の表に加えて `data/raw/stats/1_crime/hyogo_police_theft/`（ひったくり・車上ねらい）、`3_area/estat_2020/`、`4_people/mlit_jinryu/`（国土交通省「全国の人流オープンデータ」<https://www.geospatial.jp/ckan/dataset/mlit-1km-fromto>）、`5_light/viirs/`（衛星の夜間光）を読みます。

ひったくりの CSV は 2024年だけ UTF-8、ほかは Shift_JIS です（`03_cautions.py` がファイル名の年で切り替えます）。

### 2. 実行の順番

前の段の出力を次の段が読むので、この順に実行します。

```sh
export PYTHONPATH=pipeline
.venv/Scripts/python pipeline/00_kobe.py       # 行政界と地名: kobe.geojson, places.json
.venv/Scripts/python pipeline/01_accidents.py  # 事故: accidents.json
.venv/Scripts/python pipeline/02_graph.py      # 歩ける道: graph.bin, graph.meta.json, names.json, graph.ids.bin（標高を取得するため通信が要る）
.venv/Scripts/python pipeline/03_cautions.py   # 注意書きと段階の境目: cautions.json（01・02・00 の出力を読む）
.venv/Scripts/python pipeline/04_koban.py      # 近くの交番: koban.json
.venv/Scripts/python pipeline/05_crime.py      # 夜の経路の費用に足す値: graph.bin の末尾に付ける（02 を作り直したら必ず実行し直す）
```

作り直した後は `npx tsc --noEmit`、`npm run build`、`python tools/check.py` で動きを確かめてください。

`05_crime.py` は、町丁目ごとの犯罪の記録（ひったくり・車上ねらいの8年合計）を深夜の滞在人口あたりの率にし、深夜の滞在人口・夜間光と合わせて道ごとの小さな足し分にします。夜の「最短ではない」候補にだけ効き、昼は変わりません。8年合計が5件に満たない町丁目は使わず、足し分は道の長さの2割までです。町名・件数・色・地図の印は画面に出しません。
