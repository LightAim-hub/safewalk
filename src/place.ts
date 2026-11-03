import maplibregl from "maplibre-gl";
import { metres, type LatLon } from "./graph";
import { qInput, sheet, GENRES, state, map, markers, toast, el, mapPadding } from "./app";
import { places, snap } from "./data";
import { openDirections, setEnd } from "./directions";
import { searchGenre, clearGenre } from "./search";
import { type Place, type End } from "./types";
import { jstParts } from "./daylight";
import { copyLink, pushUrl } from "./url";

/** 地図の文字の名前から、詳しい情報を持つ場所を探す。 */
export function matchPlace(name: string, at: LatLon): Place | null {
  const near = places.filter((p) => p.name === name && metres(p, at) <= 200);
  near.sort((a, b) => metres(a, at) - metres(b, at));
  return near[0] ?? null;
}


export const WARD_BY_CODE: Record<string, string> = {
  "28101": "東灘区",
  "28102": "灘区",
  "28105": "兵庫区",
  "28106": "長田区",
  "28107": "須磨区",
  "28108": "垂水区",
  "28109": "北区",
  "28110": "中央区",
  "28111": "西区",
};

/** 国土地理院の逆ジオコーダーで、地点の住所を引く。取れない時は null。 */
export async function addressOf(p: LatLon): Promise<string | null> {
  const url = `https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${p.lat}&lon=${p.lon}`;
  try {
    const { results } = (await fetch(url, { signal: AbortSignal.timeout(2500) }).then((r) => r.json())) as { results?: { muniCd: string; lv01Nm: string } };
    const ward = results && WARD_BY_CODE[results.muniCd];
    if (!ward) return null;
    const town = results.lv01Nm && results.lv01Nm !== "－" ? results.lv01Nm : "";
    return `神戸市${ward}${town}`;
  } catch {
    return null;
  }
}

export let popup: maplibregl.Popup | null = null;

/** 出発地と目的地が埋まっている時は、どちらに使うかを選んでもらう。 */
export function askWhichEnd(place: Place): void {
  popup?.remove();
  const box = el("div", "popup-actions");
  for (const [end, label] of [
    ["from", "ここを出発地にする"],
    ["to", "ここを目的地にする"],
  ] as [End, string][]) {
    const button = el("button", "", label);
    button.type = "button";
    button.addEventListener("click", () => {
      popup?.remove();
      setEnd(end, place);
    });
    box.append(button);
  }
  popup = new maplibregl.Popup({ closeButton: false, maxWidth: "220px" })
    .setLngLat([place.lon, place.lat])
    .setDOMContent(box)
    .addTo(map);
}

/** 地図を押した回数。住所が届いた時、もっと後に押されていたら捨てる（最後の要求だけを使う）。 */
let pickSeq = 0;

export async function onMapPick(place: Place, labelled: boolean): Promise<void> {
  const mine = ++pickSeq;
  if (snap(place) === null) {
    toast("この地点の近くに、神戸市内の歩ける道がありません。");
    return;
  }
  if (!labelled) {
    const address = await addressOf(place);
    if (mine !== pickSeq) return;
    place.name = address ?? place.name;
  }
  if (state.mode === "browse") {
    showPlace(place);
    pushUrl();
    return;
  }
  const empty: End | null = !state.from ? "from" : !state.to ? "to" : null;
  if (empty) setEnd(empty, place);
  else askWhichEnd(place);
}


export const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export const MINUTES_PER_DAY = 1440;

/** 「Mo-Fr 09:00-18:00」形式の営業時間から、今開いているかを求める。読めない時は null。 */
export function isOpen(hours: string, now = new Date()): boolean | null {
  if (/^24\/7$/.test(hours.trim())) return true;
  const rules: { days: string | undefined; spans: [number, number][] }[] = [];
  for (const rule of hours.split(";").map((r) => r.trim()).filter(Boolean)) {
    const m = rule.match(/^(?:((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:[-,](?:Mo|Tu|We|Th|Fr|Sa|Su))*)\s+)?(off|closed|\d{1,2}:\d{2}-\d{1,2}:\d{2}(?:,\d{1,2}:\d{2}-\d{1,2}:\d{2})*)$/);
    if (!m) return null;
    const spans = m[2] === "off" || m[2] === "closed" ? [] : m[2].split(",").map(parseSpan);
    rules.push({ days: m[1], spans });
  }
  // 同じ曜日に複数の決まりがある時は、後のものが優先される。
  const spansOn = (day: number) =>
    rules.filter((r) => !r.days || r.days.split(",").some((part) => dayInRange(part, day))).at(-1)?.spans ?? [];
  // 営業時間は神戸の現地時間（日本時間）で書かれているので、端末のタイムゾーンでなく日本時間で比べる。
  const jst = jstParts(now);
  const clock = jst.hour * 60 + jst.minute;
  const today = jst.weekday;
  const yesterday = (today + 6) % 7;
  return (
    spansOn(today).some(([a, b]) => clock >= a && clock < b) ||
    spansOn(yesterday).some(([a, b]) => clock + MINUTES_PER_DAY >= a && clock + MINUTES_PER_DAY < b)
  );
}

/** 「22:00-02:00」のように日をまたぐ時間は、終わりを翌日の分で表す。 */
export function parseSpan(span: string): [number, number] {
  const [a, b] = span.split("-").map((t) => {
    const [h, min] = t.split(":").map(Number);
    return h * 60 + min;
  });
  return [a, b > a ? b : b + MINUTES_PER_DAY];
}

export function dayInRange(part: string, day: number): boolean {
  const [a, b] = part.split("-").map((d) => DAYS.indexOf(d));
  if (b === undefined) return a === day;
  return a <= b ? day >= a && day <= b : day >= a || day <= b;
}

