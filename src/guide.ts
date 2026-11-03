import type { GeoJSONSource } from "maplibre-gl";
import { track } from "./telemetry";
import { metres, type LatLon } from "./graph";
import { findRoutes, minutesFor, type Route } from "./routes";
import { $, CURRENT, state, map, markers, toast, el } from "./app";
import { snap, safety, graph, accidents, meta, names, inKobe } from "./data";
import { assess, newGuideState, nextNotice, type GuideState, type RouteAlert } from "./safety";
import { setEnd, renderStops, selectRoute, formatMetres, fitRoutes, toKoban, focusResultHeading, longStraight } from "./directions";
import { replaceUrl } from "./url";
import type { Place } from "./types";
import { showAccuracy } from "./map-ui";
import { emergencyPanel, KOBAN_HEADING_HERE } from "./emergency";
import type { KobanHit } from "./koban";
import "./guide.css";
import { chosenVoiceName, loadVoices, onVoiceChange, primeVoice, say, stopSpeaking, turnSpeech, type SayKind } from "./voice";

export const OFF_ROUTE_M = 60;
/** GPS の誤差が大きい時は、その分だけ外れの判定をゆるめる。ゆるめ過ぎて外れに気づかない事を防ぐ上限。 */
export const OFF_ROUTE_MAX_M = 120;
export const offRouteLimit = (accuracy?: number): number => Math.min(OFF_ROUTE_MAX_M, Math.max(OFF_ROUTE_M, accuracy ?? 0));
/** 経路の上にいるとみなす距離。進みが先へ飛んだ後、戻ったかを見るのに使う。 */
export const ON_ROUTE_M = 30;
export const STEP_REACHED_M = 20;
export const ANNOUNCE_M = 40;
/** 次に歩く座標を探す範囲。GPS の跳びで先へ進み過ぎないようにする。 */
export const GUIDE_WINDOW = 400;
export let guideProgress = 0;
export let watchId: number | null = null;
export let rerouting = false;
export let voiceOn = true;
export let announced = "";
export let wakeLock: WakeLockSentinel | null = null;
/**
 * 位置の更新(watchPosition の通知)がこの時間なければ、案内が古い可能性を穏やかに知らせる。
 * 端末は動かないと更新を間引くことがあるので、信号待ちで出ないよう長めにする。
 */
export const STALE_MS = 45000;
export const STALE_TEXT = "位置の更新が止まっています。屋外の開けた場所で少し歩くと戻ります";
export const ERROR_TEXT = "位置を取得できていません。屋外の開けた場所で、位置情報がオンか確かめてください";
/** 更新は来ているが、この距離以内にしか動いていない時間がこれ以上なら「停止中」と静かに出す。 */
export const STOP_MS = 20000;
export const MOVE_M = 8;
export let lastFixAt = 0;
export let staleTimer = 0;
export let lost = false;
let anchor: LatLon | null = null;
/** 最後に取れた現在地。緊急の枠が近くの交番を探すのに使う。 */
let lastPos: LatLon | null = null;
let anchorAt = 0;
/** 長距離の案内を始める時に、電池の使い方を一度だけ知らせる距離。 */
export const LONG_ROUTE_M = 3000;
export const BATTERY_TEXT = "画面を点けたままにするため電池を使います。画面を消すと位置が止まります";
/** 案内を始める前の画面の状態。経路から外れて探し直しても、終えた時に元へ戻す。 */
let origin: { from: Place | null; stops: (Place | null)[]; routes: Route[]; selected: number } | null = null;

/** 案内中の知らせ(記録のある地点・地区に近づいた時)。画面に出す秒数。 */
export const NOTICE_SHOW_MS = 8000;
let guideState: GuideState = newGuideState();
let noticeRoute: Route | null = null;
let noticeAlerts: RouteAlert[] = [];
/** 探し直せず「元の経路へ戻って」を出している間 true。経路に戻れたら消す。 */
let offStuck = false;
/** 現在地が神戸市の外にある間 true。 */
let outside = false;
export const OUTSIDE_TEXT = "現在地が神戸市の外です";
/** 案内を始めて最初の位置か。出発地から離れている時の知らせの文を変える。 */
let firstFix = false;
/** 続けて経路の外だった回数。GPS が1回だけ跳んだ時に経路を組み替えないよう、2回続いてから探し直す。 */
let offCount = 0;
export const OFF_ROUTE_CONFIRM = 2;
/** 到着したら true。その後は外れの判定も案内もしない(「終了」を押すまで「着きました」のまま)。 */
let arrivedFlag = false;
/** これより誤差の大きい位置は、案内の判定に使わない(数km先と判定して経路を組み替えてしまうため)。 */
export const UNSURE_ACCURACY_M = 300;
/** 終了の二度押しで、すぐ下の「案内を始める」が押されて再開しないよう、終えてからこの間は始めない。 */
export const RESTART_GUARD_MS = 600;
let endedAt = 0;

