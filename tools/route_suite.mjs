// 経路の品質を数百組で自動で確かめる(ブラウザ不要)。
// 本物の public/data と src の経路探索(routes.ts / graph.ts / safety.ts)を、esbuild で束ねて node で動かす。
// 画面(directions.ts)が経路を出した後に行う処理(connectEnds・isDetour・assess)は同じ式で再現する。
//
// 実行: リポジトリの直下で  node tools/route_suite.mjs
//   --update       結果を tools/route_suite_baseline.json に保存し直す(無ければ自動で作る)
//   --pairs=N      組の数(既定 420。出発地と目的地の組。昼と夜で2倍探す)
//   --seed=N       乱数の種(既定 20261104。同じ種なら同じ組になる)
//   --quiet        組ごとの差分を省き、要約だけ出す
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const PAIRS = Number(args.pairs ?? 420);
const SEED = Number(args.seed ?? 20261104);
const BASELINE = path.join(root, "tools", "route_suite_baseline.json");
const SITE = "https://lightaim-hub.github.io/safewalk/";
const t0 = performance.now();

// ---------------------------------------------------------------- src を束ねて読む
const require = createRequire(path.join(root, "package.json"));
const esbuild = require("esbuild");
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "route-suite-")), "bundle.mjs");
const src = (f) => JSON.stringify(path.join(root, "src", f).replace(/\\/g, "/"));
await esbuild.build({
  stdin: {
    contents: `
      export { Graph, metres, REMOTE, OUTSIDE } from ${src("graph.ts")};
      export { findRoutes, minutesFor, AccidentIndex, WALK_M_PER_MIN } from ${src("routes.ts")};
      export { createSafety, assess, SAFETY_RULES } from ${src("safety.ts")};
    `,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: out,
  logLevel: "error",
});
const M = await import(pathToFileURL(out).href);

// ---------------------------------------------------------------- 本物のデータ(src/data.ts と同じ作り)
const dataPath = (f) => path.join(root, "public/data", f);
const json = (f) => JSON.parse(fs.readFileSync(dataPath(f), "utf8"));
const bin = fs.readFileSync(dataPath("graph.bin"));
const graph = new M.Graph(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const accJson = json("accidents.json");
const accidents = new M.AccidentIndex(accJson);
const safety = M.createSafety(json("cautions.json"), accJson);
const meta = json("graph.meta.json");
const names = json("names.json");
const kobe = json("kobe.geojson").geometry;
const rings = (kobe.type === "Polygon" ? [kobe.coordinates] : kobe.coordinates).flat();
const places = json("places.json").map(([raw, lat, lon, kind]) => ({
  name: kind === "駅" && !raw.endsWith("駅") ? `${raw}駅` : raw,
  lat,
  lon,
  kind,
}));

function inKobe(p) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[j];
      if (y1 > p.lat !== y2 > p.lat && p.lon < ((x2 - x1) * (p.lat - y1)) / (y2 - y1) + x1) inside = !inside;
    }
  }
  return inside;
}
/** src/data.ts の snap と同じ(500m)。 */
function snap(p) {
  if (!inKobe(p)) return null;
  const r = graph.nearestRoad(p);
  return r && r.metres <= 500 ? r : null;
}
/** 市の外の点から、市の境界までの距離(m)。 */
function distanceOutside(p) {
  const k = Math.cos((p.lat * Math.PI) / 180);
  let best = Infinity;
  for (const ring of rings)
    for (let i = 0; i + 1 < ring.length; i++) {
      const ax = (ring[i][0] - p.lon) * k * 111320;
      const ay = (ring[i][1] - p.lat) * 110540;
      const bx = (ring[i + 1][0] - p.lon) * k * 111320;
      const by = (ring[i + 1][1] - p.lat) * 110540;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  return best;
}

// ---------------------------------------------------------------- 固定の乱数
let seed = SEED >>> 0;
const rand = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (a, b) => a + (b - a) * rand();
const choice = (list) => list[Math.floor(rand() * list.length)];

// ---------------------------------------------------------------- 出発地・目的地の候補
const usable = (p) => snap(p) !== null;
const stations = places.filter((p) => p.kind === "駅" && usable(p));
const FACILITY_KINDS = new Set(["学校", "病院", "役所", "大学", "博物館", "図書館", "商業施設", "百貨店", "公園", "観光", "史跡", "寺社", "スーパー", "展望地", "宿泊", "公民館", "警察", "郵便局", "劇場", "映画館", "動物園", "体育施設", "競技場", "名所", "コンビニ", "薬局"]);
const facilities = places.filter((p) => FACILITY_KINDS.has(p.kind) && usable(p));

function randomPoints(count, accept, box) {
  const list = [];
  for (let tries = 0; list.length < count && tries < count * 4000; tries++) {
    const p = { name: "", lat: between(box[0], box[1]), lon: between(box[2], box[3]), kind: "" };
    if (!inKobe(p)) continue;
    const road = graph.nearestRoad(p);
    if (!road || road.metres > 500) continue;
    if (accept(p, road)) list.push(p);
  }
  return list;
}
const residential = randomPoints(500, (_, r) => r.metres <= 60 && !(graph.flags[r.edge] & M.REMOTE), [34.64, 34.76, 135.0, 135.3]);
const mountain = [
  ...places.filter((p) => p.kind === "展望地" && usable(p)),
  ...randomPoints(300, (p, r) => p.lat >= 34.735 && r.metres <= 200, [34.735, 34.9, 134.95, 135.35]),
];
const sea = randomPoints(300, (p, r) => {
  if (r.metres > 150) return false;
  return !inKobe({ lat: p.lat - 0.0065, lon: p.lon }); // 南 700m 先が市の外 = 海に面した所
}, [34.6, 34.72, 134.95, 135.35]);
const everything = [...stations, ...facilities, ...residential, ...mountain, ...sea];

/** 目標の直線距離(対数で一様)に近い相手を poolB から選ぶ。 */
function partner(a, poolB, minD, maxD) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const target = Math.exp(between(Math.log(minD), Math.log(maxD)));
    const near = poolB.filter((b) => {
      const d = M.metres(a, b);
      return d >= Math.max(minD, target * 0.75) && d <= Math.min(maxD, target * 1.33);
    });
    if (near.length) return choice(near);
  }
  return null;
}
/** 方位と距離で相手の点を作る(短距離用)。 */
function offset(a, minD, maxD) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const d = between(minD, maxD);
    const th = between(0, Math.PI * 2);
    const b = { name: "", kind: "", lat: a.lat + (d * Math.cos(th)) / 110540, lon: a.lon + (d * Math.sin(th)) / (111320 * Math.cos((a.lat * Math.PI) / 180)) };
    if (usable(b)) return b;
  }
  return null;
}

