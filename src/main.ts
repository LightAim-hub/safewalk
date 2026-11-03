import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { $, searchbar, directions, map, toast } from "./app";
import { loadData } from "./data";
import { bindDirectionsUi } from "./directions";
import { bindGuideUi } from "./guide";
import { addLayers, bindMapUi } from "./map-ui";
import { bindMenu } from "./menu";
import { bindOnboarding } from "./onboarding";
import { bindSearchUi } from "./search";
import { applyUrl, renderPeriod, bindUrl, listenHistory } from "./url";


bindSearchUi();
bindMapUi();
bindDirectionsUi();
bindGuideUi();
bindUrl();
bindOnboarding();
bindMenu();

for (const form of [searchbar, directions]) form.addEventListener("submit", (e) => e.preventDefault());

// データが揃うまで操作を受けない。
const ui = document.querySelector<HTMLElement>(".ui")!;
const locateButton = $<HTMLButtonElement>("locate");
ui.inert = true;
locateButton.disabled = true;
renderPeriod();
// 地図の配信元が落ちても、読み込み中のまま固まらないよう、エラーと時間切れで失敗の画面に切り替える。
const LOAD_LIMIT_MS = 15000;
const mapReady = new Promise<void>((resolve, reject) => {
  map.on("load", () => resolve());
  map.on("error", (e) => {
    // 読み込み前に、地図の様式(style)が読めなかった時だけ失敗とする。個々のタイルの失敗では止めない。
    // タイルの失敗には sourceId が付く。それは様式の失敗として扱わない。
    if (!("sourceId" in e && e.sourceId) && !map.isStyleLoaded()) reject(e.error ?? new Error("地図を読み込めません"));
  });
  setTimeout(() => reject(new Error("地図の読み込みに時間がかかっています")), LOAD_LIMIT_MS);
});
Promise.all([loadData(), mapReady]).then(
  () => {
    try {
      addLayers();
      ui.inert = false;
      locateButton.disabled = false;
      $("loading").hidden = true;
    } catch (err) {
      showLoadError(err);
      return;
    }
    // 共有された URL が壊れていても、データの失敗とは別に扱い、通常の起動に戻す。
    listenHistory();
    try {
      applyUrl();
    } catch (err) {
      console.error(err);
      history.replaceState(null, "", location.pathname);
      toast("共有された地点を読めませんでした。");
    }
  },
  showLoadError,
);

/** データが読めなかった時は、知らせが消えた後も案内とボタンを画面に残す。 */
let loadFailed = false;
function showLoadError(err: unknown): void {
  console.error(err);
  if (loadFailed) return;
  loadFailed = true;
  $("loading").hidden = true;
  $("load-error").hidden = false;
  $("reload").addEventListener("click", () => location.reload());
}