/** 声を出す。kind の違い(曲がる案内は割り込む・知らせは待つ)は voice.ts の SayKind を参照。 */
export function speak(text: string, kind: SayKind | boolean = "turn"): void {
  if (!voiceOn) return;
  say(text, kind === true ? "notice" : kind === false ? "turn" : kind);
}

/** 音声ボタンの title に、使っている声の名前を出す(押さなくても、長押し・カーソルで確かめられる)。 */
export function showVoiceName(): void {
  const name = chosenVoiceName();
  $("guide-voice").title = name ? `使っている声: ${name}` : "使っている声: 端末の既定の日本語";
}

/** 案内中は画面が消えないようにする。対応しない端末ではそのまま続ける。 */
export async function keepScreenOn(): Promise<void> {
  try {
    wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
    if (watchId === null) {
      wakeLock?.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}

export function setHeading(deg: number): void {
  const me = markers.me.getElement();
  me.style.setProperty("--heading", `${deg}deg`);
  me.classList.add("facing");
}

export type CompassEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };

export function onCompass(e: CompassEvent): void {
  const deg = e.webkitCompassHeading ?? (e.absolute && e.alpha !== null ? 360 - e.alpha : null);
  if (deg !== null) setHeading(deg);
}

/** iPhone は方位の利用に許可が要る。許可を求められるのは操作の直後だけ。 */
let compassGeneration = 0;

export function watchCompass(): void {
  const generation = ++compassGeneration;
  // 方位の仕組みが無い端末（一部の PC・古いブラウザ）では、方位なしで案内する。
  if (typeof DeviceOrientationEvent === "undefined") return;
  const asking = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
  const start = () => {
    // 許可を待つ間に案内を終えた・やり直した時は、古い問い合わせの結果で監視を登録しない。
    if (watchId === null || generation !== compassGeneration) return;
    window.addEventListener("deviceorientationabsolute", onCompass as EventListener);
    window.addEventListener("deviceorientation", onCompass as EventListener);
  };
  if (asking.requestPermission) asking.requestPermission().then((answer) => answer === "granted" && start(), () => undefined);
  else start();
}

export function stopCompass(): void {
  compassGeneration++;
  window.removeEventListener("deviceorientationabsolute", onCompass as EventListener);
  window.removeEventListener("deviceorientation", onCompass as EventListener);
  markers.me.getElement().classList.remove("facing");
}

/** 線分までの距離。長い直線の途中で経路外と誤判定しないよう、頂点だけで測らない。 */
export function distanceToSegment(p: LatLon, a: [number, number], b: [number, number]): number {
  const k = Math.cos((p.lat * Math.PI) / 180);
  const dx = (b[0] - a[0]) * k;
  const dy = b[1] - a[1];
  const size = dx * dx + dy * dy;
  const t = size ? Math.max(0, Math.min(1, (((p.lon - a[0]) * k) * dx + (p.lat - a[1]) * dy) / size)) : 0;
  return metres(p, { lat: a[1] + (b[1] - a[1]) * t, lon: a[0] + (b[0] - a[0]) * t });
}

export function distanceToRoute(p: LatLon, route: Route): number {
  let best = Infinity;
  for (let i = 0; i + 1 < route.coords.length; i++) best = Math.min(best, distanceToSegment(p, route.coords[i], route.coords[i + 1]));
  return best;
}

/** 経路の座標のうち、from より先で地点にいちばん近い番号。 */
export function nearestIndex(p: LatLon, route: Route, from = 0, limit = route.coords.length): number {
  // 経路が替わった・短くなった後でも範囲の外を指さない。
  from = Math.max(0, Math.min(from, route.coords.length - 1));
  let nearest = from;
  let best = Infinity;
  const end = Math.min(route.coords.length, from + limit);
  for (let i = from; i < end; i++) {
    const [lon, lat] = route.coords[i];
    const d = metres(p, { lat, lon });
    if (d < best) {
      best = d;
      nearest = i;
    }
  }
  return nearest;
}

/** 案内の手順が、経路の座標の何番目にあるか。同じ道を往復しても順に求める。 */
export function stepIndexes(route: Route): number[] {
  let at = 0;
  return route.steps.map((step) => {
    while (at < route.coords.length && (route.coords[at][0] !== step.at[0] || route.coords[at][1] !== step.at[1])) at++;
    return at;
  });
}

/** 経路の座標 from から to までを、道なりに歩く長さ。 */
export function alongMetres(route: Route, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to && i + 1 < route.coords.length; i++) {
    const [lon1, lat1] = route.coords[i];
    const [lon2, lat2] = route.coords[i + 1];
    sum += metres({ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 });
  }
  return sum;
}

