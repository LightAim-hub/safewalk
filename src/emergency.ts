/**
 * 緊急の言葉と、災害の言葉を、画面の側で見つける。見つけたら Claude の答えより上に、固定の枠を出す。
 * 枠の文・番号は Claude を通らない(agent.ts の照合の対象外)。
 *
 * 番号の出典:
 *   110・119: 警察・消防の全国共通の番号。
 *   #7119: 神戸市の救急安心センター(#7119)のページ(https://www.city.kobe.lg.jp/a65055/bosai/kyukyuiryo/telephone.html、
 *     2026-11-03 に確認)。24時間。2025-07-11 から兵庫県全域が対象(名称は「救急安心センターひょうご」)。直通 078-331-7119。
 */
import { el } from "./app";
import { nearestKoban, type KobanHit } from "./koban";
import type { LatLon } from "./graph";
import "./emergency.css";

/** 緊急の言葉。誤検知を減らすため、普段の相談(「子どもが一人で帰る」「荷物が多い」)に出ない語だけにする。 */
export const EMERGENCY_WORDS = [
  "つけられ",
  "付けられ",
  "つけてくる",
  "つけてき",
  "尾行",
  "ストーカー",
  "追われ",
  "追われて",
  "追いかけられ",
  "追いかけてくる",
  "助けて",
  "たすけて",
  "襲われ",
  "おそわれ",
  "刺され",
  "殴られ",
  "怖い人",
  "こわい人",
  "不審者",
  "変な人",
  "倒れ",
  "意識がな",
  "意識不明",
  "息ができ",
  "息が苦し",
  "血が出",
  "出血",
  "骨折",
  "けがをし",
  "ケガをし",
  "怪我をし",
  "けがして",
  "怪我して",
  "火事",
  "燃えて",
  "煙が",
];

/** 災害の言葉。地震・津波などの避難には使えないと伝える。 */
export const DISASTER_WORDS = ["地震", "津波", "洪水", "浸水", "土砂", "崖崩れ", "がけ崩れ", "豪雨", "大雨", "台風", "高潮", "避難", "災害", "噴火"];

export const EMERGENCY_NUMBERS = ["110", "119", "7119"];

export const DISASTER_NOTICE = "地震・津波など災害の時の避難には使えません。自治体の避難情報に従ってください。";

const norm = (s: string) => s.normalize("NFKC");

export function detectEmergency(text: string): boolean {
  const t = norm(text);
  return EMERGENCY_WORDS.some((w) => t.includes(norm(w)));
}

export function detectDisaster(text: string): boolean {
  const t = norm(text);
  return DISASTER_WORDS.some((w) => t.includes(norm(w)));
}

function call(href: string, label: string, text: string): HTMLElement {
  const li = el("li");
  const a = el("a", "emg-call", label);
  a.href = href;
  li.append(a, document.createTextNode(` ${text}`));
  return li;
}

export function formatDistance(m: number): string {
  return m < 1000 ? `約${Math.max(10, Math.round(m / 10) * 10)}m` : `約${(m / 1000).toFixed(1)}km`;
}

function kobanRow(k: KobanHit, onRoute: (k: KobanHit) => void): HTMLElement {
  const li = el("li", "emg-koban");
  const info = el("div", "emg-koban-info");
  info.append(el("span", "emg-koban-name", k.name));
  const notes = [formatDistance(k.metres), k.open24 ? "24時間人がいる警察署" : `${k.kind}(人がいない時間があります)`];
  if (k.level === "丁目") notes.push("位置は目安");
  info.append(el("span", "emg-koban-note", notes.join("・")));
  const go = el("button", "secondary", "経路を出す");
  go.type = "button";
  go.setAttribute("aria-label", `${k.name}への経路を出す`);
  go.addEventListener("click", () => onRoute(k));
  li.append(info, go);
  return li;
}

/**
 * 緊急の枠。origin は今いる場所(出発地)。交番は origin に近い順に最大3つ。
 * 全体を同じ枠に入れ、番号は電話を発信するリンクにする。
 */
export function emergencyPanel(origin: LatLon | null, onRoute: (k: KobanHit) => void): HTMLElement {
  const box = el("section", "emergency");
  box.setAttribute("role", "region");
  box.setAttribute("aria-label", "緊急時の案内");
  box.append(el("h3", "", "緊急の時は、先にこちらへ"));
  const calls = el("ul", "emg-calls");
  calls.append(
    call("tel:110", "110", "身の危険を感じたら（警察）"),
    call("tel:119", "119", "急な病気・けが・火事（救急・消防）"),
    call("tel:%237119", "#7119", "迷ったら（救急安心センター・24時間）"),
  );
  box.append(calls);
  const near = el("div", "emg-near");
  box.append(near);
  if (origin) {
    near.append(el("p", "emg-hint", "近くの交番を調べています…"));
    void nearestKoban(origin, 3).then((list) => {
      if (!list.length) return near.replaceChildren(el("p", "emg-hint", "近くの交番の記録を読み込めませんでした。上の番号に電話してください。"));
      const ul = el("ul", "emg-kobans");
      ul.append(...list.map((k) => kobanRow(k, onRoute)));
      near.replaceChildren(el("h4", "", "近くの交番・警察署（出発地から近い順）"), ul, el("p", "emg-hint", "交番は人がいない時間があります。着いても誰もいないことがあります。"));
    });
  } else {
    near.append(el("p", "emg-hint", "出発地が決まると、近くの交番を出します。"));
  }
  return box;
}

export function disasterPanel(): HTMLElement {
  const box = el("section", "emergency disaster");
  box.setAttribute("role", "region");
  box.append(el("p", "emg-disaster", DISASTER_NOTICE));
  return box;
}
