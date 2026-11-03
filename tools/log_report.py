"""使われ方とエラーの記録を読み出して、日本語で集計する（デモの後の振り返り用）。

使い方: python tools/log_report.py [--hours 24]
合言葉は ~/.safewalk_log_token から読む（リポジトリには置かない）。
"""
import argparse
import collections
import json
import pathlib
import time
import urllib.request

URL = "https://safewalk-claude.matomaru-yotei.workers.dev/api/log/read"
ERRORS = {"js_error", "load_error", "consult_error", "route_none", "search_none", "locate_fail", "guide_lost", "guide_unsure", "consult_replaced", "slow"}
NAMES = {
    "open": "開いた", "ready": "使える状態になった", "load_error": "読み込み失敗", "slow": "読み込みが遅い", "js_error": "画面の不具合",
    "offline": "電波なしで表示", "sw_ready": "端末に控えを残した", "search_none": "検索で見つからない", "place": "場所を開いた",
    "route": "経路を出した", "route_none": "経路が出なかった", "share": "共有", "guide_start": "案内を始めた", "guide_stop": "案内を終えた",
    "guide_arrive": "到着", "guide_reroute": "経路を外れて探し直し", "guide_lost": "位置が取れない", "guide_unsure": "位置が不確か",
    "emergency": "緊急の枠", "intro_start": "初回の「使ってみる」", "consult": "相談した", "consult_error": "相談の失敗", "consult_replaced": "相談の文の差し替え", "locate_fail": "現在地の失敗",
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=24)
    a = ap.parse_args()
    token = (pathlib.Path.home() / ".safewalk_log_token").read_text().strip()
    since = int((time.time() - a.hours * 3600) * 1000)
    req = urllib.request.Request(f"{URL}?since={since}", headers={"x-log-token": token, "user-agent": "safewalk-log-report"})
    rows = json.load(urllib.request.urlopen(req, timeout=30))
    sessions = {r["sid"] for r in rows}
    lines = {r["ip"] for r in rows}
    print(f"直近 {a.hours:g} 時間: 出来事 {len(rows)} 件・開いた回数(画面) {len(sessions)}・回線 {len(lines)}")
    devs = collections.Counter()
    for sid in sessions:
        d = json.loads(next(r["dev"] for r in rows if r["sid"] == sid) or "{}")
        devs[f"{d.get('os', '?')}・{d.get('br', '?')}{'・ホーム画面' if d.get('app') else ''}"] += 1
    print("端末:", "、".join(f"{k} {v}" for k, v in devs.most_common()))
    print("\n■ 出来事の数")
    for t, n in collections.Counter(r["type"] for r in rows).most_common():
        print(f"  {NAMES.get(t, t)}: {n}")
    print("\n■ エラー・詰まりの中身（多い順）")
    errs = collections.Counter((r["type"], r["detail"]) for r in rows if r["type"] in ERRORS)
    for (t, d), n in errs.most_common(40):
        print(f"  {n:>3}回  {NAMES.get(t, t)}: {d or '（説明なし）'}")
    ready = [r["detail"] for r in rows if r["type"] == "ready"]
    if ready:
        secs = sorted(float(x.split("秒")[0]) for x in ready if "秒" in x)
        if secs:
            print(f"\n■ 使えるまでの時間: 中央 {secs[len(secs) // 2]}秒・最長 {secs[-1]}秒（{len(secs)}回）")


if __name__ == "__main__":
    main()
