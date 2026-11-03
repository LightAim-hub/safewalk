/* SafeWalk の Service Worker。
 * 本物の中身は `vite build` が dist/sw.js に書き出す（版の名前と、残すファイルの一覧を差し込む）。
 * この public/sw.js は雛形で、開発中(vite dev)は登録しないので動かない。
 *
 * 方針
 *  - アプリ本体(app)と道のデータ(data)は、版ごとの名前の入れ物に残す。版が変わったら新しい版を入れ、古い入れ物は消す。
 *    ページ・assets・データは同じ版の組で返す（新しい画面と古いデータが混ざらない）。
 *  - 更新は、起動のたびに sw.js が変わっていないか確かめる。変わっていれば裏で入れ、次の起動から切り替わる。
 *  - 地図のタイルは見た所だけ、数に上限を付けて残し、古い物から消す。
 *  - 外部の API（逆ジオコーダー・住所検索・zipcloud・Claude の中継）はここでは扱わず、残さない。
 */
const APP_VERSION = "__APP_VERSION__";
const DATA_VERSION = "__DATA_VERSION__";
const APP_FILES = /*__APP_FILES__*/ [];
const DATA_FILES = /*__DATA_FILES__*/ [];

const APP_CACHE = "safewalk-app-" + APP_VERSION;
const DATA_CACHE = "safewalk-data-" + DATA_VERSION;
const TILE_CACHE = "safewalk-tiles-v1";
const GSI_CACHE = "safewalk-gsi-v1";
const MAP_CACHE = "safewalk-mapfiles-v1";
/** 残すタイルの数の上限(古い物から消す)。ベクタタイル約 50〜100KB・航空写真約 20〜30KB として、合計で数十MBに収める。 */
const LIMITS = { [TILE_CACHE]: 400, [GSI_CACHE]: 150, [MAP_CACHE]: 200 };
const NETWORK_TIMEOUT_MS = 4000;

const SCOPE = self.registration.scope;
const abs = (p) => new URL(p, SCOPE).href;
const OWN_PREFIX = "safewalk-";

async function precache(name, files) {
  const cache = await caches.open(name);
  // 版の名前が同じ入れ物でも途中で止まって欠けていることがあるので、無い物だけ足す。
  await Promise.all(
    files.map(async (f) => {
      const url = abs(f);
      if (await cache.match(url)) return;
      const res = await fetch(new Request(url, { cache: "no-cache" }));
      if (!res.ok) throw new Error(url + " " + res.status);
      await cache.put(url, res);
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      // 1つでも欠けたらこの版は有効にならず、前の版が使われ続ける(次の起動でもう一度入れ直す)。
      await precache(APP_CACHE, APP_FILES);
      await precache(DATA_CACHE, DATA_FILES);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([APP_CACHE, DATA_CACHE, TILE_CACHE, GSI_CACHE, MAP_CACHE]);
      for (const k of await caches.keys()) if (k.startsWith(OWN_PREFIX) && !keep.has(k)) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

/** 古い物から消して上限に収める(cache.keys() は入れた順)。 */
async function trim(name) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  const over = keys.length - LIMITS[name];
  for (let i = 0; i < over; i++) await cache.delete(keys[i]);
}

async function put(name, req, res) {
  if (!res || !res.ok || res.type === "opaque") return;
  try {
    const cache = await caches.open(name);
    await cache.put(req, res);
    await trim(name);
  } catch {
    // 容量不足などで残せなくても、画面には影響させない。
  }
}

function networkWithTimeout(req) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), NETWORK_TIMEOUT_MS);
  return fetch(req, { signal: ctl.signal }).finally(() => clearTimeout(t));
}

/** 入れ物にあればそれを返す。無ければ通信し、残す。 */
async function cacheFirst(name, req) {
  const hit = await caches.match(req, { cacheName: name });
  if (hit) return hit;
  const res = await fetch(req);
  put(name, req, res.clone());
  return res;
}

/** 通信を優先し、遅い・つながらない時は残した物を返す。 */
async function networkFirst(name, req) {
  try {
    const res = await networkWithTimeout(req);
    put(name, req, res.clone());
    return res;
  } catch (err) {
    const hit = await caches.match(req, { cacheName: name });
    if (hit) return hit;
    throw err;
  }
}

async function sameOrigin(req, url) {
  // ページの移動は、いつも同じ版の index.html を返す(?や#が付いていても)。
  if (req.mode === "navigate") {
    const target = url.pathname.endsWith("/safety.html") ? abs("safety.html") : abs("./");
    const page = await caches.match(target, { cacheName: APP_CACHE, ignoreSearch: true });
    return page || fetch(req);
  }
  for (const name of [APP_CACHE, DATA_CACHE]) {
    const hit = await caches.match(req, { cacheName: name, ignoreSearch: true });
    if (hit) return hit;
  }
  return fetch(req);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (!url.href.startsWith(SCOPE) || url.pathname.endsWith("/sw.js")) return;
    event.respondWith(sameOrigin(req, url));
    return;
  }
  // 地図の配信元だけ残す。それ以外(住所検索・逆ジオコーダー・zipcloud・Claude の中継)は素通しで、残さない。
  if (url.hostname === "tiles.openfreemap.org") {
    // タイル(…/z/x/y)は変わらないので入れ物を先に。様式・TileJSON・文字・アイコンは通信を先にして、つながらない時だけ残した物を使う。
    const isTile = /\/\d+\/\d+\/\d+(\.[a-z]+)?$/.test(url.pathname) && !url.pathname.includes("/fonts/");
    event.respondWith(isTile ? cacheFirst(TILE_CACHE, req) : networkFirst(MAP_CACHE, req));
  } else if (url.hostname === "cyberjapandata.gsi.go.jp" && url.pathname.startsWith("/xyz/")) {
    event.respondWith(cacheFirst(GSI_CACHE, req));
  }
});
