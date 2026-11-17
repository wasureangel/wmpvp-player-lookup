#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
wmpvp_lookup.py — 完美世界竞技平台(CS2)玩家批量查询工具
用途: 把 `status` 控制台输出里的玩家昵称批量解析为平台账号, 查封禁状态, (可选)查近期战绩。

接口来源: 社区逆向 (Redamancy520/PerfectWorld-API-Collection), 2026-11-17 实测存活:
  1) POST https://appengine.wmpvp.com/steamcn/app/search/user     — 免登录可用(仅验 appversion 头)
  2) GET  https://pvp.wanmei.com/user-info/forbid-list            — 免登录, 封禁公示
  3) POST https://api.wmpvp.com/api/csgo/home/match/list          — 需有效 token, 且 mySteamId 必须与 token 匹配

用法:
  # 只解析身份 + 查封禁 (无需登录)
  python wmpvp_lookup.py --names "你的忘忘忘" "用户8322583" ...

  # 连战绩一起查 (需要 token + 自己的 steamId64)
  #   token 获取: 登录 https://partner.wmpvp.com/#/login 后从 Cookie/URL 取 access_token,
  #   或用 Fiddler/F12 抓完美客户端"战绩"页请求头里的 token
  set WMPVP_TOKEN=xxxx
  set WMPVP_STEAMID=7656119xxxxxxxxxx
  python wmpvp_lookup.py --names ... --with-matches
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")

SEARCH_URL = "https://appengine.wmpvp.com/steamcn/app/search/user"
MATCH_URL = "https://api.wmpvp.com/api/csgo/home/match/list"
FORBID_URL = "https://pvp.wanmei.com/user-info/forbid-list"

APPVERSION = "3.5.4.172"

FORBID_TYPE = {
    "1": "外挂作弊", "2": "消极比赛", "3": "谩骂侮辱", "4": "挂机", "5": "骚扰",
    "6": "传播违规信息", "7": "数据异常", "8": "破坏游戏秩序", "9": "恶意伤害队友",
    "10": "小号炸鱼", "11": "黑号", "12": "战绩异常", "100": "硬件指纹封禁",
}


def http_json(url, payload=None, headers=None, method=None, retries=3):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    h = {"Accept": "application/json"}
    if payload is not None:
        h["Content-Type"] = "application/json"
    if headers:
        h.update(headers)
    last_err = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, data=data, headers=h, method=method)
            with urllib.request.urlopen(req, timeout=15) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # 瞬时代理/网络抖动, 指数退避重试
            last_err = e
            time.sleep(1.5 * (i + 1))
    raise last_err


def search_user(keyword):
    """昵称 -> [{steamId, pvpNickName, userId, appNickName, ladderType}], 完全匹配排最前"""
    resp = http_json(
        SEARCH_URL,
        payload={"keyword": keyword, "page": 1},
        headers={"appversion": APPVERSION, "Referer": "https://client.wmpvp.com"},
    )
    if resp.get("code") == 1:
        return resp.get("result") or []
    return []


def ban_check(steam_id64):
    """封禁公示查询, 免登录。返回该 steamId 的封禁记录列表(通常 0 或 1 条)"""
    url = f"{FORBID_URL}?game_abbr_list=PVP,CSGO&uid_list={steam_id64}"
    try:
        resp = http_json(url)
        items = resp.get("data", {}).get("list", []) or []
        return [i for i in items if str(i.get("steam_id64")) == str(steam_id64)]
    except Exception as e:
        return [{"error": str(e)}]


def match_list(to_steam_id, my_steam_id, token, page=1, page_size=20):
    """近期对局。注意: mySteamId 必须与 token 一一对应"""
    headers = {"appversion": APPVERSION, "token": token}
    payload = {
        "csgoSeasonId": "recent",
        "dataSource": 3,
        "mySteamId": int(my_steam_id),
        "page": page,
        "pageSize": page_size,
        "pvpType": -1,
        "toSteamId": int(to_steam_id),
    }
    resp = http_json(MATCH_URL, payload=payload, headers=headers)
    if resp.get("statusCode") == 0:
        return (resp.get("data") or {}).get("matchList") or []
    raise RuntimeError(f"match/list 失败: statusCode={resp.get('statusCode')} msg={resp.get('errorMessage')}")


