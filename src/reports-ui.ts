/**
 * 利用者による「道の状態」の投稿の画面（地図の印・投稿の窓・「違う」）。
 * 事故の記録とは色と言葉を分け、「利用者の投稿（確かめていません）」と必ず書く。経路の段階・重みには使わない。
 */
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import { map, toast, el } from "./app";
import { REPORT_KINDS, REPORT_LABEL, REPORT_MAX_AGE_DAYS, REPORT_SOURCE, type Report, type ReportKind } from "./reports";
import { track } from "./telemetry";

// 相談の中継と同じ Worker の受け口(agent.ts の AGENT_ENDPOINT と同じ場所)。
const REPORTS_URL = "https://safewalk-claude.matomaru-yotei.workers.dev/api/reports";
/** 事故の記録（赤・橙）と分ける色。 */
export const REPORT_COLOR = "#6a3fb5";

let reports: Report[] = [];
export const getReports = (): readonly Report[] => reports;

/** 投稿を読み直して、地図の印を描き直す。読めなくても、アプリの動きには関わらない。 */
export async function loadReports(): Promise<void> {
  try {
    const res = await fetch(REPORTS_URL, { cache: "no-store" });
    if (!res.ok) return;
    const rows = (await res.json()) as Report[];
    const since = Date.now() - REPORT_MAX_AGE_DAYS * 86400_000;
    reports = rows.filter((r) => REPORT_KINDS.includes(r.kind) && r.ts >= since);
    draw();
  } catch {
    /* 投稿を出せないだけ */
  }
}

function draw(): void {
  const src = map.getSource("reports") as GeoJSONSource | undefined;
  if (!src) return;
  // 同じ場所(丸めた座標)・同じ種類は1つの印にまとめ、件数を持たせる。
  const groups = new Map<string, Report[]>();
  for (const r of reports) {
    const k = `${r.lat.toFixed(4)},${r.lon.toFixed(4)},${r.kind}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  src.setData({
    type: "FeatureCollection",
    features: [...groups.values()].map((g) => ({
      type: "Feature",
      properties: { ids: g.map((r) => r.id).join(","), kind: g[0].kind, count: g.length, latest: Math.max(...g.map((r) => r.ts)) },
      geometry: { type: "Point", coordinates: [g[0].lon, g[0].lat] },
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
  const p = f.properties as { ids: string; kind: ReportKind; count: number; latest: number };
  const ids = String(p.ids).split(",");
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
      await Promise.all(ids.map((id) => fetch(`${REPORTS_URL}/dispute`, { method: "POST", body: JSON.stringify({ id }), headers: { "content-type": "text/plain" } })));
      toast("知らせました。「違う」が重なった投稿は出さなくなります");
      track("report_dispute");
    } catch {
      toast("今は送れませんでした");
    }
    popup?.remove();
  });
  box.append(no);
  const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
  popup?.remove();
  popup = new maplibregl.Popup({ closeButton: true, maxWidth: "260px" }).setLngLat([lon, lat]).setDOMContent(box).addTo(map);
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
    "決まった選択肢だけを選べます。事件・事故・人については書けません。残すのは、場所（約10m単位）・種類・日時だけで、投稿した人は残しません。ほかの人には「利用者の投稿（確かめていません）」として見えます。",
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
        else if (!res.ok) toast("この場所には投稿できませんでした（神戸市の中だけです）");
        else {
          toast("投稿しました。確かめていない情報として地図に出ます");
          track("report_add", kind);
          void loadReports();
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
  });
  box.append(title, note, list, cancel);
  back.append(box);
  document.body.append(back);
  (list.querySelector("button") as HTMLButtonElement | null)?.focus();
}
