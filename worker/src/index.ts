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

export interface Env {
  ANTHROPIC_API_KEY?: string;
  LIMITER: DurableObjectNamespace<Limiter>;
  UPSTREAM_URL: string;
  ALLOW_TEST_UPSTREAM?: string;
  DAILY_LIMIT: string;
  IP_10MIN_LIMIT: string;
  IP_DAY_LIMIT: string;
  ENABLE_FALLBACKS?: string;
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
const FORWARD_KEYS = ["model", "max_tokens", "system", "messages", "tools", "tool_choice", "output_config", "thinking"];

const MSG = {
  origin: "この場所からは Claude を利用できません。",
  method: "POST で呼び出してください。",
  tooBig: "送られた内容が大きすぎます。",
  badJson: "送られた内容の形式が正しくありません。",
  badModel: "このモデルは利用できません。",
  badTool: "利用できない道具が含まれています。",
  badBody: "送られた内容に不足または不正があります。",
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

/** 本文を検査して、転送してよい形に直す。通らなければ理由の文を返す。 */
function sanitize(input: unknown, fallbacks: boolean): { body: Record<string, unknown> } | { error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: MSG.badBody };
  const src = input as Record<string, unknown>;
  if (typeof src.model !== "string" || !ALLOWED_MODELS.includes(src.model)) return { error: MSG.badModel };
  if (!Array.isArray(src.messages) || !src.messages.length || src.messages.length > MAX_MESSAGES) return { error: MSG.badBody };
  if (src.system !== undefined && typeof src.system !== "string") return { error: MSG.badBody };

  const body: Record<string, unknown> = {};
  for (const k of FORWARD_KEYS) if (src[k] !== undefined) body[k] = src[k];

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
    try {
      const stub = env.LIMITER.get(env.LIMITER.idFromName("global"));
      const r = await stub.hit(await sha(ip), Date.now(), {
        daily: Number(env.DAILY_LIMIT),
        ip10: Number(env.IP_10MIN_LIMIT),
        ipDay: Number(env.IP_DAY_LIMIT),
      });
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