def summarize(matches, n=10):
    """最近 n 场: 胜率 / 平均rating / K-D / 场均分变化"""
    recent = matches[:n]
    if not recent:
        return None
    wins = sum(1 for m in recent if m.get("winTeam") == m.get("team"))
    kills = sum(m.get("kill") or 0 for m in recent)
    deaths = sum(m.get("death") or 0 for m in recent)
    ratings = [m.get("rating") for m in recent if isinstance(m.get("rating"), (int, float))]
    score_chg = sum(m.get("pvpScoreChange") or 0 for m in recent)
    return {
        "games": len(recent),
        "winrate": f"{wins / len(recent):.0%}",
        "avg_rating": f"{sum(ratings) / len(ratings):.2f}" if ratings else "-",
        "kd": f"{kills / max(deaths, 1):.2f}" if deaths else "-",
        "score_change": score_chg,
        "modes": " / ".join(sorted({str(m.get('mode')) for m in recent})),
    }


def parse_status_dump(text):
    """解析 CS2 `status` 控制台输出(含完美平台 [EngineServiceManager]/[Client] 包裹格式)。

    返回 dict: {players: [(slot, name)], map, server, self_steamid}
    玩家行形如:
      [Client]    3    07:20   21    0     active 786432 ' 你的忘忘忘'
    排除: BOT 行、[NoChan]/challenging 行、#end。
    """
    players, map_name, server, self_sid = [], None, None, None
    slot_re = re.compile(
        r"^\[Client\]\s+(\d+)\s+(\d{1,2}:\d{2}|\d+)\s+(\d+)\s+(\d+)\s+(\w+)"
        r"(?:\s+(\d+))?\s+'(.*)'\s*$"
    )
    for raw in text.splitlines():
        line = raw.strip()
        m = re.search(r"hostname\s*:\s*(.+)$", line)
        if m:
            server = m.group(1).strip()
        m = re.search(r"steamid\s*:\s*\[G:1:(\d+)\]\s*\((\d+)\)", line)
        if m:
            self_sid = m.group(2)
        m = re.search(r"loaded spawngroup\(\s*\d+\s*\)\s*:\s*SV:\s*\[\d+:\s*([\w]+)\s*\|", line)
        if m and not map_name and m.group(1) not in ("main",):
            map_name = m.group(1)
        m = slot_re.match(line)
        if m:
            slot, state = int(m.group(1)), m.group(5)
            name = m.group(7).strip().strip("'\"")
            if state == "active" and name and name != "BOT":
                players.append((slot, name))
    return {"players": players, "map": map_name, "server": server, "self_steamid": self_sid}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--status", help="status 报文文件路径, 或 '-' 从 stdin 读取; 自动解析玩家昵称")
    ap.add_argument("--names", nargs="+", help="玩家昵称列表(与 --status 二选一)")
    ap.add_argument("--with-matches", action="store_true", help="同时拉取近期战绩(需要 token)")
    ap.add_argument("--report", help="输出 Markdown 报告路径")
    args = ap.parse_args()

    meta = {}
    if args.status:
        text = sys.stdin.read() if args.status == "-" else open(args.status, encoding="utf-8", errors="replace").read()
        meta = parse_status_dump(text)
        names = [n for _, n in meta["players"]]
        if not names:
            sys.exit("错误: 未能从 status 报文中解析出任何玩家行")
        print(f"解析 status 报文: {len(names)} 名玩家 | 地图={meta.get('map')} | 服务器={meta.get('server')} | 本机steamid={meta.get('self_steamid')}")
    elif args.names:
        names = args.names
    else:
        sys.exit("错误: 需要 --status <file> 或 --names <昵称...>")

    token = os.environ.get("WMPVP_TOKEN")
    my_sid = os.environ.get("WMPVP_STEAMID")
    if not (token and my_sid):  # 自动加载 wmpvp_login.py 抓取的凭据
        cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wmpvp_config.json")
        if os.path.exists(cfg_path):
            with open(cfg_path, encoding="utf-8") as f:
                cfg = json.load(f)
            token = token or cfg.get("token")
            my_sid = my_sid or cfg.get("steamId")
            if token and not args.with_matches:
                print(f"(已加载本地凭据: wmpvp_config.json, SteamID64={my_sid})")
    if args.with_matches and not (token and my_sid):
        sys.exit("错误: --with-matches 需要凭据。请先运行 python wmpvp_login.py 登录, "
                 "或设置环境变量 WMPVP_TOKEN 和 WMPVP_STEAMID")

    rows = []
    for name in names:
        print(f"\n=== {name} ===")
        time.sleep(0.6)
        try:
            results = search_user(name)
        except Exception as e:
            print(f"  搜索失败: {e}")
            rows.append({"name": name, "nick": "-", "steamId": "-", "userId": "-", "pw": "-",
                         "exact": False, "ban": "查询失败", "stats": None})
            continue
        if not results:
            print("  搜索无结果")
            rows.append({"name": name, "nick": "-", "steamId": "-", "userId": "-", "pw": "-",
                         "exact": False, "ban": "无此玩家", "stats": None})
            continue
        exact = [r for r in results if r.get("pvpNickName") == name]
        if not exact:
            pick = results[0]
            tag = f"模糊匹配(备选: {[r.get('pvpNickName') for r in results[:3]]})"
        elif len(exact) == 1:
            pick = exact[0]
            tag = "完全匹配"
        else:
            pick = exact[0]
            tag = f"完全匹配但重名×{len(exact)}(候选steamId: {[r.get('steamId') for r in exact]})"
        print(f"  -> {pick.get('pvpNickName')}  steamId={pick.get('steamId')}  userId={pick.get('userId')}  {pick.get('appNickName')}  [{tag}]")
        sid = pick.get("steamId")

        bans = ban_check(sid)
        ban_desc = "无封禁记录" if not bans else "; ".join(
            f"{FORBID_TYPE.get(str(b.get('forbid_type')), b.get('forbid_type'))}"
            f"({int(b.get('forbid_seconds', 0)) // 86400}天)" for b in bans if b.get("forbid_type")
        ) or str(bans)
        print(f"  封禁: {ban_desc}")

        stats = None
        if args.with_matches:
            try:
                time.sleep(0.6)
                ms = match_list(sid, my_sid, token, page_size=20)
                stats = summarize(ms)
                if stats:
                    print(f"  近{stats['games']}场: 胜率{stats['winrate']}  avg rating={stats['avg_rating']}  K/D={stats['kd']}  分数变化{stats['score_change']:+d}  模式:{stats['modes']}")
                else:
                    print("  近期无对局记录")
            except Exception as e:
                print(f"  战绩查询失败: {e}")

        rows.append({"name": name, "nick": pick.get("pvpNickName"), "steamId": sid,
                     "userId": pick.get("userId"), "pw": pick.get("appNickName"),
                     "exact": bool(exact), "ban": ban_desc, "stats": stats})

    if args.report:
        with open(args.report, "w", encoding="utf-8") as f:
            f.write("# 完美平台玩家查询报告\n\n")
            if meta:
                f.write(f"> 服务器: {meta.get('server')} | 地图: {meta.get('map')} | 本机: {meta.get('self_steamid')}\n\n")
            f.write("| 昵称(status) | 平台昵称 | SteamID64 | userId | PW号 | 封禁 | 近期战绩 |\n")
            f.write("|---|---|---|---|---|---|---|\n")
            for r in rows:
                st = ""
                if r["stats"]:
                    s = r["stats"]
                    st = f"{s['games']}场 胜率{s['winrate']} rating {s['avg_rating']} K/D {s['kd']} ({s['score_change']:+d})"
                f.write(f"| {r['name']} | {r['nick']} | {r['steamId']} | {r['userId']} | {r['pw']} | {r['ban']} | {st} |\n")
        print(f"\n报告已写入: {args.report}")


if __name__ == "__main__":
    main()
