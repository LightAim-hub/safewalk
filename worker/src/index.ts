/**
 * SafeWalk の Claude 中継(Cloudflare Workers)。
 *
 * POST /api/claude を受け、検査してから Anthropic の Messages API へ転送するだけ。
 * 鍵(ANTHROPIC_API_KEY)は環境変数にだけある。コード・設定ファイルには書かない。
 *
 * 検査: Origin の許可リスト / 本文の大きさ / model の許可リスト / max_tokens の上限 / 道具は自前の物だけ /
 *       1つの IP の回数 / 1日の全体の回数(Durable Objects の SQLite。無料プランで使える)。
 */
import { DurableObject } from "cloudflare:workers";
import { FIXED_SYSTEM, FIXED_TOOLS } from "./fixed";

export interface Env {
  ANTHROPIC_API_KEY?: string;
  LIMITER: DurableObjectNamespace<Limiter>;
  UPSTREAM_URL: string;
  ALLOW_TEST_UPSTREAM?: string;
  DAILY_LIMIT: string;
  IP_10MIN_LIMIT: string;
  IP_DAY_LIMIT: string;
  ENABLE_FALLBACKS?: string;
  /** 回数の上限(1端末ごと)から外す回線。secret に入れる(リポジトリに書かない)。カンマ区切り。IPv6 は先頭 64 ビットで比べる。 */
  UNLIMITED_IPS?: string;
  /** 使われ方の記録を読み出す合言葉。secret に入れる(リポジトリに書かない)。無ければ読み出しは閉じる。 */
  LOG_READ_TOKEN?: string;
}

const ALLOWED_ORIGINS = [
  "https://lightaim-hub.github.io",
  ...[4173, 4174, 4175, 4176, 4177, 4178].map((p) => `http://localhost:${p}`),
];
const ALLOWED_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5"];
const MAX_TOKENS_CAP = 6000;
const MAX_BODY_BYTES = 100_000;
const MAX_MESSAGES = 40;
const ANTHROPIC_VERSION = "2026-10-21";
const FORWARD_KEYS = ["model", "max_tokens", "tool_choice", "output_config", "thinking"];
// messages の検査の上限。agent.ts は最大 7 往復(最大 15 件)。余裕を見ている。
const MAX_MESSAGES_CHARS = 80_000;
const MAX_STRING_CHARS = 40_000;
const TOOL_NAMES = FIXED_TOOLS.map((t) => t.name);

const MSG = {
  origin: "この場所からは Claude を利用できません。",
  method: "POST で呼び出してください。",
  tooBig: "送られた内容が大きすぎます。",
  badJson: "送られた内容の形式が正しくありません。",
  badModel: "このモデルは利用できません。",
  badTool: "利用できない道具が含まれています。",
  badBody: "送られた内容に不足または不正があります。",
  badMessages: "送られた会話の形式が正しくないか、長すぎます。",
  ip10: "短い時間に回数が多すぎます。しばらくしてから、もう一度お試しください。",
  ipDay: "この端末からの 1 日の利用回数の上限に達しました。明日、もう一度お試しください。",
  daily: "今日の Claude の利用回数の上限に達しました。日本時間の朝 9 時以降にもう一度お試しください。経路の検索は Claude なしでお使いいただけます。",
  upstreamBusy: "Claude が混み合っています。少し待って、もう一度お試しください。",
  upstreamFail: "Claude の呼び出しに失敗しました。",
  notReady: "サーバーの設定が完了していません。",
  limiterDown: "利用回数の確認ができなかったため、今は Claude をお使いいただけません。",
};

function cors(origin: string | null): Record<string, string> {
  return origin && ALLOWED_ORIGINS.includes(origin)
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600",
        vary: "Origin",
      }
    : { vary: "Origin" };
}

function json(status: number, message: string, origin: string | null, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { type: "relay_error", message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors(origin), ...extra },
  });
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_STRING_CHARS;

