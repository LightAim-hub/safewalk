# 並列作業の分担（2026-11-03）

地図の完成度を上げるため、4 つの担当が別々の作業場所（git worktree・ブランチ）で同時に作業する。
合わせる（merge する）のはまとめ役だけ。各担当は自分のブランチに commit し、push と merge はしない。

## 担当と触ってよいファイル

| 担当 | 内容 | 触ってよいファイル |
| --- | --- | --- |
| A 検索・場所 | 検索の候補と並び順、場所の情報 | `src/search.ts` `src/place.ts` `pipeline/00_kobe.py` `public/data/places.json` `public/data/kobe.geojson` 新規 `src/search.css` |
| B 道のデータと経路 | 歩ける道、経路の探索、経由名、曲がる案内の文、所要時間 | `pipeline/02_graph.py` `pipeline/area.py` `pipeline/dem.py` `src/routes.ts` `src/graph.ts` `public/data/graph.bin` `public/data/graph.meta.json` `public/data/names.json` |
| C 経路画面と案内 | 経路の一覧・地図上の表示、歩きながらの案内 | `src/directions.ts` `src/guide.ts` `src/accidents-ui.ts` 新規 `src/directions.css` |
| D 地図と操作 | 地図の見た目、拡大、戻る・URL、スマホの配置 | `src/map-ui.ts` `src/url.ts` `src/main.ts` `index.html` `src/style.css` |

- 一覧に無いファイル（`src/app.ts` `src/types.ts` `README.md` `docs/` `tools/` ほか）は触らない。
  共通の部分に変更が要る時は、自分のファイルの中で済ませるか、報告に「まとめ役に頼みたい変更」として書く。
- 自分の CSS が要る時は、担当欄の新規 CSS を作り、自分の `.ts` から `import "./xxx.css";` で読む。
- 他の担当のファイルにある関数は、呼んでよいが書き換えない。関数の名前と引数を変えない。

## 確認

1. `npx tsc --noEmit` と `npx vite build` が通る。
2. 自分の番号で `npx vite preview --port <番号>` を起動し（A 4174・B 4175・C 4176・D 4177。4173 はまとめ役用）、
   `python tools/check.py http://localhost:<番号>/` の結果を `tools/check_baseline.txt` と比べる。
   変わった行が、意図した変更だけであること。ブラウザのエラーが 0 件であること。
3. 画面を変えた時は、PC（1280×800）とスマホ（390×844）のスクリーンショットを自分の目で見る。
