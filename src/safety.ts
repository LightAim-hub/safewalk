/**
 * 安全度の目安・注意書き・歩いている間の知らせ。判定と文言は全部ここに置く。
 *
 * 画面から呼ぶ物(詳しい呼び方は docs/safety-api.md ではなく下の各関数の説明を見る):
 *   loadCautions()             起動時に1回。public/data/cautions.json を読む。
 *   createSafety(cautions, acc) 起動時に1回。経路ごとの判定に使う索引を作る。acc は読み込み済みの accidents.json。
 *   assess(ctx, route, period) 経路ごと。経路の一覧と、選んだ経路の詳細で呼ぶ。
 *   newGuideState()            案内を始める時に1回。
 *   nextNotice(...)            案内中、位置が更新されるたびに呼ぶ。出す知らせがあれば文を返す。
 *
 * 言葉の決まり: 「安全」「安心」「危険」と % は使わない(アプリ名 SafeWalk と、下の免責の定数を除く)。
 * 犯罪は「この道で犯罪 N 件」と言わない。町名・件数・色・地図の印は画面に出さない(夜の経路の費用に小さく足すだけ。src/routes.ts)。
 * ひったくりは、該当する道の近くを通る時だけ、行動の注意(荷物は車道と反対の手で)を出す。
 */
import { metres, type LatLon } from "./graph";
import type { Accidents, Period, Route } from "./routes";

export type Tier = "attention" | "normal" | "low" | "unknown";

/** 交通事故の記録に基づく目安であること。画面の安全度の近くに必ず出す。 */
export const SAFETY_DISCLAIMER = "交通事故の記録に基づく目安。安全を保証しません";

export const TIER_LABEL: Record<Tier, string> = {
  attention: "注意が要る",
  normal: "ふつう",
  low: "比較的記録が少ない",
  unknown: "不明",
};

/** データの出典の表示。説明ページや情報ボタンに足す。 */
export const SAFETY_SOURCES = [
  "交通事故: 警察庁「交通事故統計情報のオープンデータ」（本票 2020〜2025年）を神戸市内で抜き出して加工",
  "ひったくり・車上ねらい: 兵庫県警察の犯罪発生状況（2018〜2025年）、兵庫県オープンデータカタログ、CC BY 2.1 JP。町丁目ごとの件数を、人口あたりの率にして夜の経路の選び方に使うなど加工しており、兵庫県が作成した物ではありません",
  "深夜の滞在人口: 国土交通省「全国の人流オープンデータ」（2019年）を加工して作成",
  "夜間光: 衛星 VIIRS 夜間光 年平均（2023〜2025年、Earth Observation Group、CC BY 4.0）を加工して作成",
  "町丁目の境界: 総務省統計局 e-Stat 2020年国勢調査 小地域（町丁・字等）境界を加工",
  "深夜営業の店: OpenStreetMap の営業時間の記録（© OpenStreetMap contributors）",
];

/** 判定に使う数字。根拠は pipeline/03_cautions.py と docs の説明を参照。 */
export const SAFETY_RULES = {
  /** 経路から何m以内の事故を「経路の近く」とみなすか(注意書き) */
  cautionNearM: 50,
  /** 注意書きを出す最小件数 */
  cautionMin: 3,
  /** 1つの経路に出す注意書きの最大数 */
  cautionMax: 3,
  /** 評価できない道(人家から離れた道・市外)がこの割合を超えたら段階を出さない。人家から離れた道は事故が起きる交通が無いだけで、記録が少なくても良い道とは言えない。 */
  unknownShare: 0.1,
  /** 割合が小さくても、評価できない道がこの長さ(m)以上なら段階を出さない */
  unknownMetres: 1000,
  /** 段階を出す最短の経路の長さ(m) */
  minMetres: 300,
  /** 深夜も開いている店を数える経路からの距離(m) */
  shopNearM: 100,
  /** 人家から離れた区間を言葉にする最小の長さ(m) */
  remoteNoteM: 100,
  /** 歩いている間の知らせ: 記録の集まりに何m以内に近づいたら知らせるか */
  noticeM: 80,
  /** 記録の集まりとして知らせる最小件数(50m以内の同種の事故) */
  noticeMin: 5,
  /** 記録の集まりが経路から何m以内なら、その経路の知らせの対象にするか */
  noticeRouteM: 40,
  /** どの知らせも、前の知らせからこれだけ空ける(ms) */
  noticeGapMs: 3 * 60 * 1000,
  /** 同じ種類の知らせは、さらにこれだけ空ける(ms) */
  noticeKindGapMs: 12 * 60 * 1000,
  /** ひったくりの注意を出す町丁目の最小の記録数(2018〜2025年の合計)。1件だけの所では出さない。 */
  snatchMinTown: 2,
};