/** 1つのブロックを、許す形だけに作り直す(余計な項目は落とす)。形が違えば null。 */
function checkBlock(b: unknown, role: string): Record<string, unknown> | null {
  if (!isObj(b)) return null;
  if (b.type === "text" && str(b.text)) return { type: "text", text: b.text };
  if (role === "user" && b.type === "tool_result") {
    if (!str(b.tool_use_id) || !str(b.content)) return null;
    if (b.is_error !== undefined && typeof b.is_error !== "boolean") return null;
    return { type: "tool_result", tool_use_id: b.tool_use_id, content: b.content, ...(b.is_error ? { is_error: true } : {}) };
  }
  if (role === "assistant") {
    if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.length <= MAX_STRING_CHARS && str(b.signature)) {
      return { type: "thinking", thinking: b.thinking, signature: b.signature };
    }
    if (b.type === "redacted_thinking" && str(b.data)) return { type: "redacted_thinking", data: b.data };
    if (b.type === "tool_use" && str(b.id) && typeof b.name === "string" && TOOL_NAMES.includes(b.name) && isObj(b.input)) {
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    }
  }
  return null;
}

/** messages を検査して作り直す。役割・件数・ブロックの種類と形・全体の長さに上限がある。 */
function checkMessages(input: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(input) || !input.length || input.length > MAX_MESSAGES) return null;
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < input.length; i++) {
    const m = input[i];
    if (!isObj(m) || (m.role !== "user" && m.role !== "assistant")) return null;
    if (i === 0 && m.role !== "user") return null;
    if (typeof m.content === "string") {
      if (!str(m.content)) return null;
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content) || !m.content.length || m.content.length > 20) return null;
    const blocks: Record<string, unknown>[] = [];
    for (const b of m.content) {
      const c = checkBlock(b, m.role);
      if (!c) return null;
      blocks.push(c);
    }
    out.push({ role: m.role, content: blocks });
  }
  if (JSON.stringify(out).length > MAX_MESSAGES_CHARS) return null;
  return out;
}

/** 本文を検査して、転送してよい形に直す。通らなければ理由の文を返す。 */
function sanitize(input: unknown, fallbacks: boolean): { body: Record<string, unknown> } | { error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: MSG.badBody };
  const src = input as Record<string, unknown>;
  if (typeof src.model !== "string" || !ALLOWED_MODELS.includes(src.model)) return { error: MSG.badModel };
  const messages = checkMessages(src.messages);
  if (!messages) return { error: MSG.badMessages };

  const body: Record<string, unknown> = {};
  for (const k of FORWARD_KEYS) if (src[k] !== undefined) body[k] = src[k];
  // system と tools は Worker 側に固定する。ブラウザから来た物は(古いブラウザ側が送っても)使わない。
  body.system = FIXED_SYSTEM;
  body.tools = FIXED_TOOLS;
  body.messages = messages;

  // max_tokens は上限で頭打ちにする(指定が無い・不正でも上限を入れる)。
  const asked = typeof src.max_tokens === "number" && Number.isFinite(src.max_tokens) && src.max_tokens > 0 ? Math.floor(src.max_tokens) : MAX_TOKENS_CAP;
  body.max_tokens = Math.min(asked, MAX_TOKENS_CAP);

  // 道具は自前の物(type が無いか "custom")だけ。サーバー側の道具(検索・実行など)は通さない。
  if (src.tools !== undefined) {
    if (!Array.isArray(src.tools) || src.tools.length > 8) return { error: MSG.badTool };
    for (const t of src.tools) {
      const type = (t as { type?: unknown })?.type;
      if (!t || typeof t !== "object" || (type !== undefined && type !== "custom")) return { error: MSG.badTool };
    }
  }
  // 強制の tool_choice は対象のモデルで 400 になる。auto と none だけ通す。
  if (src.tool_choice !== undefined) {
    const t = (src.tool_choice as { type?: unknown })?.type;
    if (t !== "auto" && t !== "none") return { error: MSG.badBody };
  }
  if (src.output_config !== undefined) {
    const o = src.output_config as Record<string, unknown>;
    if (!o || typeof o !== "object" || Object.keys(o).some((k) => k !== "effort" && k !== "format")) return { error: MSG.badBody };
  }
  if (src.thinking !== undefined) {
    const t = (src.thinking as { type?: unknown })?.type;
    if (t !== "adaptive") return { error: MSG.badBody };
  }
  if (fallbacks) body.fallbacks = "default";
  return { body };
}

