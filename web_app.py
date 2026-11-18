"""Loopback-only web UI for the supplied lookup tool."""
import json
import math
import os
from pathlib import Path
import re
import secrets
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent
if sys.stdout is None:
    sys.stdout = open(os.devnull, 'w', encoding='utf-8')
if sys.stderr is None:
    sys.stderr = sys.stdout
sys.path.insert(0, str(ROOT))
import wmpvp_lookup as lookup

PORT = 8765
ORIGIN = f'http://127.0.0.1:{PORT}'
CSRF = secrets.token_urlsafe(32)
AUTH = {}
LOCK = threading.RLock()
LAST_SMS = 0
PASSPORT = 'https://passport.pwesports.cn'
HISTORY_CACHE = {}
SEASONS_CACHE = {'expires': 0, 'seasons': []}


def remote(url, payload=None, headers=None):
    return lookup.http_json(url, payload, headers, retries=1)


def passport(path, payload=None):
    result = remote(PASSPORT + path, payload, {'platform': 'APP', 'appversion': '3.1.0'})
    if result.get('code') != 0:
        description = str(result.get('description') or '官方登录服务未能完成请求')[:200]
        if description == 'Invalid mobile phone':
            description = '手机号无效，请核对后重试'
        raise ValueError(description)
    return result


def field(data, key, limit=200):
    value = data.get(key, '')
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError('输入内容格式不正确')
    return value.strip()


def status():
    with LOCK:
        return {'loggedIn': bool(AUTH.get('token')), 'steamId': AUTH.get('steamId', ''),
                'matchesVerified': AUTH.get('matchesVerified', False)}