const TYPES = [
  ["駅どうし", () => [choice(stations), stations, 500, 15000]],
  ["主な施設どうし", () => [choice(facilities), facilities, 400, 12000]],
  ["住宅地", () => [choice(residential), residential, 300, 6000]],
  ["山側", () => [choice(mountain), [...mountain, ...stations], 300, 10000]],
  ["海側", () => [choice(sea), [...sea, ...stations, ...facilities], 300, 12000]],
  ["短距離300m〜1km", () => [choice(everything), null, 300, 1000]],
  ["長距離8〜15km", () => [choice(everything), everything, 8000, 15000]],
  ["混在", () => [choice(everything), everything, 300, 15000]],
];

const pairs = [];
for (let i = 0; pairs.length < PAIRS && i < PAIRS * 20; i++) {
  const [type, make] = TYPES[pairs.length % TYPES.length];
  const [a, poolB, minD, maxD] = make();
  const b = poolB ? partner(a, poolB, minD, maxD) : offset(a, minD, maxD);
  if (!a || !b || a === b || !usable(a) || !usable(b)) continue;
  pairs.push({ type, from: a, to: b, straight: M.metres(a, b) });
}
if (pairs.length < PAIRS) console.error(`注意: 組が ${pairs.length} しか作れませんでした(目標 ${PAIRS})`);

