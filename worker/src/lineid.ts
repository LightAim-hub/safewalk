/**
 * 回線(IP)を、記録に残す短い値に変える。秘密の鍵(secret IP_HASH_KEY)を混ぜた HMAC-SHA-256 の先頭 8 バイト。
 * 鍵を知らない人は、IPv4 を総当たりしても元の回線に戻せない（鍵なしの SHA-256 だと約43億通りで戻せてしまう）。
 */
export async function lineId(ip: string, key: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(ip));
  return [...new Uint8Array(sig)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 鍵として使える長さか（短い鍵は総当たりで当てられるため、32文字以上だけを使う）。 */
export const usableKey = (key: string | undefined): key is string => typeof key === "string" && key.length >= 32;
