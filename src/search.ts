import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import { metres, type LatLon } from "./graph";
import { $, qInput, sheet, CURRENT, GENRES, GENRE_LIMIT, state, map, markers, toast, el, mapPadding } from "./app";
import { places } from "./data";
import { formatMetres } from "./directions";
import { locateMe } from "./map-ui";
import { openState, showPlace } from "./place";
import { type Place, type IndexedPlace, type Genre } from "./types";
import { pushUrl } from "./url";

/** 全角半角と大小を揃え、カタカナはひらがなに寄せて比べる。 */
export const normalize = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
export const KIND_ORDER = ["駅", "地区", "名所", "商業施設", "百貨店", "公園", "大学", "病院", "役所", "博物館", "動物園"];

export function searchPlaces(query: string): Place[] {
  const q = normalize(query);
  if (!q) return [];
  const rank = (name: string, kind: string) => {
    const k = KIND_ORDER.indexOf(kind);
    const match = name === q ? 0 : name.startsWith(q) ? 100 : 200;
    return match + (k < 0 ? 50 : k) + name.length / 100;
  };
  const sortKey = (p: IndexedPlace) => (p.n.startsWith(q) || !p.y.startsWith(q) ? p.n : p.y);
  const seen = new Set<string>();
  return places
    .filter((p) => p.n.includes(q) || p.y.includes(q))
    .sort((a, b) => rank(sortKey(a), a.kind) - rank(sortKey(b), b.kind))
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
export async function searchAddress(query: string): Promise<Place[]> {
  const url = `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(query)}`;
  try {
    const rows: { geometry: { coordinates: [number, number] }; properties: { title: string } }[] = await fetch(url).then(
      (r) => r.json(),
    );
    return rows
      .filter((r) => r.properties.title.includes("神戸市"))
      .slice(0, 4)
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
    const addresses = await searchAddress(value);
    if (mine !== token) return;
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
