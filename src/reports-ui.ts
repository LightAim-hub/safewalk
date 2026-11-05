/**
 * 利用者による「道の状態」の投稿の画面（地図の印・投稿の窓・「違う」）。
 * 事故の記録とは色と言葉を分け、「利用者の投稿（確かめていません）」と必ず書く。経路の段階・重みには使わない。
 */
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import { map, toast, el } from "./app";
import { REPORT_KINDS, REPORT_LABEL, REPORT_MAX_AGE_DAYS, REPORT_SOURCE, type Report, type ReportKind } from "./reports";
/** 削除の依頼の窓口（GitHub の Issue）。 */
export const REPORT_REMOVAL_URL = "https://github.com/LightAim-hub/safewalk/issues/new?title=%E6%8A%95%E7%A8%BF%E3%81%AE%E5%89%8A%E9%99%A4%E3%81%AE%E4%BE%9D%E9%A0%BC";

// 相談の中継と同じ Worker の受け口(agent.ts の AGENT_ENDPOINT と同じ場所)。
const REPORTS_URL = "https://safewalk-claude.matomaru-yotei.workers.dev/api/reports";
/** 事故の記録（赤・橙）と分ける色。 */
export const REPORT_COLOR = "#6a3fb5";

let reports: Report[] = [];
let loaded = false;
/** 読み込めていない時は null（Claude に「投稿は無い」と言わせないため）。 */
export const getReports = (): readonly Report[] | null => (loaded ? reports : null);

/** 投稿を読み直して、地図の印を描き直す。読めなくても、アプリの動きには関わらない。 */
export async function loadReports(): Promise<void> {
  try {
    const res = await fetch(REPORTS_URL, { cache: "no-store" });
    if (!res.ok) return;
    const rows = (await res.json()) as Report[];
    const since = Date.now() - REPORT_MAX_AGE_DAYS * 86400_000;
    reports = rows.filter((r) => REPORT_KINDS.includes(r.kind) && r.last >= since - 86400_000);
    loaded = true;
    draw();
  } catch {
    /* 投稿を出せないだけ */
  }
}

function draw(): void {
  const src = map.getSource("reports") as GeoJSONSource | undefined;
  if (!src) return;
  // 中継が場所・種類ごとにまとめて返すので、1件を1つの印にする。
  src.setData({
    type: "FeatureCollection",
    features: reports.map((r) => ({
      type: "Feature",
      properties: { kind: r.kind, count: r.count, latest: r.last, lat: r.lat, lon: r.lon },
      geometry: { type: "Point", coordinates: [r.lon, r.lat] },
    })),
  });
}

export function addReportLayers(): void {
  map.addSource("reports", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "report-dots",
    type: "circle",
    source: "reports",
    minzoom: 13,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "count"], 1, 5, 5, 8],
      "circle-color": REPORT_COLOR,
      "circle-opacity": 0.85,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.5,
    },
  });
  void loadReports();
}

const dateText = (ts: number) => {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};

let popup: maplibregl.Popup | null = null;

/** 地図の印を押した時。種類・件数・日付と、「違う」を出す。 */
export function showReportPopup(f: maplibregl.MapGeoJSONFeature): void {
  const p = f.properties as { kind: ReportKind; count: number; latest: number; lat: number; lon: number };
  const box = el("div", "report-pop");
  box.append(
    el("p", "report-src", REPORT_SOURCE),
    el("strong", "", REPORT_LABEL[p.kind] ?? ""),
    el("p", "", `この場所の投稿 ${p.count}件・最後は${dateText(Number(p.latest))}`),
  );
  const no = el("button", "secondary", "違う（今はこうではない）");
  no.type = "button";
  no.addEventListener("click", async () => {
    no.disabled = true;
    try {
      const r = await fetch(`${REPORTS_URL}/dispute`, { method: "POST", body: JSON.stringify({ lat: Number(p.lat), lon: Number(p.lon), kind: p.kind }), headers: { "content-type": "text/plain" } });
      if (r.status === 429) {
        toast("今日の「違う」の上限に達しました");
        return void popup?.remove();
      }
      if (!r.ok) throw new Error("dispute");
      toast("知らせました。「違う」が投稿の数より多くなると、出さなくなります（1分ほどで反映）");
      void loadReports();
    } catch {
      toast("今は送れませんでした");
    }
    popup?.remove();
  });
  const removal = el("a", "report-removal", "削除の依頼");
  removal.href = REPORT_REMOVAL_URL;
  removal.target = "_blank";
  removal.rel = "noopener";
  box.append(no, removal);
  const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
  popup?.remove();
  popup = new maplibregl.Popup({ closeButton: true, maxWidth: "260px" }).setLngLat([lon, lat]).setDOMContent(box).addTo(map);
  no.focus({ preventScroll: true });
}

/** この場所の道の状態を投稿する窓。決まった5つから選ぶだけ（自由に書く欄は無い）。 */
export function openReportDialog(at: { lat: number; lon: number }, opener?: HTMLElement): void {
  document.getElementById("report-dialog")?.remove();
  const back = el("div", "confirm-back");
  back.id = "report-dialog";
  const box = el("div", "card confirm");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-labelledby", "report-title");
  const title = el("h3", "", "この場所の道の状態を投稿");
  title.id = "report-title";
  const note = el(
    "p",
    "menu-note",
    "この投稿は地図の上に公開されます。自宅など、個人の場所が分かる所からは書き込まないでください。決まった選択肢だけを選べます。事件・事故・人については書けません。場所はいちばん近い道の上に寄せ、地図には日付までを出します。",
  );
  const list = el("div", "report-kinds");
  const close = () => {
    back.remove();
    if (opener?.isConnected) opener.focus();
  };
  for (const kind of REPORT_KINDS) {
    const b = el("button", "secondary", REPORT_LABEL[kind]);
    b.type = "button";
    b.addEventListener("click", async () => {
      list.querySelectorAll("button").forEach((x) => ((x as HTMLButtonElement).disabled = true));
      try {
        const res = await fetch(REPORTS_URL, { method: "POST", body: JSON.stringify({ lat: at.lat, lon: at.lon, kind }), headers: { "content-type": "text/plain" } });
        if (res.status === 429) toast("今日の投稿の上限に達しました。明日またお願いします");
        else if (res.status === 400) toast("この場所には投稿できませんでした（神戸市の中だけです）");
        else if (!res.ok) toast("今は投稿できませんでした。少し置いてからお試しください");
        else {
          toast(map.getZoom() < 13 ? "投稿しました。1分ほどで、地図を拡大すると紫の印で出ます" : "投稿しました。1分ほどで、確かめていない情報として地図に出ます");
          window.setTimeout(() => void loadReports(), 65000);
        }
      } catch {
        toast("今は投稿できませんでした。電波を確かめてください");
      }
      close();
    });
    list.append(b);
  }
  const cancel = el("button", "plain", "やめる");
  cancel.type = "button";
  cancel.addEventListener("click", close);
  back.addEventListener("click", (e) => {
    if (e.target === back) close();
  });
  back.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "Tab") {
      // 窓の中だけで焦点を回す（後ろの画面へ抜けない）。
      const items = [...box.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      e.preventDefault();
      items[(i + (e.shiftKey ? items.length - 1 : 1)) % items.length]?.focus();
    }
  });
  box.append(title, note, list, cancel);
  back.append(box);
  document.body.append(back);
  (list.querySelector("button") as HTMLButtonElement | null)?.focus();
}
