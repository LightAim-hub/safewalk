import * as maplibregl from "maplibre-gl";
import { type GeoJSONSource } from "maplibre-gl";
import { metres, type LatLon } from "./graph";
import { $, qInput, sheet, CURRENT, GENRES, GENRE_LIMIT, state, map, markers, el, mapPadding } from "./app";
import { places } from "./data";
import { formatMetres } from "./directions";
import { locateMe } from "./map-ui";
import { emergencyNote, isMedical, openState, showPlace } from "./place";
import { type Place, type IndexedPlace, type Genre } from "./types";
import { pushUrl } from "./url";
import "./search.css";

/**
 * 全角半角と大小を揃え、カタカナはひらがなに寄せて比べる。
 * 「セブン-イレブン」と「セブンイレブン」、「三ノ宮」と「三宮」のような表記ゆれも同じにする。
 */
export const normalize = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/(?<=[ァ-ヶー])[-‐‑–—・･](?=[ァ-ヶ])/g, "")
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/三[のノ]宮/g, "三宮");
export const KIND_ORDER = ["駅", "地区", "名所", "商業施設", "百貨店", "公園", "大学", "病院", "役所", "博物館", "動物園"];

/** 駅や名所より下に並べる種類。種類の名前そのものを検索した時は下げない。 */
const MINOR_KINDS = ["駐車場", "駐輪場", "バス停"];

/** 略称・通称から、地図に載っている正式な名前へ。 */
const ALIASES = new Map(
  Object.entries({
    スタバ: "スターバックス",
    ファミマ: "ファミリーマート",
    セブン: "セブン-イレブン",
    セブイレ: "セブン-イレブン",
    マクド: "マクドナルド",
    マック: "マクドナルド",
    ミニスト: "ミニストップ",
    ドンキ: "ドン・キホーテ",
    ケンタ: "ケンタッキー",
    ミスド: "ミスタードーナツ",
    サイゼ: "サイゼリヤ",
    ココイチ: "CoCo壱番屋",
    吉牛: "吉野家",
    無印: "無印良品",
    コメダ: "コメダ珈琲",
    モス: "モスバーガー",
    // 通称・旧称から、地図に載っている名前へ（どれも places.json に実在する名前）。
    中華街: "南京町",
    須磨水族園: "神戸須磨シーワールド",
    須磨水族館: "神戸須磨シーワールド",
    ポートタワー: "神戸ポートタワー",
    神戸タワー: "神戸ポートタワー",
    空港: "神戸空港",
    ハーバー: "ハーバーランド",
  }).map(([short, full]) => [normalize(short), normalize(full)]),
);

/** ローマ字(ヘボン式・訓令式の基本)の音。 */
const ROMAJI: Record<string, string> = {
  a: "あ", i: "い", u: "う", e: "え", o: "お",
  ka: "か", ki: "き", ku: "く", ke: "け", ko: "こ",
  sa: "さ", si: "し", shi: "し", su: "す", se: "せ", so: "そ",
  ta: "た", ti: "ち", chi: "ち", tu: "つ", tsu: "つ", te: "て", to: "と",
  na: "な", ni: "に", nu: "ぬ", ne: "ね", no: "の",
  ha: "は", hi: "ひ", hu: "ふ", fu: "ふ", he: "へ", ho: "ほ",
  ma: "ま", mi: "み", mu: "む", me: "め", mo: "も",
  ya: "や", yu: "ゆ", yo: "よ",
  ra: "ら", ri: "り", ru: "る", re: "れ", ro: "ろ",
  wa: "わ", wo: "を",
  ga: "が", gi: "ぎ", gu: "ぐ", ge: "げ", go: "ご",
  za: "ざ", zi: "じ", ji: "じ", zu: "ず", ze: "ぜ", zo: "ぞ",
  da: "だ", di: "ぢ", du: "づ", de: "で", do: "ど",
  ba: "ば", bi: "び", bu: "ぶ", be: "べ", bo: "ぼ",
  pa: "ぱ", pi: "ぴ", pu: "ぷ", pe: "ぺ", po: "ぽ",
  kya: "きゃ", kyu: "きゅ", kyo: "きょ",
  sha: "しゃ", shu: "しゅ", sho: "しょ", sya: "しゃ", syu: "しゅ", syo: "しょ",
  cha: "ちゃ", chu: "ちゅ", cho: "ちょ", tya: "ちゃ", tyu: "ちゅ", tyo: "ちょ",
  nya: "にゃ", nyu: "にゅ", nyo: "にょ",
  hya: "ひゃ", hyu: "ひゅ", hyo: "ひょ",
  mya: "みゃ", myu: "みゅ", myo: "みょ",
  rya: "りゃ", ryu: "りゅ", ryo: "りょ",
  gya: "ぎゃ", gyu: "ぎゅ", gyo: "ぎょ",
  ja: "じゃ", ju: "じゅ", jo: "じょ",
  bya: "びゃ", byu: "びゅ", byo: "びょ",
  pya: "ぴゃ", pyu: "ぴゅ", pyo: "ぴょ",
};

