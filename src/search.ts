import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import { metres, type LatLon } from "./graph";
import { $, qInput, sheet, CURRENT, GENRES, GENRE_LIMIT, state, map, markers, toast, el, mapPadding } from "./app";
import { places } from "./data";
import { formatMetres } from "./directions";
import { locateMe } from "./map-ui";
import { openState, showPlace } from "./place";
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

/** 今見ている範囲のジャンルの場所を、中心から近い順に出す。 */
export function searchGenre(genre: Genre): void {
  state.genre = genre;
  state.picked = null;
  markers.picked.remove();
  qInput.value = genre.label;
  renderChips();
  $("research").hidden = true;
  const view = map.getBounds();
  const center = map.getCenter();
  const from = { lat: center.lat, lon: center.lng };
  const ofGenre = places.filter((p) => genre.kinds.includes(p.kind));
  const inView = ofGenre.filter((p) => view.contains([p.lon, p.lat]));
  const rows = (inView.length ? inView : ofGenre)
    .slice()
    .sort((a, b) => metres(a, from) - metres(b, from))
    .slice(0, GENRE_LIMIT);
  showResultDots(rows);
  const wrap = el("div");
  wrap.append(el("h2", "sheet-title", inView.length ? `この範囲の${genre.label}` : `近くの${genre.label}（この範囲にはありません）`));
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
  if (rows.length && (!inView.length || map.getZoom() < 13)) {
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

export function renderChips(): void {
  $("chips").replaceChildren(
    ...GENRES.map((genre) => {
      const chip = el("button", "chip", genre.label);
      chip.type = "button";
      chip.setAttribute("aria-pressed", String(state.genre === genre));
      chip.addEventListener("click", () => searchGenre(genre));
      return chip;
    }),
  );
}

/** 国土地理院の住所検索。神戸市内の住所だけを採る。 */
export async function searchAddress(query: string, limit = 4): Promise<Place[]> {
  const url = `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(query)}`;
  try {
    const rows: { geometry: { coordinates: [number, number] }; properties: { title: string } }[] = await fetch(url).then(
      (r) => r.json(),
    );
    return rows
      .filter((r) => r.properties.title.includes("神戸市"))
      .slice(0, limit)
      .map((r) => ({
        name: r.properties.title,
        lat: r.geometry.coordinates[1],
        lon: r.geometry.coordinates[0],
        kind: "住所",
      }));
  } catch {
    return [];
  }
}


/**
 * 郵便番号から場所を探す。国土地理院の住所検索は郵便番号を引けないので、
 * 日本郵便の郵便番号データを返す zipcloud（https://zipcloud.ibsnet.co.jp/doc/api）で町名を調べ、
 * その町名を国土地理院の住所検索で位置にする。神戸市内の物だけを採る。
 */
export async function searchPostcode(code: string): Promise<Place[]> {
  try {
    const found: { results: { address2: string; address3: string }[] | null } = await fetch(
      `https://zipcloud.ibsnet.co.jp/api/search?zipcode=${code.replace("-", "")}`,
    ).then((r) => r.json());
    const rows = (found.results ?? []).filter((r) => r.address2.startsWith("神戸市"));
    const spots = await Promise.all(
      rows.slice(0, 3).map(async (r): Promise<Place | null> => {
        const town = /以下に掲載がない場合|一円/.test(r.address3) ? "" : r.address3.replace(/（.*$/, "");
        const text = `兵庫県${r.address2}${town}`;
        const hits = (await searchAddress(text, 20)).filter((h) => h.name.includes(`${r.address2}${town}`));
        if (!hits.length) return null;
        const lat = hits.reduce((s, h) => s + h.lat, 0) / hits.length;
        const lon = hits.reduce((s, h) => s + h.lon, 0) / hits.length;
        return { name: `〒${code} ${r.address2}${town}`, lat, lon, kind: "郵便番号", address: `兵庫県${r.address2}${town}` };
      }),
    );
    return spots.filter((p): p is Place => p !== null);
  } catch {
    return [];
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
  field.append(list);
  let items: Place[] = [];
  let active = -1;
  let token = 0;
  let timer = 0;

  const close = () => {
    token++;
    list.hidden = true;
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

  const render = () => {
    list.replaceChildren(
      ...items.map((p, i) => {
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
      }),
    );
    if (!items.length && input.value.trim()) {
      list.replaceChildren(el("li", "empty", "神戸市内で見つかりません（SafeWalk の検索は神戸市内のみです）"));
      list.hidden = false;
      return;
    }
    list.hidden = items.length === 0;
  };

  const refresh = async () => {
    const mine = ++token;
    const value = input.value.trim();
    const local = searchPlaces(value);
    const head: Place[] = offerCurrent && !value ? [{ name: CURRENT, lat: 0, lon: 0, kind: "位置情報" }] : [];
    if (!value) head.push(...recentPlaces().map((p) => ({ ...p, kind: "最近" })));
    if (offerGenres) {
      head.push(...matchGenres(value).map((genre) => ({ name: `${genre.label}を探す`, lat: 0, lon: 0, kind: "ジャンル", genre })));
    }
    items = [...head, ...local];
    active = -1;
    render();
    if (value.length < 2) return;
    const code = postcodeOf(value);
    const found = code ? await searchPostcode(code) : await searchAddress(value);
    if (mine !== token) return;
    // 施設名で引いた住所検索の結果が、すでに出ている場所と同じ物なら省く（「王子動物園」が二重に出る）。
    const names = local.map((p) => normalize(p.name));
    const addresses = found.filter((a) => {
      const n = normalize(a.name);
      return !names.some((x) => n.includes(x) || x.includes(n));
    });
    items = [...head, ...local, ...addresses].slice(0, 9);
    render();
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
  input.addEventListener("blur", close);
  const submit = async () => {
    clearTimeout(timer);
    if (active < 0) await refresh();
    const pick = items[Math.max(active, 0)];
    if (pick) await choose(pick);
    else toast(`「${input.value.trim()}」を神戸市内で見つけられませんでした。`);
  };

  input.addEventListener("keydown", (e) => {
    // 日本語入力の変換を確定する Enter は、検索の確定にしない。
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") return close();
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
