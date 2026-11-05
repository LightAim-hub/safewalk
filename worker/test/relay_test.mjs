// 中継(Worker)の試験。鍵・ログインは要らない。
// 手元の wrangler dev を起動し、Anthropic の代わりの模擬サーバーへ転送させて、
// Origin 制限・入力の検査・max_tokens の上限・回数制限(IP・1日の全体)・上流のエラーの変換を確かめる。
// 実行: cd worker && node test/relay_test.mjs
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const MOCK_PORT = 9099;
const WORKER_PORT = 8788;
const BASE = `http://127.0.0.1:${WORKER_PORT}/api/claude`;
const OK_ORIGIN = "http://localhost:4178";

const seen = [];
const mock = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    const body = JSON.parse(data || "{}");
    seen.push({ headers: req.headers, body });
    if (body.messages?.[0]?.content === "MODE429") {
      res.writeHead(429, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "upstream limit" } }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg_mock", type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] }));
  });
});

let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + detail}`);
  if (!cond) failed++;
};

const goodBody = (extra = {}) => ({
  model: "claude-opus-5-5",
  max_tokens: 99999,
  system: "s",
  messages: [{ role: "user", content: "hi" }],
  tools: [{ name: "find_routes", description: "d", input_schema: { type: "object", properties: {}, additionalProperties: false } }],
  ...extra,
});

async function call(body, { origin = OK_ORIGIN, ip = "1.1.1.1", method = "POST", raw } = {}) {
  const headers = { "content-type": "application/json", "cf-connecting-ip": ip };
  if (origin) headers.origin = origin;
  const res = await fetch(BASE, { method, headers, body: method === "GET" ? undefined : (raw ?? JSON.stringify(body)) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, json, text };
}

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${WORKER_PORT}/`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev が起動しませんでした");
}

await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
const wrangler = spawn(
  process.execPath,
  [
    path.join(root, "node_modules/wrangler/bin/wrangler.js"),
    "dev",
    "--port", String(WORKER_PORT),
    "--ip", "127.0.0.1",
    "--persist-to", fs.mkdtempSync(path.join(os.tmpdir(), "relay-state-")), // 毎回まっさらな回数の記録で始める
    "--var", `UPSTREAM_URL:http://127.0.0.1:${MOCK_PORT}/v1/messages`,
    "--var", "ALLOW_TEST_UPSTREAM:1",
    "--var", "ANTHROPIC_API_KEY:dummy-key-for-local-test-only",
    "--var", "IP_10MIN_LIMIT:5",
    "--var", "DAILY_LIMIT:9",
    "--var", "IP_DAY_LIMIT:60",
    "--var", "IP_HASH_KEY:local-test-key-0123456789abcdef0123456789",
  ],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } },
);
let log = "";
wrangler.stdout.on("data", (d) => (log += d));
wrangler.stderr.on("data", (d) => (log += d));

