/**
 * Claude に渡す道具の定義と実行。全てブラウザの中で動き、Claude には「要約した文」だけを返す。
 *
 * - 座標・経路の点列・高低の配列は Claude に渡さない。
 * - 注意書きの文は safety.ts の固定の文をそのまま渡す。Claude に作らせない(agent.ts で ID だけを選ばせる)。
 * - 返す文には ID を付ける(例: r0.distance)。Claude は根拠として ID を挙げ、agent.ts が実在と数字を照合する。
 * - 経路は「経路A・経路B」と呼ばせる。数字(1,2…)を文に出させないため。route.label(「最も安全」)は渡さない。
 * - DOM に依存する物(data.ts・directions.ts・app.ts)は import しない。必要な物は AgentContext で受け取る。
 */
import { findRoutes, type AccidentIndex, type Meta, type Period, type Route } from "./routes";
import { metres, type Anchor, type Graph, type LatLon } from "./graph";
import { assess, SAFETY_RULES, TIER_LABEL, type Safety } from "./safety";
import type { Place } from "./types";

/** 画面側が data.ts の読み込み後に作って渡す。snap は data.ts の snap をそのまま渡せばよい。 */
export type AgentContext = {
  graph: Graph;
  accidents: AccidentIndex;
  meta: Meta;
  names: string[];
  safety: Safety;
  places: Place[];
  snap: (p: LatLon) => Anchor | null;
  /** 経路を作った直後に呼ぶ。画面の経路と数字を揃えるため、画面側が出発地・目的地までの区間を足す(directions.ts の connectEnds)。 */
  afterFind?: (routes: Route[]) => void;
};

export type Fact = { id: string; text: string };

export type ToolSession = {
  ctx: AgentContext;
  from: LatLon;
  to: LatLon;
  period: Period;
  routes: Route[] | null;
};

export type ToolOutput = { content: string; facts: Fact[]; isError: boolean };

export function newToolSession(ctx: AgentContext, from: LatLon, to: LatLon, period: Period): ToolSession {
  return { ctx, from, to, period, routes: null };
}

/** app.ts の GENRES と同じ(app.ts は DOM を読み込むので写した)。 */
export const PLACE_GENRES: { label: string; kinds: string[] }[] = [
  { label: "コンビニ", kinds: ["コンビニ"] },
  { label: "飲食店", kinds: ["飲食店"] },
  { label: "カフェ", kinds: ["カフェ"] },
  { label: "スーパー", kinds: ["スーパー"] },
  { label: "薬局", kinds: ["薬局"] },
  { label: "トイレ", kinds: ["トイレ"] },
  { label: "ATM", kinds: ["ATM", "銀行"] },
  { label: "駅", kinds: ["駅"] },
  { label: "病院", kinds: ["病院"] },
  { label: "交番", kinds: ["警察"] },
];
/** 営業時間の記録から深夜も開いている店(safety.ts の late)。 */
export const LATE_GENRE = "深夜営業の店";

const ALONG_M = 100;
const ALONG_LIMIT = 5;
export const LONG_WALK_M = 8000;
export const BIG_CLIMB_M = 300;
export const NOTE_REMOTE_M = 500;