/** 営業時間という考えが当てはまらない種類（地区・住所・駅・バス停など）。ここには「記録なし」を出さない。 */
const NO_HOURS_KINDS = new Set(["地区", "住所", "郵便番号", "位置情報", "最近", "ジャンル", "駅", "バス停", "公園", "駐車場", "駐輪場", "史跡", "展望地", "観光", "名所", "寺社", "トイレ", "ATM"]);

export function openState(place: Place): string {
  if (!place.hours) return place.kind && !NO_HOURS_KINDS.has(place.kind) ? "営業時間の記録なし" : "";
  const open = isOpen(place.hours);
  return open === null ? "" : open ? "営業中（記録上）" : "営業時間外（記録上）";
}

export function japaneseHours(hours: string): string {
  const names: Record<string, string> = { Mo: "月", Tu: "火", We: "水", Th: "木", Fr: "金", Sa: "土", Su: "日", PH: "祝" };
  return hours
    .replace("24/7", "24時間営業")
    .replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH)\b/g, (d) => names[d])
    .replace(/\boff\b/g, "休み");
}

/** 病院・薬局（種類が施設でも、名前が診療所・急病センターの物を含む）か。 */
const MEDICAL_NAME = /急病センター|救急(?:病院|医療|センター)|病院|クリニック|医院|診療所/;
const NOT_FOR_PEOPLE = /歯科|デンタル|動物|犬猫|ペット|獣医/;
export function isMedical(place: Place): boolean {
  if (place.kind === "病院" || place.kind === "薬局") return true;
  return place.kind === "施設" && MEDICAL_NAME.test(place.name) && !NOT_FOR_PEOPLE.test(place.name);
}

/** 急な病気・けがの連絡先の一行。#7119 は神戸市の救急医療のページ（city.kobe.lg.jp/a65055/bosai/kyukyuiryo/telephone.html）で24時間の相談先とされている。 */
export function emergencyNote(): HTMLElement {
  const p = el("p", "emergency-note");
  const tel = (text: string, num: string) => {
    const a = el("a", "", text);
    a.href = `tel:${num}`;
    return a;
  };
  p.append("急な病気・けがは ", tel("119", "119"), "。迷ったら ", tel("#7119", "%237119"), "（救急安心センター）");
  return p;
}

export function infoRow(label: string, value: Node | string): HTMLElement {
  const row = el("div", "info");
  const body = el("span");
  body.append(value);
  row.append(el("span", "label", label), body);
  return row;
}

export function closePlace(): void {
  if (!state.picked && !state.genre) return;
  state.picked = null;
  markers.picked.remove();
  qInput.value = "";
  sheet.hidden = true;
  clearGenre();
  pushUrl();
}

export function externalLink(url: string): HTMLAnchorElement | null {
  if (!/^https?:\/\//.test(url)) return null;
  const link = el("a", "", url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""));
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

export function showPlace(place: Place): void {
  state.picked = place;
  qInput.value = place.name;
  markers.picked.setLngLat([place.lon, place.lat]).addTo(map);

  const wrap = el("div", "place");
  const facts = place.name.startsWith("神戸市")
    ? "地図で選んだ地点"
    : [place.kind, place.operator, place.ward ? `神戸市${place.ward}` : "神戸市"].filter(Boolean).join("・");
  const go = el("button", "primary", "経路");
  go.type = "button";
  go.addEventListener("click", () => {
    openDirections({ to: place });
    pushUrl();
  });
  const start = el("button", "secondary", "ここから出発");
  start.type = "button";
  start.addEventListener("click", () => {
    openDirections({ from: place });
    pushUrl();
  });
  const share = el("button", "secondary", "共有");
  share.type = "button";
  share.addEventListener("click", () => copyLink(share));
  const actions = el("div", "actions");
  actions.append(go, start, share);
  const address = infoRow("住所", place.address || "確認しています…");
  const info = el("div", "infos");
  info.append(address);
  if (!place.address) {
    addressOf(place).then((text) => {
      address.lastElementChild!.textContent = text ?? "記録がありません";
    });
  }
  if (place.hours) {
    const now = openState(place);
    info.append(infoRow("営業時間", [now, japaneseHours(place.hours)].filter(Boolean).join(" ")));
  } else if (openState(place)) {
    info.append(infoRow("営業時間", "営業時間の記録なし"));
  }
  if (place.phone) {
    const call = el("a", "", place.phone);
    call.href = `tel:${place.phone.replace(/[^0-9+]/g, "")}`;
    info.append(infoRow("電話", call));
  }
  const web = place.web ? externalLink(place.web) : null;
  if (web) info.append(infoRow("サイト", web));
  const nearby = el("div", "chips inline");
  nearby.append(
    ...GENRES.slice(0, 6).map((genre) => {
      const chip = el("button", "chip", genre.label);
      chip.type = "button";
      chip.addEventListener("click", () => {
        map.jumpTo({ center: [place.lon, place.lat], zoom: Math.max(map.getZoom(), 16), padding: mapPadding() });
        searchGenre(genre);
      });
      return chip;
    }),
  );
  wrap.append(el("h2", "", place.name), el("p", "", facts), actions);
  if (isMedical(place)) wrap.append(emergencyNote());
  wrap.append(info);
  wrap.append(el("p", "sub-title", "付近を検索"), nearby);
  if (place.hours || place.phone || place.web) wrap.append(el("p", "note", "営業時間などは OpenStreetMap の記録で、最新とは限りません。"));
  sheet.replaceChildren(wrap);
  sheet.hidden = false;
  map.flyTo({ center: [place.lon, place.lat], zoom: Math.max(map.getZoom(), 15), padding: mapPadding(), duration: 600 });
}
