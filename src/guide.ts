import { metres, type LatLon } from "./graph";
import { minutesFor, type Route } from "./routes";
import { $, CURRENT, state, map, markers, toast, el } from "./app";
import { snap, safety } from "./data";
import { assess, newGuideState, nextNotice, type GuideState, type RouteAlert } from "./safety";
import { setEnd, renderStops, selectRoute, formatMetres } from "./directions";
import { showAccuracy } from "./map-ui";
import { chosenVoiceName, loadVoices, onVoiceChange, primeVoice, say, stopSpeaking, turnSpeech, type SayKind } from "./voice";

export const OFF_ROUTE_M = 60;
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
/** 位置の更新がこの時間なければ、案内が古い可能性を知らせる。 */
export const STALE_MS = 20000;
export let lastFixAt = 0;
export let staleTimer = 0;
export let lost = false;

/** 案内中の知らせ(記録のある地点・地区に近づいた時)。画面に出す秒数。 */
export const NOTICE_SHOW_MS = 8000;
let guideState: GuideState = newGuideState();
let noticeRoute: Route | null = null;
let noticeAlerts: RouteAlert[] = [];
let noticeTimer = 0;

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

export function remainingFrom(
  p: LatLon,
  route: Route,
): { next: Route["steps"][number] | null; then: Route["steps"][number] | null; metresLeft: number; metresToNext: number } {
  // 往復する経路で帰りを行きと取り違えないよう、進んだ所より先だけを見る。
  const nearest = nearestIndex(p, route, guideProgress, GUIDE_WINDOW);
  guideProgress = nearest;
  let metresLeft = 0;
  for (let i = nearest; i + 1 < route.coords.length; i++) {
    const [lon1, lat1] = route.coords[i];
    const [lon2, lat2] = route.coords[i + 1];
    metresLeft += metres({ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 });
  }
  const indexes = stepIndexes(route);
  const rest = route.steps.filter((_, i) => indexes[i] > nearest);
  const at = rest.findIndex((s) => metres(p, { lat: s.at[1], lon: s.at[0] }) > STEP_REACHED_M);
  const next = at >= 0 ? rest[at] : null;
  const then = at >= 0 ? (rest[at + 1] ?? null) : null;
  // 次の曲がり角までは、直線ではなく道なりの長さで示す。
  const metresToNext = next ? alongMetres(route, nearest, indexes[route.steps.indexOf(next)]) : 0;
  return { next, then, metresLeft, metresToNext };
}

/** 現在地から探し直す。探せない時は元の経路を残し、戻るように伝える。 */
export function reroute(p: LatLon, route: Route): void {
  const saved = { from: state.from, stops: state.stops, routes: state.routes, selected: state.selected };
  const here = nearestIndex(p, route, guideProgress);
  rerouting = true;
  state.stops = state.stops.filter((stop) => stop !== null && nearestIndex(stop, route, here) > here);
  renderStops();
  guideProgress = 0;
  if (snap(p)) {
    toast("経路を外れたので、現在地から探し直します。");
    speak("経路を外れました。探し直します。");
    setEnd("from", { ...p, name: CURRENT });
  }
  rerouting = false;
  if (state.routes.length && snap(p)) return;
  state.stops = saved.stops;
  renderStops();
  state.routes = saved.routes;
  setEnd("from", saved.from, false);
  selectRoute(saved.selected);
  showTurn("!", "");
  $("guide-then").textContent = "";
  $("guide-next").textContent = "経路から離れています。元の経路へ戻ってください";
}

/** 案内の矢印と、次の曲がり角までの距離。 */
export function showTurn(arrow: string, distance: string): void {
  $("guide-arrow").textContent = arrow;
  $("guide-dist").textContent = distance;
  $("guide-dist").hidden = !distance;
}

/** 位置が取れていない間は、古い案内を正しいように見せない。 */
export function setLost(on: boolean, reason = ""): void {
  const wasLost = lost;
  lost = on;
  $("guide").classList.toggle("lost", on);
  $("guide-warn").hidden = !on;
  if (on) $("guide-warn").textContent = reason;
  if (on && !wasLost) speak("位置を取得できていません");
}

/** 位置が更新されるたびに、記録のある地点・地区に近づいていないか見る。文が返ったら数秒だけ出し、読み上げる。 */
export function checkNotice(p: LatLon, route: Route): void {
  if (noticeRoute !== route) {
    noticeRoute = route;
    noticeAlerts = assess(safety, route, state.period).alerts;
  }
  const text = nextNotice(safety, noticeAlerts, guideState, p, Date.now());
  if (!text) return;
  const box = $("guide-notice");
  box.textContent = text;
  box.hidden = false;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => (box.hidden = true), NOTICE_SHOW_MS);
  speak(text, "notice");
}

