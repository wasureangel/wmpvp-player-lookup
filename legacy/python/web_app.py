"""Loopback-only web UI for the supplied lookup tool."""
import json
import asyncio
import logging
from logging.handlers import RotatingFileHandler
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

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT.parents[1]
if sys.stdout is None:
    sys.stdout = open(os.devnull, 'w', encoding='utf-8')
if sys.stderr is None:
    sys.stderr = sys.stdout
sys.path.insert(0, str(ROOT))
import wmpvp_lookup as lookup
import query_batch
from player_query import basic, match_player, query_history
from upstream import LOG, PlatformError, runtime

PORT = int(os.environ.get('WMPVP_PORT', '8765'))
ORIGIN = f'http://127.0.0.1:{PORT}'
CSRF = secrets.token_urlsafe(32)
AUTH = {}
LOCK = threading.RLock()
LAST_SMS = 0
PASSPORT = 'https://passport.pwesports.cn'
async def passport(platform, path, payload=None):
    def decode(result):
        if result.get('code') != 0:
            description = str(result.get('description') or '官方登录服务未能完成请求')[:200]
            if description == 'Invalid mobile phone':
                description = '手机号无效，请核对后重试'
            raise PlatformError('business', description)
        return result
    return await platform.request('passport', PASSPORT + path, payload, {'platform':'APP','appversion':'3.1.0'},
                                  attempts=1, decode=decode)


def field(data, key, limit=200):
    value = data.get(key, '')
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError('输入内容格式不正确')
    return value.strip()


def status():
    with LOCK:
        return {'loggedIn': bool(AUTH.get('token')), 'steamId': AUTH.get('steamId', ''),
                'matchesVerified': AUTH.get('matchesVerified', False)}


def mark_verified(auth, value):
    with LOCK:
        if AUTH.get('token') == auth.get('token') and AUTH.get('steamId') == auth.get('steamId'):
            AUTH['matchesVerified'] = value


def validate_sid(sid):
    if not re.fullmatch(r'\d{17}', sid):
        raise ValueError('玩家标识格式不正确')


async def dispatch(platform, path, data):
    global LAST_SMS
    with LOCK:
        auth = dict(AUTH)
    if path == '/api/batch/start':
        names = data.get('names')
        if not isinstance(names, list) or not 1 <= len(names) <= 20 or any(
                not isinstance(n, str) or not n.strip() or len(n) > 100 for n in names):
            raise ValueError('请输入 1–20 个昵称')
        sid = field(data, 'steamId', 17)
        if sid:
            validate_sid(sid)
            if len(names) != 1:
                raise ValueError('请只选择一个玩家')
        return query_batch.start(platform, names, auth, sid, mark_verified)
    if path in ('/api/batch/poll', '/api/batch/cancel'):
        batch = query_batch.batches.get(field(data, 'batch', 64))
        if path.endswith('/cancel'):
            if batch:
                batch.cancel()
                await asyncio.gather(batch.task, return_exceptions=True)
            return {}
        if not batch:
            raise ValueError('查询已结束或过期，请重新查询')
        return await batch.poll(data.get('cursor', 0))
    if path == '/api/batch/timing':
        event = data.get('event')
        ms, count = data.get('ms'), data.get('players')
        if (event not in ('first_player', 'all_basic', 'complete') or not isinstance(ms, int)
                or not 0 <= ms <= 86400000 or not isinstance(count, int) or not 1 <= count <= 20):
            raise ValueError('无效的耗时记录')
        LOG.info('display event=%s ms=%d players=%d', event, ms, count)
        return {}
    if path == '/api/match-ranks':
        sid = field(data, 'steamId', 17)
        if not re.fullmatch(r'\d{17}', sid):
            raise ValueError('玩家标识格式不正确')
        with LOCK:
            auth = dict(AUTH)
        if not auth.get('token') or not auth.get('steamId'):
            raise ValueError('请先在网页登录，再检查比赛字段')
        matches = await platform.matches(lookup.MATCH_URL, lookup.APPVERSION, sid, auth['steamId'], auth['token'])
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
        name, sid = field(data, 'name', 100), field(data, 'steamId', 17)
        if sid:
            validate_sid(sid)
        elif not name:
            raise ValueError('请输入昵称')
        row = await basic(platform, name, auth, sid=sid, matches=data.get('matches') is True,
                          auto_select=False, verified=mark_verified)
        if not row.get('needsChoice'):
            records = row.get('recentMatches') or []
            history, details = await asyncio.gather(query_history(platform, row['steamId']),
                asyncio.gather(*(match_player(platform, m, row['steamId']) for m in records)))
            row.update(history)
            if records:
                row['recentMatches'] = details
        return row
    if path == '/api/auth/status':
        return status()
    if path == '/api/auth/captcha':
        result = await passport(platform, '/initcaptcha')
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
        await passport(platform, '/securitycode?' + urllib.parse.urlencode({'mobilePhone': mobile, 'secCode': code, 'capTicket': ticket, 'reason': 1}))
        return {'message': '验证码已发送，请查看手机短信'}
    if path == '/api/auth/login':
        mobile, code = field(data, 'mobile', 11), field(data, 'code', 6)
        if not re.fullmatch(r'\d{11}', mobile) or not re.fullmatch(r'\d{6}', code):
            raise ValueError('请输入手机号和 6 位短信验证码')
        result = await passport(platform, '/account/login', {'appId': 10, 'mobilePhone': mobile, 'securityCode': code})
        info = (result.get('result') or {}).get('loginResult', {}).get('accountInfo', {})
        token = info.get('token')
        if not isinstance(token, str) or not token:
            raise ValueError('官方登录响应未包含可用凭据')
        sid = str(info.get('steamId') or '')
        try:
            profile = await platform.request('profile', 'https://partner.wmpvp.com/thirdparty/steamcn/user/login', {}, {'Authorization': token}, attempts=1)
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
            await platform.matches(lookup.MATCH_URL, lookup.APPVERSION, sid, sid, auth['token'], size=1, cache=False)
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
            image_path = ASSETS / self.path.lstrip('/')
            return self.send(200, image_path.read_bytes(), 'image/svg+xml' if self.path.endswith('.svg') else 'image/png')
        files = {'/': ('web.html', 'text/html; charset=utf-8'), '/app.js': ('web.js', 'text/javascript; charset=utf-8'),
                 '/app.css': ('web.css', 'text/css; charset=utf-8')}
        if self.path not in files:
            return self.send(404, {'error': '页面不存在'})
        name, kind = files[self.path]
        body = (ASSETS / name).read_text(encoding='utf-8').replace('__CSRF__', CSRF).encode()
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
            self.send(200, runtime.run(dispatch, self.path, data))
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return
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
    cache_path = Path(os.environ.get('WMPVP_CACHE_PATH', ROOT / '.lookup-cache' / 'stats.sqlite3'))
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    log_file = RotatingFileHandler(cache_path.parent / 'performance.log', maxBytes=1024*1024,
                                   backupCount=2, encoding='utf-8')
    log_file.setFormatter(logging.Formatter('%(asctime)s %(message)s'))
    LOG.addHandler(log_file)
    LOG.setLevel(logging.INFO)
    logging.basicConfig(level=logging.WARNING, format='%(asctime)s %(message)s')
    try:
        server.serve_forever()
    finally:
        server.server_close()
        runtime.close()
