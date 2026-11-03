// route_suite.mjs --dump で書いた 2 つの JSON(前と後)を比べる。
// 実行: node tools/route_suite_compare.mjs 前.json 後.json [変化の詳細を書く先.json]
//   昼夜ごとに「経路の道が変わった組」の数、距離の増え方の分布を出す。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [oldFile, newFile, outFile] = process.argv.slice(2);
const a = JSON.parse(fs.readFileSync(oldFile, "utf8"));
const b = JSON.parse(fs.readFileSync(newFile, "utf8"));
const sig = (r) => r.edges.join(",");
const stat = { day: { cases: 0, any: 0, first: 0 }, night: { cases: 0, any: 0, first: 0 } };
const changed = [];
for (const k of Object.keys(a)) {
  const p = a[k].period;
  const x = a[k].routes;
  const y = b[k]?.routes ?? [];
  stat[p].cases++;
  const anyDiff = x.length !== y.length || x.some((r, i) => sig(r) !== sig(y[i]));
  if (anyDiff) stat[p].any++;
  if (x[0] && y[0] && sig(x[0]) !== sig(y[0])) stat[p].first++;
  if (!anyDiff) continue;
  x.forEach((r, i) => {
    const q = y[i];
    if (q && sig(r) !== sig(q)) changed.push({ key: k, index: i, type: a[k].type, ratio: q.metres / r.metres, diff: q.metres - r.metres, before: r.metres, after: q.metres, viaBefore: r.via, viaAfter: q.via, from: a[k].from, to: a[k].to, period: p });
  });
}
console.log("昼夜ごと(組の数 / 経路のどれかの道が変わった組 / 先頭の経路が変わった組)");
for (const p of ["day", "night"]) console.log(`  ${p}: ${stat[p].cases} / ${stat[p].any} / ${stat[p].first}`);
const ratios = changed.map((c) => c.ratio).sort((u, v) => u - v);
const q = (f) => ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * f))];
console.log(`道が変わった経路(夜) ${changed.length}本  距離の比 最小 ${ratios[0]?.toFixed(3)}・中央 ${q(0.5)?.toFixed(3)}・90% ${q(0.9)?.toFixed(3)}・最大 ${ratios.at(-1)?.toFixed(3)}`);
console.log("増減(m)", changed.map((c) => Math.round(c.diff)).sort((u, v) => u - v).join(" "));
if (outFile) fs.writeFileSync(outFile, JSON.stringify(changed, null, 1));

// ---------------------------------------------------------------- 駅前・繁華街を避けるようになっていないか
// 主な駅の 300m 以内を通る長さ(夜の全経路の合計)を、前と後で比べる。
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const places = JSON.parse(fs.readFileSync(path.join(root, "public/data/places.json"), "utf8"));
const HUBS = ["三ノ宮", "三宮", "元町", "神戸", "新長田", "垂水", "西神中央", "住吉", "六甲道", "板宿", "須磨", "舞子", "岡本", "灘", "兵庫", "新神戸", "湊川", "谷上", "三宮・花時計前", "県庁前", "ハーバーランド", "高速神戸", "大倉山", "学園都市", "名谷", "鈴蘭台", "西神南"];
const hubs = places.filter(([n, , , kind]) => kind === "駅" && HUBS.some((h) => n.replace(/駅$/, "").startsWith(h))).map(([n, la, lo]) => ({ n, la, lo }));
const near = (la, lo) => hubs.some((h) => Math.hypot((lo - h.lo) * 91000, (la - h.la) * 111000) <= 300);
function hubMetres(routes) {
  let sum = 0;
  let all = 0;
  for (const r of routes) {
    const c = r.coords ?? [];
    for (let i = 1; i < c.length; i++) {
      const len = Math.hypot((c[i][0] - c[i - 1][0]) * 91000, (c[i][1] - c[i - 1][1]) * 111000);
      all += len;
      if (near((c[i][1] + c[i - 1][1]) / 2, (c[i][0] + c[i - 1][0]) / 2)) sum += len;
    }
  }
  return [sum, all];
}
let before = [0, 0];
let after = [0, 0];
const worse = [];
for (const k of Object.keys(a)) {
  if (a[k].period !== "night") continue;
  const x = hubMetres(a[k].routes);
  const y = hubMetres(b[k].routes);
  before = [before[0] + x[0], before[1] + x[1]];
  after = [after[0] + y[0], after[1] + y[1]];
  if (x[0] - y[0] > 100) worse.push([Math.round(x[0] - y[0]), k]);
}
console.log(`主な駅(${hubs.length}か所)の300m以内を通る長さ(夜・全経路の合計): 前 ${(before[0] / 1000).toFixed(1)}km (全体の ${((100 * before[0]) / before[1]).toFixed(2)}%) → 後 ${(after[0] / 1000).toFixed(1)}km (${((100 * after[0]) / after[1]).toFixed(2)}%)`);
console.log(`駅前を通る長さが 100m 以上減った組: ${worse.length}件`, worse.slice(0, 5).map((w) => `${w[0]}m ${w[1]}`).join(" / "));