/** 案内の文から、曲がる向きの矢印を選ぶ。 */
export function arrowFor(text: string): string {
  if (text.startsWith("経由地")) return "◎";
  const right = text.includes("右");
  if (!right && !text.includes("左")) return "↑";
  if (text.startsWith("やや")) return right ? "↗" : "↖";
  if (text.startsWith("大きく")) return right ? "↘" : "↙";
  return right ? "→" : "←";
}

/**
 * 経路の線の上で、地点にいちばん近い位置。seg 番目の線分(座標 seg → seg+1)の t(0〜1)の所。
 * 頂点だけで測ると、頂点の間隔(直線では数十 m)ごとにしか距離が変わらず、歩いても「30m先」のまま止まって見える。
 * 往復する経路で帰りを行きと取り違えないよう、from(進んだ所)より先の線分だけを見る。
 */
export function projectOnRoute(p: LatLon, route: Route, from = 0, limit = route.coords.length): { seg: number; t: number; d: number } {
  const last = route.coords.length - 2;
  if (last < 0) return { seg: 0, t: 0, d: Infinity };
  let best = { seg: Math.min(from, last), t: 0, d: Infinity };
  let bestD = Infinity;
  const end = Math.min(last + 1, from + limit);
  const k = Math.cos((p.lat * Math.PI) / 180);
  for (let i = from; i < end; i++) {
    const [lon1, lat1] = route.coords[i];
    const [lon2, lat2] = route.coords[i + 1];
    const dx = (lon2 - lon1) * k;
    const dy = lat2 - lat1;
    const size = dx * dx + dy * dy;
    const t = size ? Math.max(0, Math.min(1, (((p.lon - lon1) * k) * dx + (p.lat - lat1) * dy) / size)) : 0;
    const d = metres(p, { lat: lat1 + dy * t, lon: lon1 + (lon2 - lon1) * t });
    if (d < bestD) {
      bestD = d;
      best = { seg: i, t, d };
    }
  }
  return best;
}

export function remainingFrom(
  p: LatLon,
  route: Route,
): { next: Route["steps"][number] | null; then: Route["steps"][number] | null; metresLeft: number; metresToNext: number } {
  let found = projectOnRoute(p, route, guideProgress, GUIDE_WINDOW);
  // 先の遠い所へ一度飛んだ後に経路の手前へ戻った時は、進みも手前へ直す（先へだけ数えると残りが戻らない）。
  if (guideProgress > 0 && found.d > ON_ROUTE_M) {
    const back = projectOnRoute(p, route, 0, guideProgress);
    if (back.d <= ON_ROUTE_M && back.d < found.d) found = back;
  }
  const { seg, t } = found;
  guideProgress = seg;
  // いま立っている線分の、先の頂点までの残り。ここから先は頂点どうしの道なりの長さを足す。
  const [lon1, lat1] = route.coords[seg];
  const [lon2, lat2] = route.coords[Math.min(seg + 1, route.coords.length - 1)];
  const toVertex = (1 - t) * metres({ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 });
  const metresLeft = toVertex + alongMetres(route, seg + 1, route.coords.length - 1);
  const indexes = stepIndexes(route);
  const rest = route.steps.filter((_, i) => indexes[i] > seg);
  const at = rest.findIndex((s) => metres(p, { lat: s.at[1], lon: s.at[0] }) > STEP_REACHED_M);
  const next = at >= 0 ? rest[at] : null;
  const then = at >= 0 ? (rest[at + 1] ?? null) : null;
  // 次の曲がり角までは、直線ではなく道なりの長さで示す。
  const metresToNext = next ? toVertex + alongMetres(route, seg + 1, indexes[route.steps.indexOf(next)]) : 0;
  return { next, then, metresLeft, metresToNext };
}