type Hot = [lat: number, lon: number, all: number, night: number];
type Town = { name: string; ward: string; n: number; rings: [number, number][][] };
type TierEdges = { lo: number; hi: number; quantiles: Record<string, number>; roadKm: number; cells: number; accidents: number; zeroShare: number };

export type Cautions = {
  accidentPeriod: [number, number];
  hittakuriPeriod: [number, number];
  tiers: { all: TierEdges; night: TierEdges };
  hot: { bike: Hot[]; ped: Hot[] };
  towns: Town[];
  late: [number, number][];
};

export async function loadCautions(): Promise<Cautions> {
  // サブパス(GitHub Pages の /safewalk/)でも動くよう、ページの位置から求める。
  return fetch(new URL("data/cautions.json", document.baseURI).href).then((r) => {
    if (!r.ok) throw new Error(`cautions.json: ${r.status}`);
    return r.json() as Promise<Cautions>;
  });
}

// ---------------------------------------------------------------- 索引

const CELL = 0.002;

class Grid {
  private readonly cells = new Map<string, number[]>();
  constructor(readonly lat: ArrayLike<number>, readonly lon: ArrayLike<number>) {
    for (let i = 0; i < lat.length; i++) {
      const k = Grid.key(lat[i], lon[i]);
      const list = this.cells.get(k);
      if (list) list.push(i);
      else this.cells.set(k, [i]);
    }
  }
  private static key(lat: number, lon: number): string {
    return `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
  }
  /** 経路の点列から radius(m) 以内にある点の添字(重複なし)。radius は 180m まで。 */
  near(points: [number, number][], radius: number, accept: (i: number) => boolean = () => true): number[] {
    const hit = new Set<number>();
    for (const [lon, lat] of points) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const i of this.cells.get(Grid.key(lat + dy * CELL, lon + dx * CELL)) ?? []) {
            if (hit.has(i) || !accept(i)) continue;
            if (metres({ lat, lon }, { lat: this.lat[i], lon: this.lon[i] }) <= radius) hit.add(i);
          }
        }
      }
    }
    return [...hit];
  }
}

export type Safety = {
  cautions: Cautions;
  acc: Accidents;
  accGrid: Grid;
  lateGrid: Grid;
  hotBike: Grid;
  hotPed: Grid;
  townBox: { minLon: number; maxLon: number; minLat: number; maxLat: number }[];
};

export function createSafety(cautions: Cautions, acc: Accidents): Safety {
  const grid = (rows: ArrayLike<number>[]) => new Grid(rows.map((r) => r[0]), rows.map((r) => r[1]));
  return {
    cautions,
    acc,
    accGrid: new Grid(acc.lat, acc.lon),
    lateGrid: grid(cautions.late),
    hotBike: grid(cautions.hot.bike),
    hotPed: grid(cautions.hot.ped),
    townBox: cautions.towns.map((t) => {
      const pts = t.rings.flat();
      return {
        minLon: Math.min(...pts.map((p) => p[0])),
        maxLon: Math.max(...pts.map((p) => p[0])),
        minLat: Math.min(...pts.map((p) => p[1])),
        maxLat: Math.max(...pts.map((p) => p[1])),
      };
    }),
  };
}

/** 経路の点列を 20m ごとに細かくする。 */
function densify(coords: [number, number][], step = 20): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < coords.length; i++) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[i + 1];
    const n = Math.max(1, Math.ceil(metres({ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 }) / step));
    for (let t = 0; t < n; t++) out.push([lon1 + ((lon2 - lon1) * t) / n, lat1 + ((lat2 - lat1) * t) / n]);
  }
  if (coords.length) out.push(coords[coords.length - 1]);
  return out;
}

function inRing(lon: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function townAt(s: Safety, lon: number, lat: number): number {
  for (let i = 0; i < s.cautions.towns.length; i++) {
    const b = s.townBox[i];
    if (lon < b.minLon || lon > b.maxLon || lat < b.minLat || lat > b.maxLat) continue;
    if (s.cautions.towns[i].rings.some((r) => inRing(lon, lat, r))) return i;
  }
  return -1;
}

// ---------------------------------------------------------------- 経路の判定

export type Caution = { kind: "bike" | "ped" | "snatch"; count: number; text: string };

export type RouteAlert = {
  id: string;
  kind: "bike" | "ped" | "snatch";
  /** 地点の知らせ。ひったくりの町丁目は null(町丁目に入った時に知らせる) */
  at: LatLon | null;
  town: number | null;
  count: number;
  text: string;
};

export type Assessment = {
  /** 交通事故の記録の軸 */
  accident: {
    tier: Tier;
    label: string;
    /** 歩行者・自転車が関わる事故の記録(経路から30m以内)の、1kmあたりの件数。段階が不明の時は null */
    perKm: number | null;
    count: number;
    /** 段階の根拠(多くても2つ) */
    reasons: string[];
  };
  /** 夜の歩きやすさの軸。昼は null */
  night: { remoteMetres: number; lateShops: number; lines: string[] } | null;
  /** 段階が不明の理由。距離つき(例: 人家から離れた区間 1.2km)。不明でない時は null */
  unknown: string | null;
  /** 経路を選ぶ時の注意書き(多くても3つ。件数の多い順) */
  cautions: Caution[];
  /** 歩いている間の知らせの候補 */
  alerts: RouteAlert[];
  disclaimer: string;
};

const km = (m: number) => `${(m / 1000).toFixed(1)}km`;
const perKmText = (v: number) => `${v.toFixed(1)}件`;

function tierOf(edges: TierEdges, perKm: number): Tier {
  if (perKm >= edges.hi) return "attention";
  if (perKm <= edges.lo) return "low";
  return "normal";
}

/**
 * 経路1本の安全度の目安・夜の歩きやすさ・注意書き・知らせの候補を返す。
 * 経路の一覧(全経路)と、選んだ経路の詳細で呼ぶ。route.accidents は routes.ts が入れる(30m 以内の事故の添字)。
 * 夜(period === "night")は夜間の記録で数え、夜の歩きやすさの言葉も返す。
 */
export function assess(s: Safety, route: Route, period: Period): Assessment {
  const night = period === "night";
  const acc = s.acc;
  const pts = densify(route.coords);
  const total = Math.max(route.metres, 1);

  // 交通事故の記録
  const near = route.accidents.filter((i) => (acc.ped[i] || acc.bike[i]) && (!night || acc.night[i]));
  const ped = near.filter((i) => acc.ped[i]).length;
  const bike = near.filter((i) => acc.bike[i]).length;
  const perKm = near.length / (total / 1000);
  const edges = night ? s.cautions.tiers.night : s.cautions.tiers.all;

  const unfit = route.remoteMetres + route.outsideMetres;
  let unknown: string | null = null;
  if (unfit > total * SAFETY_RULES.unknownShare || unfit >= SAFETY_RULES.unknownMetres) {
    const parts = [];
    if (route.remoteMetres >= SAFETY_RULES.remoteNoteM) parts.push(`家が少ない区間 ${km(route.remoteMetres)}`);
    if (route.outsideMetres >= SAFETY_RULES.remoteNoteM) parts.push(`神戸市の外の区間 ${km(route.outsideMetres)}`);
    unknown = parts.join("、") || "評価できない区間が長い";
  } else if (route.metres < SAFETY_RULES.minMetres) {
    unknown = `経路が短い（${Math.round(route.metres)}m）`;
  }
  const tier: Tier = unknown ? "unknown" : tierOf(edges, perKm);
  const reasons: string[] = [];
  if (!unknown) {
    reasons.push(
      `${night ? "夜の" : ""}歩行者・自転車が関わる事故の記録が、1kmあたり${perKmText(perKm)}（神戸市の道では${perKmText(edges.hi)}以上が上位2割、${
        edges.lo > 0 ? `${perKmText(edges.lo)}以下が下位2割` : `記録が無い道が${Math.round(edges.zeroShare * 10)}割`
      }）`,
    );
    reasons.push(`経路の近くの記録は${near.length}件（歩行者${ped}件・自転車${bike}件）`);
  }

  // 夜の歩きやすさ
  let nightPart: Assessment["night"] = null;
  if (night) {
    const shops = s.lateGrid.near(pts, SAFETY_RULES.shopNearM).length;
    const lines: string[] = [];
    lines.push(
      route.remoteMetres >= SAFETY_RULES.remoteNoteM
        ? `家が少ない区間 ${km(route.remoteMetres)}`
        : "家が少ない区間はほとんどありません",
    );
    lines.push(
      shops > 0 ? `深夜営業の店 ${shops}軒（経路から${SAFETY_RULES.shopNearM}m以内）` : "深夜営業の店は記録にありません",
    );
    lines.push("夜は人通りと明かりの多い道を優先しています");
    nightPart = { remoteMetres: route.remoteMetres, lateShops: shops, lines };
  }

  const { cautions, alerts } = cautionsFor(s, route, pts, period);
  return {
    accident: { tier, label: TIER_LABEL[tier], perKm: unknown ? null : perKm, count: near.length, reasons },
    night: nightPart,
    unknown,
    cautions,
    alerts,
    disclaimer: SAFETY_DISCLAIMER,
  };
}

function cautionsFor(s: Safety, route: Route, pts: [number, number][], period: Period): { cautions: Caution[]; alerts: RouteAlert[] } {
  const night = period === "night";
  const acc = s.acc;
  const [y0, y1] = s.cautions.accidentPeriod;
  const span = `${y0}〜${y1}年`;
  const list: Caution[] = [];
  const nearAll = s.accGrid.near(pts, SAFETY_RULES.cautionNearM);

  const make = (kind: "bike" | "ped", who: string, advice: string) => {
    const all = nearAll.filter((i) => acc[kind][i]);
    const nightOnly = all.filter((i) => acc.night[i]);
    // 夜は夜間の記録を優先して数える。足りない時は昼夜あわせた件数を使う。
    const useNight = night && nightOnly.length >= SAFETY_RULES.cautionMin;
    const count = useNight ? nightOnly.length : all.length;
    if (count < SAFETY_RULES.cautionMin) return;
    list.push({
      kind,
      count,
      text: `この経路の近くで、${span}${useNight ? "の夜" : ""}に${who}の記録が${count}件あります。${advice}`,
    });
  };
  make("bike", "自転車との事故", "周りの自転車に注意してください");
  make("ped", "歩行者の事故", "横断と車に注意してください");

  // ひったくり: 記録のある町丁目を通る時だけ、行動の注意を1つ出す。町名・件数は画面に出さない。
  const towns = new Map<number, number>();
  for (const [lon, lat] of densify(route.coords, 25)) {
    const t = townAt(s, lon, lat);
    if (t >= 0 && s.cautions.towns[t].n >= SAFETY_RULES.snatchMinTown) towns.set(t, (towns.get(t) ?? 0) + 1);
  }
  const alerts: RouteAlert[] = [];
  for (const t of towns.keys()) {
    const town = s.cautions.towns[t];
    alerts.push({
      id: `town:${town.ward}${town.name}`,
      kind: "snatch",
      at: null,
      town: t,
      count: town.n,
      text: "この付近では、荷物は車道と反対の手で持ってください",
    });
  }
  if (alerts.length) {
    list.push({
      kind: "snatch",
      count: Math.max(...alerts.map((a) => a.count)),
      text: "ひったくりに備えて、荷物は車道と反対の手で持ってください。この経路には、備えたい区間があります",
    });
  }
  list.sort((a, b) => b.count - a.count);

  // 歩いている間の知らせの候補: 経路の近くにある記録の集まり
  for (const kind of ["bike", "ped"] as const) {
    const grid = kind === "bike" ? s.hotBike : s.hotPed;
    const rows = s.cautions.hot[kind];
    for (const i of grid.near(pts, SAFETY_RULES.noticeRouteM)) {
      const [lat, lon, all, nightN] = rows[i];
      const count = night ? nightN : all;
      if (count < SAFETY_RULES.noticeMin) continue;
      alerts.push({
        id: `${kind}:${lat},${lon}`,
        kind,
        at: { lat, lon },
        town: null,
        count,
        text:
          kind === "bike"
            ? "この付近で自転車との事故の記録があります。自転車に注意してください"
            : "この付近で歩行者の事故の記録があります。横断と車に注意してください",
      });
    }
  }
  return { cautions: list.slice(0, SAFETY_RULES.cautionMax), alerts };
}

// ---------------------------------------------------------------- 歩いている間の知らせ

export type GuideState = {
  /** 知らせた物の id */
  done: string[];
  /** 最後に知らせた時刻(ms) */
  lastAt: number | null;
  /** 種類ごとに最後に知らせた時刻(ms) */
  lastByKind: Partial<Record<RouteAlert["kind"], number>>;
};

export function newGuideState(): GuideState {
  return { done: [], lastAt: null, lastByKind: {} };
}

/**
 * 案内中に現在地が更新されるたびに呼ぶ。出す知らせがあれば文を返し、無ければ null。
 * - alerts: assess() が返した、案内中の経路の alerts
 * - state: newGuideState() で作った物。知らせを返した時にこの関数が書き換える
 * - now: 現在時刻(ms)。Date.now() を渡す
 * 記録の集まりに 80m 以内に近づいた時、またはひったくりの記録がある町丁目に入った時だけ知らせる。
 * 同じ地点・同じ地区は1回だけ。どの知らせも前から3分、同じ種類は12分空ける。
 * 空ける間に条件が外れた(通り過ぎた)知らせは出さない。
 */
export function nextNotice(s: Safety, alerts: RouteAlert[], state: GuideState, pos: LatLon, now: number): string | null {
  if (state.lastAt !== null && now - state.lastAt < SAFETY_RULES.noticeGapMs) return null;
  const here = townAt(s, pos.lon, pos.lat);
  let best: RouteAlert | null = null;
  for (const a of alerts) {
    if (state.done.includes(a.id)) continue;
    const last = state.lastByKind[a.kind];
    if (last !== undefined && now - last < SAFETY_RULES.noticeKindGapMs) continue;
    const hit = a.at ? metres(pos, a.at) <= SAFETY_RULES.noticeM : a.town === here;
    if (hit && (!best || a.count > best.count)) best = a;
  }
  if (!best) return null;
  state.done.push(best.id);
  state.lastAt = now;
  state.lastByKind[best.kind] = now;
  return best.text;
}
