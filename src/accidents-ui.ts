import { type GeoJSONSource, type LngLatLike } from "maplibre-gl";
import { type Route } from "./routes";
import { state, map, el, mapPadding } from "./app";
import { accidents, safety } from "./data";

export function accidentLine(i: number): string {
  const a = accidents.data;
  const year = Math.floor(a.ym[i] / 100);
  const month = a.ym[i] % 100;
  const who = a.ped[i] ? "歩行者の事故" : a.bike[i] ? "自転車の事故" : "車両の事故";
  const harm = a.dead[i] ? `死者${a.dead[i]}人` : `負傷者${a.hurt[i]}人`;
  return `${year}年${month}月 ${a.hour[i]}時台 ${who}（${harm}）`;
}

/** 事故の点は、一覧を開いている間だけ地図に出す。 */
export function showAccidents(route: Route, visible: boolean): void {
  const a = accidents.data;
  (map.getSource("accidents") as GeoJSONSource).setData({
    type: "FeatureCollection",
    features: (visible ? route.accidents : []).map((i) => ({
      type: "Feature",
      properties: { ped: a.ped[i], dead: a.dead[i] },
      geometry: { type: "Point", coordinates: [a.lon[i], a.lat[i]] },
    })),
  });
}

export function accidentDetail(route: Route): HTMLElement {
  const a = accidents.data;
  const list = route.accidents;
  const count = (test: (i: number) => boolean) => list.filter(test).length;
  const [y0, y1] = safety.cautions.accidentPeriod;
  // 他の折りたたみと見分けがつくよう、枠と色を付ける（directions.css の .accident-detail）。
  const wrap = el("details", "detail accident-detail");
  wrap.addEventListener("toggle", () => showAccidents(route, wrap.open));
  const summary = el("summary");
  summary.append(
    el("span", "", `この経路の近くの事故の記録 ${list.length}件`),
    el("small", "", `${y0}〜${y1}年・歩行者と自転車以外の事故も含む`),
  );
  wrap.append(summary);
  wrap.append(
    el(
      "p",
      "",
      `経路から30m以内、${y0}〜${y1}年の、車どうしの事故も含む全部の記録です。` +
        `内訳は、歩行者の事故${count((i) => a.ped[i] === 1)}件、自転車の事故${count((i) => a.bike[i] === 1)}件、` +
        `夜の事故${count((i) => a.night[i] === 1)}件、死亡事故${count((i) => a.dead[i] > 0)}件です。` +
        "経路の一覧の件数は、歩行者・自転車が関わる事故だけなので、これより少なくなります。",
    ),
  );
  const inPeriod = (i: number) => (a.night[i] === 1) === (state.period === "night");
  const severity = (i: number) => a.dead[i] * 100 + a.ped[i] * 10 + a.bike[i] * 2 + (inPeriod(i) ? 5 : 0);
  const items = el("ul");
  for (const i of [...list].sort((x, y) => severity(y) - severity(x)).slice(0, 5)) {
    const li = el("li");
    const button = el("button", "", accidentLine(i));
    button.type = "button";
    button.addEventListener("click", () => {
      const center: LngLatLike = [a.lon[i], a.lat[i]];
      map.flyTo({ center, zoom: 17, padding: mapPadding() });
    });
    li.append(button);
    items.append(li);
  }
  wrap.append(items);
  return wrap;
}