async function sha(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const allowed = origin !== null && ALLOWED_ORIGINS.includes(origin);

    if (url.pathname === "/api/log") return handleLog(request, env, origin, allowed);
    if (url.pathname === "/api/log/read") return readLog(request, env, url);
    if (url.pathname !== "/api/claude") {
      return new Response("safewalk-claude relay", { status: url.pathname === "/" ? 200 : 404 });
    }
    // Origin が無い・許可リストに無い呼び出しは、何も転送せず断る。
    if (!allowed) return json(403, MSG.origin, null);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== "POST") return json(405, MSG.method, origin);

    if (!env.ANTHROPIC_API_KEY) return json(500, MSG.notReady, origin);
    let upstream: URL;
    try {
      upstream = new URL(env.UPSTREAM_URL);
    } catch {
      return json(500, MSG.notReady, origin);
    }
    // 鍵を api.anthropic.com 以外へ送らない(手元の試験の時だけ例外)。
    if (upstream.host !== "api.anthropic.com" && env.ALLOW_TEST_UPSTREAM !== "1") return json(500, MSG.notReady, origin);

    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return json(413, MSG.tooBig, origin);
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json(413, MSG.tooBig, origin);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return json(400, MSG.badJson, origin);
    }
    const checked = sanitize(parsed, env.ENABLE_FALLBACKS === "1");
    if ("error" in checked) return json(400, checked.error, origin);

    // 回数の制限(検査を通った呼び出しだけを数える)。
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    // 上限の設定が無い・数字でない時は、全部が素通りになるので通さない。
    const limits = { daily: Number(env.DAILY_LIMIT), ip10: Number(env.IP_10MIN_LIMIT), ipDay: Number(env.IP_DAY_LIMIT) };
    if (!Object.values(limits).every((n) => Number.isFinite(n) && n > 0)) return json(503, MSG.limiterDown, origin);
    // 登録した回線(作り手の家)は1端末ごとの上限から外す。全体の1日の上限には数え、それは超えない(費用の上限を守るため)。
    if (isUnlimited(ip, env.UNLIMITED_IPS)) {
      limits.ip10 = Number.MAX_SAFE_INTEGER;
      limits.ipDay = Number.MAX_SAFE_INTEGER;
    }
    try {
      const stub = env.LIMITER.get(env.LIMITER.idFromName("global"));
      const r = await stub.hit(await sha(ip), Date.now(), limits);
      if (!r.ok) {
        const retry = r.reason === "ip10" ? "600" : "3600";
        return json(429, r.reason === "daily" ? MSG.daily : r.reason === "ipDay" ? MSG.ipDay : MSG.ip10, origin, { "retry-after": retry });
      }
    } catch {
      // 数えられない時は通さない(費用の上限が守れないため)。
      return json(503, MSG.limiterDown, origin);
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    };
    if (env.ENABLE_FALLBACKS === "1") headers["anthropic-beta"] = "server-side-fallback-2026-07-01";

    let res: Response;
    try {
      res = await fetch(upstream.toString(), { method: "POST", headers, body: JSON.stringify(checked.body) });
    } catch {
      return json(502, MSG.upstreamFail, origin);
    }
    if (res.status === 429 || res.status === 529 || res.status === 503) return json(503, MSG.upstreamBusy, origin, { "retry-after": "30" });
    if (res.status === 401 || res.status === 403) return json(502, MSG.notReady, origin);
    // 成功とその他の 4xx(形式の誤りなど)は、中身をそのまま返す。
    return new Response(res.body, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json", ...cors(origin) },
    });
  },
};

