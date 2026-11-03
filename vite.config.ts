import { defineConfig } from "vite";

// GitHub Pages の /safewalk/ でも動くよう、読み込みを相対の場所にする。
export default defineConfig({ base: "./" });