// ---------------------------------------------------------------- 1組の検査
const f5 = (v) => v.toFixed(5);
const urlOf = (c) => `${SITE}?from=${f5(c.from.lat)},${f5(c.from.lon)}&to=${f5(c.to.lat)},${f5(c.to.lon)}&period=${c.period}`;
const countNear = (r, period) => {
  const d = accidents.data;
  return r.accidents.filter((i) => (d.ped[i] || d.bike[i]) && (period !== "night" || d.night[i])).length;
};
function overlapOf(a, b) {
  const set = new Set(a);
  let shared = 0;
  let total = 0;
  for (const e of b) {
    total += graph.length[e];
    if (set.has(e)) shared += graph.length[e];
  }
  return total ? shared / total : 1;
}
const lineLength = (coords) => {
  let s = 0;
  for (let i = 1; i < coords.length; i++) s += M.metres({ lat: coords[i - 1][1], lon: coords[i - 1][0] }, { lat: coords[i][1], lon: coords[i][0] });
  return s;
};

const TIERS = new Set(["attention", "normal", "low", "unknown"]);
const SLOW_MS = 2000;

function runCase(pair, period) {
  const c = { type: pair.type, from: pair.from, to: pair.to, period, straight: pair.straight };
  const fails = []; // [種類, 説明]
  const info = [];
  const fail = (code, text) => fails.push([code, text]);

  const start = snap(pair.from);
  const goal = snap(pair.to);
  const tStart = performance.now();
  let routes;
  try {
    routes = M.findRoutes(graph, start, goal, period, accidents, meta, names);
  } catch (e) {
    c.ms = performance.now() - tStart;
    fail("例外", `findRoutes が例外: ${e.message}`);
    return { ...c, fails, info, routes: [] };
  }
  c.ms = performance.now() - tStart;
  if (c.ms > SLOW_MS) fail("探索が遅い", `${Math.round(c.ms)}ms`);

  if (!routes.length) {
    const sameComponentHint = start.edge === goal.edge ? "同じ道の上" : "道がつながっていない(分断された道網)";
    fail("経路が出ない", `歩いて行ける経路なし。${sameComponentHint}。出発地の道まで ${Math.round(start.metres)}m・目的地の道まで ${Math.round(goal.metres)}m`);
    return { ...c, fails, info, routes: [] };
  }

  // 画面が経路を出した後の処理(directions.ts showRoutes -> connectEnds)
  for (const r of routes) {
    const [sLon, sLat] = r.coords[0];
    const [eLon, eLat] = r.coords[r.coords.length - 1];
    r.metres += M.metres(pair.from, { lat: sLat, lon: sLon }) + M.metres(pair.to, { lat: eLat, lon: eLon });
    r.minutes = M.minutesFor(r.metres, r.climb);
    r.coords = [[pair.from.lon, pair.from.lat], ...r.coords, [pair.to.lon, pair.to.lat]];
  }
  const first = routes[0];
  const straight = pair.straight;

  // 夜の既定の経路(画面は最初の経路を選ぶ)
  if (!first || !first.coords.length) fail("既定の経路が無い", period);
  // 最短の札
  if (!routes.some((r) => r.label === "最短" || r.label === "おすすめ")) fail("最短の札が無い", `札: ${routes.map((r) => r.label).join(",")}`);
  if (routes.length > 1 && first.label !== "最短" && first.label !== "おすすめ") fail("最短の札が先頭に無い", `先頭の札: ${first.label}`);
  // 「最短」は所要時間(坂を含む)で選ぶ作り。時間で2分以上・5%以上短い候補があれば札が合っていない。
  const quickest = routes.reduce((a, b) => (b.minutes < a.minutes ? b : a));
  if (routes.length > 1 && first.label === "最短" && first.minutes - quickest.minutes >= 2 && first.minutes > quickest.minutes * 1.05) fail(period === "night" && quickest.remoteMetres > first.remoteMetres + 50 ? "最短の札が最短でない(夜に人家から離れた道を避けた結果)" : "最短の札が最短でない", `先頭 ${first.minutes}分(${Math.round(first.metres)}m)に対し ${quickest.minutes}分(${Math.round(quickest.metres)}m)の候補がある`);

  routes.forEach((r, i) => {
    const tag = `経路${"ABCDEFG"[i] ?? i}(${r.label})`;
    // 直線との比と遠回りの一行(directions.ts isDetour と同じ条件)
    const ratio = r.metres / straight;
    const detourLine = straight > 500 && r.metres > straight * 1.8;
    // 既定の経路(先頭)だけを不合格にする。別の道は、先頭の1.7倍までの候補なので参考に留める。
    const judged = i === 0;
    // 直線500m以下は遠回りの一行を出さない(余分に歩く距離がわずかなため)。不合格にせず参考に留める。
    const shortTrip = straight <= 500;
    if (ratio > 1.8 && !detourLine && (!judged || shortTrip)) info.push(["別の道が直線の1.8倍超(一行なし)", `${tag}: ${ratio.toFixed(2)}倍`]);
    if (ratio > 1.8 && !detourLine && judged && !shortTrip) fail("遠回りなのに一行が出ない", `${tag}: 直線 ${Math.round(straight)}m に対し ${Math.round(r.metres)}m(${ratio.toFixed(2)}倍。直線が500m以下なので一行が出ない)`);
    if (detourLine) info.push(["遠回りの一行あり", `${tag}: ${ratio.toFixed(2)}倍`]);
    if (ratio > 3 && judged) fail("遠回りが3倍超", `${tag}: 直線 ${Math.round(straight)}m に対し ${Math.round(r.metres)}m(${ratio.toFixed(2)}倍${detourLine ? "・一行は出る" : ""})`);
    if (r.metres < straight * 0.97) fail("経路が直線より短い", `${tag}: ${Math.round(r.metres)}m < 直線 ${Math.round(straight)}m`);
    // 所要時間と距離
    const speed = r.metres / Math.max(r.minutes, 1);
    if (r.minutes < 1 || !(speed >= 30 && speed <= 76)) fail("所要時間と距離が合わない", `${tag}: ${Math.round(r.metres)}m で ${r.minutes}分(分速 ${speed.toFixed(0)}m)`);
    // 点列の長さと距離
    const drawn = lineLength(r.coords);
    if (Math.abs(drawn - r.metres) > Math.max(30, r.metres * 0.03)) fail("点列の長さと距離が合わない", `${tag}: 点列 ${Math.round(drawn)}m・表示 ${Math.round(r.metres)}m`);
    // 市の境界
    let worst = 0;
    for (const [lon, lat] of r.coords) {
      const p = { lat, lon };
      if (!inKobe(p)) worst = Math.max(worst, distanceOutside(p));
    }
    if (worst > 300) {
      if (r.outsideMetres >= 100) info.push(["市外の迂回(理由あり)", `${tag}: 市の外へ最大 ${Math.round(worst)}m・市外の道 ${Math.round(r.outsideMetres)}m`]);
      else fail("市外へ出るのに理由が無い", `${tag}: 市の外へ最大 ${Math.round(worst)}m・市外の道 ${Math.round(r.outsideMetres)}m`);
    } else if (worst > 0) info.push(["市境のずれ(300m以内)", `${tag}: ${Math.round(worst)}m`]);
    // 件数・段階(directions.ts assessment と同じ呼び方)
    try {
      const a = M.assess(safety, r, period);
      const n = a.accident.count;
      if (!TIERS.has(a.accident.tier)) fail("段階が計算できない", `${tag}: 段階 ${a.accident.tier}`);
      else if (!Number.isInteger(n) || n < 0) fail("段階が計算できない", `${tag}: 件数 ${n}`);
      else if (a.accident.tier === "unknown") {
        if (!a.unknown) fail("評価なしの理由が無い", `${tag}: 段階は不明だが理由の文が無い`);
        info.push(["評価なし", `${tag}: ${a.unknown}`]);
      } else if (!Number.isFinite(a.accident.perKm)) fail("段階が計算できない", `${tag}: 1kmあたり ${a.accident.perKm}`);
      if (period === "night" && !a.night) fail("夜の評価が無い", tag);
      r._tier = a.accident.tier;
    } catch (e) {
      fail("段階が計算できない", `${tag}: 例外 ${e.message}`);
    }
  });

  // 候補の間の重複(routes.ts dropWorse が消すはずの物が残っていないか)
  const count = routes.map((r) => countNear(r, period));
  routes.forEach((r, i) => {
    if (i === 0) return;
    routes.forEach((o, j) => {
      if (j === i) return;
      const noWorse = o.metres <= r.metres && o.minutes <= r.minutes && count[j] <= count[i];
      if (!noWorse) return;
      const same = o.metres === r.metres && o.minutes === r.minutes && count[j] === count[i];
      const ov = overlapOf(o.edges, r.edges);
      if (!same) fail("劣る経路が残っている", `経路${"ABCDEFG"[i]}は経路${"ABCDEFG"[j]}より距離・時間・件数のどれも良くない(${Math.round(r.metres)}m/${r.minutes}分/${count[i]}件 対 ${Math.round(o.metres)}m/${o.minutes}分/${count[j]}件)`);
      else if (j < i && ov > 0.6) fail("ほぼ同じ経路が残っている", `経路${"ABCDEFG"[i]}は経路${"ABCDEFG"[j]}と数値が同じで道が ${(ov * 100).toFixed(0)}% 重なる`);
    });
    for (let j = 0; j < i; j++) {
      const ov = overlapOf(routes[j].edges, r.edges);
      if (ov > 0.85) fail("ほぼ同じ経路が残っている", `経路${"ABCDEFG"[i]}は経路${"ABCDEFG"[j]}と道が ${(ov * 100).toFixed(0)}% 重なる`);
    }
  });

  return { ...c, fails, info, routes };
}