/** IPv6 を8組の4桁に直す(省略の :: を戻す)。IPv4 はそのまま返す。 */
function expandIp(ip: string): string {
  const v = ip.trim().toLowerCase();
  if (!v.includes(":")) return v;
  const [head, tail = ""] = v.split("::");
  const a = head ? head.split(":") : [];
  const b = v.includes("::") ? (tail ? tail.split(":") : []) : [];
  const fill = v.includes("::") ? Array(Math.max(0, 8 - a.length - b.length)).fill("0") : [];
  return [...a, ...fill, ...b].map((g) => g.padStart(4, "0")).join(":");
}

/** 上限から外す回線か。IPv4 は完全一致、IPv6 は同じ家の端末どうしで変わらない先頭 64 ビット(4組)で比べる。 */
export function isUnlimited(ip: string, list: string | undefined): boolean {
  if (!list || !ip || ip === "unknown") return false;
  const key = (x: string) => {
    const e = expandIp(x);
    return e.includes(":") ? e.split(":").slice(0, 4).join(":") : e;
  };
  const me = key(ip);
  return list.split(/[\s,]+/).filter(Boolean).some((x) => key(x) === me);
}


// ---------------------------------------------------------------- 使われ方の記録(デモの集計用)
// 送ってよいのは、決まった種類の出来事と、短い説明だけ。座標・検索の文字・IP は受け取らない・残さない。
const LOG_TYPES = new Set([
  "open", "ready", "load_error", "slow", "js_error", "offline", "sw_ready",
  "search", "search_none", "place", "route", "route_none", "period", "share",
  "guide_start", "guide_stop", "guide_arrive", "guide_reroute", "guide_lost", "guide_unsure",
  "emergency", "consult", "consult_error", "consult_replaced", "locate", "locate_fail", "menu", "intro_start",
]);
const LOG_MAX_BODY = 16_000;
const LOG_MAX_EVENTS = 60;
const LOG_PER_IP_DAY = 3000;

/** 説明の文から、座標らしい数字・URL の ? 以降・長すぎる部分を落とす。 */
export function scrubDetail(v: unknown): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/\?[^\s"']*/g, "?…")
    .replace(/\d{2,3}\.\d{3,}/g, "#")
    .slice(0, 300);
}

async function handleLog(request: Request, env: Env, origin: string | null, allowed: boolean): Promise<Response> {
  const h = { ...cors(origin) };
  if (!allowed) return new Response(null, { status: 403, headers: h });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: h });
  const text = await request.text();
  if (text.length > LOG_MAX_BODY) return new Response(null, { status: 413, headers: h });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400, headers: h });
  }
  if (!isObj(body) || typeof body.sid !== "string" || !Array.isArray(body.events)) return new Response(null, { status: 400, headers: h });
  const sid = body.sid.replace(/[^a-z0-9]/gi, "").slice(0, 16);
  const dev = isObj(body.dev) ? JSON.stringify({
    os: scrubDetail(body.dev.os).slice(0, 20), br: scrubDetail(body.dev.br).slice(0, 20),
    w: Number(body.dev.w) | 0, h: Number(body.dev.h) | 0, app: body.dev.app === true, ver: scrubDetail(body.dev.ver).slice(0, 20),
  }) : "{}";
  const now = Date.now();
  const rows = body.events.slice(0, LOG_MAX_EVENTS).flatMap((e) => {
    if (!isObj(e) || typeof e.type !== "string" || !LOG_TYPES.has(e.type)) return [];
    const at = Number(e.at);
    const ts = Number.isFinite(at) && Math.abs(now - at) < 3600_000 ? at : now;
    return [{ ts, type: e.type, detail: scrubDetail(e.detail) }];
  });
  if (!sid || !rows.length) return new Response(null, { status: 204, headers: h });
  try {
    const ip = await sha(request.headers.get("cf-connecting-ip") ?? "unknown");
    const stub = env.LIMITER.get(env.LIMITER.idFromName("global"));
    await stub.log(ip, sid, dev, rows, now, LOG_PER_IP_DAY);
  } catch {
    // 記録できなくても、アプリの動きには関わらない。
  }
  return new Response(null, { status: 204, headers: h });
}

