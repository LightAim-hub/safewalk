"""利用者100人の使用テスト。公開版を、人ごとの端末・回線・位置・台本で順に動かして結果を出す。

使い方（1行）:  python tools/persona_test.py
  --only 5,20-30   一部の人だけ（番号。範囲も可）
  --save           結果を基準（tools/persona_baseline.json / .md）に保存する（基準が無い時は自動で保存）
  --workers 4      並列の数（既定 4）
  --url URL        試験の相手（既定は公開版）
  --shots DIR      スクショの置き場（既定は scratchpad\\persona）
基準が有る時は、前回との差分（通った人・詰まった所・システムの問題の増減）も出す。

必要: pip install playwright && playwright install chromium webkit
台本の書き方は tools/personas.json の先頭の "_steps" を参照。
画面の文字・通信・コンソールの検査は全員に毎手順で掛かる。端末は Playwright の模擬で、実機とは違う（限界は baseline.md の末尾）。
"""
import argparse
import json
import math
import multiprocessing as mp
import os
import re
import sys
import time
import urllib.parse
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
PERSONAS = HERE / "personas.json"
BASE_JSON = HERE / "persona_baseline.json"
BASE_MD = HERE / "persona_baseline.md"
DEFAULT_URL = "https://lightaim-hub.github.io/safewalk/"
DEFAULT_SHOTS = Path(r"C:\Users\paipa\AppData\Local\Temp\claude\C--Users-paipa\53140e86-2d6b-4c67-8b03-040c21293150\scratchpad\persona")
ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
DISCLAIMER = "表示は目安で、安全を保証しません"
WORDS = ["安全", "安心", "危険", "%", "％", "パーセント"]

PRESETS = {  # 名前: (出発, 到着)
    "kitano": ((34.6947, 135.1955), (34.7000, 135.1870)),
    "kobe": ((34.6947, 135.1955), (34.6797, 135.1786)),
    "harbor": ((34.6947, 135.1955), (34.6797, 135.1840)),
    "maya": ((34.7700, 135.2140), (34.7250, 135.2150)),
    "arima": ((34.7985, 135.2478), (34.6947, 135.1955)),
    "suma": ((34.6440, 135.1130), (34.6330, 135.0330)),
}
STARTS = {"sannomiya": (34.6947, 135.1955), "kobe_sta": (34.6797, 135.1786), "osaka": (34.7025, 135.4959)}


class StepFail(Exception):
    def __init__(self, cat, msg):
        super().__init__(msg)
        self.cat = cat
        self.msg = msg


def norm(s, n=140):
    s = re.sub(r"\?.*", "", str(s))
    s = re.sub(r"/\d+/\d+/\d+", "/z/x/y", s)
    s = re.sub(r"\d+", "N", s)
    return s.replace("\n", " ")[:n]


class Run:
    """1人分の実行。"""

    def __init__(self, persona, base, shots, ctx, pg):
        self.p = persona
        self.base = base
        self.shots = shots
        self.ctx = ctx
        self.pg = pg
        self.steps = []
        self.find = defaultdict(lambda: {"n": 0, "step": ""})
        self.expect = 0  # 想定した失敗の間は 1 以上
        self.slept = 0.0
        self.cur = "open"
        self.walk_i = 0
        self.t0 = None
        self.ready_sec = None
        self.notes = []
        self.claude_n = 0

    # ---- 記録
    def add(self, kind, text):
        f = self.find[(kind, text)]
        f["n"] += 1
        if not f["step"]:
            f["step"] = self.cur

    def sleep(self, ms):
        self.slept += ms / 1000
        self.pg.wait_for_timeout(ms)

    # ---- 検査
    def check_text(self):
        try:
            data = self.pg.evaluate(
                """() => {
                  const vis = document.body.innerText || '';
                  const at = [...document.querySelectorAll('[aria-label],[title],[placeholder]')]
                    .filter(e => e.offsetParent !== null || e.tagName === 'INPUT')
                    .map(e => [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('placeholder')].filter(Boolean).join(' ')).join('\\n');
                  return {vis, at};
                }"""
            )
        except Exception:
            return
        for src, text in (("画面", data["vis"]), ("属性", data["at"])):
            t = text.replace("SafeWalk", "").replace(DISCLAIMER, "")
            # 免責の文（「保証しません」「保証するものではありません」を含む一文）は除く
            t = re.sub(r"[^。\n]*保証[^。\n]*[。]?", "", t)
            for w in WORDS:
                if w in t:
                    i = t.index(w)
                    self.add("禁句", f"{w}（{src}）…{t[max(0, i - 12):i + 12].strip()}".replace("\n", " "))
        try:
            ov = self.pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
            if ov and ov > 4:
                self.add("横にはみ出す", f"{ov}px")
        except Exception:
            pass

    def tiny_and_names(self):
        try:
            res = self.pg.evaluate(
                """() => {
                  const out = {noname: [], tiny: []};
                  const sel = 'button, a[href], input, summary, [role=button]';
                  for (const e of document.querySelectorAll(sel)) {
                    const r = e.getBoundingClientRect();
                    if (!r.width || !r.height || e.closest('[hidden]') || getComputedStyle(e).visibility === 'hidden') continue;
                    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
                    const name = (e.getAttribute('aria-label') || e.textContent || e.getAttribute('title') || e.getAttribute('placeholder') || '').trim();
                    const id = (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/)[0] : '') || e.tagName.toLowerCase();
                    if (!name && !e.closest('.maplibregl-ctrl')) out.noname.push(e.tagName.toLowerCase() + id + ' ' + e.outerHTML.replace(/[ 	
]+/g, ' ').slice(0, 70));
                    if ((r.width < 32 || r.height < 32) && !e.closest('.maplibregl-ctrl') && e.tagName !== 'INPUT') out.tiny.push(id + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
                  }
                  return out;
                }"""
            )
        except Exception:
            return
        for x in res["noname"]:
            self.add("名前の無い操作部品", x)
        for x in res["tiny"]:
            self.add("小さい操作部品(32px未満)", x)

    # ---- 操作の部品
    def tap(self, loc, what, timeout=8000):
        pg = self.pg
        try:
            if loc.count() == 0:
                raise StepFail("要素が無い", f"{what}が画面に無い")
            loc.first.click(timeout=timeout)
        except StepFail:
            raise
        except Exception as e:
            m = str(e)
            if "intercepts pointer events" in m:
                raise StepFail("押せない(他の物が重なる)", f"{what}に他の物が重なって押せない")
            if "outside of the viewport" in m:
                raise StepFail("押せない(画面の外)", f"{what}が画面の外で押せない")
            if "not visible" in m or "waiting for" in m or "Timeout" in m:
                raise StepFail("見えない", f"{what}が見えない/押せる状態にならない")
            raise StepFail("操作の失敗", f"{what}: {m[:100]}")

    def text_of(self, sel, n=200):
        try:
            return self.pg.inner_text(sel, timeout=2000).replace("\n", " ")[:n]
        except Exception:
            return ""

    def wait_vis(self, sel, what, timeout=15000, cat="表示が出ない"):
        try:
            self.pg.wait_for_selector(sel, state="visible", timeout=timeout)
        except Exception:
            raise StepFail(cat, f"{what}が出ない（{self.screen_hint()}）")

    def screen_hint(self):
        t = self.text_of("#sheet", 90) or self.text_of(".suggest:not([hidden])", 90) or self.text_of("#toast", 90)
        return "画面: " + t if t else "画面の文字なし"

    def wait_ready(self, timeout):
        pg = self.pg
        end = time.time() + timeout / 1000
        reloads = 0
        while True:
            try:
                pg.wait_for_function(
                    "!document.querySelector('.ui').inert || !!document.querySelector('[aria-labelledby=intro-title]')",
                    timeout=min(20000, max(3000, int((end - time.time()) * 1000))),
                )
                if self.p.get("net") == "flaky" and self.expect > 0:
                    self.expect -= 1  # 切れた最初の読み込みが片付いた
                return
            except Exception:
                pass
            if pg.locator("#load-error").is_visible():
                if self.p.get("net") != "flaky":
                    self.add("読み込み失敗の画面", self.text_of("#load-error", 80))
                self.notes.append("読み込み失敗の画面が出た→再読み込みを押した")
                self.tap(pg.locator("#reload"), "再読み込み")
                reloads += 1
                self.sleep(1500)
                if reloads > 3:
                    raise StepFail("読み込めない", "再読み込みを3回押しても起動しない")
                continue
            if pg.locator("#load-slow").is_visible() and not any("遅い時" in n for n in self.notes):
                self.notes.append("遅い時の案内(約7MB)が出た")
            if time.time() > end:
                raise StepFail("読み込めない", f"{timeout // 1000}秒待っても起動しない（{self.text_of('#loading', 60)}）")


