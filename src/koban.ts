/**
 * 近くの交番・警察署・駐在所。public/data/koban.json(pipeline/04_koban.py)を読んで、地点に近い順に返す。
 * 出典: 兵庫県警察「警察署・交番・駐在所の所在地」(兵庫県オープンデータカタログ、CC BY 2.1 JP)。座標は国土地理院の住所検索。
 */
import { metres, type LatLon } from "./graph";

export type Koban = {
  name: string;
  kind: string;
  lat: number;
  lon: number;
  /** 住所から座標にした時の一致。「丁目」は位置が数十〜数百mずれうる。 */
  level: "番" | "丁目";
};
export type KobanHit = Koban & { metres: number; open24: boolean };

type Row = [string, string, number, number, string];

/** 24時間人がいると記録されているのは警察署だけ(交番・駐在所は勤務員が不在の時間がある)。 */
export const isOpen24 = (k: Pick<Koban, "kind">) => k.kind === "警察署";

export function nearestFrom(list: Koban[], p: LatLon, n: number): KobanHit[] {
  return list
    .map((k) => ({ ...k, metres: metres(p, k), open24: isOpen24(k) }))
    .sort((a, b) => a.metres - b.metres)
    .slice(0, n);
}

let cache: Promise<Koban[]> | null = null;

function load(): Promise<Koban[]> {
  cache ??= fetch(new URL("data/koban.json", document.baseURI).href)
    .then((r) => (r.ok ? (r.json() as Promise<Row[]>) : Promise.reject(new Error(String(r.status)))))
    .then((rows) => rows.map(([name, kind, lat, lon, level]) => ({ name, kind, lat, lon, level: level === "丁目" ? "丁目" : "番" }) as Koban))
    .catch(() => {
      cache = null;
      return [];
    });
  return cache;
}

/** p に近い交番などを n か所(近い順)。読み込めなかった時は空。 */
export async function nearestKoban(p: LatLon, n: number): Promise<KobanHit[]> {
  return nearestFrom(await load(), p, n);
}