/** 合言葉が合う時だけ、記録を JSON で返す(?since=ミリ秒)。 */
async function readLog(request: Request, env: Env, url: URL): Promise<Response> {
  const token = request.headers.get("x-log-token") ?? "";
  if (!env.LOG_READ_TOKEN || token.length !== env.LOG_READ_TOKEN.length || token !== env.LOG_READ_TOKEN) {
    return new Response("not found", { status: 404 });
  }
  const since = Number(url.searchParams.get("since") ?? 0) || Date.now() - 86400_000;
  const stub = env.LIMITER.get(env.LIMITER.idFromName("global"));
  const rows = await stub.readLog(since);
  return new Response(JSON.stringify(rows), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

// ---------------------------------------------------------------- 回数の数え方

type Limits = { daily: number; ip10: number; ipDay: number };
export type HitResult = { ok: true } | { ok: false; reason: "daily" | "ip10" | "ipDay" };

/**
 * 1つだけ作る Durable Object。呼び出しは1つずつ順に処理されるので、数え間違いが起きない。
 * 保存は SQLite。IP は SHA-256 の先頭 8 バイトだけ保存する(元の IP は残さない)。
 */
export class Limiter extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hits (ip TEXT NOT NULL, ts INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS hits_ip_ts ON hits (ip, ts)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS daily (day TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS events (ts INTEGER NOT NULL, ip TEXT NOT NULL, sid TEXT NOT NULL, type TEXT NOT NULL, detail TEXT NOT NULL, dev TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS events_ts ON events (ts)");
  }

  /** 使われ方の記録を足す。1つの回線(元に戻せない短い値)あたり1日の件数に上限。30日より古い物は消す。 */
  log(ip: string, sid: string, dev: string, rows: { ts: number; type: string; detail: string }[], now: number, perIpDay: number): void {
    const sql = this.ctx.storage.sql;
    const n = sql.exec("SELECT COUNT(*) AS c FROM events WHERE ip = ? AND ts > ?", ip, now - 86400_000).one().c as number;
    const room = Math.max(0, perIpDay - n);
    for (const r of rows.slice(0, room)) sql.exec("INSERT INTO events (ts, ip, sid, type, detail, dev) VALUES (?, ?, ?, ?, ?, ?)", r.ts, ip, sid, r.type, r.detail, dev);
    sql.exec("DELETE FROM events WHERE ts < ?", now - 30 * 86400_000);
  }

  readLog(since: number): Record<string, unknown>[] {
    return this.ctx.storage.sql.exec("SELECT ts, ip, sid, type, detail, dev FROM events WHERE ts >= ? ORDER BY ts LIMIT 20000", since).toArray() as Record<string, unknown>[];
  }

  hit(ip: string, now: number, limits: Limits): HitResult {
    const sql = this.ctx.storage.sql;
    const day = new Date(now).toISOString().slice(0, 10);
    const total = sql.exec("SELECT n FROM daily WHERE day = ?", day).toArray()[0]?.n as number | undefined;
    if ((total ?? 0) >= limits.daily) return { ok: false, reason: "daily" };
    const count = (since: number) => sql.exec("SELECT COUNT(*) AS c FROM hits WHERE ip = ? AND ts > ?", ip, since).one().c as number;
    if (count(now - 24 * 3600_000) >= limits.ipDay) return { ok: false, reason: "ipDay" };
    if (count(now - 600_000) >= limits.ip10) return { ok: false, reason: "ip10" };
    sql.exec("DELETE FROM hits WHERE ts <= ?", now - 24 * 3600_000);
    sql.exec("INSERT INTO hits (ip, ts) VALUES (?, ?)", ip, now);
    sql.exec("INSERT INTO daily (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1", day);
    sql.exec("DELETE FROM daily WHERE day < ?", new Date(now - 3 * 86400_000).toISOString().slice(0, 10));
    return { ok: true };
  }
}