// ---------------------------------------------------------------- 実行
const results = [];
for (const pair of pairs) for (const period of ["day", "night"]) results.push(runCase(pair, period));
const seconds = (performance.now() - t0) / 1000;

// ---------------------------------------------------------------- 記録(baseline)の形
const key = (c) => `${f5(c.from.lat)},${f5(c.from.lon)}>${f5(c.to.lat)},${f5(c.to.lon)}|${c.period}`;
const compact = (c) => {
  const r0 = c.routes[0];
  return {
    t: c.type,
    n: c.routes.length,
    m: r0 ? Math.round(r0.metres) : 0,
    min: r0 ? r0.minutes : 0,
    tier: r0?._tier ?? "",
    l: c.routes.map((r) => r.label).join("/"),
    f: [...new Set(c.fails.map((x) => x[0]))].sort(),
  };
};
const current = Object.fromEntries(results.map((c) => [key(c), compact(c)]));

// ---------------------------------------------------------------- 要約
const pct = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};
const total = results.length;
const bad = results.filter((c) => c.fails.length);
const byCode = new Map();
for (const c of bad) for (const [code, text] of c.fails) {
  const e = byCode.get(code) ?? { cases: new Set(), items: [] };
  if (!e.cases.has(c)) e.items.push({ c, text });
  e.cases.add(c);
  byCode.set(code, e);
}