# ---------------------------------------------------------------- 手順

def s_open(r, arg):
    t = time.time()
    r.pg.goto(r.base, wait_until="domcontentloaded", timeout=r.tmo)
    r.wait_ready(r.tmo)
    r.ready_sec = round(time.time() - t, 1)


def s_intro_read(r, arg):
    r.wait_vis("[aria-labelledby=intro-title]", "初回の説明", 8000)
    txt = r.text_of("[aria-labelledby=intro-title]", 400)
    r.notes.append("初回説明: " + txt[:80])
    r.tap(r.pg.get_by_role("button", name="使ってみる"), "使ってみる")
    r.sleep(500)
    if r.pg.locator("[aria-labelledby=intro-title]").is_visible():
        raise StepFail("閉じない", "使ってみるを押しても説明が閉じない")
    # 初めての「使ってみる」は、すぐ経路の入力になり、目的地の欄に文字を入れられる状態になる。
    try:
        r.pg.wait_for_function("document.body.classList.contains('routing') && document.activeElement && document.activeElement.id === 'to'", timeout=15000)
    except Exception:
        raise StepFail("次の一手が無い", "使ってみるの後、目的地の欄に文字を入れられる状態にならない")
    r.notes.append("使ってみる→経路の入力（目的地の欄）")
    # この後の台本は地図の検索から始まるので、経路の入力を閉じて戻る。
    r.tap(r.pg.locator("#close-directions"), "経路を閉じる")
    r.sleep(400)


def pick_suggest(r, idx, what):
    sel = ".suggest:not([hidden]) li"
    try:
        r.pg.wait_for_selector(sel, state="visible", timeout=15000)
    except Exception:
        raise StepFail("検索で見つからない", f"{what}の候補が出ない（{r.screen_hint()}）")
    items = r.pg.locator(sel).filter(has_not_text="現在地")  # 先頭の「現在地」ではなく、打った語の候補を選ぶ
    txt = items.first.inner_text().replace("\n", " ") if items.count() else r.pg.locator(sel).first.inner_text().replace("\n", " ")
    if "見つかりません" in txt or "ありません" in txt or not items.count():
        raise StepFail("検索で見つからない", f"{what}: 『{txt[:50]}』")
    n = items.count()
    r.tap(items.nth(min(idx, n - 1)), f"{what}の候補")
    return txt


def settle(r):
    """起動の最後（データの読み込み）が終わるまで待つ。初回の説明を読んでいた人は、その間に読み込みが続いている。"""
    try:
        r.pg.wait_for_function(
            "(() => { const l = document.getElementById('loading'); return !document.querySelector('.ui').inert && (!l || l.hidden || !l.offsetParent); })()",
            timeout=r.tmo,
        )
    except Exception:
        raise StepFail("読み込めない", "画面は出たが、データの読み込みが終わらない")


def s_search(r, arg):
    settle(r)
    q, idx = (arg.split("#") + ["0"])[:2] if "#" in arg else (arg, "0")
    r.pg.fill("#q", q)
    first = pick_suggest(r, int(idx), f"『{q}』")
    r.wait_vis("#sheet h2", "場所の画面", 15000)
    r.notes.append(f"{q}→{r.text_of('#sheet h2', 30)}")


def s_kb_search(r, arg):
    settle(r)
    pg = r.pg
    for _ in range(12):
        if pg.evaluate("document.activeElement && document.activeElement.id") == "q":
            break
        pg.keyboard.press("Tab")
    else:
        raise StepFail("キーボードで届かない", "Tab で検索欄に着けない")
    pg.keyboard.type(arg, delay=40)
    try:
        pg.wait_for_selector(".suggest:not([hidden]) li", state="visible", timeout=15000)
    except Exception:
        raise StepFail("検索で見つからない", f"『{arg}』の候補が出ない")
    pg.keyboard.press("ArrowDown")
    sel = pg.evaluate("(document.querySelector('#q').getAttribute('aria-activedescendant')||'')")
    if not sel:
        r.add("キーボード:選択中の候補が読み上げに出ない", "#q に aria-activedescendant が無い")
    pg.keyboard.press("Enter")
    r.wait_vis("#sheet h2", "場所の画面", 10000)


def s_to_place(r, arg):
    if r.pg.locator("#sheet").get_by_role("button", name="経路", exact=True).count() == 0 and r.pg.locator(".results button").count():
        # 「コンビニ」「トイレ」のような種類の語は一覧が出る。人は一覧の先頭を押して場所を開く。
        r.notes.append("種類の語で一覧が出たので先頭を選んだ")
        r.tap(r.pg.locator(".results button"), "一覧の先頭")
        r.wait_vis("#sheet h2", "場所の画面", 10000)
    r.tap(r.pg.locator("#sheet").get_by_role("button", name="経路", exact=True), "経路ボタン")
    r.wait_vis("#directions", "経路の入力欄", 10000)
    r.sleep(1200)


