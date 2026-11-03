import { type LatLon } from "./graph";

export type PlaceInfo = { hours?: string; phone?: string; web?: string; address?: string; operator?: string };
export type Place = LatLon & PlaceInfo & { name: string; kind?: string; ward?: string; genre?: Genre };
export type PlaceRow = [string, number, number, string, string, string, string, string, string, string, string];
export type IndexedPlace = Place & { kind: string; ward: string; n: string; y: string };
export type Genre = { label: string; kinds: string[] };
export type End = "from" | "to";