const lines = [];
const say = (s = "") => lines.push(s);
say(`経路の品質の一括検査  ${pairs.length}組 × 昼夜 = ${total}件  種=${SEED}`);
say(`所要 ${seconds.toFixed(1)}秒(データ読み込みと束ねを含む)`);
say(`合格 ${total - bad.length}件 / 不合格 ${bad.length}件`);
say("");
say("組の種類ごと(不合格 / 件数)");
const types = [...new Set(pairs.map((p) => p.type))];
for (const t of types) {
  const rs = results.filter((c) => c.type === t);
  say(`  ${t.padEnd(14, "　")}${String(rs.filter((c) => c.fails.length).length).padStart(4)} / ${rs.length}`);
}
const d = pairs.map((p) => p.straight);
say(`  直線距離の分布: 最小 ${Math.round(Math.min(...d))}m・中央 ${Math.round(pct(d, 0.5))}m・最大 ${Math.round(Math.max(...d))}m`);
say("");
say("不合格の種類(件数・代表の URL)");
if (!byCode.size) say("  なし");
for (const [code, e] of [...byCode].sort((a, b) => b[1].cases.size - a[1].cases.size)) {
  say(`  ■ ${code}  ${e.cases.size}件`);
  for (const { c, text } of e.items.slice(0, 2)) {
    say(`      ${text}`);
    say(`      ${urlOf(c)}`);
  }
}
say("");
const infoCount = new Map();
for (const c of results) for (const [code] of c.info) infoCount.set(code, (infoCount.get(code) ?? 0) + 1);
say("参考(不合格ではない)");
for (const [code, n] of infoCount) say(`  ${code}: ${n}件`);
const withRoutes = results.filter((c) => c.routes.length);
const tiers = {};
for (const c of withRoutes) tiers[c.routes[0]._tier ?? "?"] = (tiers[c.routes[0]._tier ?? "?"] ?? 0) + 1;
say(`  先頭の経路の段階: ${Object.entries(tiers).map(([k, v]) => `${k}=${v}`).join(" ")}`);
const counts = {};
for (const c of withRoutes) counts[c.routes.length] = (counts[c.routes.length] ?? 0) + 1;
say(`  候補の数: ${Object.entries(counts).map(([k, v]) => `${k}本=${v}`).join(" ")}`);
const ms = results.map((c) => c.ms);
say("");
say(`探索時間(1件あたり ms): 中央 ${pct(ms, 0.5).toFixed(0)}・90% ${pct(ms, 0.9).toFixed(0)}・99% ${pct(ms, 0.99).toFixed(0)}・最大 ${Math.max(...ms).toFixed(0)}・平均 ${(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(0)}`);
for (const period of ["day", "night"]) {
  const m2 = results.filter((c) => c.period === period).map((c) => c.ms);
  say(`  ${period === "day" ? "昼" : "夜"}: 中央 ${pct(m2, 0.5).toFixed(0)}・90% ${pct(m2, 0.9).toFixed(0)}・最大 ${Math.max(...m2).toFixed(0)}`);
}
const slowest = [...results].sort((a, b) => b.ms - a.ms)[0];
say(`  最も遅い: ${Math.round(slowest.ms)}ms  ${urlOf(slowest)}`);