def expand_dir(r):
    s = r.pg.locator("#dir-summary")
    if s.is_visible() and s.get_attribute("aria-expanded") == "false":
        r.tap(s, "経路の入力欄を開く")
        r.sleep(300)


def s_field(r, which, arg):
    expand_dir(r)
    if arg == "現在地":
        r.tap(r.pg.locator("button.use-current"), "現在地を使う")
        return
    r.pg.fill("#" + which, arg)
    r.sleep(1500 if r.slow else 600)  # 候補が打った語の物に入れ替わるのを待つ
    pick_suggest(r, 0, f"{'出発地' if which == 'from' else '目的地'}『{arg}』")
    r.sleep(800)


def s_routes(r, arg):
    try:
        r.pg.wait_for_selector(".routes button", state="visible", timeout=r.tmo if r.slow else 45000)
    except Exception:
        raise StepFail("経路が出ない", f"経路の一覧が出ない（{r.screen_hint()}）")
    r.sleep(600)
    n = r.pg.locator(".routes button").count()
    body = r.text_of("body", 4000)
    shown = DISCLAIMER in r.pg.evaluate("document.body.innerText")
    if not shown:
        r.add("免責が経路画面に無い", "経路の一覧が出ているのに免責の一文が無い")
    else:
        vis = r.pg.evaluate(
            """(t) => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              while (w.nextNode()) { if (w.currentNode.textContent.includes(t)) { const e = w.currentNode.parentElement; const b = e.getBoundingClientRect();
                return b.width > 0 && b.bottom <= innerHeight + 1 && b.top >= 0; } } return false; }""",
            DISCLAIMER,
        )
        if not vis:
            r.add("免責が画面の外にある", "免責の一文が見えない位置にある")
    r.notes.append(f"経路{n}本")


def s_period(r, arg):
    expand_dir(r)
    r.tap(r.pg.locator(f"[data-period={arg}]"), f"{'昼' if arg == 'day' else '夜'}の切り替え")
    r.sleep(1500)


def s_pick_route(r, arg):
    rows = r.pg.locator(".routes button")
    if rows.count() <= int(arg):
        raise StepFail("要素が無い", f"経路{int(arg) + 1}番目が無い（{rows.count()}本）")
    r.tap(rows.nth(int(arg)), f"経路{int(arg) + 1}番目")
    r.sleep(600)


def s_details(r, arg):
    summ = r.pg.locator("#sheet summary, #sheet button").filter(has_text="くわしく")
    r.tap(summ, "くわしく")
    r.sleep(500)


def s_guide(r, arg):
    r.tap(r.pg.locator("button.start, button:has-text('案内を始める')"), "案内を始める", 10000)
    r.wait_vis("#guide", "案内の画面", 10000)
    r.sleep(800)
    r.guide_texts = {r.text_of("#guide-next", 60)}
    r.notes.append("案内の最初: " + r.text_of("#guide-next", 40))


def route_ends(r):
    q = urllib.parse.urlparse(r.pg.url).query
    d = urllib.parse.parse_qs(q)
    def pt(k):
        v = (d.get(k) or [""])[0]
        m = re.match(r"(-?\d+\.?\d*),(-?\d+\.?\d*)", v)
        return (float(m.group(1)), float(m.group(2))) if m else None
    return pt("from") or r.start, pt("to")


def s_walk(r, arg):
    n = int(arg)
    a, b = route_ends(r)
    if not b:
        raise StepFail("歩けない", "目的地の座標が取れない")
    seen = getattr(r, "guide_texts", set())
    for i in range(1, n + 1):
        f = (r.walk_i + i) / (r.walk_i + n) * 0.6
        pos = {"latitude": a[0] + (b[0] - a[0]) * f, "longitude": a[1] + (b[1] - a[1]) * f}
        r.ctx.set_geolocation(pos)
        r.sleep(1800)
        if not r.pg.locator("#guide").is_visible():
            raise StepFail("案内が止まった", "歩いている途中で案内の画面が消えた")
        seen.add(r.text_of("#guide-next", 60))
    r.walk_i += n
    r.guide_texts = seen
    r.notes.append(f"{n}回動かして案内の文が{len(seen)}通り")
    if len(seen) < 2 and n >= 3:
        r.add("案内が進まない", "位置を動かしても案内の文が変わらない")
    off = r.text_of("#guide", 160)
    if "外れ" in off:
        r.notes.append("経路を外れた表示が出た（直線で歩かせたため）")


def s_offroute(r, arg):
    a, b = route_ends(r)
    m = float(arg)
    pos = {"latitude": a[0] + m / 111000, "longitude": a[1] + m / 91000}
    r.ctx.set_geolocation(pos)
    r.sleep(2500)
    r.notes.append(f"{arg}m外れて: " + r.text_of("#guide", 60))
    if not r.pg.locator("#guide").is_visible():
        raise StepFail("案内が止まった", "経路を外れたら案内の画面が消えた")


def s_stop(r, arg):
    r.tap(r.pg.locator("#guide-stop"), "案内を終わる")
    r.sleep(800)
    if r.pg.locator("#guide").is_visible():
        raise StepFail("閉じない", "終了を押しても案内の画面が残る")


def s_guide_emg(r, arg):
    r.tap(r.pg.locator(".guide-emergency"), "緊急")
    r.wait_vis("#guide-emg", "緊急の枠", 6000)
    t = r.text_of("#guide-emg", 300)
    for need in ("110", "119"):
        if need not in t:
            raise StepFail("表示が出ない", f"緊急の枠に{need}が無い")
    r.sleep(1500)
    r.notes.append("緊急の枠: 交番" + ("あり" if "交番" in r.text_of("#guide-emg", 600) else "なし"))


def s_guide_emg_close(r, arg):
    r.tap(r.pg.locator(".guide-emg-close"), "緊急を閉じる")
    r.sleep(400)


def s_voice_toggle(r, arg):
    b = r.pg.locator("#guide-voice")
    if r.p.get("voice") == "no":
        if b.is_visible():
            raise StepFail("反応しない", "音声が使えない端末なのに音声ボタンが出ている")
        r.notes.append("音声が使えない端末: 音声ボタンは隠れている")
        return
    before = b.get_attribute("aria-pressed")
    txt = b.inner_text()
    r.tap(b, "音声ボタン")
    r.sleep(300)
    r.notes.append(f"音声 {txt}→{b.inner_text()}（押した状態 {before}→{b.get_attribute('aria-pressed')}）")


