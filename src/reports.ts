/**
 * 利用者による「道の状態」の投稿（確かめていない情報）。画面・Claude の道具・中継で同じ決まりを使う。
 * 書けるのは決まった5種類の道の状態だけ。事件・事故・人については書けない。自由記述は無い。
 * 事故の記録とは混ぜない（安全度の段階・経路の重みには入れない）。
 */
import { metres, type LatLon } from "./graph";

export const REPORT_KINDS = ["dark", "nolight", "surface", "bikes", "narrow"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const REPORT_LABEL: Record<ReportKind, string> = {
  dark: "夜は暗い",
  nolight: "街灯が無い・切れている",
  surface: "路面の割れ・段差・隆起",
  bikes: "自転車がよく通る",
  narrow: "歩道が狭い・無い",
};
export type Report = { id: string; lat: number; lon: number; kind: ReportKind; ts: number; disputes: number };

/** 見せる期間。これより古い投稿は出さない。 */
export const REPORT_MAX_AGE_DAYS = 90;
/** 経路の近くとみなす距離。 */
export const REPORT_NEAR_M = 50;
export const REPORT_SOURCE = "利用者の投稿（確かめていません）";

/** 経路の線から REPORT_NEAR_M 以内の投稿を、種類ごとに数える。 */
export function countReportsAlong(reports: readonly Report[], coords: readonly [number, number][]): Map<ReportKind, number> {
  const out = new Map<ReportKind, number>();
  // 経路の範囲を少し広げた枠で先に絞る（全部の投稿と経路の全部の点を比べない）。
  let s = 90, n = -90, w = 180, e = -180;
  for (const [lon, lat] of coords) {
    s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lon); e = Math.max(e, lon);
  }
  const pad = 0.001; // 約100m
  for (const r of reports) {
    if (r.lat < s - pad || r.lat > n + pad || r.lon < w - pad || r.lon > e + pad) continue;
    if (nearLine({ lat: r.lat, lon: r.lon }, coords)) out.set(r.kind, (out.get(r.kind) ?? 0) + 1);
  }
  return out;
}

function nearLine(p: LatLon, coords: readonly [number, number][]): boolean {
  for (const [lon, lat] of coords) if (metres(p, { lat, lon }) <= REPORT_NEAR_M) return true;
  for (let i = 1; i < coords.length; i++) {
    const [ax, ay] = coords[i - 1];
    const [bx, by] = coords[i];
    // 線分への最短距離（近い範囲なので平面で近似）。
    const k = Math.cos((p.lat * Math.PI) / 180);
    const dx = (bx - ax) * k, dy = by - ay;
    const len = dx * dx + dy * dy;
    if (!len) continue;
    const t = Math.max(0, Math.min(1, (((p.lon - ax) * k) * dx + (p.lat - ay) * dy) / len));
    if (metres(p, { lat: ay + dy * t, lon: ax + (dx * t) / k }) <= REPORT_NEAR_M) return true;
  }
  return false;
}