export function updateGuide(p: LatLon, accuracy?: number): void {
  lastFixAt = Date.now();
  setLost(false);
  const route = state.routes[state.selected];
  if (!route) return;
  markers.me.setLngLat([p.lon, p.lat]).addTo(map);
  if (accuracy) showAccuracy(p, accuracy);
  map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 17), duration: 500 });
  if (distanceToRoute(p, route) > OFF_ROUTE_M && !rerouting) {
    reroute(p, route);
    return;
  }
  const end = route.coords[route.coords.length - 1];
  if (metres(p, { lat: end[1], lon: end[0] }) <= STEP_REACHED_M) {
    if ($("guide-next").textContent !== "目的地に着きました") speak("目的地に到着しました。お疲れさまでした。");
    $("guide-next").textContent = "目的地に着きました";
    showTurn("⚑", "");
    $("guide-then").textContent = "";
    $("guide-rest").textContent = "";
    return;
  }
  const { next, then, metresLeft, metresToNext } = remainingFrom(p, route);
  if (next && metres(p, { lat: next.at[1], lon: next.at[0] }) <= ANNOUNCE_M) {
    const key = next.at.join(",");
    if (key !== announced) {
      announced = key;
      speak(turnSpeech(next.text, metres(p, { lat: next.at[1], lon: next.at[0] })));
    }
  }
  checkNotice(p, route);
  showTurn(next ? arrowFor(next.text) : "↑", next ? (metresToNext < 15 ? "まもなく" : `${formatMetres(metresToNext)}先`) : "");
  $("guide-next").textContent = next ? next.text : "このまま目的地へ進む";
  $("guide-then").textContent = next && then ? `そのあと ${formatMetres(next.metres)}進んで ${arrowFor(then.text)} ${then.text.replace(/（.*）/, "")}` : "";
  $("guide-rest").textContent = `残り ${formatMetres(metresLeft)}・約${minutesFor(metresLeft, 0)}分`;
}

export function startGuide(index: number): void {
  // 案内中にもう一度押されても、位置の監視を二重にしない。
  if (watchId !== null) return;
  if (!navigator.geolocation) {
    toast("この端末では現在地を取得できません。");
    return;
  }
  selectRoute(index);
  primeVoice();
  document.body.classList.add("guiding");
  $("guide").hidden = false;
  $("guide-next").textContent = "現在地を確認しています…";
  $("guide-rest").textContent = "";
  $("guide-then").textContent = "";
  showTurn("…", "");
  setLost(false);
  lastFixAt = Date.now();
  window.clearInterval(staleTimer);
  staleTimer = window.setInterval(() => {
    if (watchId !== null && Date.now() - lastFixAt > STALE_MS) {
      setLost(true, "位置を取得できていません。今の案内は、最後に取得できた位置のものです。屋外の開けた場所で、位置情報がオンか確かめてください。");
    }
  }, 3000);
  announced = "";
  guideProgress = 0;
  guideState = newGuideState();
  noticeRoute = null;
  $("guide-notice").hidden = true;
  watchId = navigator.geolocation.watchPosition(
    ({ coords }) => {
      updateGuide({ lat: coords.latitude, lon: coords.longitude }, coords.accuracy);
      if (coords.heading !== null && coords.heading !== undefined && (coords.speed ?? 0) > 0.5) setHeading(coords.heading);
    },
    (error) => {
      // 位置が取れない間も案内は止めず、取れない事を画面に出す。戻れば消える。
      if (error.code !== error.PERMISSION_DENIED) {
        setLost(true, "位置を取得できていません。今の案内は、最後に取得できた位置のものです。屋外の開けた場所で、位置情報がオンか確かめてください。");
        return;
      }
      toast("位置情報が許可されていないため、案内を終わります。");
      stopGuide();
    },
    { enableHighAccuracy: true, maximumAge: 2000 },
  );
  keepScreenOn();
  watchCompass();
}

export function stopGuide(): void {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  window.clearInterval(staleTimer);
  window.clearTimeout(noticeTimer);
  $("guide-notice").hidden = true;
  setLost(false);
  document.body.classList.remove("guiding");
  $("guide").hidden = true;
  stopCompass();
  wakeLock?.release();
  wakeLock = null;
  stopSpeaking();
}

/** 案内の枠に、矢印・距離・次の次の案内・位置が取れない時の警告を足す。HTML は別の担当なので、ここで作る。 */
export function buildGuideParts(): void {
  const card = $("guide");
  const next = $("guide-next");
  const main = el("div", "guide-main");
  const arrow = el("span", "guide-arrow");
  arrow.id = "guide-arrow";
  arrow.setAttribute("aria-hidden", "true");
  const column = el("div", "guide-col");
  const dist = el("p", "guide-dist");
  dist.id = "guide-dist";
  dist.hidden = true;
  const then = el("p", "guide-then");
  then.id = "guide-then";
  column.append(dist, next, then);
  main.append(arrow, column);
  const warn = el("p", "guide-warn");
  warn.id = "guide-warn";
  warn.hidden = true;
  warn.setAttribute("role", "alert");
  const notice = el("p", "guide-notice");
  notice.id = "guide-notice";
  notice.hidden = true;
  notice.setAttribute("role", "status");
  card.prepend(warn, notice, main);
}

export function bindGuideUi(): void {
  buildGuideParts();
  showVoiceName();
  onVoiceChange(showVoiceName);
  void loadVoices();
  $("guide-stop").addEventListener("click", stopGuide);
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