/**
 * 選んだ経路の、p から行く先の点 idx 以降を、p からの戻り道(leg)につないだ1本の経路にする。
 * 選んだ経路を捨てず、その経路にいちばん近い点まで歩いてから乗る。
 */
export function joinBack(p: LatLon, route: Route, idx: number, leg: Route): Route {
  const rest = route.coords.slice(idx);
  const toJoin = alongMetres(route, 0, idx);
  const restM = alongMetres(route, idx, route.coords.length - 1);
  const first = leg.coords[0];
  const lastLeg = leg.coords[leg.coords.length - 1];
  const joinPoint = route.coords[idx];
  const legM = metres(p, { lat: first[1], lon: first[0] }) + leg.metres + metres({ lat: lastLeg[1], lon: lastLeg[0] }, { lat: joinPoint[1], lon: joinPoint[0] });
  const fraction = route.metres ? restM / route.metres : 1;
  const indexes = stepIndexes(route);
  const steps = [...leg.steps, ...route.steps.filter((_, i) => indexes[i] >= idx)];
  const lift = leg.profile[leg.profile.length - 1]?.[1] ?? 0;
  const profile: [number, number][] = [
    ...leg.profile,
    ...route.profile.filter(([d]) => d >= toJoin).map(([d, h]): [number, number] => [d - toJoin + legM, h + lift]),
  ];
  const climb = leg.climb + Math.round(route.climb * fraction);
  const metresAll = legM + restM;
  return {
    ...route,
    edges: [...leg.edges, ...route.edges],
    coords: [[p.lon, p.lat], ...leg.coords, ...rest],
    metres: metresAll,
    climb,
    descent: leg.descent + Math.round(route.descent * fraction),
    profile,
    steps,
    minutes: minutesFor(metresAll, climb),
    accidents: [...new Set([...leg.accidents, ...route.accidents])],
    remoteMetres: leg.remoteMetres + route.remoteMetres * fraction,
    outsideMetres: leg.outsideMetres + route.outsideMetres * fraction,
    safety: route.safety !== null && leg.safety !== null ? Math.round((route.safety * restM + leg.safety * legM) / Math.max(1, metresAll)) : null,
  };
}

/**
 * 経路から離れた時の探し直し。選んだ経路にいちばん近い点へ向かう道を探し、その点から選んだ経路に乗る。
 * 探せない時は元の経路を残し、戻るように伝える。
 */
export function reroute(p: LatLon, route: Route, startOfGuide = false): boolean {
  track("guide_reroute", startOfGuide ? "開始時" : "");
  const idx = nearestIndex(p, route, guideProgress);
  const join = route.coords[idx];
  const here = snap(p);
  const there = snap({ lat: join[1], lon: join[0] });
  const leg = here && there ? findRoutes(graph, here, there, state.period, accidents, meta, names)[0] : undefined;
  if (!leg) {
    showTurn("!", "");
    put("guide-then", "");
    put("guide-next", "元の経路へ戻ってください");
    showAlert("off", "経路から離れています。元の経路へ戻るか、案内を終えて選び直せます");
    offStuck = true;
    return false;
  }
  rerouting = true;
  const joined = joinBack(p, route, idx, leg);
  const toJoin = metres(p, { lat: leg.coords[0][1], lon: leg.coords[0][0] }) + leg.metres;
  const atStart = startOfGuide && alongMetres(route, 0, idx) < 30;
  const text = atStart
    ? `出発地まで${formatMetres(toJoin)}あります。選んだ経路の出発地へ向かいます`
    : startOfGuide
      ? `選んだ経路まで${formatMetres(toJoin)}あります。そこへ向かってから、選んだ経路に乗ります`
      : `経路を外れたので、選んだ経路へ戻る道を案内します（${formatMetres(toJoin)}）`;
  showAlert("off", text, 8000);
  speak(startOfGuide ? text : "経路を外れました。選んだ経路へ戻ります。");
  state.routes = [joined];
  guideProgress = 0;
  announced = "";
  noticeRoute = null;
  setEnd("from", { ...p, name: CURRENT }, false, true);
  selectRoute(0, true);
  rerouting = false;
  return true;
}