export const TOOLS = [
  {
    name: "find_routes",
    description:
      "出発地から目的地までの徒歩経路を探し、各経路の距離・所要時間・上り下り・人家から離れた区間・主に通る道・事故の記録の段階を要約して返す。最初に1回だけ呼ぶ。場所の指定は要らない。経路は経路A・経路B…と呼ぶ。",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "assess_route",
    description:
      "経路1本の詳しい評価を返す。事故の記録の段階とその根拠、夜の歩きやすさ(夜のみ)、経路を選ぶ時の固定の注意書き。route_index は find_routes が返した経路の番号(0 から)。",
    strict: true,
    input_schema: {
      type: "object",
      properties: { route_index: { type: "integer", description: "find_routes が返した経路の番号(0 から)" } },
      required: ["route_index"],
      additionalProperties: false,
    },
  },
  {
    name: "places_along",
    description: `経路から${ALONG_M}m以内にある場所の記録を数えて返す。genre に「${LATE_GENRE}」を指定すると、営業時間の記録で深夜も開いている店の数を返す(夜の時だけ意味がある)。記録に無い店は数えられない。`,
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        route_index: { type: "integer", description: "find_routes が返した経路の番号(0 から)" },
        genre: { type: "string", enum: [...PLACE_GENRES.map((g) => g.label), LATE_GENRE] },
      },
      required: ["route_index", "genre"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------- 書式(照合する側と同じ書式で出す)

export const fmtKm = (m: number) => `${(m / 1000).toFixed(1)}km`;
export const fmtMin = (min: number) => `${Math.round(min)}分`;
const letter = (i: number) => "ABCDEFGH"[i] ?? String.fromCharCode(65 + i);
const routeName = (i: number) => `経路${letter(i)}`;

function fail(text: string): ToolOutput {
  return { content: JSON.stringify({ error: text }), facts: [], isError: true };
}

function ok(head: Record<string, unknown>, facts: Fact[]): ToolOutput {
  return { content: JSON.stringify({ ...head, facts }), facts, isError: false };
}

/** directions.ts の routeWarnings と同じ基準の文(period を引数にした純関数)。「安全度」の語は使わない。 */
export function routeWarningTexts(route: Route, period: Period): string[] {
  const lines: string[] = [];
  if (route.metres >= LONG_WALK_M) lines.push(`徒歩では長い距離です（${fmtKm(route.metres)}）。`);
  if (route.climb >= BIG_CLIMB_M) lines.push(`上りの大きい経路です（上り${route.climb}m）。`);
  if (route.remoteMetres >= NOTE_REMOTE_M) {
    const km = fmtKm(route.remoteMetres);
    lines.push(
      period === "night"
        ? `人家から離れた道を${km}通ります。夜は避けることをおすすめします。`
        : `人家から離れた道を${km}通ります。`,
    );
  }
  if (route.safety === null) lines.push("事故データで評価できない道が多いため、事故の記録の段階は不明です。");
  return lines;
}

function accidentCounts(s: ToolSession, route: Route) {
  const a = s.ctx.accidents.data;
  const night = s.period === "night";
  const near = route.accidents.filter((i) => (a.ped[i] || a.bike[i]) && (!night || a.night[i]));
  return {
    all: near.length,
    ped: near.filter((i) => a.ped[i]).length,
    bike: near.filter((i) => a.bike[i]).length,
  };
}

// ---------------------------------------------------------------- find_routes

function findRoutesTool(s: ToolSession): ToolOutput {
  const { ctx } = s;
  const from = ctx.snap(s.from);
  const to = ctx.snap(s.to);
  if (!from) return fail("出発地が、神戸市内の歩ける道の近くにありません。");
  if (!to) return fail("目的地が、神戸市内の歩ける道の近くにありません。");
  const routes = findRoutes(ctx.graph, from, to, s.period, ctx.accidents, ctx.meta, ctx.names);
  s.routes = routes;
  ctx.afterFind?.(routes);
  if (!routes.length) return fail("経路が見つかりませんでした。");

  const facts: Fact[] = [];
  const shortest = routes[0];
  routes.forEach((r, i) => {
    const p = `r${i}`;
    facts.push({ id: `${p}.distance`, text: `${routeName(i)}: 距離 ${fmtKm(r.metres)}、歩いて約${fmtMin(r.minutes)}` });
    if (i > 0) {
      const d = r.minutes - shortest.minutes;
      const dm = r.metres - shortest.metres;
      facts.push({
        id: `${p}.diff`,
        // 「+5分短く」のような重なりを生まないよう、符号ではなく「長い・短い」で書く(読み上げても自然な形)。
        text: `${routeName(i)}は経路Aより、${Math.round(d) === 0 ? "時間はほぼ同じで" : `時間が${Math.abs(Math.round(d))}分${d > 0 ? "長く" : "短く"}`}、距離が${fmtKm(Math.abs(dm))}${dm >= 0 ? "長い" : "短い"}`,
      });
    }
    if (r.via) facts.push({ id: `${p}.via`, text: `${routeName(i)}が主に通る道: ${r.via}` });
    facts.push({ id: `${p}.climb`, text: `${routeName(i)}: 上り${Math.round(r.climb)}m・下り${Math.round(r.descent)}m` });
    facts.push({
      id: `${p}.remote`,
      text:
        r.remoteMetres >= SAFETY_RULES.remoteNoteM
          ? `${routeName(i)}: 人家から離れた区間 ${fmtKm(r.remoteMetres)}`
          : `${routeName(i)}: 人家から離れた区間はほとんどない`,
    });
    if (r.outsideMetres >= SAFETY_RULES.remoteNoteM)
      facts.push({ id: `${p}.outside`, text: `${routeName(i)}: 神戸市の外の区間 ${fmtKm(r.outsideMetres)}(事故の記録が無い)` });
    const a = assess(ctx.safety, r, s.period);
    facts.push({
      id: `${p}.tier`,
      text:
        a.accident.tier === "unknown"
          ? `${routeName(i)}: 事故の記録の段階は「不明」(${a.unknown})`
          : `${routeName(i)}: 事故の記録の段階は「${TIER_LABEL[a.accident.tier]}」`,
    });
    routeWarningTexts(r, s.period).forEach((t, k) => facts.push({ id: `${p}.warn.${k}`, text: t }));
  });
  return ok({ period: s.period === "night" ? "夜" : "昼", routeCount: routes.length, note: "経路は経路A,B,C…と呼ぶ。route_index は 0,1,2…" }, facts);
}

// ---------------------------------------------------------------- assess_route

function routeOf(s: ToolSession, idx: unknown): Route | string {
  if (!s.routes) return "先に find_routes を呼んでください。";
  if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= s.routes.length)
    return `route_index は 0 から ${s.routes.length - 1} の整数です。`;
  return s.routes[idx];
}

function assessTool(s: ToolSession, idx: unknown): ToolOutput {
  const r = routeOf(s, idx);
  if (typeof r === "string") return fail(r);
  const i = idx as number;
  const p = `r${i}`;
  const a = assess(s.ctx.safety, r, s.period);
  const c = accidentCounts(s, r);
  const facts: Fact[] = [];
  if (a.accident.tier === "unknown") {
    facts.push({ id: `${p}.a.tier`, text: `${routeName(i)}: 事故の記録の段階は「不明」。理由: ${a.unknown}` });
  } else {
    facts.push({
      id: `${p}.a.tier`,
      text: `${routeName(i)}: ${s.period === "night" ? "夜間の" : ""}事故の記録の段階は「${a.accident.label}」`,
    });
    a.accident.reasons.forEach((t, k) => facts.push({ id: `${p}.a.reason.${k}`, text: t }));
    facts.push({
      id: `${p}.a.count`,
      text: `経路の近く(30m以内)の記録: 歩行者が関わる事故${c.ped}件、自転車が関わる事故${c.bike}件、合計${c.all}件`,
    });
  }
  if (a.night) {
    a.night.lines.forEach((t, k) => facts.push({ id: `${p}.night.${k}`, text: t }));
  }
  a.cautions.forEach((cn, k) => facts.push({ id: `${p}.caution.${k}`, text: cn.text }));
  routeWarningTexts(r, s.period).forEach((t, k) => facts.push({ id: `${p}.warn.${k}`, text: t }));
  return ok({ route: routeName(i), note: "注意書き(caution.*, warn.*)は固定の文。言い換えず、ID で選ぶ。" }, facts);
}

// ---------------------------------------------------------------- places_along

export function placesAlongRoute(places: Place[], route: Route, kinds: string[]): { place: Place; order: number }[] {
  const stride = Math.max(1, Math.floor(route.coords.length / 400));
  const points = route.coords.filter((_, i) => i % stride === 0);
  const lons = route.coords.map(([lon]) => lon);
  const lats = route.coords.map(([, lat]) => lat);
  const pad = 0.002;
  const [west, east] = [Math.min(...lons) - pad, Math.max(...lons) + pad];
  const [south, north] = [Math.min(...lats) - pad, Math.max(...lats) + pad];
  const hits: { place: Place; order: number }[] = [];
  for (const place of places) {
    if (!place.kind || !kinds.includes(place.kind)) continue;
    if (place.lon < west || place.lon > east || place.lat < south || place.lat > north) continue;
    const order = points.findIndex(([lon, lat]) => metres(place, { lat, lon }) <= ALONG_M);
    if (order >= 0) hits.push({ place, order });
  }
  return hits.sort((a, b) => a.order - b.order);
}

function placesTool(s: ToolSession, idx: unknown, genre: unknown): ToolOutput {
  const r = routeOf(s, idx);
  if (typeof r === "string") return fail(r);
  const i = idx as number;
  const p = `r${i}`;
  const facts: Fact[] = [];
  if (genre === LATE_GENRE) {
    const night = assess(s.ctx.safety, r, "night").night;
    const n = night?.lateShops ?? 0;
    facts.push({
      id: `${p}.late`,
      text:
        n > 0
          ? `${routeName(i)}の沿い${SAFETY_RULES.shopNearM}m以内に、営業時間の記録で深夜も開いている店が${n}軒(営業時間が記録されている店のみ)`
          : `${routeName(i)}の沿い${SAFETY_RULES.shopNearM}m以内に、営業時間の記録で深夜も開いている店は見つからない`,
    });
    return ok({ route: routeName(i), genre }, facts);
  }
  const g = PLACE_GENRES.find((x) => x.label === genre);
  if (!g) return fail("genre が一覧にありません。");
  const hits = placesAlongRoute(s.ctx.places, r, g.kinds);
  facts.push({
    id: `${p}.places.${g.label}`,
    text: hits.length
      ? `${routeName(i)}から${ALONG_M}m以内の${g.label}の記録: ${hits.length}件(地図データにある店のみ)`
      : `${routeName(i)}から${ALONG_M}m以内に${g.label}の記録はない`,
  });
  hits.slice(0, ALONG_LIMIT).forEach(({ place }, k) =>
    facts.push({
      id: `${p}.places.${g.label}.${k}`,
      text: `${place.name}${place.hours ? `(記録上の営業時間: ${place.hours})` : ""}`,
    }),
  );
  return ok({ route: routeName(i), genre }, facts);
}

// ---------------------------------------------------------------- 実行

export function executeTool(s: ToolSession, name: string, input: unknown): ToolOutput {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  try {
    if (name === "find_routes") return findRoutesTool(s);
    if (name === "assess_route") return assessTool(s, args.route_index);
    if (name === "places_along") return placesTool(s, args.route_index, args.genre);
  } catch (e) {
    return fail(`道具の実行に失敗しました: ${(e as Error).message}`);
  }
  return fail(`${name} という道具はありません。`);
}