def s_menu(r, arg):
    r.tap(r.pg.locator("#menu-open"), "メニュー")
    r.wait_vis(".menu-sheet", "メニュー", 6000)


def s_menu_close(r, arg):
    r.tap(r.pg.locator(".menu-close"), "メニューを閉じる")
    r.sleep(300)


def s_menu_emg(r, arg):
    r.tap(r.pg.locator("#menu-emg"), "緊急の時（110・119）")
    r.wait_vis("#menu-emg-box", "緊急の枠", 6000)
    t = r.text_of("#menu-emg-box", 300)
    if "110" not in t or "119" not in t:
        raise StepFail("表示が出ない", "緊急の枠に110/119が無い")


def s_menu_koban(r, arg):
    r.tap(r.pg.locator(".menu-find"), "近い交番を探す")
    try:
        r.pg.wait_for_selector(".emg-near li, .emg-near button", state="visible", timeout=15000)
    except Exception:
        raise StepFail("表示が出ない", f"近くの交番の一覧が出ない（{r.text_of('#menu-emg-box', 100)}）")
    r.notes.append("交番: " + r.text_of(".emg-near", 60))


def s_menu_route(r, arg):
    r.tap(r.pg.locator(".menu-sheet").get_by_role("button", name="経路を出す"), "交番への経路を出す")
    r.sleep(1500)


def s_menu_help(r, arg):
    r.tap(r.pg.locator(".menu-sheet").get_by_role("button", name="使い方"), "使い方")
    r.sleep(800)
    t = r.text_of("body", 3000)
    r.notes.append("使い方→" + ("初回の説明が出た" if r.pg.locator("[aria-labelledby=intro-title]").is_visible() else "別の画面"))


def s_menu_map(r, arg):
    r.tap(r.pg.locator(".menu-sheet").get_by_role("button", name=arg), f"地図の種類『{arg}』")
    r.sleep(1500)
    if r.pg.locator(".menu-sheet").get_by_role("button", name=arg).get_attribute("aria-pressed") != "true":
        raise StepFail("反応しない", f"{arg}を押しても選ばれた状態にならない")


def s_back_menu(r, arg):
    r.pg.go_back()
    r.sleep(800)
    if r.pg.locator(".menu-sheet").is_visible():
        raise StepFail("戻るで閉じない", "メニューを開いて「戻る」を押してもメニューが閉じない")


def s_back(r, arg):
    r.pg.go_back()
    r.sleep(1000)
    if r.pg.locator("#guide").count() and not r.pg.locator("#guide").is_visible() and getattr(r, "guide_texts", None):
        r.add("案内中に戻るで案内が終わる", "確認なしで案内が消えた")
    r.notes.append("戻る→" + (r.text_of("#sheet", 40) or "画面: " + r.text_of("body", 40)))


def s_locate(r, arg):
    ask = r.pg.locator(".note button.primary, button:has-text('現在地を使う')")
    r.tap(r.pg.locator("#locate"), "現在地ボタン")
    r.sleep(1200)
    if ask.count() and ask.first.is_visible():
        r.notes.append("位置の前置き: " + r.text_of(".note", 90))
        r.tap(ask.first, "現在地を使う")
        r.sleep(1500)
    # 知らせ(#toast)と現在地の説明の札(.locate-note)は同時に出ることがある(初回の「端末に残しました」など)。両方を見る。
    t = " / ".join(x for x in (r.text_of(".locate-note", 120), r.text_of("#toast", 120)) if x)
    r.notes.append("現在地→" + (t or ("印が出た" if r.pg.locator(".me").count() else "反応なし")))
    if arg and arg not in t:
        raise StepFail("期待と違う", f"『{arg}』を含む知らせが出ない（出た物: {t or 'なし'}）")


def s_genre(r, arg):
    settle(r)
    chip = r.pg.locator("#chips .chip", has_text=arg)
    if chip.count() == 0:
        more = r.pg.locator("#chips .chip-more")
        if more.count():
            r.tap(more, "ジャンルのほか")
            r.sleep(400)
    r.tap(r.pg.locator("#chips .chip", has_text=arg), f"ジャンル『{arg}』")
    try:
        r.pg.wait_for_selector(".results li", state="visible", timeout=15000)
    except Exception:
        raise StepFail("表示が出ない", f"『{arg}』の一覧が出ない（{r.screen_hint()}）")
    r.notes.append(f"{arg}の一覧{r.pg.locator('.results li').count()}件")


def s_genre_pick(r, arg):
    r.tap(r.pg.locator(".results button"), "一覧の先頭")
    r.wait_vis("#sheet h2", "場所の画面", 10000)


def s_link(r, arg):
    parts = arg.split(",")
    name = parts[0]
    period = next((p for p in parts if p in ("day", "night")), "day")
    a, b = PRESETS[name]
    fr = "me" if "me" in parts else f"{a[0]},{a[1]}"
    q = {"from": fr, "to": f"{b[0]},{b[1]}", "fromName": "出発", "toName": "到着", "period": period}
    if "sh" in parts:
        q["sh"] = "1"
    url = r.base + "?" + urllib.parse.urlencode(q, safe=",")
    t = time.time()
    r.pg.goto(url, wait_until="domcontentloaded", timeout=r.tmo)
    r.wait_ready(r.tmo)
    if r.ready_sec is None:
        r.ready_sec = round(time.time() - t, 1)
    if "sh" in parts:
        r.notes.append("共有リンクの最初: " + r.text_of("#sheet", 70))


def s_send(r, arg):
    r.tap(r.pg.locator("button.send, button:has-text('経路を送る')"), "経路を送る")
    r.sleep(900)
    seen = r.text_of("#send-confirm", 120) or r.text_of("#toast", 120)
    if not seen:
        raise StepFail("反応しない", "経路を送るを押しても画面に何も出ない")
    r.notes.append("送る→" + seen[:60])


def s_claude(r, arg):
    text, _, expect = arg.partition("~")
    pg = r.pg
    r.tap(pg.locator("summary", has_text="Claude に相談"), "Claude に相談")
    r.sleep(400)
    box = pg.locator("#sheet input[aria-label='歩く事情']")
    if not box.is_visible():
        raise StepFail("見えない", "相談の入力欄が見えない")
    box.fill(text)
    r.tap(pg.get_by_role("button", name="相談する"), "相談する")
    try:
        pg.wait_for_function("(document.querySelector('.agent-out')||{}).innerText && document.querySelector('.agent-out').innerText.trim().length > 5 && !document.querySelector('.agent-out').innerText.includes('伝えています') && !document.querySelector('.agent-out').innerText.includes('調べています')", timeout=30000)
    except Exception:
        raise StepFail("表示が出ない", "相談の返事の欄に何も出ない")
    out = r.text_of(".agent-out", 160)
    r.notes.append("相談→" + out[:80])
    if expect and expect not in pg.inner_text("#sheet"):
        raise StepFail("期待と違う", f"相談の返事に『{expect}』が無い（{out[:60]}）")
    r.claude_n += 1