/**
 * 案内の枠のすぐ下に出す知らせ。種類ごとに色と記号を変える(CSS の data-kind)。
 *   notice 記録のある地点・地区 / off 経路から外れた / gps 位置が取れない / info 電池など
 * 案内文には重ならない(枠の下に縦に並ぶ)。ms を渡すと、その時間で消える。
 */
export type AlertKind = "notice" | "off" | "gps" | "info";
const ALERT_ID: Record<AlertKind, string> = { notice: "guide-notice", off: "guide-off", gps: "guide-warn", info: "guide-info" };
const alertTimers: Partial<Record<AlertKind, number>> = {};

export function showAlert(kind: AlertKind, text: string, ms = 0): void {
  const box = $(ALERT_ID[kind]);
  // 同じ文を毎回書き直すと、読み上げが繰り返される。出ていて同じ文なら触らない。
  if (box.hidden || box.textContent !== text) box.textContent = text;
  box.hidden = false;
  window.clearTimeout(alertTimers[kind]);
  if (ms) alertTimers[kind] = window.setTimeout(() => (box.hidden = true), ms);
}

export function hideAlert(kind: AlertKind): void {
  window.clearTimeout(alertTimers[kind]);
  $(ALERT_ID[kind]).hidden = true;
}

/** 更新は来ているが動いていない時の、静かな表示。 */
export function setStopped(on: boolean): void {
  $("guide-status").hidden = !on;
}

/** 文字が変わった時だけ書き換える（位置の更新のたびに同じ文を書くと、読み上げが連発する）。 */
function put(id: string, text: string): void {
  const node = $(id);
  if (node.textContent !== text) node.textContent = text;
}

/** 案内の矢印と、次の曲がり角までの距離。 */
export function showTurn(arrow: string, distance: string): void {
  put("guide-arrow", arrow);
  put("guide-dist", distance);
  $("guide-dist").hidden = !distance;
}

/** 位置が取れていない間は、古い案内を正しいように見せない。 */
export function setLost(on: boolean, reason = "", aloud = true): void {
  const wasLost = lost;
  if (on && !wasLost) track("guide_lost", reason === STALE_TEXT ? "更新が止まった" : "取得できない");
  lost = on;
  $("guide").classList.toggle("lost", on);
  if (on) {
    showAlert("gps", reason);
    setStopped(false);
  } else hideAlert("gps");
  if (on && !wasLost && aloud) speak("位置を取得できていません");
}

/** 位置が更新されるたびに、記録のある地点・地区に近づいていないか見る。文が返ったら数秒だけ出し、読み上げる。 */
export function checkNotice(p: LatLon, route: Route): void {
  if (noticeRoute !== route) {
    noticeRoute = route;
    noticeAlerts = assess(safety, route, state.period).alerts;
  }
  const text = nextNotice(safety, noticeAlerts, guideState, p, Date.now());
  if (!text) return;
  showAlert("notice", text, NOTICE_SHOW_MS);
  speak(text, "notice");
}