/** ローマ字だけの言葉をひらがなにする。全部は変換できない言葉(英語など)は null。 */
export function romajiToKana(text: string): string | null {
  const t = text.toLowerCase();
  if (!/^[a-z']+$/.test(t)) return null;
  let out = "";
  let i = 0;
  while (i < t.length) {
    const c = t[i];
    const next = t[i + 1];
    if (c === "n") {
      // 母音・y の前の n は「な行」。それ以外(語末・子音の前・nn・n')は「ん」。
      if (!(next !== undefined && "aiueoy".includes(next))) {
        out += "ん";
        // 「sannomiya」の最初の n は「ん」だけ。次の n は「の」の頭。「nn」だけで終わる・子音が続く時は2文字で「ん」。
        const after = t[i + 2];
        i += next === "'" || (next === "n" && !(after !== undefined && "aiueoy".includes(after))) ? 2 : 1;
        continue;
      }
    }
    // 同じ子音が重なるのは「っ」(kk・tt・ss・pp など。n は除く)。
    if (c === next && "kstphgzdbfjmryw".includes(c)) {
      out += "っ";
      i += 1;
      continue;
    }
    const len = [3, 2, 1].find((l) => ROMAJI[t.slice(i, i + l)] !== undefined);
    if (len === undefined) return null;
    out += ROMAJI[t.slice(i, i + len)];
    i += len;
  }
  return out;
}

/** 郵便番号なら「650-0001」の形にする。 */
export function postcodeOf(text: string): string | null {
  const m = /^〒?(\d{3})[-‐‑–—−ー]?(\d{4})$/.exec(text.normalize("NFKC").replace(/\s+/g, ""));
  return m ? `${m[1]}-${m[2]}` : null;
}

/** 「神戸三宮駅」を「三宮駅」と同じに扱うため、頭の「神戸」を外した名前。 */
const withoutKobe = (name: string) => (/^神戸(?!駅|市).{2,}/.test(name) ? name.slice(2) : name);

const MAIN_OPERATORS = ["西日本旅客鉄道", "阪急電鉄", "阪神電気鉄道"];

/** 英語で書いた場所。空白とハイフンを除いた形で引く。 */
const ENGLISH_PLACES = new Map(
  Object.entries({
    kobeairport: "神戸空港",
    airport: "神戸空港",
    chinatown: "南京町",
    nankinmachi: "南京町",
    harborland: "ハーバーランド",
    kobeuniversity: "神戸大学",
    meriken: "メリケンパーク",
    merikenpark: "メリケンパーク",
    kobeporttower: "神戸ポートタワー",
    porttower: "神戸ポートタワー",
    kitanoijinkan: "北野 異人館街",
    ijinkan: "異人館",
  }),
);

/** 駅を表す英語の語。 */
const EN_STATION = new Set(["station", "sta", "stn", "eki"]);

/** 神戸新交通の路線。駅の公式ページの番号（800〜811）はポートライナー、住吉〜アイランドセンターは六甲ライナー。 */
const ROKKO_LINER = new Set(["住吉駅", "魚崎駅", "南魚崎駅", "アイランド北口駅", "マリンパーク駅", "アイランドセンター駅"]);
type Liner = "ポートライナー" | "六甲ライナー";

function linerNumber(p: Place): number {
  const m = /knt-liner\.co\.jp\/station\/(\d+)/.exec(p.web ?? "");
  return m ? Number(m[1]) : -1;
}

export function lineOf(p: Place): Liner | null {
  if (p.kind !== "駅") return null;
  if (linerNumber(p) >= 800) return "ポートライナー";
  return p.operator?.includes("神戸新交通") && ROKKO_LINER.has(p.name) ? "六甲ライナー" : null;
}

/** 名前が JR だけの駅（私鉄・地下鉄に同じ名前が無い物）。事業者の記録がない駅を見分けるために持つ。 */
const JR_ONLY = new Set(["三ノ宮駅", "神戸駅", "六甲道駅", "摂津本山駅", "甲南山手駅", "灘駅", "鷹取駅", "塩屋駅", "垂水駅", "舞子駅", "須磨駅", "摩耶駅"]);

export function isJr(p: Place): boolean {
  if (p.kind !== "駅") return false;
  return !!p.operator?.includes("西日本旅客鉄道") || !!p.web?.includes("jr-odekake") || JR_ONLY.has(p.name);
}

/** 候補の二行目に出す路線・事業者。JR と神戸新交通は線が分かる形にする。 */
export function operatorLabel(p: Place): string | undefined {
  const line = lineOf(p);
  if (line) return `神戸新交通（${line}）`;
  if (isJr(p)) return "JR";
  return p.operator || undefined;
}

interface Prepared {
  q: string;
  station: boolean;
  jr: boolean;
}

/** 検索の言葉を整える。英語の station／airport／jr、ハイフンと空白を処理する。 */
function prepare(query: string): Prepared {
  let text = query.normalize("NFKC").toLowerCase().trim();
  let station = false;
  let jr = false;
  if (/^[\x20-\x7e]+$/.test(text)) {
    // 「shin-kobe」「shin kobe」は、ひと続きのローマ字として読む。
    const tokens = text.split(/[\s\-_.]+/).filter(Boolean);
    station = tokens.some((t) => EN_STATION.has(t));
    jr = tokens.includes("jr");
    const rest = tokens.filter((t) => !EN_STATION.has(t) && t !== "jr").join("");
    text = ENGLISH_PLACES.get(rest) ?? rest;
  } else if (/^jr|jr$/.test(text.replace(/\s+/g, ""))) {
    jr = true;
    text = text.replace(/\s+/g, "").replace(/^jr|jr$/, "");
  }
  return { q: normalize(text), station, jr };
}

/** 「夜」「夜間」のような、場所の名前ではなく条件の言葉。 */
const NIGHT_WORD = /^(夜|夜間|よる|深夜|night|24時間)$/;
/** 夜に開いている・受けられると分かる場所（名前か営業時間の記録から）。 */
function openAtNight(p: Place): boolean {
  return /夜間|急病|救急|24時間/.test(p.name) || /24\/7|-0[0-6]:\d\d|-24:00/.test(p.hours ?? "");
}

/** 名前の全体で 0 件だった時、空白で分けて探し直す。「病院 夜」のような 語＋条件 は、条件に合う物を先に出す。 */
function searchByParts(query: string): Place[] {
  const tokens = query.normalize("NFKC").trim().split(/[\s,、]+/).filter(Boolean);
  if (tokens.length < 2) return [];
  const night = tokens.some((t) => NIGHT_WORD.test(t.toLowerCase()));
  const rest = tokens.filter((t) => !NIGHT_WORD.test(t.toLowerCase()));
  if (night) {
    if (rest.length !== 1) return [];
    const genre = matchGenres(rest[0])[0];
    const pool = genre
      ? places.filter((p) => genre.kinds.includes(p.kind) || (genre.label === "病院" && p.kind === "施設" && isMedical(p)))
      : searchPlaces(rest[0]);
    const hit = pool.filter(openAtNight);
    return (hit.length ? hit : pool).slice(0, 7);
  }
  const parts = tokens.map((t) => {
    const n = normalize(t);
    return { n, brand: ALIASES.get(n) };
  });
  const all = places.filter((p) => parts.every((t) => p.n.includes(t.n) || p.y.includes(t.n) || (t.brand && p.n.includes(t.brand)) || normalize(p.ward).includes(t.n)));
  if (all.length) return all.slice(0, 7);
  for (const t of tokens) {
    const one = searchPlaces(t);
    if (one.length) return one;
  }
  return [];
}

/** 路線の名前で探した時の、駅の並び（路線の順）。 */
function searchLine(q: string): Place[] | null {
  const port = q === normalize("ポートライナー") || q === normalize("神戸新交通") || q === normalize("新交通");
  const rokko = q === normalize("六甲ライナー") || q === normalize("神戸新交通") || q === normalize("新交通");
  if (!port && !rokko) return null;
  const on = (line: Liner) => places.filter((p) => lineOf(p) === line);
  const rows = [
    ...(port ? on("ポートライナー").sort((a, b) => linerNumber(a) - linerNumber(b)) : []),
    ...(rokko ? on("六甲ライナー") : []),
  ];
  return rows.slice(0, 7);
}

export function searchPlaces(query: string): Place[] {
  const { q, station, jr } = prepare(query);
  if (!q) return [];
  if (postcodeOf(q)) return [];
  const line = searchLine(q);
  if (line) return line;
  const found = searchNormalized(q, station, jr);
  return found.length ? found : searchByParts(query);
}

function searchNormalized(q: string, station: boolean, jr: boolean): Place[] {
  const brand = ALIASES.get(q);
  const kindNamed = (kind: string) => q.length >= 2 && (normalize(kind).includes(q) || q.includes(normalize(kind)));
  // ローマ字(sannomiya)は、読みにだけ当てる。英語の店名などで全部は変換できない言葉は使わない。
  // 長音はローマ字で書かないことが多い（kobe=こうべ、rokko=ろっこう）。読みの側の「う」を落として比べる。
  const kana = /^[a-z']{3,}$/.test(q) ? romajiToKana(q) : null;
  const yomi = (p: IndexedPlace) => (kana ? p.y.replace(/([おこそとのほもよろごぞどぼぽょくすつぬふむゆるぐずづぶぷゅ])う/g, "$1") : p.y);
  const rank = (p: IndexedPlace) => {
    const name = withoutKobe(p.n);
    let key = name.startsWith(q) || !p.y.startsWith(q) ? name : p.y;
    // 駅の読みは「…えき」。「さんのみや」と打った時は、駅名そのものと同じ扱いにする。
    if (p.kind === "駅" && key === p.y && key.replace(/えき$/, "") === q) key = q;
    const k = KIND_ORDER.indexOf(p.kind);
    let match = key === q || p.n === q ? 0 : key.startsWith(q) ? 100 : 200;
    // 略称で探した時は、略称と同じ名前の別の場所（セブンという名のカフェなど）より、正式な名前の店を上にする。
    // 名前がそのまま一致する場所（南京町）は、その広場や案内図より上にする。
    if (brand) match = p.n === brand ? -100 : p.n.startsWith(brand) ? 0 : p.n.includes(brand) ? 100 : 300 + match;
    // ローマ字から変えた読みだけで当たった物。駅・地区などは読みの一致で並べ、ほかの場所は名前で当たった物より下げる。
    if (kana && !p.n.includes(q) && !p.y.includes(q) && (p.y.includes(kana) || yomi(p).includes(kana))) {
      const y = p.y.includes(kana) ? p.y : yomi(p);
      const reading = p.kind === "駅" ? y.replace(/えき$/, "") : y;
      match = reading === kana ? 0 : y.startsWith(kana) ? 100 : 200;
    }
    // 読みだけで当たった駅・地区以外の場所(三呑み屋など)は、駅・地区より下げる。
    // 略称（ファミマ→ファミリーマート）で当たった店は対象外。
    if (k < 0 && !brand && key === p.y && !p.n.includes(q)) match += 100;
    const minor = MINOR_KINDS.includes(p.kind) && !kindNamed(p.kind) ? 150 : 0;
    // 「station」と添えた時は駅を、「JR」と添えた時は JR の駅を先に出す。
    const asked = kindNamed(p.kind) || (station && p.kind === "駅") ? -150 : 0;
    const onlyJr = jr ? (isJr(p) ? -300 : p.kind === "駅" ? 0 : 100) : 0;
    const main = p.kind === "駅" && MAIN_OPERATORS.some((o) => p.operator?.includes(o)) ? -0.3 : 0;
    return match + minor + asked + onlyJr + (k < 0 ? 50 : k) + key.length / 100 + main;
  };
  const seen = new Set<string>();
  return places
    .filter((p) => p.n.includes(q) || p.y.includes(q) || (brand && p.n.includes(brand)) || (kana && KIND_ORDER.includes(p.kind) && (p.y.includes(kana) || yomi(p).includes(kana))))
    .map((p) => ({ p, score: rank(p) }))
    .sort((a, b) => a.score - b.score)
    .map(({ p }) => p)
    .filter((p) => {
      // 同じ駅が路線ごとに重なるのを1つにする。チェーン店は別の店なので残す。
      const key = `${p.name}:${p.kind}:${Math.round(p.lat * 200)}:${Math.round(p.lon * 200)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 7);
}

/** 「コンビニ」のような言葉から、ジャンルを探す。 */
export function matchGenres(query: string): Genre[] {
  const q = normalize(query);
  return q ? GENRES.filter((g) => normalize(g.label).startsWith(q)) : [];
}

export const RECENT_KEY = "safewalk.recent";
export const RECENT_LIMIT = 6;

/** 保存された値が、地点として使える形か。壊れた値や古い形は捨てる。 */
function isPlace(value: unknown): value is Place {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.name === "string" &&
    p.name.length > 0 &&
    typeof p.lat === "number" &&
    Number.isFinite(p.lat) &&
    typeof p.lon === "number" &&
    Number.isFinite(p.lon)
  );
}

export function recentPlaces(): Place[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter(isPlace).slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

export function remember(place: Place): void {
  if (place.name === CURRENT) return;
  const rest = recentPlaces().filter((p) => p.name !== place.name);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([place, ...rest].slice(0, RECENT_LIMIT)));
  } catch {
    // 履歴を残せない環境でも、検索はそのまま使える。
  }
}

export let lastResults: Place[] = [];

export function placeRows(rows: Place[], from: LatLon, onPick: (p: Place) => void): HTMLOListElement {
  const list = el("ol", "results");
  list.append(
    ...rows.map((place) => {
      const li = el("li");
      const button = el("button");
      button.type = "button";
      const open = openState(place);
      button.append(
        el("span", "name", place.name),
        el("span", "facts", [place.kind, formatMetres(metres(place, from)), open].filter(Boolean).join("・")),
      );
      button.addEventListener("click", () => onPick(place));
      li.append(button);
      return li;
    }),
  );
  return list;
}

export function showResultDots(rows: Place[]): void {
  lastResults = rows;
  (map.getSource("results") as GeoJSONSource).setData({
    type: "FeatureCollection",
    features: rows.map((place, index) => ({
      type: "Feature",
      properties: { index, name: place.name },
      geometry: { type: "Point", coordinates: [place.lon, place.lat] },
    })),
  });
}

/** 履歴の移動の最中か。url.ts の popstate より先に立てる（url.ts は書き換えない）。 */
let fromHistory = false;
window.addEventListener(
  "popstate",
  () => {
    fromHistory = true;
    setTimeout(() => (fromHistory = false), 0);
  },
  true,
);

/** 最後に出したジャンルの一覧。戻った時に同じ並びで出すため、並べた順と数えた中心を残す。 */
let genreList: { label: string; rows: Place[]; from: LatLon; inView: boolean } | null = null;

/** 今見ている範囲のジャンルの場所を、中心から近い順に出す。 */
export function searchGenre(genre: Genre): void {
  // 履歴の「戻る」「進む」で一覧に戻る時は、最初に出した並びをそのまま出す（戻した地図の中心から数え直すと並びが変わる）。
  const reuse = fromHistory && genreList !== null && genreList.label === genre.label;
  state.genre = genre;
  state.picked = null;
  markers.picked.remove();
  qInput.value = genre.label;
  renderChips();
  $("research").hidden = true;
  const view = map.getBounds();
  const center = map.getCenter();
  const from = genreList && reuse ? genreList.from : { lat: center.lat, lon: center.lng };
  // 「病院」は、種類が施設で名前が急病センター・クリニック・医院などの物も含める（places.json は作り直さず検索側で救う）。
  const ofGenre = places.filter((p) => genre.kinds.includes(p.kind) || (genre.label === "病院" && p.kind === "施設" && isMedical(p)));
  const inView = ofGenre.filter((p) => view.contains([p.lon, p.lat]));
  const rows =
    genreList && reuse
      ? genreList.rows
      : (inView.length ? inView : ofGenre)
          .slice()
          .sort((a, b) => metres(a, from) - metres(b, from))
          .slice(0, GENRE_LIMIT);
  if (!reuse) genreList = { label: genre.label, rows, from, inView: inView.length > 0 };
  showResultDots(rows);
  const wrap = el("div");
  wrap.append(el("h2", "sheet-title", (reuse ? genreList?.inView : inView.length) ? `この範囲の${genre.label}` : `近くの${genre.label}（この範囲にはありません）`));
  if (genre.label === "病院" || genre.label === "薬局") wrap.append(emergencyNote());
  // 営業時間の記録がある物が半分に満たない時は、「営業中」と出ない理由と確かめ方を一行で伝える。
  if ((genre.label === "病院" || genre.label === "薬局") && rows.length && rows.filter((p) => p.hours).length * 2 < rows.length) {
    wrap.append(el("p", "hours-note", "営業時間の記録がある所は少数です。夜間・休日は、出かける前に電話で確かめてください。"));
  }
  wrap.append(
    rows.length
      ? placeRows(rows, from, (place) => {
          showPlace(place);
          pushUrl();
        })
      : el("p", "", `${genre.label}の記録がありません。`),
  );
  sheet.replaceChildren(wrap);
  sheet.hidden = false;
  // 市全体を見ている時や範囲内に無い時は、結果が見える所まで寄る。
  if (!reuse && rows.length && (!inView.length || map.getZoom() < 13)) {
    const all = rows.slice(0, 12).map((p): [number, number] => [p.lon, p.lat]);
    map.fitBounds(
      all.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(all[0], all[0])),
      { padding: mapPadding(), maxZoom: 16, duration: 500 },
    );
  }
}

export function clearGenre(): void {
  state.genre = null;
  showResultDots([]);
  $("research").hidden = true;
  renderChips();
}

/**
 * 最初に並べるジャンル。歩いている途中に「いま要る」物（買う・食べる・体調・乗る）を先頭に置く。
 * 利用の回数を測った順ではなく、設計上の判断。残りは「ほか」で開く。
 */
export const MAIN_GENRES = ["コンビニ", "飲食店", "病院", "駅"];

/** 「ほか」を開いているか。 */
let chipsOpen = false;

export function renderChips(): void {
  const main = MAIN_GENRES.map((label) => GENRES.find((g) => g.label === label)).filter((g): g is Genre => !!g);
  const rest = GENRES.filter((g) => !main.includes(g));
  // 選んでいるジャンルが「ほか」の中なら、開いたままにする。
  const open = chipsOpen || (state.genre !== null && rest.includes(state.genre));
  const chip = (genre: Genre) => {
    const b = el("button", "chip", genre.label);
    b.type = "button";
    b.setAttribute("aria-pressed", String(state.genre === genre));
    b.addEventListener("click", () => searchGenre(genre));
    return b;
  };
  const more = el("button", "chip chip-more", open ? "閉じる" : "ほか");
  more.type = "button";
  more.setAttribute("aria-expanded", String(open));
  more.addEventListener("click", () => {
    chipsOpen = !open;
    renderChips();
    $("chips").querySelector<HTMLElement>(".chip-more")?.focus({ preventScroll: true });
    // 開いた時は「閉じる」を左端にそろえる（どのジャンルも途中で欠けず、続きのジャンルが右に並ぶ）。閉じた時は先頭に戻す。
    const row = $("chips");
    const closeChip = row.querySelector<HTMLElement>(".chip-more");
    row.scrollLeft = 0;
    if (chipsOpen && closeChip) row.scrollLeft += closeChip.getBoundingClientRect().left - 4;
  });
  $("chips").replaceChildren(...main.map(chip), more, ...(open ? rest.map(chip) : []));
}

/** 外部の検索を待つ長さ。これを過ぎたら手元の候補だけで続ける。 */
export const EXTERNAL_TIMEOUT_MS = 2500;

/** 指定の時間で中断する signal。AbortSignal.timeout が無い古い端末(iOS 16 以前など)でも例外にならない。 */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), ms);
  return ctl.signal;
}

export interface Lookup {
  places: Place[];
  /** 時間切れ・通信の失敗で、外部の検索が使えなかった。 */
  failed: boolean;
}

/** 国土地理院の住所検索。神戸市内の住所だけを採る。時間切れや失敗は failed で知らせる。 */
export async function lookupAddress(
  query: string,
  limit = 4,
  signal: AbortSignal = timeoutSignal(EXTERNAL_TIMEOUT_MS),
): Promise<Lookup> {
  const url = `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return { places: [], failed: true };
    const rows: { geometry: { coordinates: [number, number] }; properties: { title: string } }[] = await res.json();
    const places = rows
      .filter((r) => r.properties.title.includes("神戸市"))
      .slice(0, limit)
      .map((r) => ({
        name: r.properties.title,
        lat: r.geometry.coordinates[1],
        lon: r.geometry.coordinates[0],
        kind: "住所",
      }));
    return { places, failed: false };
  } catch {
    return { places: [], failed: true };
  }
}

export async function searchAddress(query: string, limit = 4): Promise<Place[]> {
  return (await lookupAddress(query, limit)).places;
}

/**
 * 郵便番号から場所を探す。国土地理院の住所検索は郵便番号を引けないので、
 * 日本郵便の郵便番号データを返す zipcloud（https://zipcloud.ibsnet.co.jp/doc/api）で町名を調べ、
 * その町名を国土地理院の住所検索で位置にする。神戸市内の物だけを採る。
 * 全体で EXTERNAL_TIMEOUT_MS を超えたら打ち切る。
 */
export async function lookupPostcode(
  code: string,
  signal: AbortSignal = timeoutSignal(EXTERNAL_TIMEOUT_MS),
): Promise<Lookup> {
  try {
    const res = await fetch(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${code.replace("-", "")}`, { signal });
    if (!res.ok) return { places: [], failed: true };
    const found: { results: { address2: string; address3: string }[] | null } = await res.json();
    const rows = (found.results ?? []).filter((r) => r.address2.startsWith("神戸市"));
    let failed = false;
    const spots = await Promise.all(
      rows.slice(0, 3).map(async (r): Promise<Place | null> => {
        const town = /以下に掲載がない場合|一円/.test(r.address3) ? "" : r.address3.replace(/（.*$/, "");
        const text = `兵庫県${r.address2}${town}`;
        const lookup = await lookupAddress(text, 20, signal);
        failed ||= lookup.failed;
        const hits = lookup.places.filter((h) => h.name.includes(`${r.address2}${town}`));
        if (!hits.length) return null;
        const lat = hits.reduce((s, h) => s + h.lat, 0) / hits.length;
        const lon = hits.reduce((s, h) => s + h.lon, 0) / hits.length;
        return { name: `〒${code} ${r.address2}${town}`, lat, lon, kind: "郵便番号", address: `兵庫県${r.address2}${town}` };
      }),
    );
    return { places: spots.filter((p): p is Place => p !== null), failed };
  } catch {
    return { places: [], failed: true };
  }
}

export async function searchPostcode(code: string): Promise<Place[]> {
  return (await lookupPostcode(code)).places;
}

/** 候補の一覧を持つ入力欄の番号（一覧の id を欄ごとに分ける）。 */
let suggestCount = 0;

/**
 * 候補の一覧を開かずに、入力欄へ焦点を移す（押した物が消えた後の焦点の行き先に使う）。
 * 欄に焦点が当たると普通は候補が開くが、他の欄を覆うので、ここでは開かない。矢印の下か文字を打てば開く。
 */
export function focusQuietly(input: HTMLInputElement): void {
  input.dataset.quiet = "1";
  try {
    input.focus();
  } finally {
    delete input.dataset.quiet;
  }
}

/** 入力欄に候補の一覧を付ける。Enter で候補を確定する。 */
export function bindSuggest(
  input: HTMLInputElement,
  onPick: (p: Place) => void,
  { offerCurrent = false, offerGenres = false, onEdit }: {
    offerCurrent?: boolean;
    offerGenres?: boolean;
    onEdit?: (value: string) => void;
  } = {},
): void {
  const field = input.parentElement as HTMLElement;
  const list = el("ul", "suggest");
  list.hidden = true;
  const listId = `suggest-${++suggestCount}`;
  list.id = listId;
  // 読み上げ・キーボードの読み取りには、入力欄を combobox、一覧を listbox として伝える（見た目と操作は変えない）。
  list.setAttribute("aria-label", input.getAttribute("aria-label") ?? "候補");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", listId);
  input.setAttribute("aria-expanded", "false");
  // 「検索しています」「見つかりません」は画面の一覧にも出るが、読み上げには status で伝える。
  const status = el("p", "sr-only");
  status.setAttribute("role", "status");
  field.append(list, status);
  const say = (text: string) => {
    if (status.textContent !== text) status.textContent = text;
  };
  /** 一覧の状態を、入力欄の属性に写す。 */
  const syncAria = () => {
    const open = !list.hidden && items.length > 0;
    input.setAttribute("aria-expanded", String(open));
    if (open && active >= 0) input.setAttribute("aria-activedescendant", `${listId}-${active}`);
    else input.removeAttribute("aria-activedescendant");
    if (open) list.setAttribute("role", "listbox");
    else list.removeAttribute("role");
  };
  let items: Place[] = [];
  let active = -1;
  let token = 0;
  let timer = 0;
  /** 外部の検索が使えなかった時の知らせ。 */
  let unavailable = false;
  /** 外部の検索の返事を待っている。 */
  let pending = false;
  let head: Place[] = [];
  let local: Place[] = [];
  /** 打った言葉。欄の中身が「現在地」の文字の時は、探す言葉ではないので空として扱う。 */
  const typed = () => {
    const value = input.value.trim();
    return value === CURRENT ? "" : value;
  };

  const close = () => {
    token++;
    list.hidden = true;
    list.classList.remove("up");
    list.style.removeProperty("top");
    pending = false;
    active = -1;
    say("");
    syncAria();
  };

  const choose = async (place: Place) => {
    close();
    if (place.name === CURRENT && place.lat === 0) {
      // 現在地を待つ間に経路の画面を開いた・閉じた時は、出発地などに入れない。
      const mode = state.mode;
      const me = await locateMe();
      if (me && state.mode === mode) onPick(me);
      return;
    }
    if (place.genre) return searchGenre(place.genre);
    remember({ ...place, genre: undefined });
    onPick(place);
  };

  /** 欄のすぐ下に出す。下に収まらず上に余裕がある時だけ、欄の上に出す。 */
  const position = () => {
    list.classList.remove("up");
    list.style.removeProperty("--room");
    list.style.removeProperty("top");
    const vv = window.visualViewport;
    const viewH = vv ? vv.height : window.innerHeight;
    const top = vv ? vv.offsetTop : 0;
    const box = field.getBoundingClientRect();
    const need = Math.min(list.scrollHeight, window.innerHeight * 0.52) + 6;
    // 下に出すと別の入力欄を覆う時は、その欄のさらに下まで下げる。
    const others = [...document.querySelectorAll<HTMLInputElement>("input")]
      .filter((o) => o !== input && o.offsetParent && !list.contains(o))
      .map((o) => o.getBoundingClientRect())
      .filter((r) => r.top >= box.bottom - 1 && r.right > box.left - 14 && r.left < box.right + 52);
    let lowest = box.bottom;
    for (let changed = true; changed; ) {
      changed = false;
      for (const r of others) {
        if (r.top < lowest + 6 + need && r.bottom > lowest) {
          lowest = r.bottom;
          changed = true;
        }
      }
    }
    const below = top + viewH - lowest - 12;
    const above = box.top - top - 12;
    if (lowest === box.bottom && need > below && above > below && above >= 120) {
      list.classList.add("up");
      list.style.setProperty("--room", `${above}px`);
      return;
    }
    if (lowest > box.bottom) list.style.top = `${lowest - box.top + 6}px`;
    list.style.setProperty("--room", `${Math.max(below, 80)}px`);
  };

  /** 焦点が当たっている欄にだけ一覧を出す。 */
  const focused = () => document.activeElement === input;

  const render = () => {
    if (!focused()) {
      list.hidden = true;
      say("");
      syncAria();
      return;
    }
    const value = typed();
    const rows = items.map((p, i) => {
      const li = el("li");
      li.setAttribute("role", "presentation");
      const button = el("button");
      button.type = "button";
      button.id = `${listId}-${i}`;
      button.tabIndex = -1;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(i === active));
      const hint = [p.kind, operatorLabel(p), p.ward].filter(Boolean).join("・");
      button.append(el("span", "", p.name), el("span", "kind", hint));
      button.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(p);
      });
      li.append(button);
      return li;
    });
    let note = "";
    if (!items.length && value && pending) {
      note = "検索しています…";
    } else if (!items.length && value) {
      // 見つからない知らせは、この一か所だけに出す（下の知らせには出さない）。
      note = unavailable
        ? "神戸市内の場所が見つかりません（住所検索は今使えませんでした。SafeWalk の検索は神戸市内のみです）"
        : "神戸市内で見つかりません（SafeWalk の検索は神戸市内のみです）";
    } else if (unavailable && value) {
      note = "住所検索は今使えないため、手元の候補だけを出しています。";
    }
    if (note) {
      // 読み上げには下の status が伝える。一覧の中の同じ文は、二重に読まれないよう隠す。
      const li = el("li", "empty", note);
      li.setAttribute("aria-hidden", "true");
      rows.push(li);
    }
    say(note);
    list.replaceChildren(...rows);
    list.hidden = rows.length === 0;
    if (!list.hidden) position();
    syncAria();
    if (active >= 0) list.querySelector(`[id="${listId}-${active}"]`)?.scrollIntoView({ block: "nearest" });
  };

  /** 手元の候補だけを今すぐ並べる。 */
  const refreshLocal = () => {
    const value = typed();
    local = searchPlaces(value);
    head = offerCurrent && !value ? [{ name: CURRENT, lat: 0, lon: 0, kind: "位置情報" }] : [];
    if (!value) head.push(...recentPlaces().map((p) => ({ ...p, kind: "最近" })));
    if (offerGenres) {
      // 「病院 夜」のように語＋条件で打った時も、先頭の語でジャンルを出す。
      const genres = matchGenres(value);
      head.push(...(genres.length ? genres : matchGenres(value.split(/[\s　]+/)[0])).map((genre) => ({ name: `${genre.label}を探す`, lat: 0, lon: 0, kind: "ジャンル", genre })));
    }
    items = [...head, ...local];
    active = -1;
    unavailable = false;
    pending = value.length >= 2;
    render();
  };

  /** 外部の検索を足す。時間切れ・失敗の時は手元の候補のまま、使えなかったことを出す。 */
  const refreshExternal = async (mine: number) => {
    const value = typed();
    if (value.length < 2) return;
    const code = postcodeOf(value);
    const lookup = code ? await lookupPostcode(code) : await lookupAddress(value);
    if (mine !== token) return;
    pending = false;
    // 施設名で引いた住所検索の結果が、すでに出ている場所と同じ物なら省く（「王子動物園」が二重に出る）。
    const names = local.map((p) => normalize(p.name));
    const addresses = lookup.places.filter((a) => {
      const n = normalize(a.name);
      return !names.some((x) => n.includes(x) || x.includes(n));
    });
    items = [...head, ...local, ...addresses].slice(0, 9);
    unavailable = lookup.failed;
    render();
  };

  const refresh = async () => {
    const mine = ++token;
    refreshLocal();
    await refreshExternal(mine);
  };

  input.addEventListener("input", () => {
    onEdit?.(input.value);
    clearTimeout(timer);
    timer = window.setTimeout(refresh, 120);
  });
  input.addEventListener("focus", () => {
    // focusQuietly で移した時は、候補を開かない。
    if (input.dataset.quiet) return;
    input.select();
    refresh();
  });
  input.addEventListener("blur", () => {
    clearTimeout(timer);
    close();
  });
  const submit = async () => {
    clearTimeout(timer);
    // 何も打っていない時は何もしない。
    if (!input.value.trim()) return;
    if (active < 0) {
      // 手元に候補があれば、外部の返事を待たずに先頭で確定する。無い時だけ外部を（時間切れまで）待つ。
      const mine = ++token;
      refreshLocal();
      if (!items.length) await refreshExternal(mine);
    }
    // 見つからない時の知らせは、一覧の中に出ている。
    const pick = items[Math.max(active, 0)];
    if (pick) await choose(pick);
  };

  input.addEventListener("keydown", (e) => {
    // 日本語入力の変換を確定する Enter は、検索の確定にしない。
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      // ブラウザ標準の「Esc で入力を全部消す」を止め、一覧だけ閉じる。
      e.preventDefault();
      return close();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    // 候補が閉じている時（Esc の後・焦点を移した直後）の矢印の下は、開き直す。
    if (list.hidden) return void refresh();
    if (!items.length) return;
    active = (active + (e.key === "ArrowDown" ? 1 : items.length - 1 + (active < 0 ? 1 : 0))) % items.length;
    render();
  });
}


export function bindSearchUi(): void {
  bindSuggest(
    qInput,
    (p) => {
      clearGenre();
      showPlace(p);
      pushUrl();
    },
    { offerGenres: true },
  );
  renderChips();
  $("research").addEventListener("click", () => state.genre && searchGenre(state.genre));
}