def score_value(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
        return value
    return None


def history_peak(scores):
    if not isinstance(scores, list):
        return None
    valid = [score for value in scores if (score := score_value(value)) is not None]
    return max(valid) if valid else None


def season_history_peak(sid, season):
    # historyScores belongs to the requested season, not the player's whole career.
    response = remote('https://api.wmpvp.com/api/v2/csgo/pvpDetailStats',
                      {'steamId64': sid, 'csgoSeasonId': season},
                      {'appversion': lookup.APPVERSION})
    if response.get('statusCode') != 0 or not isinstance(response.get('data'), dict):
        raise ValueError('历史分数查询失败')
    if response['data'].get('seasonId') != season:
        raise ValueError('历史赛季返回不匹配')
    return history_peak(response['data'].get('historyScores'))


def history_seasons():
    with LOCK:
        if SEASONS_CACHE['expires'] > time.monotonic():
            return list(SEASONS_CACHE['seasons'])
    response = remote('https://api.wmpvp.com/api/v2/common/matchdata/csgoSeasons',
                      headers={'appversion': lookup.APPVERSION})
    if response.get('statusCode') != 0 or not isinstance(response.get('data'), list):
        raise ValueError('赛季列表查询失败')
    seasons = list(dict.fromkeys(s.get('season') for s in response['data']
                               if isinstance(s, dict) and isinstance(s.get('season'), str)
                               and re.fullmatch(r'[A-Za-z0-9_-]{1,24}', s['season'])))
    if not seasons:
        raise ValueError('未取得赛季列表')
    with LOCK:
        SEASONS_CACHE.update(expires=time.monotonic() + 3600, seasons=seasons)
    return seasons


def query_history(sid):
    with LOCK:
        cached = HISTORY_CACHE.get(sid)
        if cached and cached[0] > time.monotonic():
            return dict(cached[1])
    list_available = True
    try:
        seasons = history_seasons()
    except Exception:
        seasons, list_available = ['recent'], False
    def fetch(season):
        try:
            return True, season_history_peak(sid, season)
        except Exception:
            return False, None
    with ThreadPoolExecutor(max_workers=3) as pool:
        records = list(pool.map(fetch, seasons))
    completed = sum(ok for ok, _ in records)
    peak = history_peak([score for _, score in records])
    complete = list_available and completed == len(seasons)
    state = ('available' if peak is not None else 'empty') if complete else ('partial' if completed else 'unavailable')
    result = {'historyPeakScore': peak, 'historyRankState': state,
              'historySeasonsChecked': completed, 'historySeasonsTotal': len(seasons) if list_available else None}
    # Only complete results are cached; transient failures must be retried.
    if complete:
        with LOCK:
            if len(HISTORY_CACHE) >= 128:
                HISTORY_CACHE.pop(next(iter(HISTORY_CACHE)))
            HISTORY_CACHE[sid] = (time.monotonic() + 600, dict(result))
    return result


def honor_ids(value):
    """Normalize the official honor IDs; empty or unknown codes add no badge."""
    if isinstance(value, str):
        values = value.split(',')
    elif isinstance(value, list):
        values = value
    else:
        values = [value]
    return [code for item in values if (code := str(item).strip()) in ('1', '2', '3', '4', '5', '6', '7')]


def missing_pro_honors(players, sid):
    """Fallback matched against eight client rows when all Pro honors are null.

    Select the first maximum in API player order, not every tied player. Only
    complete ten-player numeric data can establish an award; zero earns none.
    """
    if len(players) != 10 or len({str(p.get('playerId')) for p in players}) != 10:
        return []
    if any(honor_ids(p.get('honor')) for p in players):
        return []
    awards = []
    for code, key in [('2', 'headShot'), ('3', 'snipeNum'), ('4', 'entryKill'),
                      ('5', 'endGame'), ('6', 'flashSuccess'), ('7', 'assist')]:
        values = [score_value(p.get(key)) for p in players]
        if any(v is None for v in values) or max(values) <= 0:
            continue
        winner = players[values.index(max(values))]
        if str(winner.get('playerId')) == sid:
            awards.append(code)
    return awards


def match_player(match, sid):
    """Enrich one listed match, always selecting the player by ID, never nickname."""
    result = dict(match)
    result['honor'] = ','.join(dict.fromkeys(honor_ids(match.get('honor'))))
    match_id = str(match.get('matchId') or '')
    if not re.fullmatch(r'[A-Za-z0-9@_-]{1,80}', match_id):
        return result
    try:
        response = remote('https://api.wmpvp.com/api/v1/csgo/match',
                          {'matchId': match_id, 'platform': 'admin', 'dataSource': '3'},
                          {'appversion': lookup.APPVERSION})
        detail = response.get('data')
        if response.get('statusCode') != 0 or not isinstance(detail, dict):
            return result
        players = detail.get('players') or []
        player = next((p for p in players
                       if str(p.get('playerId')) == sid), None)
        if player:
            # Prefer the match-list WE precision; fill only the known detail fields.
            for key in ('we', 'pwRating', 'adpr', 'rws', 'kill', 'death', 'assist'):
                if score_value(result.get(key)) is None:
                    result[key] = player.get(key)
            # The list may contain only a subset (e.g. "1"); detail contains
            # the remaining awards. A nonempty list value must not hide them.
            result['honor'] = ','.join(dict.fromkeys(
                honor_ids(result.get('honor')) + honor_ids(player.get('honor'))))
            if match.get('mode') == '完美官匹Pro':
                derived = missing_pro_honors(players, sid)
                if derived:
                    result['honor'] = ','.join(dict.fromkeys(honor_ids(result['honor']) + derived))
                    result['derivedHonors'] = derived
            for key in ('mvp', 'pvpMvp'):
                result[key] = result.get(key) is True or player.get(key) is True
    except Exception:
        pass  # Missing detail must never erase the confirmed match or become zero.
    return result


def recent_matches(sid, auth):
    """Fetch ten individual games once; details supply ADR, RWS and honors."""
    matches = lookup.match_list(sid, auth['steamId'], auth['token'], page_size=10)[:10]
    with ThreadPoolExecutor(max_workers=3) as pool:
        enriched = list(pool.map(lambda match: match_player(match, sid), matches))
    keys = ('startTime', 'endTime', 'mode', 'mapName', 'mapLogo', 'team', 'winTeam', 'score1', 'score2',
            'kill', 'death', 'assist', 'adpr', 'rws', 'pwRating', 'we', 'pvpScore',
            'pvpNormalRank', 'honor', 'derivedHonors', 'mvp', 'pvpMvp')
    return [{key: match.get(key) for key in keys} for match in enriched]


def query(data):
    name = field(data, 'name', 100)
    sid = field(data, 'steamId', 17)
    if not sid:
        if not name:
            raise ValueError('请输入昵称')
        response = remote(lookup.SEARCH_URL, {'keyword': name, 'page': 1},
                          {'appversion': lookup.APPVERSION, 'Referer': 'https://client.wmpvp.com'})
        if response.get('code') != 1 or not isinstance(response.get('result'), (list, type(None))):
            raise ValueError('昵称搜索接口返回异常，请稍后重试')
        candidates = [{**{k: str(r.get(k) or '') for k in ('steamId', 'pvpNickName', 'appNickName')},
                       'pvpScore': score_value(r.get('pvpScore')), 'avatar': str(r.get('pvpAvatar') or '')}
                      for r in response.get('result') or [] if re.fullmatch(r'\d{17}', str(r.get('steamId', '')))]
        exact = [r for r in candidates if r['pvpNickName'] == name]
        if len(exact) != 1:
            return {'name': name, 'candidates': exact or candidates[:20],
                    'needsChoice': True, 'message': '请核对并选择玩家' if candidates else '未搜索到玩家'}
        picked = exact[0]
        sid = picked['steamId']
    else:
        picked = {'steamId': sid, 'pvpNickName': name, 'appNickName': '', 'pvpScore': None}
        if not re.fullmatch(r'\d{17}', sid):
            raise ValueError('SteamID64 应为 17 位数字')
        try:
            response = remote(lookup.SEARCH_URL, {'keyword': name, 'page': 1},
                              {'appversion': lookup.APPVERSION, 'Referer': 'https://client.wmpvp.com'})
            if response.get('code') == 1:
                matched = next((r for r in response.get('result') or [] if str(r.get('steamId')) == sid), {})
                picked['pvpScore'] = score_value(matched.get('pvpScore'))
                picked['avatar'] = str(matched.get('pvpAvatar') or '')
        except Exception:
            pass
    if not re.fullmatch(r'\d{17}', sid):
        raise ValueError('SteamID64 应为 17 位数字')
    row = {'name': name, **picked, 'recentMatches': None, 'matchMessage': ''}
    row['historyPeakScore'] = None
    row['historyRankState'] = 'unavailable'
    try:
        row.update(query_history(sid))
    except Exception:
        pass
    if data.get('matches') is True:
        with LOCK:
            auth = dict(AUTH)
        if not auth.get('token') or not auth.get('steamId'):
            row['matchMessage'] = '请先登录并确认自己的 SteamID'
        else:
            try:
                row['recentMatches'] = recent_matches(sid, auth)
                row['matchMessage'] = '' if row['recentMatches'] else '近期无对局记录'
                with LOCK:
                    if AUTH.get('token') == auth['token']:
                        AUTH['matchesVerified'] = True
            except Exception:
                row['matchMessage'] = '战绩查询失败：登录可能过期、SteamID 不匹配或接口不可用'
                with LOCK:
                    AUTH['matchesVerified'] = False
    return row


def dispatch(path, data):
    global LAST_SMS
    if path == '/api/match-ranks':
        sid = field(data, 'steamId', 17)
        if not re.fullmatch(r'\d{17}', sid):
            raise ValueError('玩家标识格式不正确')
        with LOCK:
            auth = dict(AUTH)
        if not auth.get('token') or not auth.get('steamId'):
            raise ValueError('请先在网页登录，再检查比赛字段')
        matches = lookup.match_list(sid, auth['steamId'], auth['token'], page_size=10)[:10]
        keys = ('matchId', 'startTime', 'endTime', 'mapName', 'mode', 'rank', 'oldrank', 'deltaRank',
                'pvpScore', 'pvpScoreChange', 'pvpScoreChangeType', 'pvpStars', 'pvpNormalRank',
                'pvpGrading', 'matchType', 'gameMode', 'dataSource', 'team', 'winTeam',
                'score1', 'score2', 'kill', 'death', 'assist', 'rating', 'pwRating', 'we', 'status')
        return {'records': [{key: match[key] for key in keys if key in match} for match in matches]}
    if path == '/api/parse':
        text = field(data, 'text', 60000)
        if data.get('mode') == 'status':
            names = [name for _, name in lookup.parse_status_dump(text)['players']]
        else:
            names = [line.strip() for line in text.splitlines() if line.strip()]
        names = list(dict.fromkeys(names))
        if not names or len(names) > 20 or any(len(n) > 100 for n in names):
            raise ValueError('请输入 1–20 个昵称，每行一个；status 模式请粘贴完整玩家行')
        return {'names': names}
    if path == '/api/query':
        return query(data)
    if path == '/api/auth/status':
        return status()
    if path == '/api/auth/captcha':
        result = passport('/initcaptcha')
        if not result.get('capTicket'):
            raise ValueError('官方验证码未返回验证票据')
        return {'capTicket': result['capTicket']}
    if path == '/api/auth/sms':
        mobile = field(data, 'mobile', 11)
        if not re.fullmatch(r'\d{11}', mobile):
            raise ValueError('请输入 11 位手机号')
        ticket, code = field(data, 'ticket', 4096), field(data, 'code', 4096)
        if not ticket or not code:
            raise ValueError('请先完成人机验证')
        with LOCK:
            if time.monotonic() - LAST_SMS < 60:
                raise ValueError('请等待 60 秒后再发送短信')
            LAST_SMS = time.monotonic()
        passport('/securitycode?' + urllib.parse.urlencode({'mobilePhone': mobile, 'secCode': code, 'capTicket': ticket, 'reason': 1}))
        return {'message': '验证码已发送，请查看手机短信'}
    if path == '/api/auth/login':
        mobile, code = field(data, 'mobile', 11), field(data, 'code', 6)
        if not re.fullmatch(r'\d{11}', mobile) or not re.fullmatch(r'\d{6}', code):
            raise ValueError('请输入手机号和 6 位短信验证码')
        result = passport('/account/login', {'appId': 10, 'mobilePhone': mobile, 'securityCode': code})
        info = (result.get('result') or {}).get('loginResult', {}).get('accountInfo', {})
        token = info.get('token')
        if not isinstance(token, str) or not token:
            raise ValueError('官方登录响应未包含可用凭据')
        sid = str(info.get('steamId') or '')
        try:
            profile = remote('https://partner.wmpvp.com/thirdparty/steamcn/user/login', {}, {'Authorization': token})
            user = (profile.get('result') or {}).get('user') or {}
            sid = str(user.get('steamId') or sid)
        except Exception:
            pass
        if not re.fullmatch(r'\d{17}', sid):
            sid = ''
        with LOCK:
            AUTH.clear()
            AUTH.update(token=token, steamId=sid, matchesVerified=False)
        return status()
    if path == '/api/auth/steamid':
        sid = field(data, 'steamId', 17)
        with LOCK:
            auth = dict(AUTH)
        if not auth.get('token'):
            raise ValueError('请先登录')
        if not re.fullmatch(r'\d{17}', sid):
            raise ValueError('请输入自己的 17 位 SteamID64')
        try:
            lookup.match_list(sid, sid, auth['token'], page_size=1)
        except Exception:
            raise ValueError('战绩接口验证失败，请核对 SteamID；也可能是此登录凭据不适用于战绩接口')
        with LOCK:
            if AUTH.get('token') != auth['token']:
                raise ValueError('登录状态已变化，请重试')
            AUTH.update(steamId=sid, matchesVerified=True)
        return status()
    if path == '/api/auth/logout':
        with LOCK:
            AUTH.clear()
        return status()
    raise ValueError('未知操作')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, status_code, body, content_type='application/json; charset=utf-8'):
        raw = json.dumps(body, ensure_ascii=False).encode() if isinstance(body, dict) else body
        self.send_response(status_code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.end_headers()
        self.wfile.write(raw)

    def valid_host(self):
        return self.headers.get('Host') == f'127.0.0.1:{PORT}'

    def do_GET(self):
        if not self.valid_host():
            return self.send(403, {'error': '只允许从本机页面访问'})
        if self.path == '/health':
            return self.send(200, {'app': 'wmpvp-local-web-v1'})
        if re.fullmatch(r'/rank-assets/(?:D|C|C1|C11|B|B1|B11|A|A1|A11|none|ABC_bg|C11_bg|B11_bg|A11_bg)\.svg', self.path) or self.path == '/rank-assets/s-brass.png':
            image_path = ROOT / self.path.lstrip('/')
            return self.send(200, image_path.read_bytes(), 'image/svg+xml' if self.path.endswith('.svg') else 'image/png')
        files = {'/': ('web.html', 'text/html; charset=utf-8'), '/app.js': ('web.js', 'text/javascript; charset=utf-8'),
                 '/app.css': ('web.css', 'text/css; charset=utf-8')}
        if self.path not in files:
            return self.send(404, {'error': '页面不存在'})
        name, kind = files[self.path]
        body = (ROOT / name).read_text(encoding='utf-8').replace('__CSRF__', CSRF).encode()
        self.send(200, body, kind)

    def do_POST(self):
        if not self.valid_host() or self.headers.get('Origin') != ORIGIN or not secrets.compare_digest(self.headers.get('X-App-Token', ''), CSRF):
            return self.send(403, {'error': '请从本机网页重新打开工具'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 100000:
                raise ValueError('输入内容过长或为空')
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError('输入格式不正确')
            self.send(200, dispatch(self.path, data))
        except ValueError as exc:
            self.send(400, {'error': str(exc)})
        except Exception:
            self.send(502, {'error': '平台暂时无响应或返回异常，请稍后重试'})


if __name__ == '__main__':
    try:
        server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    except OSError:
        try:
            with urllib.request.urlopen(ORIGIN + '/health', timeout=2) as response:
                existing = json.load(response)
            if existing.get('app') != 'wmpvp-local-web-v1':
                raise RuntimeError('端口被其他程序占用')
            webbrowser.open(ORIGIN)
        except Exception:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, '8765 端口已被占用，请关闭占用程序后重试。', '启动失败', 0)
        sys.exit()
    if '--open' in sys.argv:
        threading.Timer(0.5, lambda: webbrowser.open(ORIGIN)).start()
    server.serve_forever()