def s_maptap(r, arg):
    box = r.pg.locator("#map").bounding_box()
    r.pg.mouse.click(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.4)
    r.sleep(1200)
    r.notes.append("地図をタップ→" + (r.text_of("#sheet h2", 30) or "何も出ない"))


def s_offline(r, arg):
    on = arg == "on"
    r.ctx.set_offline(on)
    r.expect += 1 if on else -1 if r.expect > 0 else 0
    r.offline = on
    r.sleep(400)


def s_blip(r, arg):
    r.expect += 1
    r.ctx.set_offline(True)
    r.sleep(int(float(arg) * 1000))
    r.ctx.set_offline(False)
    r.expect -= 1
    r.sleep(1500)
    if r.pg.locator("#guide").count() and getattr(r, "guide_texts", None) and not r.pg.locator("#guide").is_visible():
        raise StepFail("案内が止まった", "電波が一瞬切れたら案内の画面が消えた")


def s_warm(r, arg):
    """2回目に備え、Service Worker が有効になり、アプリとデータが端末に残るまで待つ。"""
    try:
        r.pg.wait_for_function(
            "navigator.serviceWorker && navigator.serviceWorker.controller === null ? navigator.serviceWorker.getRegistration().then(g => !!(g && g.active)) : true",
            timeout=40000,
        )
        r.pg.reload(wait_until="domcontentloaded")
        r.wait_ready(r.tmo)
        ctrl = r.pg.evaluate("!!navigator.serviceWorker.controller")
        keys = r.pg.evaluate("caches.keys()")
    except Exception as e:
        raise StepFail("残らない", f"Service Worker が有効にならない: {str(e)[:60]}")
    r.sleep(2500)
    r.notes.append(f"2回目の備え: 制御{'あり' if ctrl else 'なし'}・入れ物{len(keys)}個")
    if not ctrl:
        raise StepFail("残らない", "再読み込み後も Service Worker が画面を制御していない")


def s_reload(r, arg):
    t = time.time()
    r.pg.reload(wait_until="domcontentloaded", timeout=r.tmo)
    r.wait_ready(r.tmo)
    r.notes.append(f"再起動 {time.time() - t:.1f}秒" + ("・電波なし" if getattr(r, "offline", False) else ""))
    if getattr(r, "offline", False) and not r.pg.locator("#offline-note").is_visible():
        r.add("電波なしの一行が出ない", "電波が無いのに「前に読み込んだ地図で表示」の一行が無い")


def s_a11y(r, arg):
    r.tiny_and_names()


def s_tab_walk(r, arg):
    pg = r.pg
    names = []
    for _ in range(30):
        pg.keyboard.press("Tab")
        info = pg.evaluate(
            """() => { const e = document.activeElement; if (!e || e === document.body) return null;
              const b = e.getBoundingClientRect(); const cs = getComputedStyle(e);
              return {name: (e.getAttribute('aria-label') || e.innerText || e.getAttribute('placeholder') || '').trim().slice(0, 20),
                      tag: e.tagName, vis: b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < innerHeight,
                      ring: cs.outlineStyle !== 'none' || cs.boxShadow !== 'none'}; }"""
        )
        if info:
            names.append(info)
    if not names:
        raise StepFail("キーボードで届かない", "Tab で何にも着かない")
    bad = [n for n in names if not n["name"]]
    off = [n for n in names if not n["vis"]]
    noring = [n for n in names if not n["ring"]]
    if bad:
        r.add("Tab:名前の無い物に着く", f"{len(bad)}件")
    if off:
        r.add("Tab:画面の外の物に着く", f"{len(off)}件")
    if len(noring) > len(names) // 2:
        r.add("Tab:着いた所の目印が薄い", f"{len(noring)}/{len(names)}")
    r.notes.append(f"Tab {len(names)}回: 名前なし{len(bad)}・画面外{len(off)}")


def s_page(r, arg):
    t = time.time()
    r.pg.goto(r.base + arg, wait_until="domcontentloaded", timeout=r.tmo)
    r.sleep(800)
    txt = r.text_of("body", 3000)
    if len(txt) < 50:
        raise StepFail("表示が出ない", f"{arg} に中身が出ない")
    r.notes.append(f"{arg}→{txt[:40]}")


STEPS = {
    "open": s_open, "intro_read": s_intro_read, "search": s_search, "kb_search": s_kb_search, "to_place": s_to_place,
    "from": lambda r, a: s_field(r, "from", a), "to": lambda r, a: s_field(r, "to", a), "routes": s_routes, "period": s_period,
    "pick_route": s_pick_route, "details": s_details, "guide": s_guide, "walk": s_walk, "offroute": s_offroute, "stop": s_stop,
    "guide_emg": s_guide_emg, "guide_emg_close": s_guide_emg_close, "voice_toggle": s_voice_toggle, "menu": s_menu,
    "menu_close": s_menu_close, "menu_emg": s_menu_emg, "menu_koban": s_menu_koban, "menu_route": s_menu_route,
    "menu_help": s_menu_help, "menu_map": s_menu_map, "back_menu": s_back_menu, "back": s_back, "locate": s_locate,
    "genre": s_genre, "genre_pick": s_genre_pick, "link": s_link, "send": s_send, "claude": s_claude, "maptap": s_maptap,
    "offline": s_offline, "blip": s_blip, "warm": s_warm, "reload": s_reload, "a11y": s_a11y, "tab_walk": s_tab_walk, "page": s_page,
}


# ---------------------------------------------------------------- 1人分

def device_kwargs(pw, p):
    name = p["dev"] + (" landscape" if p.get("orient") == "landscape" and not p["dev"].startswith("Desktop") else "")
    d = dict(pw.devices[name])
    font = float(p.get("font", 100)) / 100
    if font != 1:
        v = d.get("viewport") or {"width": 1280, "height": 720}
        d["viewport"] = {"width": int(v["width"] / font), "height": int(v["height"] / font)}
        d["device_scale_factor"] = d.get("device_scale_factor", 1) * font
    d["locale"] = "ja-JP"
    d["timezone_id"] = "Asia/Tokyo"
    d["color_scheme"] = "dark" if p.get("dark") else "light"
    return d


