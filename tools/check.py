"""合わせる前の確認。基準の経路・検索・画面の操作を自動で行い、結果を一覧で出す。

使い方: npx vite build && npx vite preview --port <番号> を起動してから
  python tools/check.py http://localhost:<番号>/ > 結果.txt
基準（tools/check_baseline.txt）と差分を取り、変わった行が意図した変更だけかを確かめる。
必要: pip install playwright && playwright install chromium
"""
import sys
import urllib.parse

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4173/"
ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]

ROUTES = [
    ("三宮→神戸駅 昼", "34.6947,135.1955", "34.6797,135.1786", "day"),
    ("三宮→北野 夜", "34.6939,135.1924", "34.7000,135.1870", "night"),
    ("三宮→ハーバーランド 夜", "34.6947,135.1955", "34.6797,135.1840", "night"),
    ("須磨→舞子 昼", "34.6440,135.1130", "34.6330,135.0330", "day"),
    ("有馬→三宮 夜", "34.7985,135.2478", "34.6947,135.1955", "night"),
    ("六甲山上 夜", "34.7780,135.2630", "34.7640,135.2200", "night"),
    ("摩耶山→南麓 昼", "34.7700,135.2140", "34.7250,135.2150", "day"),
    ("市外→三宮", "34.7025,135.4959", "34.6947,135.1955", "day"),
    ("同一地点", "34.6947,135.1955", "34.6947,135.1955", "day"),
]
QUERIES = ["三宮", "三宮駅", "神戸駅", "新神戸駅", "メリケンパーク", "王子動物園", "神戸大学", "病院",
           "セブン", "スタバ", "ファミマ", "駐車場", "650-0001", "六甲山"]


def ready(pg):
    pg.wait_for_function("!document.querySelector('.ui').inert", timeout=60000)
    pg.wait_for_timeout(1000)


def main():
    errors = []
    with sync_playwright() as p:
        b = p.chromium.launch(args=ARGS)
        ctx = b.new_context(viewport={"width": 1280, "height": 800}, locale="ja-JP",
                            geolocation={"latitude": 34.6947, "longitude": 135.1955}, permissions=["geolocation"])
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(str(e)[:200]))
        pg.on("console", lambda m: errors.append(m.text[:200]) if m.type == "error" else None)

        print("■ 経路")
        for label, f, t, period in ROUTES:
            q = urllib.parse.urlencode({"from": f, "to": t, "fromName": "A", "toName": "B", "period": period})
            pg.goto(BASE + "?" + q)
            pg.wait_for_selector(".routes button,#sheet p", timeout=60000)
            pg.wait_for_timeout(800)
            rows = [x.inner_text().replace("\n", " ") for x in pg.locator(".routes button").all()]
            print(label, rows or pg.inner_text("#sheet").replace("\n", " ")[:120])

        print("■ 検索")
        pg.goto(BASE)
        ready(pg)
        for text in QUERIES:
            pg.fill("#q", text)
            pg.wait_for_timeout(1500)
            print(text, [x.inner_text().replace("\n", " ") for x in pg.locator(".suggest li").all()][:3])
        pg.keyboard.press("Escape")

        print("■ 操作")
        pg.goto(BASE)
        ready(pg)
        pg.locator("#chips .chip").nth(1).click()
        pg.wait_for_timeout(900)
        print("ジャンル結果", pg.locator(".results li").count())
        pg.locator(".results button").first.click()
        pg.wait_for_timeout(900)
        print("結果→場所", pg.locator("#sheet h2").inner_text())
        pg.go_back()
        pg.wait_for_timeout(900)
        print("戻る→一覧の件数", pg.locator(".results li").count())
        pg.goto(BASE + "?from=34.6947,135.1955&to=34.6797,135.1786&fromName=A&toName=B&period=night")
        pg.wait_for_selector(".routes button", timeout=60000)
        start = pg.locator("button:has-text('案内を始める')")
        if start.count():
            start.first.click()
            pg.wait_for_timeout(1200)
        print("案内の表示", pg.locator("#guide").is_visible() if pg.locator("#guide").count() else "なし")
        ctx.close()

        m = b.new_context(viewport={"width": 390, "height": 844}, locale="ja-JP", has_touch=True, is_mobile=True)
        pg = m.new_page()
        pg.on("pageerror", lambda e: errors.append(str(e)[:200]))
        pg.goto(BASE)
        ready(pg)
        print("■ スマホ 起動", "OK")
        b.close()
    print("■ エラー", errors)


main()
