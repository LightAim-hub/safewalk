// 中継(Worker)の試験。鍵・ログインは要らない。
// 手元の wrangler dev を起動し、Anthropic の代わりの模擬サーバーへ転送させて、
// Origin 制限・入力の検査・max_tokens の上限・回数制限(IP・1日の全体)・上流のエラーの変換を確かめる。
// 実行: cd worker && node test/relay_test.mjs
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

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
    "--var", `UPSTREAM_URL:http://127.0.0.1:${MOCK_PORT}/v1/messages`,
    "--var", "ALLOW_TEST_UPSTREAM:1",
    "--var", "ANTHROPIC_API_KEY:dummy-key-for-local-test-only",
    "--var", "IP_10MIN_LIMIT:5",
    "--var", "DAILY_LIMIT:8",
    "--var", "IP_DAY_LIMIT:60",
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
  check("応答に CORS が付く", r.headers.get("access-control-allow-origin") === OK_ORIGIN);

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

  // --- 1日の全体(8回まで。ここまでで5回)
  for (let i = 0; i < 3; i++) r = await call(goodBody(), { ip: "2.2.2.2" });
  check("別の IP は通る(全体で8回目)", r.status === 200, r.text);
  r = await call(goodBody(), { ip: "3.3.3.3" });
  check("全体の上限 -> 429(1日)", r.status === 429 && /今日の Claude/.test(r.json?.error?.message ?? ""), r.text);
  check("  上流への実際の呼び出しは 8 回", seen.length === 8, String(seen.length));
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