export function updateGuide(p: LatLon, accuracy?: number): void {
  lastFixAt = Date.now();
  lastPos = p;
  setLost(false);
  // 更新は来ている。位置がほとんど変わらないまま STOP_MS 経ったら、警告ではなく「停止中」と静かに出す。
  if (!anchor || metres(p, anchor) > MOVE_M) {
    anchor = p;
    anchorAt = lastFixAt;
  }
  setStopped(lastFixAt - anchorAt >= STOP_MS);
  let route = state.routes[state.selected];
  if (!route) return;
  markers.me.setLngLat([p.lon, p.lat]).addTo(map);
  if (accuracy) showAccuracy(p, accuracy);
  // 神戸市の外へ出た時は、神戸の残り距離や注意を出さず、探し直しもしない。市内へ戻れば続ける。
  if (!inKobe(p)) {
    if (!outside) speak(OUTSIDE_TEXT, "notice");
    outside = true;
    offStuck = true;
    showTurn("!", "");
    put("guide-next", OUTSIDE_TEXT);
    put("guide-then", "");
    put("guide-rest", "");
    showAlert("off", `${OUTSIDE_TEXT}。このアプリは神戸市の中だけで案内します`);
    return;
  }
  outside = false;
  if (arrivedFlag) return;
  // 誤差が大きすぎる位置では、判定も表示も変えない(数km先と判定して経路を組み替えないように)。
  if (accuracy && accuracy > UNSURE_ACCURACY_M) {
    showAlert("gps", "位置が不確かです。屋外の開けた場所で少し待つと戻ります", 6000);
    track("guide_unsure", `${Math.round(accuracy)}m`);
    return;
  }
  map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 17), duration: 500 });
  const first = firstFix;
  firstFix = false;
  if (distanceToRoute(p, route) > offRouteLimit(accuracy) && !rerouting) {
    // 最初の位置以外は、2回続けて外れた時だけ探し直す(1回だけの跳びで経路を組み替えない)。
    offCount++;
    if (first || offCount >= OFF_ROUTE_CONFIRM) {
      offCount = 0;
      // 選んだ経路へ戻る道ができたら、その新しい経路で続けて案内を出す。できなければ「戻って」の表示で終える。
      if (!reroute(p, route, first)) return;
      route = state.routes[state.selected];
    } else return;
  } else offCount = 0;
  if (offStuck) {
    offStuck = false;
    hideAlert("off");
  }
  const end = route.coords[route.coords.length - 1];
  const rest = remainingFrom(p, route);
  // 終点の近くに来たら着いたとする。出発地と終点が近い周回だけは、経路の終わりまで進んだ時に限る(歩き始めに「着きました」と言わない)。
  const begin = route.coords[0];
  const loop = metres({ lat: begin[1], lon: begin[0] }, { lat: end[1], lon: end[0] }) <= STEP_REACHED_M * 2;
  if (metres(p, { lat: end[1], lon: end[0] }) <= STEP_REACHED_M && (!loop || rest.metresLeft <= STEP_REACHED_M * 2)) {
    arrivedFlag = true;
    if ($("guide-next").textContent !== "目的地に着きました") {
      speak("目的地に到着しました。お疲れさまでした。");
      track("guide_arrive");
    }
    put("guide-next", "目的地に着きました");
    showTurn("⚑", "");
    put("guide-then", "");
    put("guide-rest", "");
    return;
  }
  const { next, then, metresLeft, metresToNext } = rest;
  if (next && metres(p, { lat: next.at[1], lon: next.at[0] }) <= ANNOUNCE_M) {
    const key = next.at.join(",");
    if (key !== announced) {
      announced = key;
      speak(turnSpeech(next.text, metres(p, { lat: next.at[1], lon: next.at[0] })));
    }
  }
  checkNotice(p, route);
  showTurn(next ? arrowFor(next.text) : "↑", next ? (metresToNext < 15 ? "まもなく" : `${formatMetres(metresToNext)}先`) : "");
  // 長い直進は、曲がり角の手前に着いてから「この先◯kmは曲がりません」と出す。
  const straight = next && metresToNext < 15 ? longStraight(next) : null;
  if (straight) showTurn(arrowFor(next!.text), "");
  put("guide-next", straight ?? (next ? next.text : "このまま目的地へ進む"));
  put("guide-then", next && then ? `そのあと ${formatMetres(next.metres)}進んで ${arrowFor(then.text)} ${then.text.replace(/（.*）/, "")}` : "");
  put("guide-rest", `残り ${formatMetres(metresLeft)}・約${minutesFor(metresLeft, 0)}分`);
}

