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
import { lineId, usableKey } from "./lineid";

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
  /** 回線を記録に残す値に変える時に混ぜる秘密の鍵。secret に入れる。無い時は相談を止める（記録を戻せる形で残さないため）。 */
  IP_HASH_KEY?: string;
  /** 使われ方の記録を読み出す合言葉。secret に入れる(リポジトリに書かない)。無ければ読み出しは閉じる。 */
  LOG_READ_TOKEN?: string;
  /** 投稿を運営が隠す・戻す・消す時の合言葉（読み出し用とは別）。secret に入れる。無ければ運営の操作は閉じる。 */
  REPORT_ADMIN_TOKEN?: string;
  /** 手元の試験だけで使う: 1件だけの場所を出すまでの待ち(ms)。本番は設定しない(24時間)。 */
  REPORT_SINGLE_DELAY_MS?: string;
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
        "access-control-allow-methods": "GET, POST, OPTIONS",
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


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const allowed = origin !== null && ALLOWED_ORIGINS.includes(origin);

    if (url.pathname === "/api/log") return handleLog(request, env, origin, allowed);
    if (url.pathname.startsWith("/api/reports")) return handleReports(request, env, url, origin, allowed);
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
      if (!usableKey(env.IP_HASH_KEY)) return json(503, MSG.limiterDown, origin);
      const r = await stub.hit(await lineId(lineKey(ip), env.IP_HASH_KEY), Date.now(), limits);
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
/** 回線を数える単位。IPv6 は家や1台の機械が先頭64ビットの中で番号を自由に変えられるので、先頭64ビットでまとめる。 */
export function lineKey(ip: string): string {
  const e = expandIp(ip);
  return e.includes(":") ? e.split(":").slice(0, 4).join(":") + "::/64" : e;
}

/** 「違う」を数える単位。家庭の回線には /56〜/48 が配られるので、IPv6 は先頭48ビットで数える（回線を替えて何度も押せないように）。 */
export function disputeKey(ip: string): string {
  const e = expandIp(ip);
  return e.includes(":") ? e.split(":").slice(0, 3).join(":") + "::/48" : e;
}

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
    if (!usableKey(env.IP_HASH_KEY)) return new Response(null, { status: 204, headers: h });
    const ip = await lineId(lineKey(request.headers.get("cf-connecting-ip") ?? "unknown"), env.IP_HASH_KEY);
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


// ---------------------------------------------------------------- 道の状態の投稿（利用者の投稿・確かめていない）
// 書けるのは決まった5種類だけ。地図に出すのは、場所(道の上の点・小数4桁)ごと・種類ごとの件数と最後の日だけ。
// 投稿の行には投稿者を結び付けない。1日の上限と重複のために、回線を鍵つきで変えた値を別の表に30日だけ残す。
// 相談の回数を数える所(global)とは別の所(reports)に置く（投稿の読み書きで相談が止まらないように）。
const REPORT_KINDS = new Set(["dark", "nolight", "surface", "bikes", "narrow"]);
const REPORT_PER_IP_DAY = 20;
const DISPUTE_PER_IP_DAY = 10;
const REPORT_DAYS = 90;
const REPORT_LIST_CACHE_S = 60;
/** 1件だけの場所は、投稿から24時間たつまで地図に出さない（投稿した時刻から人の動きを読まれないように）。 */
const SINGLE_DELAY_MS = 24 * 3600_000;
let listMemo: { text: string; until: number } | null = null;
// 神戸市のまわりの範囲（graph.meta.json の bbox と同じ）。点は画面側で道の上に寄せてから送る。
const KOBE_BBOX = { s: 34.55, w: 134.9, n: 34.95, e: 135.38 };

function reportJson(status: number, body: unknown, origin: string | null, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors(origin), ...extra } });
}

/** 一定時間で比べる（合言葉の長さや中身を、返事の速さから当てられないように）。 */
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

function placeOf(body: Record<string, unknown>): { lat: number; lon: number; kind: string } | null {
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  const kind = String(body.kind ?? "");
  if (!REPORT_KINDS.has(kind)) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < KOBE_BBOX.s || lat > KOBE_BBOX.n || lon < KOBE_BBOX.w || lon > KOBE_BBOX.e) return null;
  return { lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4, kind };
}

async function handleReports(request: Request, env: Env, url: URL, origin: string | null, allowed: boolean): Promise<Response> {
  try {
    return await handleReportsInner(request, env, url, origin, allowed);
  } catch {
    // 数えられない・保存できない時は、CORS つきで「今は使えない」を返す。
    return reportJson(503, { error: "unavailable" }, allowed ? origin : null);
  }
}