try {
  await waitReady();

  // --- Origin
  let r = await call(goodBody(), { origin: null });
  check("Origin なし -> 403", r.status === 403, r.text);
  check("  日本語の文", /[ぁ-ん]/.test(r.json?.error?.message ?? ""));
  r = await call(goodBody(), { origin: "https://evil.example" });
  check("許可リスト外の Origin -> 403", r.status === 403);
  check("  上流へ転送していない", seen.length === 0);
  r = await call(goodBody(), { origin: "http://localhost:4179" });
  check("localhost:4179(範囲外) -> 403", r.status === 403);
  r = await call(null, { method: "OPTIONS", origin: "https://lightaim-hub.github.io" });
  check("OPTIONS(許可 Origin) -> 204 と CORS", r.status === 204 && r.headers.get("access-control-allow-origin") === "https://lightaim-hub.github.io");
  r = await call(null, { method: "OPTIONS", origin: "https://evil.example" });
  check("OPTIONS(許可外) -> 403・CORS なし", r.status === 403 && !r.headers.get("access-control-allow-origin"));
  r = await call(null, { method: "GET" });
  check("GET -> 405", r.status === 405);

  // --- 入力の検査(ここまでは回数に数えない)
  r = await call(goodBody({ model: "claude-haiku-4-5" }));
  check("許可外のモデル -> 400", r.status === 400 && /モデル/.test(r.json.error.message), r.text);
  r = await call(goodBody({ tools: [{ type: "web_search_20260209", name: "web_search" }] }));
  check("サーバー側の道具 -> 400", r.status === 400);
  r = await call(goodBody({ tool_choice: { type: "any" } }));
  check("強制の tool_choice -> 400", r.status === 400);
  r = await call(goodBody({ thinking: { type: "enabled", budget_tokens: 1000 } }));
  check("thinking の budget -> 400", r.status === 400);
  const longMsgs = Array.from({ length: 41 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x" }));
  const bad = [
    ["messages が件数オーバー", { messages: longMsgs }],
    ["最初が assistant", { messages: [{ role: "assistant", content: "x" }] }],
    ["role が不正(system)", { messages: [{ role: "system", content: "x" }] }],
    ["content が数値", { messages: [{ role: "user", content: 5 }] }],
    ["未知のブロック(image)", { messages: [{ role: "user", content: [{ type: "image", source: {} }] }] }],
    ["user が tool_use を送る", { messages: [{ role: "user", content: [{ type: "tool_use", id: "a", name: "find_routes", input: {} }] }] }],
    ["未知の道具名の tool_use", { messages: [{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "tool_use", id: "a", name: "bash", input: {} }] }] }],
    ["tool_result の形が不正", { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: 1, content: "x" }] }] }],
    ["全体が長すぎる", { messages: [1, 2, 3].map(() => ({ role: "user", content: "x".repeat(30_000) })) }],
  ];
  for (const [name, extra] of bad) {
    r = await call(goodBody(extra));
    check(`messages: ${name} -> 400`, r.status === 400 && /[ぁ-ん]/.test(r.json?.error?.message ?? ""), r.text);
  }
  r = await call(null, { raw: "{not json" });
  check("壊れた JSON -> 400", r.status === 400);
  r = await call(goodBody({ system: "x".repeat(120_000) }));
  check("大きすぎる本文 -> 413", r.status === 413);
  check("  検査で落ちた物は上流へ行かない", seen.length === 0);

  // --- 転送(1回目)
  r = await call(goodBody({ stream: true, fallbacks: "default", metadata: { x: 1 } }));
  check("正常な呼び出し -> 200 で上流の本文", r.status === 200 && r.json?.id === "msg_mock", r.text);
  const up = seen[0];
  check("max_tokens が 6000 に頭打ち", up?.body.max_tokens === 6000, JSON.stringify(up?.body.max_tokens));
  check("上流には鍵が付く(模擬の鍵)", up?.headers["x-api-key"] === "dummy-key-for-local-test-only");
  check("anthropic-version を付ける", !!up?.headers["anthropic-version"]);
  check("クライアントの Origin を上流へ渡さない", !up?.headers["origin"]);
  check("stream・fallbacks・metadata を落とす", up && !("stream" in up.body) && !("fallbacks" in up.body) && !("metadata" in up.body));
  check("ブラウザの system を使わず Worker の固定の文を送る", typeof up?.body.system === "string" && up.body.system !== "s" && up.body.system.includes("SafeWalk"), String(up?.body.system).slice(0, 40));
  check("ブラウザの tools を使わず Worker の固定の道具を送る", up?.body.tools?.length === 4 && up.body.tools.every((t) => t.strict === true), JSON.stringify(up?.body.tools).slice(0, 80));
  check("応答に CORS が付く", r.headers.get("access-control-allow-origin") === OK_ORIGIN);

  // agent.ts が実際に送る形(output_config・strict の道具・tool_use の履歴)を通す
  r = await call(goodBody({
    max_tokens: 6000,
    output_config: { effort: "medium", format: { type: "json_schema", schema: { type: "object", properties: {}, additionalProperties: false } } },
    tools: [{ name: "find_routes", description: "d", strict: true, input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } }],
    messages: [
      { role: "user", content: "x" },
      { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "tool_use", id: "t1", name: "find_routes", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] },
    ],
  }), { ip: "9.9.9.9" });
  check("agent.ts の形の要求を通す", r.status === 200 && seen.at(-1).body.output_config.effort === "medium" && seen.at(-1).body.messages.length === 3, r.text);
  seen.pop();

  // --- 上流の混雑
  r = await call(goodBody({ messages: [{ role: "user", content: "MODE429" }] }));
  check("上流 429 -> 503 と日本語の文", r.status === 503 && /混み合って/.test(r.json?.error?.message ?? ""), r.text);

  // --- IP の回数(10分に5回。ここまでで2回)
  for (let i = 0; i < 3; i++) r = await call(goodBody());
  check("同じ IP の5回目までは通る", r.status === 200, r.text);
  r = await call(goodBody());
  check("同じ IP の6回目 -> 429(IP)", r.status === 429 && /短い時間/.test(r.json?.error?.message ?? ""), r.text);
  check("  Retry-After が付く", !!r.headers.get("retry-after"));
  const before = seen.length;
  await call(goodBody());
  check("  429 の呼び出しは上流へ行かない", seen.length === before);

  // --- 1日の全体(9回まで。ここまでで6回)
  for (let i = 0; i < 3; i++) r = await call(goodBody(), { ip: "2.2.2.2" });
  check("別の IP は通る(全体で9回目)", r.status === 200, r.text);
  r = await call(goodBody(), { ip: "3.3.3.3" });
  check("全体の上限 -> 429(1日)", r.status === 429 && /今日の Claude/.test(r.json?.error?.message ?? ""), r.text);
  check("  上流への実際の呼び出しは 8 回", seen.length === 8, String(seen.length));

  // --- 道の状態の投稿
  const RB = `http://127.0.0.1:${WORKER_PORT}/api/reports`;
  const rep = async (path, body, { origin = OK_ORIGIN, ip = "5.5.5.5", method = "POST", headers: extra = {} } = {}) => {
    const headers = { "content-type": "text/plain", "cf-connecting-ip": ip, ...extra };
    if (origin) headers.origin = origin;
    const res = await fetch(RB + path, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  };
  // 一覧は1分だけ使い回すので、試験では毎回ちがう場所を使い、最後にまとめて一覧を見る。
  let q = await rep("", { lat: 34.69461234, lon: 135.19551234, kind: "dark" });
  check("投稿: 正しい種類と神戸の中の点は受け付ける", q.status === 200 && q.json?.ok === true, q.text);
  check("投稿: 決まっていない種類は 400", (await rep("", { lat: 34.69, lon: 135.19, kind: "crime" })).status === 400);
  check("投稿: 神戸の外の点は 400", (await rep("", { lat: 35.0, lon: 135.5, kind: "dark" })).status === 400);
  check("投稿: Origin なしは 403", (await rep("", { lat: 34.69, lon: 135.19, kind: "dark" }, { origin: null })).status === 403);
  // 同じ回線の重ねは1件
  await rep("", { lat: 34.70, lon: 135.20, kind: "bikes" }, { ip: "8.8.8.8" });
  await rep("", { lat: 34.70, lon: 135.20, kind: "bikes" }, { ip: "8.8.8.8" });
  // 「違う」: 1件の場所は別の回線3つで出さない。同じ回線の2回目は数えない
  await rep("", { lat: 34.71, lon: 135.21, kind: "narrow" }, { ip: "9.9.9.1" });
  for (const ip of ["6.6.6.1", "6.6.6.2", "6.6.6.2"]) await rep("/dispute", { lat: 34.71, lon: 135.21, kind: "narrow" }, { ip });
  // 4つの回線が入れた場所は、「違う」3つでは消えない（投稿の数より多くないと消えない）
  for (const ip of ["9.9.8.1", "9.9.8.2", "9.9.8.3", "9.9.8.4"]) await rep("", { lat: 34.72, lon: 135.22, kind: "surface" }, { ip });
  for (const ip of ["6.6.7.1", "6.6.7.2", "6.6.7.3"]) await rep("/dispute", { lat: 34.72, lon: 135.22, kind: "surface" }, { ip });
  await rep("", { lat: 34.74, lon: 135.24, kind: "nolight" }, { ip: "9.9.7.1" });
  for (const ip of ["6.6.8.1", "6.6.8.2", "6.6.8.3"]) await rep("/dispute", { lat: 34.74, lon: 135.24, kind: "nolight" }, { ip });
  // IPv6 は先頭64ビットでまとめて数える（番号を替えても同じ回線）
  await rep("", { lat: 34.73, lon: 135.23, kind: "dark" }, { ip: "2001:db8:1:2::a" });
  await rep("", { lat: 34.73, lon: 135.23, kind: "dark" }, { ip: "2001:db8:1:2::b" });
  q = await rep("", null, { method: "GET" });
  const list = q.json ?? [];
  const find = (lat, lon, kind) => list.find((x) => x.lat === lat && x.lon === lon && x.kind === kind);
  const got = find(34.6946, 135.1955, "dark");
  check("投稿: 一覧に出る・座標は小数4桁に丸める", !!got, q.text.slice(0, 200));
  check("投稿: 一覧に投稿者の値・id は入らない", got && !("ip" in got) && !("id" in got), JSON.stringify(got));
  check("投稿: 日時は日に丸める", got && got.last % 86400000 === 0, JSON.stringify(got));
  check("投稿: 同じ回線・同じ場所・同じ種類の2回目は数えない", find(34.70, 135.20, "bikes")?.count === 1, JSON.stringify(find(34.70, 135.20, "bikes")));
  check("投稿: 同じ回線の2回目の「違う」は数えない（2つでは消えない）", find(34.71, 135.21, "narrow") !== undefined, JSON.stringify(find(34.71, 135.21, "narrow")));
  check("投稿: 1件の場所は別の回線の「違う」3つで出さない", find(34.74, 135.24, "nolight") === undefined, JSON.stringify(find(34.74, 135.24, "nolight")));
  check("投稿: 4つの回線が入れた場所は「違う」3つでは消えない", find(34.72, 135.22, "surface")?.count === 4, JSON.stringify(find(34.72, 135.22, "surface")));
  check("投稿: IPv6 は先頭64ビットで1つの回線", find(34.73, 135.23, "dark")?.count === 1, JSON.stringify(find(34.73, 135.23, "dark")));
  check("投稿: 運営の操作は合言葉なしで 404", (await rep("/admin", { action: "delete", lat: 34.70, lon: 135.20, kind: "bikes" })).status === 404);
  for (let i = 0; i < 20; i++) await rep("", { lat: 34.60 + i / 1000, lon: 135.19, kind: "narrow" }, { ip: "7.7.7.7" });
  check("投稿: 1つの回線から1日20件を超えると 429", (await rep("", { lat: 34.80, lon: 135.19, kind: "narrow" }, { ip: "7.7.7.7" })).status === 429);
} catch (e) {
  console.error(e);
  console.error(log.slice(-3000));
  failed++;
} finally {
  wrangler.kill();
  mock.close();
}
console.log(failed ? `\n${failed} 件失敗` : "\n全て通りました");
process.exit(failed ? 1 : 0);