export function startGuide(index: number): void {
  // 案内中にもう一度押されても、位置の監視を二重にしない。
  if (watchId !== null) return;
  // 終了の二度押しが、すぐ下の「案内を始める」に当たって再開するのを防ぐ。
  if (Date.now() - endedAt < RESTART_GUARD_MS) return;
  track("guide_start", `${Math.round((state.routes[index]?.metres ?? 0) / 100) / 10}km`);
  if (!navigator.geolocation) {
    toast("この端末では現在地を取得できません。");
    return;
  }
  selectRoute(index);
  // 経路から外れて探し直しても、終えた時に元の出発地・経路へ戻せるよう、始める時の状態を覚えておく。
  origin = { from: state.from, stops: [...state.stops], routes: state.routes, selected: state.selected };
  primeVoice();
  document.body.classList.add("guiding");
  $("guide").hidden = false;
  put("guide-next", "現在地を確認しています…");
  put("guide-rest", "");
  put("guide-then", "");
  showTurn("…", "");
  setLost(false);
  setStopped(false);
  lastFixAt = Date.now();
  anchor = null;
  anchorAt = lastFixAt;
  window.clearInterval(staleTimer);
  staleTimer = window.setInterval(() => {
    const now = Date.now();
    if (watchId === null) return;
    if (now - lastFixAt > STALE_MS) {
      // 歩いている最中に止まった時だけ声で知らせる。止まっていた(信号待ち・休憩)なら、画面に静かに出すだけ。
      setLost(true, STALE_TEXT, lastFixAt - anchorAt < STOP_MS);
    } else if (!lost) setStopped(now - anchorAt >= STOP_MS && anchor !== null);
  }, 3000);
  announced = "";
  guideProgress = 0;
  guideState = newGuideState();
  noticeRoute = null;
  offStuck = false;
  outside = false;
  firstFix = true;
  offCount = 0;
  arrivedFlag = false;
  for (const kind of ["notice", "off", "gps", "info"] as AlertKind[]) hideAlert(kind);
  const lengthM = state.routes[index]?.metres ?? 0;
  if (lengthM >= LONG_ROUTE_M) showAlert("info", BATTERY_TEXT, 12000);
  watchId = navigator.geolocation.watchPosition(
    ({ coords }) => {
      updateGuide({ lat: coords.latitude, lon: coords.longitude }, coords.accuracy);
      if (coords.heading !== null && coords.heading !== undefined && (coords.speed ?? 0) > 0.5) setHeading(coords.heading);
    },
    (error) => {
      // 位置が取れない間も案内は止めず、取れない事を画面に出す。戻れば消える。
      if (error.code !== error.PERMISSION_DENIED) {
        setLost(true, ERROR_TEXT);
        return;
      }
      toast("位置情報が許可されていないため、案内を終わります。");
      finishGuide();
    },
    { enableHighAccuracy: true, maximumAge: 2000 },
  );
  keepScreenOn();
  watchCompass();
}

/** 案内中の緊急の枠。押しただけでは電話はかからない(番号を押して初めて発信)。 */
export function toggleEmergency(open?: boolean): void {
  const box = document.getElementById("guide-emg");
  const button = document.getElementById("guide-emergency");
  if (!box || !button) return;
  const show = open ?? box.hidden;
  button.setAttribute("aria-expanded", String(show));
  if (show) track("emergency", "案内中");
  if (!show) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  const close = el("button", "secondary guide-emg-close", "閉じる");
  close.type = "button";
  close.addEventListener("click", () => toggleEmergency(false));
  box.replaceChildren(close, emergencyPanel(lastPos, routeToKobanFromGuide, undefined, KOBAN_HEADING_HERE));
  box.hidden = false;
  if (!escBound) {
    escBound = true;
    document.addEventListener("keydown", (e) => {
      const b = document.getElementById("guide-emg");
      if (e.key !== "Escape" || !b || b.hidden) return;
      e.stopPropagation();
      toggleEmergency(false);
      document.getElementById("guide-emergency")?.focus();
    });
  }
}
let escBound = false;

/** 案内を終えて、今いる場所から交番への経路を出す。 */
function routeToKobanFromGuide(k: KobanHit): void {
  const here = lastPos;
  finishGuide();
  if (here) setEnd("from", { ...here, name: CURRENT }, false);
  toKoban(k);
}

export function stopGuide(): void {
  toggleEmergency(false);
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  const wasGuiding = watchId !== null;
  watchId = null;
  if (wasGuiding) {
    track("guide_stop", arrivedFlag ? "到着後" : "途中");
    // 案内で出した現在地の点と誤差の円は、終えたら消す(古い場所を今の場所のように見せないため)。
    markers.me.remove();
    (map.getSource("accuracy") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] });
    endedAt = Date.now();
    document.body.classList.add("guide-cooldown");
    window.setTimeout(() => document.body.classList.remove("guide-cooldown"), RESTART_GUARD_MS);
  }
  window.clearInterval(staleTimer);
  for (const kind of ["notice", "off", "gps", "info"] as AlertKind[]) hideAlert(kind);
  setLost(false);
  setStopped(false);
  document.body.classList.remove("guiding");
  $("guide").hidden = true;
  stopCompass();
  wakeLock?.release();
  wakeLock = null;
  stopSpeaking();
  // 探し直しで「現在地」に変わった出発地・経路を、案内を始める前の状態へ戻す。
  const saved = origin;
  origin = null;
  if (wasGuiding && saved && state.routes !== saved.routes) {
    state.stops = saved.stops;
    renderStops();
    setEnd("from", saved.from, false);
    state.routes = saved.routes;
    selectRoute(saved.selected);
    replaceUrl();
  }
}