// ---------------------------------------------------------------- 前回との差分
say("");
if (!fs.existsSync(BASELINE)) {
  fs.writeFileSync(BASELINE, serialize(current));
  say(`記録なし → ${path.relative(root, BASELINE)} を新しく保存しました(次回からこれとの差分を出します)`);
} else {
  const prev = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  if (prev.seed !== SEED || prev.pairs !== PAIRS) {
    say(`記録は種=${prev.seed}・${prev.pairs}組、今回は種=${SEED}・${PAIRS}組。条件が違うため、一致した組だけ比べます。`);
  }
  const before = prev.cases ?? {};
  const newFail = [];
  const fixed = [];
  const changed = [];
  let same = 0;
  for (const c of results) {
    const k = key(c);
    const a = before[k];
    const b = current[k];
    if (!a) continue;
    const added = b.f.filter((x) => !a.f.includes(x));
    const gone = a.f.filter((x) => !b.f.includes(x));
    if (added.length) newFail.push([c, added]);
    if (gone.length) fixed.push([c, gone]);
    const delta = [];
    if (a.n !== b.n) delta.push(`候補 ${a.n}→${b.n}本`);
    if (Math.abs(a.m - b.m) >= 1) delta.push(`距離 ${a.m}→${b.m}m`);
    if (a.min !== b.min) delta.push(`時間 ${a.min}→${b.min}分`);
    if (a.l !== b.l) delta.push(`札 ${a.l}→${b.l}`);
    if (a.tier !== b.tier) delta.push(`段階 ${a.tier}→${b.tier}`);
    if (delta.length) changed.push([c, delta.join("・")]);
    else if (!added.length && !gone.length) same++;
  }
  const missing = Object.keys(before).filter((k) => !(k in current)).length;
  say(`前回との差分(${path.relative(root, BASELINE)})`);
  say(`  変化なし ${same}件 / 新しい不合格 ${newFail.length}件 / 直った ${fixed.length}件 / 結果が変わった ${changed.length}件${missing ? ` / 今回無い組 ${missing}件` : ""}`);
  if (!args.quiet) {
    for (const [c, codes] of newFail.slice(0, 20)) say(`  [新しい不合格] ${codes.join("・")}  ${urlOf(c)}`);
    for (const [c, codes] of fixed.slice(0, 20)) say(`  [直った] ${codes.join("・")}  ${urlOf(c)}`);
    for (const [c, text] of changed.slice(0, 20)) say(`  [変化] ${text}  ${urlOf(c)}`);
    const rest = changed.length - 20;
    if (rest > 0) say(`  …ほか ${rest}件`);
  }
  if (args.update) {
    fs.writeFileSync(BASELINE, serialize(current));
    say("  --update: 記録を保存し直しました");
  } else if (changed.length || newFail.length || fixed.length) {
    say("  (記録を今回の結果に更新するには --update)");
  }
}
console.log(lines.join("\n"));

function serialize(cases) {
  const head = `{"seed":${SEED},"pairs":${PAIRS},"site":${JSON.stringify(SITE)},"cases":{\n`;
  const body = Object.entries(cases).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",\n");
  return `${head}${body}\n}}\n`;
}