def init_scripts(p):
    s = []
    if not p.get("intro"):
        s.append("try { localStorage.setItem('safewalk.intro.seen', '1') } catch (e) {}")
    s.append(
        "window.addEventListener('unhandledrejection', e => console.error('__unhandled__ ' + (e.reason && (e.reason.message || e.reason))));"
    )
    geo = p.get("geo", "allow")
    if geo == "none":
        s.append("Object.defineProperty(navigator, 'geolocation', {value: undefined, configurable: true});")
    elif geo == "deny":
        s.append(
            """(() => { const err = {code: 1, message: 'User denied Geolocation', PERMISSION_DENIED: 1};
              navigator.geolocation.getCurrentPosition = (ok, ng) => setTimeout(() => ng && ng(err), 50);
              navigator.geolocation.watchPosition = (ok, ng) => { setTimeout(() => ng && ng(err), 50); return 1; };
              const q = navigator.permissions && navigator.permissions.query ? navigator.permissions.query.bind(navigator.permissions) : null;
              if (q) navigator.permissions.query = (d) => d && d.name === 'geolocation' ? Promise.resolve({state: 'denied', onchange: null}) : q(d); })();"""
        )
    voice = p.get("voice", "yes")
    if voice == "no":
        s.append("try { delete window.speechSynthesis; } catch (e) {} try { delete Window.prototype.speechSynthesis; } catch (e) {} if ('speechSynthesis' in window) Object.defineProperty(window, 'speechSynthesis', {get: undefined, set: undefined, configurable: true});")
    else:
        s.append(
            # 本物の読み上げは使わない(Windows では --mute-audio でも OS の声で鳴り、PC のスピーカーから聞こえてしまう)。どの端末でも音の出ない偽物に差し替える。
            """{ const v = [{name: 'Kyoko', lang: 'ja-JP', default: true, localService: true, voiceURI: 'Kyoko'}];
              Object.defineProperty(window, 'speechSynthesis', {value: {speaking: false, pending: false, paused: false, getVoices: () => v,
                speak(u) { setTimeout(() => u.onend && u.onend({}), 50); }, cancel() {}, pause() {}, resume() {}, addEventListener() {}, removeEventListener() {}, onvoiceschanged: null}, configurable: true});
              window.SpeechSynthesisUtterance = function (t) { this.text = t; }; }"""
        )
    return s


CLAUDE_JS = """(() => {
  const mode = %s; let n = 0; const real = window.fetch.bind(window);
  const json = (status, body) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!url.includes('/api/claude')) return real(input, init);
    n++;
    if (mode === 'abort') return Promise.reject(new TypeError('Failed to fetch'));
    if (mode === '503') return Promise.resolve(json(503, {error: {message: ''}}));
    if (mode === 'declined') return Promise.resolve(json(200, {stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify({summary: '', chosenRouteIndex: -1, declined: true, reasons: [], cautions: [], caveats: ''})}]}));
    if (n %% 2 === 1) return Promise.resolve(json(200, {stop_reason: 'tool_use', content: [{type: 'tool_use', id: 't' + n, name: 'find_routes', input: {}}]}));
    return Promise.resolve(json(200, {stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify({summary: '一覧の経路Aは、道のりが短い経路です。', chosenRouteIndex: 0, declined: false, reasons: [], cautions: [], caveats: '記録の限界があります。'})}]}));
  };
})();"""


def classify_fail(cat):
    return {
        "検索で見つからない": "データ・検索",
        "経路が出ない": "データ・経路",
        "読み込めない": "回線・起動",
        "残らない": "回線・起動",
        "見えない": "画面・操作",
        "押せない(他の物が重なる)": "画面・操作",
        "押せない(画面の外)": "画面・操作",
        "要素が無い": "画面・操作",
        "表示が出ない": "画面・操作",
        "反応しない": "画面・操作",
        "閉じない": "画面・操作",
        "案内が止まった": "画面・操作",
        "期待と違う": "仕様の食い違い",
    }.get(cat, "その他")


def expand_script(p):
    """台本の整形: 位置が使えない人は、経路の画面で出発地を入れる手順を足す。"""
    out = []
    steps = list(p["script"])
    for i, s in enumerate(steps):
        out.append(s)
        if s == "to_place" and p.get("geo", "allow") != "allow" and not (i + 1 < len(steps) and steps[i + 1].startswith("from:")):
            out.append("from:三宮駅" if not any(x.startswith("search:三宮") for x in steps) else "from:神戸駅")
    return out


