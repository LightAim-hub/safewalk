import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { defineConfig, type Plugin } from "vite";

/** フォルダの中の全ファイルを、dist からの相対の道(/区切り)で返す。 */
function walk(dir: string, root = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full, root) : [relative(root, full).split(sep).join("/")];
  });
}

/**
 * 電波が弱い・無い時の備え。build の最後に dist/sw.js の雛形(public/sw.js)へ、
 * 版の名前(中身のハッシュ)と、端末に残すファイルの一覧を差し込む。
 * アプリ(app)とデータ(data)の版を別にして、アプリだけの更新で約18MBのデータを入れ直さないようにする。
 */
function serviceWorker(): Plugin {
  let outDir = "dist";
  return {
    name: "safewalk-service-worker",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle: {
      order: "post",
      handler() {
        const files = walk(outDir).filter((f) => f !== "sw.js");
        // graph.ids.bin はアプリが読まない(pipeline の検証用)ので残さない。
        // 住居表示（何番何号）の位置は区ごとに約1MBあり、号まで入れて探した時に、その区の分だけを読む。端末に先に残さない。
        const data = files.filter((f) => f.startsWith("data/") && f !== "data/graph.ids.bin" && !f.startsWith("data/jusho/")).sort();
        const app = files.filter((f) => !f.startsWith("data/")).sort();
        const hash = (list: string[]) => {
          const h = createHash("sha256");
          for (const f of list) h.update(f).update(readFileSync(join(outDir, f)));
          return h.digest("hex").slice(0, 12);
        };
        const swPath = join(outDir, "sw.js");
        const body = readFileSync(swPath, "utf8")
          .replace("__APP_VERSION__", hash(app))
          .replace("__DATA_VERSION__", hash(data))
          .replace("/*__APP_FILES__*/ []", () => JSON.stringify(["./", ...app]))
          .replace("/*__DATA_FILES__*/ []", () => JSON.stringify(data));
        writeFileSync(swPath, body);
      },
    },
  };
}

// GitHub Pages の /safewalk/ でも動くよう、読み込みを相対の場所にする。
export default defineConfig({ base: "./", plugins: [serviceWorker()] });