/** 案内を終える。地図は経路の全体が見える表示に戻す(閉じる操作から呼ばれる stopGuide では動かさない)。 */
export function finishGuide(): void {
  stopGuide();
  if (state.mode === "directions" && state.routes.length) fitRoutes(500);
}

/** 案内の枠に、矢印・距離・次の次の案内・位置が取れない時の警告を足す。HTML は別の担当なので、ここで作る。 */
export function buildGuideParts(): void {
  const card = $("guide");
  const next = $("guide-next");
  const rest = $("guide-rest");
  const actions = card.querySelector<HTMLElement>(".guide-actions")!;
  const main = el("div", "guide-main card");
  const arrow = el("span", "guide-arrow");
  arrow.id = "guide-arrow";
  arrow.setAttribute("aria-hidden", "true");
  const column = el("div", "guide-col");
  const dist = el("p", "guide-dist");
  dist.id = "guide-dist";
  dist.hidden = true;
  const then = el("p", "guide-then");
  then.id = "guide-then";
  // 読み上げるのは次の曲がり角の案内だけ。残り距離・次の次の案内は読み上げの対象にしない。
  next.setAttribute("aria-live", "polite");
  next.setAttribute("aria-atomic", "true");
  column.append(dist, next, then);
  main.append(arrow, column);
  // 知らせは案内の枠(main)のすぐ下に縦に並べる。枠にも下の帯にも重ならない。
  const alerts = el("div", "guide-alerts");
  for (const [kind, id, role] of [
    ["gps", "guide-warn", "alert"],
    ["off", "guide-off", "alert"],
    ["notice", "guide-notice", "status"],
    ["info", "guide-info", "status"],
  ] as const) {
    const box = el("p", "guide-alert");
    box.id = id;
    box.dataset.kind = kind;
    box.hidden = true;
    box.setAttribute("role", role);
    alerts.append(box);
  }
  // 下の細い帯: 残り距離・時間・停止中の表示と、終了・音声のボタン。
  const bar = el("div", "guide-bar card");
  const info = el("div", "guide-info");
  const status = el("span", "guide-status", "停止中");
  status.id = "guide-status";
  status.hidden = true;
  info.append(rest, status);
  bar.append(info, actions);
  const emergency = el("button", "secondary guide-emergency", "緊急");
  emergency.id = "guide-emergency";
  emergency.type = "button";
  emergency.setAttribute("aria-label", "緊急の時の電話番号を出す");
  emergency.setAttribute("aria-expanded", "false");
  emergency.addEventListener("click", () => toggleEmergency());
  actions.prepend(emergency);
  const panel = el("div", "guide-emg");
  panel.id = "guide-emg";
  panel.hidden = true;
  card.replaceChildren(main, alerts, panel, bar);
}

export function bindGuideUi(): void {
  buildGuideParts();
  showVoiceName();
  onVoiceChange(showVoiceName);
  void loadVoices();
  $("guide-stop").textContent = "終了";
  // 見える文字と読み上げの名前をそろえる（音声操作で「終了」と言えば押せる）。
  $("guide-stop").removeAttribute("aria-label");
  $("guide-stop").title = "案内を終わる";
  $("guide-stop").addEventListener("click", () => {
    // 押した「終了」は消える。焦点は、戻った経路の一覧の見出しへ移す。
    finishGuide();
    focusResultHeading();
  });
  // 声を出せない端末では、効かない「音声 オン」を出さない。
  if (!("speechSynthesis" in window)) $("guide-voice").hidden = true;
  $("guide-voice").addEventListener("click", () => {
    voiceOn = !voiceOn;
    $("guide-voice").setAttribute("aria-pressed", String(voiceOn));
    $("guide-voice").textContent = voiceOn ? "音声 オン" : "音声 オフ";
    if (voiceOn) speak("音声案内をオンにしました", "toggle");
    else stopSpeaking();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && watchId !== null) keepScreenOn();
  });
}