def run_persona(pw, browsers, p, base, shots):
    kind = p["browser"]
    if kind not in browsers:
        browsers[kind] = (pw.chromium.launch(args=ARGS) if kind == "chromium" else pw.webkit.launch())
    br = browsers[kind]
    kw = device_kwargs(pw, p)
    net = p.get("net", "normal")
    geo = p.get("geo", "allow")
    start = None
    if p.get("start") in STARTS:
        start = STARTS[p["start"]]
    elif any(s.startswith("search:三宮") for s in p["script"]):
        start = STARTS["kobe_sta"]
    else:
        start = STARTS["sannomiya"]
    if geo == "allow":
        kw["geolocation"] = {"latitude": start[0], "longitude": start[1]}
        kw["permissions"] = ["geolocation"] + (["clipboard-read", "clipboard-write"] if kind == "chromium" else [])
    elif kind == "chromium":
        kw["permissions"] = ["clipboard-read", "clipboard-write"]
    ctx = br.new_context(**kw)
    ctx.set_default_timeout(15000)
    if p.get("claude"):
        ctx.add_init_script(CLAUDE_JS % json.dumps(p["claude"]))
    pg = ctx.new_page()
    run = Run(p, base, shots, ctx, pg)
    run.start = start
    run.slow = net == "slow3g"
    if net == "flaky":
        run.expect = 1
    run.tmo = 300000 if run.slow else 60000
    for s in init_scripts(p):
        ctx.add_init_script(s)

    # 想定した失敗: 回線の模擬・中継の模擬が起こす物
    mode = p.get("claude")
    claude_expected = mode in ("503", "abort")
    # 本物の中継は呼ばない（日ごとの回数上限・費用があるため）。相談は fetch を差し替えて模擬する（WebKit は page.route が効かない）。
    ctx.route(re.compile(r"workers\.dev"), lambda route: route.abort())
    induced = set()
    if net == "flaky":
        counts = defaultdict(int)

        def flaky(route):
            u = route.request.url
            k = u.rsplit("/", 1)[-1]
            counts[k] += 1
            if counts[k] == 1:
                induced.add(u)
                return route.abort("connectionreset")
            route.continue_()

        ctx.route("**/data/graph.bin", flaky)
        ctx.route("**/data/places.json", flaky)
    if net == "slow3g" and kind == "chromium":
        cdp = ctx.new_cdp_session(pg)
        cdp.send("Network.enable")
        cdp.send("Network.emulateNetworkConditions", {"offline": False, "latency": 400, "downloadThroughput": 62500, "uploadThroughput": 50000})

    # 通信・コンソールの監視
    def on_console(m):
        if m.type != "error":
            return
        t = m.text
        if "Failed to load resource" in t or "net::ERR" in t:
            return  # 通信の失敗は response/requestfailed で数える
        if run.expect > 0:
            return
        if t.startswith("__unhandled__"):
            run.add("未処理のPromise reject", norm(t[14:]))
        else:
            run.add("コンソールエラー", norm(t))

    def on_pageerror(e):
        if run.expect <= 0:
            run.add("ページのエラー", norm(str(e)))

    def on_failed(req):
        err = (req.failure or "").lower() if isinstance(req.failure, str) else str(req.failure).lower()
        if "abort" in err or "cancel" in err or run.expect > 0 or req.url in induced:
            return
        if claude_expected and "/api/claude" in req.url:
            return
        run.add("失敗した通信", f"{req.method} {norm(req.url)} ({norm(err, 40)})")

    def on_response(resp):
        if resp.status >= 400 and run.expect <= 0 and not (claude_expected and "/api/claude" in resp.url):
            run.add("失敗した通信", f"{resp.status} {norm(resp.url)}")

    pg.on("console", on_console)
    pg.on("pageerror", on_pageerror)
    pg.on("requestfailed", on_failed)
    pg.on("response", on_response)

    script = expand_script(p)
    budget = 600 if run.slow else 240
    t_begin = time.time()
    failed = None
    detours = []
    goal_t = None
    for si, raw in enumerate(script):
        if time.time() - t_begin > budget:
            failed = {"step": raw, "cat": "時間切れ", "msg": f"{budget}秒の枠を超えた", "i": si}
            break
        alts = raw.split("||")
        st0 = time.time()
        slept0 = run.slept
        ok = False
        err = None
        for ai, alt in enumerate(alts):
            verb, _, arg = alt.partition(":")
            run.cur = alt
            try:
                if verb not in STEPS:
                    raise StepFail("台本の誤り", f"知らない手順 {verb}")
                STEPS[verb](run, arg)
                ok = True
                if ai > 0:
                    detours.append({"step": raw, "first_error": err.msg if err else ""})
                break
            except StepFail as e:
                if err is None:
                    err = e
            except Exception as e:
                if err is None:
                    err = StepFail("操作の失敗", str(e)[:120])
        sec = round(time.time() - st0 - (run.slept - slept0), 1)
        run.check_text()
        run.steps.append({"step": raw, "ok": ok, "sec": sec, "err": None if ok else err.msg, "cat": None if ok else err.cat})
        if not ok:
            failed = {"step": raw, "cat": err.cat, "msg": err.msg, "i": si}
            break
        goal_t = time.time() - t_begin - run.slept
    if not failed:
        run.tiny_and_names()
    tag = f"{p['id']:03d}"
    try:
        pg.screenshot(path=str(shots / (tag + ("_fail.jpg" if failed else "_end.jpg"))), type="jpeg", quality=55)
        if failed:
            failed["screen"] = (run.text_of("body", 200))
    except Exception:
        pass
    res = {
        "id": p["id"], "label": p["label"], "dev": p["dev"], "browser": kind, "net": net, "geo": geo,
        "status": "詰まった" if failed else ("回り道で通った" if detours else "通った"),
        "failed": failed, "detours": detours, "goal_sec": round(goal_t, 1) if goal_t and not failed else None,
        "ready_sec": run.ready_sec, "steps": run.steps, "notes": run.notes[:12],
        "findings": [{"kind": k[0], "text": k[1], "n": v["n"], "step": v["step"]} for k, v in sorted(run.find.items())],
    }
    ctx.close()
    return res


def worker(args):
    ids, base, shots = args
    from playwright.sync_api import sync_playwright

    data = {x["id"]: x for x in json.loads(PERSONAS.read_text(encoding="utf-8"))["personas"]}
    out = []
    with sync_playwright() as pw:
        browsers = {}
        for i in ids:
            t = time.time()
            try:
                out.append(run_persona(pw, browsers, data[i], base, Path(shots)))
            except Exception as e:
                out.append({"id": i, "label": data[i]["label"], "dev": data[i]["dev"], "browser": data[i]["browser"], "net": data[i].get("net", "normal"), "geo": data[i].get("geo", "allow"),
                            "status": "詰まった", "failed": {"step": "(準備)", "cat": "テスト側", "msg": str(e)[:160], "i": -1}, "detours": [], "goal_sec": None, "ready_sec": None, "steps": [], "notes": [], "findings": []})
            r = out[-1]
            print(f"[{r['id']:3d}] {r['status']:<6} {r['label'][:28]:<28} {time.time() - t:5.0f}s" + (f"  ← {r['failed']['step']}: {r['failed']['msg'][:60]}" if r["failed"] else ""), flush=True)
        for b in browsers.values():
            b.close()
    return out


# ---------------------------------------------------------------- 集計・基準

def parse_only(s, allids):
    if not s:
        return allids
    out = []
    for part in s.split(","):
        if "-" in part:
            a, b = part.split("-")
            out += list(range(int(a), int(b) + 1))
        else:
            out.append(int(part))
    return [i for i in allids if i in out]


def system_issues(results):
    agg = defaultdict(list)
    for r in results:
        for f in r["findings"]:
            agg[(f["kind"], f["text"])].append(r["id"])
    return agg


