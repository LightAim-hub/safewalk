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
Promise.all([loadData(), new Promise<void>((resolve) => map.on("load", () => resolve()))])
  .then(() => {
    addLayers();
    ui.inert = false;
    locateButton.disabled = false;
    $("loading").hidden = true;
    applyUrl();
  })
  .catch((err) => {
    console.error(err);
    $("loading").hidden = true;
    toast("データの読み込みに失敗しました。再読み込みしてください。");
  });
