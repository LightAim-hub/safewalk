/**
 * 昼夜の既定を、端末の時刻・時間帯ではなく日本時間（Asia/Tokyo, UTC+9）と、神戸の日の入り・日の出で決める。
 *
 * 日の入り・日の出の計算は NOAA（米国海洋大気庁）の Solar Calculator の式
 * （https://gml.noaa.gov/grad/solcalc/calcdetails.html ・ Meeus "Astronomical Algorithms" に基づく近似）。
 * 太陽の見かけの中心が地平線の下 0.833 度（大気差と太陽の半径）に来る時を日の出・日の入りとする。誤差は数分。
 */
export const KOBE_LAT = 34.69;
export const KOBE_LON = 135.19;
const JST_OFFSET_MIN = 540;
const MS_PER_MIN = 60_000;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** 日本時間の暦（年・月・日・時・分）。端末のタイムゾーンに依らない。 */
export function jstParts(now: Date = new Date()) {
  const t = new Date(now.getTime() + JST_OFFSET_MIN * MS_PER_MIN);
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    weekday: t.getUTCDay(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
  };
}

/** 日本時間のその日の、日の出・日の入り（日本時間の0時からの分）。 */
export function sunTimes(year: number, month: number, day: number): { sunrise: number; sunset: number } {
  const doy = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86_400_000) + 1;
  const days = (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 366 : 365;
  const g = ((2 * Math.PI) / days) * (doy - 1 + (12 - 12) / 24); // 正午（UTC）の年角
  const eqTime =
    229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const cosHa = Math.cos(rad(90.833)) / (Math.cos(rad(KOBE_LAT)) * Math.cos(decl)) - Math.tan(rad(KOBE_LAT)) * Math.tan(decl);
  const ha = (Math.acos(Math.max(-1, Math.min(1, cosHa))) * 180) / Math.PI;
  const noonUtc = 720 - 4 * KOBE_LON - eqTime;
  return { sunrise: noonUtc - 4 * ha + JST_OFFSET_MIN, sunset: noonUtc + 4 * ha + JST_OFFSET_MIN };
}

/** 神戸の日の入り後〜日の出前なら "night"。 */
export function periodNow(now: Date = new Date()): "day" | "night" {
  const p = jstParts(now);
  const { sunrise, sunset } = sunTimes(p.year, p.month, p.day);
  const clock = p.hour * 60 + p.minute;
  return clock < sunrise || clock >= sunset ? "night" : "day";
}