async function handleReportsInner(request: Request, env: Env, url: URL, origin: string | null, allowed: boolean): Promise<Response> {
  const stub = env.LIMITER.get(env.LIMITER.idFromName("reports"));
  const now = Date.now();
  // 運営の操作（隠す・戻す・消す）。読み出し用とは別の合言葉で、POST だけ。
  if (url.pathname === "/api/reports/admin") {
    const token = request.headers.get("x-admin-token") ?? "";
    if (request.method !== "POST" || !usableKey(env.REPORT_ADMIN_TOKEN) || !sameSecret(token, env.REPORT_ADMIN_TOKEN)) {
      return new Response("not found", { status: 404 });
    }
    const adminText = await request.text();
    if (adminText.length > 400) return reportJson(413, { error: "too big" }, null);
    let body: unknown;
    try {
      body = JSON.parse(adminText);
    } catch {
      return reportJson(400, { error: "json" }, null);
    }
    const at = isObj(body) ? placeOf(body) : null;
    const action = isObj(body) ? String(body.action) : "";
    if (isObj(body) && body.action === "requests") return reportJson(200, await stub.removalRequests(), null);
    if (!at || !["hide", "unhide", "delete"].includes(action)) return reportJson(400, { error: "body" }, null);
    return reportJson(200, await stub.adminReport(action, at.lat, at.lon, at.kind), null);
  }
  if (!allowed) return new Response(null, { status: 403, headers: { vary: "Origin" } });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (request.method === "GET" && url.pathname === "/api/reports") {
    // 一覧は1分だけ使い回す（開くたびに表を読まない）。Worker のメモリに持つ。
    let text: string;
    if (listMemo && listMemo.until > now) text = listMemo.text;
    else {
      const delay = Number(env.REPORT_SINGLE_DELAY_MS ?? SINGLE_DELAY_MS);
      text = JSON.stringify(await stub.listReports(now - REPORT_DAYS * 86400_000, now, Number.isFinite(delay) ? delay : SINGLE_DELAY_MS));
      listMemo = { text, until: now + REPORT_LIST_CACHE_S * 1000 };
    }
    return new Response(text, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${REPORT_LIST_CACHE_S}`, ...cors(origin) } });
  }
  if (request.method !== "POST") return reportJson(405, { error: "method" }, origin);
  if (!usableKey(env.IP_HASH_KEY)) return reportJson(503, { error: "unavailable" }, origin);
  if (Number(request.headers.get("content-length") ?? 0) > 400) return reportJson(413, { error: "too big" }, origin);
  const raw = await request.text();
  if (raw.length > 400) return reportJson(413, { error: "too big" }, origin);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reportJson(400, { error: "json" }, origin);
  }
  if (!isObj(body)) return reportJson(400, { error: "body" }, origin);
  const at = placeOf(body);
  if (!at) return reportJson(400, { error: "place" }, origin);
  const rawIp = request.headers.get("cf-connecting-ip") ?? "unknown";
  const place = `${at.lat},${at.lon},${at.kind}`;
  if (url.pathname === "/api/reports/dispute") {
    const line = await lineId(disputeKey(rawIp), env.IP_HASH_KEY);
    const mark = await lineId(`${disputeKey(rawIp)}|${place}`, env.IP_HASH_KEY);
    const r = await stub.disputeReport(at.lat, at.lon, at.kind, line, mark, now, DISPUTE_PER_IP_DAY);
    return reportJson(r.ok ? 200 : r.error === "none" ? 404 : 429, r, origin);
  }
  if (url.pathname === "/api/reports/removal") {
    // 削除の依頼（場所と種類だけ。自由記述なし）。運営が確かめる列に入れる。依頼だけでは隠さない（荒らしに使われないように）。
    const line = await lineId(lineKey(rawIp), env.IP_HASH_KEY);
    const r = await stub.requestRemoval(at.lat, at.lon, at.kind, line, now);
    return reportJson(r.ok ? 200 : 429, r, origin);
  }
  if (url.pathname !== "/api/reports") return reportJson(404, { error: "not found" }, origin);
  const line = await lineId(lineKey(rawIp), env.IP_HASH_KEY);
  const mark = await lineId(`${lineKey(rawIp)}|${place}`, env.IP_HASH_KEY);
  const r = await stub.addReport(line, mark, at.lat, at.lon, at.kind, now, REPORT_PER_IP_DAY, REPORT_DAYS);
  return reportJson(r.ok ? 200 : 429, r, origin);
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
    // 道の状態の投稿（"reports" の所だけで使う）。投稿の行に投稿者は入れない。
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS road_reports (ts INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, kind TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS road_reports_ts ON road_reports (ts)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS road_reports_place ON road_reports (lat, lon, kind)");
    // 1日の上限: (回線, 時刻) だけ。重複: HMAC(回線|場所|種類) と時刻だけ。回線と場所を同じ行に並べない。30日で消す。
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS report_quota2 (ip TEXT NOT NULL, ts INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS report_quota2_ip ON report_quota2 (ip, ts)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS report_quota2_ts ON report_quota2 (ts)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS report_dedup (mark TEXT PRIMARY KEY, ts INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS report_dedup_ts ON report_dedup (ts)");
    // 「違う」: 場所・種類ごとの数は (場所, HMAC(回線|場所|種類))。1日の上限は (回線, 時刻) だけ。30日で消す。
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS report_disputes3 (lat REAL NOT NULL, lon REAL NOT NULL, kind TEXT NOT NULL, mark TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (lat, lon, kind, mark))");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS report_disputes3_ts ON report_disputes3 (ts)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS dispute_quota (ip TEXT NOT NULL, ts INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS dispute_quota_ip ON dispute_quota (ip, ts)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS report_hidden (lat REAL NOT NULL, lon REAL NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (lat, lon, kind))");
    // 削除の依頼（場所と種類だけ）。運営が確かめる。依頼の上限は (回線, 時刻)。
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS removal_requests (lat REAL NOT NULL, lon REAL NOT NULL, kind TEXT NOT NULL, ts INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS removal_quota (ip TEXT NOT NULL, ts INTEGER NOT NULL)");
    // 試しの版の名前の表（使っていない）は、作られていれば消す。
    ctx.storage.sql.exec("DROP TABLE IF EXISTS report_quota");
    ctx.storage.sql.exec("DROP TABLE IF EXISTS report_disputes2");
    ctx.storage.sql.exec("DROP TABLE IF EXISTS reports");
    ctx.storage.sql.exec("DROP TABLE IF EXISTS report_disputes");
  }

  /** 期限切れを消す（1時間に1回まで）。 */
  private cleanedAt = 0;
  private cleanup(now: number, keepDays: number): void {
    if (now - this.cleanedAt < 3600_000) return;
    this.cleanedAt = now;
    const sql = this.ctx.storage.sql;
    const d30 = now - 30 * 86400_000;
    sql.exec("DELETE FROM report_quota2 WHERE ts < ?", d30);
    sql.exec("DELETE FROM report_dedup WHERE ts < ?", now - keepDays * 86400_000);
    sql.exec("DELETE FROM report_disputes3 WHERE ts < ?", d30);
    sql.exec("DELETE FROM dispute_quota WHERE ts < ?", d30);
    sql.exec("DELETE FROM removal_quota WHERE ts < ?", d30);
    sql.exec("DELETE FROM road_reports WHERE ts < ?", now - keepDays * 86400_000);
  }

  /** 道の状態の投稿を足す。1つの回線あたり1日 perDay 件まで。同じ回線・同じ場所・同じ種類は投稿を残す間1回だけ数える。 */
  addReport(line: string, mark: string, lat: number, lon: number, kind: string, now: number, perDay: number, keepDays: number): { ok: boolean; error?: string } {
    const sql = this.ctx.storage.sql;
    this.cleanup(now, keepDays);
    const n = sql.exec("SELECT COUNT(*) AS c FROM report_quota2 WHERE ip = ? AND ts > ?", line, now - 86400_000).one().c as number;
    if (n >= perDay) return { ok: false, error: "limit" };
    sql.exec("INSERT INTO report_quota2 (ip, ts) VALUES (?, ?)", line, now);
    const dup = sql.exec("SELECT 1 AS x FROM report_dedup WHERE mark = ?", mark).toArray()[0];
    if (dup) return { ok: true };
    sql.exec("INSERT INTO report_dedup (mark, ts) VALUES (?, ?)", mark, now);
    sql.exec("INSERT INTO road_reports (ts, lat, lon, kind) VALUES (?, ?, ?, ?)", now, lat, lon, kind);
    return { ok: true };
  }

  /**
   * 地図に出す一覧。場所・種類ごとに、件数と最後の日（日に丸める）だけ。
   * 出さない物: 「違う」の数が max(3, その場所の件数) に届いた物・運営が隠した物・1件だけで投稿から delayMs たっていない物。
   * 出さない物を先に除いてから上限の件数で切る（偽の投稿の山で本物が押し出されないよう、2件以上の場所を先に並べる）。
   */
  listReports(since: number, now: number, delayMs: number): Record<string, unknown>[] {
    const sql = this.ctx.storage.sql;
    this.cleanup(now, 90);
    const rows = sql
      .exec(
        "SELECT g.lat AS lat, g.lon AS lon, g.kind AS kind, g.count AS count, g.last AS last FROM (" +
          "SELECT r.lat AS lat, r.lon AS lon, r.kind AS kind, COUNT(*) AS count, MAX(r.ts) AS last, MIN(r.ts) AS first, " +
          "(SELECT COUNT(*) FROM report_disputes3 d WHERE d.lat = r.lat AND d.lon = r.lon AND d.kind = r.kind) AS disputes " +
          "FROM road_reports r WHERE r.ts >= ? GROUP BY r.lat, r.lon, r.kind) AS g " +
          "WHERE g.disputes < MAX(3, g.count) AND (g.count >= 2 OR g.first < ?) " +
          "AND NOT EXISTS (SELECT 1 FROM report_hidden h WHERE h.lat = g.lat AND h.lon = g.lon AND h.kind = g.kind) " +
          "ORDER BY (g.count >= 2) DESC, g.last DESC LIMIT 3000",
        since,
        now - delayMs,
      )
      .toArray() as { lat: number; lon: number; kind: string; count: number; last: number }[];
    return rows.map((r) => ({ lat: r.lat, lon: r.lon, kind: r.kind, count: r.count, last: Math.floor(r.last / 86400_000) * 86400_000 }));
  }

  /** 「違う」を1つ数える（投稿のある場所だけ。同じ回線・同じ場所・同じ種類は1回。1つの回線から1日 perDay 回まで）。 */
  disputeReport(lat: number, lon: number, kind: string, line: string, mark: string, now: number, perDay: number): { ok: boolean; error?: string } {
    const sql = this.ctx.storage.sql;
    const exists = sql.exec("SELECT 1 AS x FROM road_reports WHERE lat = ? AND lon = ? AND kind = ? LIMIT 1", lat, lon, kind).toArray()[0];
    if (!exists) return { ok: false, error: "none" };
    const n = sql.exec("SELECT COUNT(*) AS c FROM dispute_quota WHERE ip = ? AND ts > ?", line, now - 86400_000).one().c as number;
    if (n >= perDay) return { ok: false, error: "limit" };
    sql.exec("INSERT INTO dispute_quota (ip, ts) VALUES (?, ?)", line, now);
    sql.exec("INSERT OR IGNORE INTO report_disputes3 (lat, lon, kind, mark, ts) VALUES (?, ?, ?, ?, ?)", lat, lon, kind, mark, now);
    return { ok: true };
  }

  /** 削除の依頼を受ける（1つの回線から1日5回まで）。運営が removalRequests で見て、隠す・消すを決める。 */
  requestRemoval(lat: number, lon: number, kind: string, line: string, now: number): { ok: boolean; error?: string } {
    const sql = this.ctx.storage.sql;
    const n = sql.exec("SELECT COUNT(*) AS c FROM removal_quota WHERE ip = ? AND ts > ?", line, now - 86400_000).one().c as number;
    if (n >= 5) return { ok: false, error: "limit" };
    sql.exec("INSERT INTO removal_quota (ip, ts) VALUES (?, ?)", line, now);
    sql.exec("INSERT INTO removal_requests (lat, lon, kind, ts) VALUES (?, ?, ?, ?)", lat, lon, kind, now);
    return { ok: true };
  }

  removalRequests(): Record<string, unknown>[] {
    return this.ctx.storage.sql.exec("SELECT lat, lon, kind, ts FROM removal_requests ORDER BY ts DESC LIMIT 200").toArray() as Record<string, unknown>[];
  }

  /** 運営の操作: hide（隠す）・unhide（戻す。「違う」も消す）・delete（その場所・種類の投稿を消す）。依頼の列からも外す。 */
  adminReport(action: string, lat: number, lon: number, kind: string): { ok: boolean; action: string } {
    const sql = this.ctx.storage.sql;
    if (action === "hide") sql.exec("INSERT OR REPLACE INTO report_hidden (lat, lon, kind) VALUES (?, ?, ?)", lat, lon, kind);
    if (action === "unhide") {
      sql.exec("DELETE FROM report_hidden WHERE lat = ? AND lon = ? AND kind = ?", lat, lon, kind);
      sql.exec("DELETE FROM report_disputes3 WHERE lat = ? AND lon = ? AND kind = ?", lat, lon, kind);
    }
    if (action === "delete") {
      sql.exec("DELETE FROM road_reports WHERE lat = ? AND lon = ? AND kind = ?", lat, lon, kind);
      sql.exec("DELETE FROM report_disputes3 WHERE lat = ? AND lon = ? AND kind = ?", lat, lon, kind);
    }
    sql.exec("DELETE FROM removal_requests WHERE lat = ? AND lon = ? AND kind = ?", lat, lon, kind);
    listMemo = null;
    return { ok: true, action };
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