def summarize(results, url):
    L = []
    n = len(results)
    ok = [r for r in results if r["status"] == "通った"]
    dt = [r for r in results if r["status"] == "回り道で通った"]
    ng = [r for r in results if r["status"] == "詰まった"]
    L.append(f"# 利用者100人の使用テスト（{time.strftime('%Y-%m-%d')}・{url}）")
    L.append("")
    L.append(f"- 通った {len(ok)}人 / 回り道で通った {len(dt)}人 / 詰まった {len(ng)}人（計{n}人）")
    secs = sorted(r["goal_sec"] for r in results if r["goal_sec"])
    if secs:
        L.append(f"- 目的の画面までの秒数（待ちを除く）: 中央値 {secs[len(secs) // 2]}秒・最長 {secs[-1]}秒")
    L.append("")
    L.append("## 詰まった人（手順と原因の分類）")
    by = defaultdict(list)
    for r in ng:
        by[classify_fail(r["failed"]["cat"])].append(r)
    for cat, rs in sorted(by.items(), key=lambda x: -len(x[1])):
        L.append(f"### {cat}（{len(rs)}人）")
        for r in rs:
            L.append(f"- {r['id']} {r['label']}（{r['dev']}・{r['browser']}・{r['net']}・位置{r['geo']}）: 手順 `{r['failed']['step']}` — {r['failed']['msg']}")
    L.append("")
    L.append("## 回り道で通った人（最初のやり方では通らず、別の言い方・手順で通った）")
    for r in dt:
        for d in r["detours"]:
            L.append(f"- {r['id']} {r['label']}: `{d['step']}` — {d['first_error']}")
    L.append("")
    L.append("## システム上の問題（全員の検査から。人数の多い順）")
    agg = system_issues(results)
    for (kind, text), ids in sorted(agg.items(), key=lambda x: -len(x[1])):
        L.append(f"- [{kind}] {text} — {len(ids)}人（{','.join(map(str, ids[:12]))}{'…' if len(ids) > 12 else ''}）")
    L.append("")
    L.append("## 遅かった人（目的の画面まで 20秒超）")
    for r in sorted(results, key=lambda r: -(r["goal_sec"] or 0))[:10]:
        if r["goal_sec"] and r["goal_sec"] > 20:
            L.append(f"- {r['id']} {r['label']}（{r['net']}）: {r['goal_sec']}秒")
    L.append("")
    L.append("## テストの限界（実機との違い）")
    L += [
        "- 端末は Playwright の機種の設定（画面の大きさ・UA・タッチ）の模擬。実機の iOS Safari・Android Chrome の挙動、アドレスバーの出入り、ソフトキーボードで画面が縮む動き、省電力、サイレントスイッチは再現しない。",
        "- WebKit は Playwright 同梱の WebKit（Safari と同じエンジンではない部分がある）。Service Worker・ストレージ上限・バックグラウンド停止は実機と違う。",
        "- 位置は set_geolocation で直線に動かす。実際の GPS のずれ・精度・道なりの動きではない。「経路を外れた」は直線のために出うる。",
        "- 文字の大きさは、画面の幅を縮めて拡大した見え方にする模擬。OS の文字サイズ設定・VoiceOver・TalkBack そのものではない（名前・Tab 順の検査まで）。",
        "- 回線: Chromium は CDP の Slow 3G（500kbps・遅延400ms）。遅い回線の iPhone の人は、WebKit では回線を絞れないので、iPhone の画面設定の Chromium で動かす（Safari の挙動ではない）。「途中で切れる」は最初の通信を一度切る模擬、電波なしは set_offline。",
        "- 電波なしの再起動: Chromium(70)は起動したが、WebKit(36・82)は起動しなかった。Playwright の WebKit が Service Worker 経由の読み込みを set_offline で止める可能性があり、実機の Safari で同じかは未確認。",
        "- 音声: どの端末でも音の出ない偽の speechSynthesis を差す（本物は PC のスピーカーで鳴るため）。読み上げの聞こえ方は見ない。",
        "- Claude への相談は fetch を差し替えた偽の返事（中継の Worker・CORS・本物の応答は通らない）。本物の応答の質・遅さ・失敗は見ない。",
        "- 地図の絵（WebGL）は swiftshader のソフト描画。見た目の崩れは目で見るスクショ頼み。",
    ]
    return "\n".join(L)


def diff_report(old, new):
    o = {r["id"]: r for r in old["results"]}
    L = []
    for r in new:
        b = o.get(r["id"])
        if not b:
            L.append(f"+ {r['id']} 新しく入った: {r['status']}")
            continue
        if b["status"] != r["status"]:
            L.append(f"~ {r['id']} {r['label']}: {b['status']} → {r['status']}" + (f"（{r['failed']['step']}: {r['failed']['msg'][:60]}）" if r["failed"] else ""))
        elif r["failed"] and b["failed"] and r["failed"]["step"] != b["failed"]["step"]:
            L.append(f"~ {r['id']} 詰まる手順が変わった: {b['failed']['step']} → {r['failed']['step']}")
        ob = {(f["kind"], f["text"]) for f in b["findings"]}
        nw = {(f["kind"], f["text"]) for f in r["findings"]}
        for k in sorted(nw - ob):
            L.append(f"+ {r['id']} 新しい問題 [{k[0]}] {k[1][:90]}")
        for k in sorted(ob - nw):
            L.append(f"- {r['id']} 解消 [{k[0]}] {k[1][:90]}")
        if b.get("goal_sec") and r.get("goal_sec") and r["goal_sec"] > b["goal_sec"] * 1.5 and r["goal_sec"] - b["goal_sec"] > 5:
            L.append(f"~ {r['id']} 遅くなった: {b['goal_sec']}秒 → {r['goal_sec']}秒")
    return L


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only")
    ap.add_argument("--save", action="store_true")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--shots", default=str(DEFAULT_SHOTS))
    a = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    personas = json.loads(PERSONAS.read_text(encoding="utf-8"))["personas"]
    ids = parse_only(a.only, [p["id"] for p in personas])
    shots = Path(a.shots)
    shots.mkdir(parents=True, exist_ok=True)
    base = a.url if a.url.endswith("/") else a.url + "/"
    # 遅い人を先に配る（全体の終わりが揃うように）
    pmap = {p["id"]: p for p in personas}
    ids_sorted = sorted(ids, key=lambda i: 0 if pmap[i].get("net") == "slow3g" else 1)
    w = max(1, min(a.workers, len(ids_sorted)))
    chunks = [ids_sorted[k::w] for k in range(w)]
    t0 = time.time()
    results = []
    if w == 1:
        results = worker((chunks[0], base, str(shots)))
    else:
        with mp.get_context("spawn").Pool(w) as pool:
            for part in pool.imap_unordered(worker, [(c, base, str(shots)) for c in chunks]):
                results += part
    results.sort(key=lambda r: r["id"])
    print(f"\n所要 {time.time() - t0:.0f}秒\n")
    summary = summarize(results, base)
    print(summary)
    old = json.loads(BASE_JSON.read_text(encoding="utf-8")) if BASE_JSON.exists() else None
    if old:
        d = diff_report(old, results)
        print("\n## 前回の基準との差分")
        print("\n".join(d) if d else "差分なし")
    if a.save or not old:
        merged = {r["id"]: r for r in (old["results"] if old and a.only else [])}
        merged.update({r["id"]: r for r in results})
        allr = [merged[k] for k in sorted(merged)]
        BASE_JSON.write_text(json.dumps({"date": time.strftime("%Y-%m-%d"), "url": base, "results": allr}, ensure_ascii=False, indent=1), encoding="utf-8")
        BASE_MD.write_text(summarize(allr, base) + "\n", encoding="utf-8")
        print(f"\n基準を保存: {BASE_JSON.name} / {BASE_MD.name}")


if __name__ == "__main__":
    main()
