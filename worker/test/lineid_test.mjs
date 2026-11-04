// 回線の見分けの値が、鍵なしでは戻せないことを確かめる（実行: node worker/test/lineid_test.mjs）。
import { createHash } from "node:crypto";
import { lineId, usableKey } from "../src/lineid.ts";

let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + detail}`);
  if (!cond) failed++;
};
const key = "test-key-" + "x".repeat(40);
const ip = "203.0.113.77";
const id = await lineId(ip, key);
check("同じ回線・同じ鍵なら同じ値", id === (await lineId(ip, key)));
check("鍵が違えば別の値", id !== (await lineId(ip, key + "y")));
// 鍵を知らない人の総当たり: 鍵なしの SHA-256 で同じ /24 の256通りを試しても、一致しない。
const plain = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
let hit = null;
for (let i = 0; i < 256; i++) if (plain(`203.0.113.${i}`) === id) hit = i;
check("鍵なしの総当たりでは元の回線に戻らない（/24 の256通り）", hit === null, String(hit));
// 前の作り（鍵なし）なら戻せてしまったことも確かめる。
let old = null;
for (let i = 0; i < 256; i++) if (plain(`203.0.113.${i}`) === plain(ip)) old = i;
check("（比べ）鍵なしの作りは総当たりで戻せた", old === 77);
check("短い鍵は使わない", !usableKey("short") && usableKey("a".repeat(32)));
console.log(failed ? `\n${failed} 件失敗` : "\n全て通りました");
process.exit(failed ? 1 : 0);
