import maplibregl, { type GeoJSONSource } from "maplibre-gl";
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
  }).map(([short, full]) => [normalize(short), normalize(full)]),
);

/** 郵便番号なら「650-0001」の形にする。 */
export function postcodeOf(text: string): string | null {
  const m = /^〒?(\d{3})[-‐‑–—−ー]?(\d{4})$/.exec(text.normalize("NFKC").replace(/\s+/g, ""));
  return m ? `${m[1]}-${m[2]}` : null;
}

/** 「神戸三宮駅」を「三宮駅」と同じに扱うため、頭の「神戸」を外した名前。 */
const withoutKobe = (name: string) => (/^神戸(?!駅|市).{2,}/.test(name) ? name.slice(2) : name);

const MAIN_OPERATORS = ["西日本旅客鉄道", "阪急電鉄", "阪神電気鉄道"];

export function searchPlaces(query: string): Place[] {
  const q = normalize(query);
  if (!q) return [];
  if (postcodeOf(q)) return [];
  const brand = ALIASES.get(q);
  const kindNamed = (kind: string) => q.length >= 2 && (normalize(kind).includes(q) || q.includes(normalize(kind)));
  const rank = (p: IndexedPlace) => {
    const name = withoutKobe(p.n);
    const key = name.startsWith(q) || !p.y.startsWith(q) ? name : p.y;
    const k = KIND_ORDER.indexOf(p.kind);
    let match = key === q ? 0 : key.startsWith(q) ? 100 : 200;
    // 略称で探した時は、略称と同じ名前の別の場所（セブンという名のカフェなど）より、正式な名前の店を上にする。
    if (brand) match = p.n.startsWith(brand) ? 0 : p.n.includes(brand) ? 100 : 300 + match;
    const minor = MINOR_KINDS.includes(p.kind) && !kindNamed(p.kind) ? 150 : 0;
    const asked = kindNamed(p.kind) ? -150 : 0;
    const main = p.kind === "駅" && MAIN_OPERATORS.some((o) => p.operator?.includes(o)) ? -0.3 : 0;
    return match + minor + asked + (k < 0 ? 50 : k) + key.length / 100 + main;
  };
  const seen = new Set<string>();
  return places
    .filter((p) => (p.n.includes(q) || p.y.includes(q) || (brand && p.n.includes(brand))))
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

export function recentPlaces(): Place[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as Place[];
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

export interface Lookup {
  places: Place[];
  /** 時間切れ・通信の失敗で、外部の検索が使えなかった。 */
  failed: boolean;
}

/** 国土地理院の住所検索。神戸市内の住所だけを採る。時間切れや失敗は failed で知らせる。 */
export async function lookupAddress(
  query: string,
  limit = 4,
  signal: AbortSignal = AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
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
  signal: AbortSignal = AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
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
  field.append(list);
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

  const close = () => {
    token++;
    list.hidden = true;
    list.classList.remove("up");
    list.style.removeProperty("top");
    pending = false;
    active = -1;
  };

  const choose = async (place: Place) => {
    close();
    if (place.name === CURRENT && place.lat === 0) {
      const me = await locateMe();
      if (me) onPick(me);
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
      return;
    }
    const value = input.value.trim();
    const rows = items.map((p, i) => {
      const li = el("li");
      const button = el("button");
      button.type = "button";
      button.setAttribute("aria-selected", String(i === active));
      const hint = [p.kind, p.operator, p.ward].filter(Boolean).join("・");
      button.append(el("span", "", p.name), el("span", "kind", hint));
      button.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(p);
      });
      li.append(button);
      return li;
    });
    if (!items.length && value && pending) {
      rows.push(el("li", "empty", "検索しています…"));
    } else if (!items.length && value) {
      // 見つからない知らせは、この一か所だけに出す（下の知らせには出さない）。
      rows.push(
        el(
          "li",
          "empty",
          unavailable
            ? "神戸市内の場所が見つかりません（住所検索は今使えませんでした。SafeWalk の検索は神戸市内のみです）"
            : "神戸市内で見つかりません（SafeWalk の検索は神戸市内のみです）",
        ),
      );
    } else if (unavailable && value) {
      rows.push(el("li", "empty", "住所検索は今使えないため、手元の候補だけを出しています。"));
    }
    list.replaceChildren(...rows);
    list.hidden = rows.length === 0;
    if (!list.hidden) position();
  };

  /** 手元の候補だけを今すぐ並べる。 */
  const refreshLocal = () => {
    const value = input.value.trim();
    local = searchPlaces(value);
    head = offerCurrent && !value ? [{ name: CURRENT, lat: 0, lon: 0, kind: "位置情報" }] : [];
    if (!value) head.push(...recentPlaces().map((p) => ({ ...p, kind: "最近" })));
    if (offerGenres) {
      head.push(...matchGenres(value).map((genre) => ({ name: `${genre.label}を探す`, lat: 0, lon: 0, kind: "ジャンル", genre })));
    }
    items = [...head, ...local];
    active = -1;
    unavailable = false;
    pending = value.length >= 2;
    render();
  };

  /** 外部の検索を足す。時間切れ・失敗の時は手元の候補のまま、使えなかったことを出す。 */
  const refreshExternal = async (mine: number) => {
    const value = input.value.trim();
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
