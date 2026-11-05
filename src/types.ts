import { type LatLon } from "./graph";

/** updated = 地図の記録（OpenStreetMap）が最後に直された年。0 は不明。 */
export type PlaceInfo = { hours?: string; phone?: string; web?: string; address?: string; operator?: string; updated?: number };
export type Place = LatLon & PlaceInfo & { name: string; kind?: string; ward?: string; genre?: Genre };
export type PlaceRow = [string, number, number, string, string, string, string, string, string, string, string, number?];
export type IndexedPlace = Place & { kind: string; ward: string; n: string; y: string };
export type Genre = { label: string; kinds: string[] };
export type End = "from" | "to";
