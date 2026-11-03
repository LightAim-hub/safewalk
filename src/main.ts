import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { $, searchbar, directions, map, toast } from "./app";
import { loadData } from "./data";
import { bindDirectionsUi } from "./directions";
import { bindGuideUi } from "./guide";
import { addLayers, bindMapUi } from "./map-ui";
import { bindSearchUi } from "./search";
import { applyUrl, renderPeriod, bindUrl } from "./url";


bindSearchUi();
bindMapUi();
bindDirectionsUi();
bindGuideUi();
bindUrl();

for (const form of [searchbar, directions]) form.addEventListener("submit", (e) => e.preventDefault());

// データが揃うまで操作を受けない。
const ui = document.querySelector<HTMLElement>(".ui")!;
const locateButton = $<HTMLButtonElement>("locate");
ui.inert = true;
locateButton.disabled = true;
renderPeriod();
Promise.all([loadData(), new Promise<void>((resolve) => map.on("load", () => resolve()))]).then(
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
function showLoadError(err: unknown): void {
  console.error(err);
  $("loading").hidden = true;
  $("load-error").hidden = false;
  $("reload").addEventListener("click", () => location.reload());
}
