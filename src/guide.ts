import { metres, type LatLon } from "./graph";
import { minutesFor, type Route } from "./routes";
import { $, CURRENT, state, map, markers, toast } from "./app";
import { snap } from "./data";
import { setEnd, renderStops, selectRoute, formatMetres } from "./directions";
import { showAccuracy } from "./map-ui";

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

export function speak(text: string): void {
  if (!voiceOn || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const line = new SpeechSynthesisUtterance(text);
  line.lang = "ja-JP";
  speechSynthesis.speak(line);
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
export function watchCompass(): void {
  const asking = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
  const start = () => {
    if (watchId === null) return;
    window.addEventListener("deviceorientationabsolute", onCompass as EventListener);
    window.addEventListener("deviceorientation", onCompass as EventListener);
  };
  if (asking.requestPermission) asking.requestPermission().then((answer) => answer === "granted" && start(), () => undefined);
  else start();
}

export function stopCompass(): void {
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

export function remainingFrom(p: LatLon, route: Route): { next: Route["steps"][number] | null; metresLeft: number } {
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
  return { next: rest.find((s) => metres(p, { lat: s.at[1], lon: s.at[0] }) > STEP_REACHED_M) ?? null, metresLeft };
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
  $("guide-next").textContent = "経路から離れています。元の経路へ戻ってください";
}

export function updateGuide(p: LatLon, accuracy?: number): void {
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
    if ($("guide-next").textContent !== "目的地に着きました") speak("目的地に着きました");
    $("guide-next").textContent = "目的地に着きました";
    $("guide-rest").textContent = "";
    return;
  }
  const { next, metresLeft } = remainingFrom(p, route);
  if (next && metres(p, { lat: next.at[1], lon: next.at[0] }) <= ANNOUNCE_M) {
    const key = next.at.join(",");
    if (key !== announced) {
      announced = key;
      speak(`まもなく、${next.text.replace(/（.*）/, "")}`);
    }
  }
  $("guide-next").textContent = next
    ? `${formatMetres(metres(p, { lat: next.at[1], lon: next.at[0] }))}先、${next.text}`
    : "このまま目的地へ進む";
  $("guide-rest").textContent = `残り ${formatMetres(metresLeft)}・約${minutesFor(metresLeft, 0)}分`;
}

export function startGuide(index: number): void {
  if (!navigator.geolocation) {
    toast("この端末では現在地を取得できません。");
    return;
  }
  selectRoute(index);
  document.body.classList.add("guiding");
  $("guide").hidden = false;
  $("guide-next").textContent = "現在地を確認しています…";
  $("guide-rest").textContent = "";
  announced = "";
  guideProgress = 0;
  watchId = navigator.geolocation.watchPosition(
    ({ coords }) => {
      updateGuide({ lat: coords.latitude, lon: coords.longitude }, coords.accuracy);
      if (coords.heading !== null && coords.heading !== undefined && (coords.speed ?? 0) > 0.5) setHeading(coords.heading);
    },
    (error) => {
      // 立ち止まって更新が途切れただけでは案内を止めない。
      if (error.code !== error.PERMISSION_DENIED) return;
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
  document.body.classList.remove("guiding");
  $("guide").hidden = true;
  stopCompass();
  wakeLock?.release();
  wakeLock = null;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

export function bindGuideUi(): void {
  $("guide-stop").addEventListener("click", stopGuide);
  $("guide-voice").addEventListener("click", () => {
    voiceOn = !voiceOn;
    $("guide-voice").setAttribute("aria-pressed", String(voiceOn));
    $("guide-voice").textContent = voiceOn ? "音声 オン" : "音声 オフ";
    if (voiceOn) speak("音声案内をオンにしました");
    else speechSynthesis?.cancel();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && watchId !== null) keepScreenOn();
  });
}
