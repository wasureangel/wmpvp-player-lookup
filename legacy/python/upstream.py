"""One event loop, HTTP connection pool and admission queue per process."""
import asyncio
from collections import Counter
from contextlib import asynccontextmanager
from datetime import timezone
from email.utils import parsedate_to_datetime
import hashlib
import json
import logging
import os
from pathlib import Path
import sqlite3
import threading
import time

import httpx

LOG = logging.getLogger('lookup.performance')
# httpx's INFO line includes the full URL, which can contain SMS credentials.
logging.getLogger('httpx').setLevel(logging.WARNING)
logging.getLogger('httpcore').setLevel(logging.WARNING)

BASIC, DETAIL, HISTORY = range(3)
SHORT = 60
LONG = 180 * 86400


class PlatformError(ValueError):
    messages = {'network': '连接平台失败', 'timeout': '平台请求超时', 'auth': '登录失效或权限不足',
                'rate': '平台限流，请稍后重试', 'server': '平台服务暂时不可用',
                'http': '平台拒绝了请求', 'business': '平台未能完成请求', 'format': '平台返回的数据异常'}

    def __init__(self, kind, message=None):
        self.kind = kind
        super().__init__(message or self.messages[kind])


def retry_after(value):
    if not value:
        return None
    try:
        return max(0, int(value))
    except ValueError:
        try:
            date = parsedate_to_datetime(value)
            if date.tzinfo is None:
                date = date.replace(tzinfo=timezone.utc)
            return max(0, date.timestamp() - time.time())
        except (ValueError, TypeError, OverflowError):
            return None


class Scheduler:
    def __init__(self, limit):
        self.limit = limit
        self.active = 0
        self.waiting = [0, 0, 0]
        self.changed = asyncio.Condition()

    @asynccontextmanager
    async def slot(self, priority):
        async with self.changed:
            self.waiting[priority] += 1
            try:
                await self.changed.wait_for(lambda: self.active < self.limit and not any(self.waiting[:priority]))
                self.active += 1
            finally:
                self.waiting[priority] -= 1
                self.changed.notify_all()
        try:
            yield
        finally:
            async with self.changed:
                self.active -= 1
                self.changed.notify_all()


class Platform:
    def __init__(self, db_path=None, limit=None, transport=None):
        self.limit = limit if limit is not None else int(os.getenv('WMPVP_CONCURRENCY', '6'))
        if not 1 <= self.limit <= 64:
            raise ValueError('WMPVP_CONCURRENCY 应为 1 到 64')
        self.gate = Scheduler(self.limit)
        self.client = httpx.AsyncClient(
            transport=transport, timeout=httpx.Timeout(8, connect=4),
            limits=httpx.Limits(max_connections=self.limit, max_keepalive_connections=self.limit),
            headers={'Accept': 'application/json'})
        if db_path is None:
            db_path = Path(os.environ.get('WMPVP_CACHE_PATH', Path(__file__).parent / '.lookup-cache' / 'stats.sqlite3'))
            db_path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(db_path)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=NORMAL')
        self.db.execute('CREATE TABLE IF NOT EXISTS cache (api TEXT, key TEXT, expires REAL, value TEXT, PRIMARY KEY(api,key))')
        self.db.execute('DELETE FROM cache WHERE expires <= ?', (time.time(),))
        self.db.commit()
        self.next_cleanup = time.monotonic() + 3600
        self.flights = {}
        self.cooldown = {}
        self.metrics = Counter()

    async def close(self):
        tasks = [flight[0] for flight in self.flights.values()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.client.aclose()
        self.db.close()

    async def cached(self, api, key, ttl, fetch):
        if time.monotonic() >= self.next_cleanup:
            with self.db:
                self.db.execute('DELETE FROM cache WHERE expires <= ?', (time.time(),))
            self.next_cleanup = time.monotonic() + 3600
        row = self.db.execute('SELECT value FROM cache WHERE api=? AND key=? AND expires>?', (api, key, time.time())).fetchone()
        self.metrics[api, 'lookups'] += 1
        self.metrics[api, 'hits'] += int(row is not None)
        LOG.info('cache api=%s hit=%d hit_rate=%.3f', api, row is not None,
                 self.metrics[api, 'hits'] / self.metrics[api, 'lookups'])
        if row:
            return json.loads(row[0])

        async def fill():
            value = await fetch()
            with self.db:
                self.db.execute('INSERT OR REPLACE INTO cache VALUES (?,?,?,?)',
                                (api, key, time.time() + ttl, json.dumps(value, separators=(',', ':'))))
            return value

        token = (api, key)
        if token not in self.flights:
            self.flights[token] = [asyncio.create_task(fill()), 0]
        flight = self.flights[token]
        flight[1] += 1
        try:
            return await asyncio.shield(flight[0])
        finally:
            flight[1] -= 1
            if flight[1] == 0:
                self.flights.pop(token, None)
                if not flight[0].done():
                    flight[0].cancel()
                await asyncio.gather(flight[0], return_exceptions=True)

    async def request(self, api, url, payload=None, headers=None, *, priority=BASIC,
                      attempts=2, decode=None, method=None):
        host = httpx.URL(url).host
        for attempt in range(attempts):
            while True:
                # Recheck after admission: another request may have received 429 while we queued.
                delay = self.cooldown.get(host, 0) - time.monotonic()
                if delay > 12:
                    raise PlatformError('rate')
                if delay > 0:
                    await asyncio.sleep(delay)
                async with self.gate.slot(priority):
                    if self.cooldown.get(host, 0) > time.monotonic():
                        continue
                    start = time.monotonic()
                    error = None
                    backoff = 0.25 * 2 ** attempt
                    self.metrics[api, 'requests'] += 1
                    count = self.metrics[api, 'requests']
                    outcome = 'ok'
                    try:
                        response = await self.client.request(method or ('GET' if payload is None else 'POST'),
                                                             url, json=payload, headers=headers)
                        status = response.status_code
                        if status in (401, 403):
                            raise PlatformError('auth')
                        if status == 429 or 500 <= status < 600:
                            requested = retry_after(response.headers.get('Retry-After'))
                            if requested is not None or status == 429:
                                backoff = requested if requested is not None else 1.0
                                self.cooldown[host] = max(self.cooldown.get(host, 0), time.monotonic() + backoff)
                            raise PlatformError('rate' if status == 429 else 'server')
                        if not 200 <= status < 300:
                            raise PlatformError('http')
                        data = response.json()
                        if not isinstance(data, dict):
                            raise PlatformError('format')
                        return decode(data) if decode else data
                    except asyncio.CancelledError:
                        outcome = 'cancelled'
                        raise
                    except PlatformError as exc:
                        error = exc
                    except httpx.TimeoutException:
                        error = PlatformError('timeout')
                    except httpx.TransportError:
                        error = PlatformError('network')
                    except (ValueError, KeyError, TypeError):
                        error = PlatformError('format')
                    finally:
                        LOG.info('upstream api=%s count=%d ms=%.1f attempt=%d outcome=%s', api,
                                 count, (time.monotonic()-start)*1000, attempt+1,
                                 error.kind if error else outcome)
                break
            if attempt+1 == attempts or error.kind not in {'network', 'timeout', 'rate', 'server'} or backoff > 12:
                raise error
            self.metrics[api, 'retries'] += 1
            LOG.info('retry api=%s count=%d reason=%s', api, self.metrics[api, 'retries'], error.kind)
            await asyncio.sleep(backoff)

    async def matches(self, url, version, sid, viewer, token, page=1, size=10, cache=True):
        def decode(data):
            data = success(data)
            rows = data.get('matchList') if isinstance(data, dict) else None
            if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                raise PlatformError('format')
            # Store only the fields consumed by the web, CLI and rank inspector.
            fields = {'matchId','startTime','endTime','mode','mapName','mapLogo','team','winTeam',
                      'score1','score2','kill','death','assist','adpr','rws','pwRating','we','pvpScore',
                      'pvpNormalRank','honor','mvp','pvpMvp','rank','oldrank','deltaRank','pvpStars',
                      'pvpScoreChange','pvpScoreChangeType','pvpGrading','matchType','gameMode','dataSource','rating','status'}
            return [{k:v for k,v in row.items() if k in fields} for row in rows[:size]]

        async def fetch():
            return await self.request('recent', url, {'csgoSeasonId':'recent','dataSource':3,'mySteamId':int(viewer),
                'page':page,'pageSize':size,'pvpType':-1,'toSteamId':int(sid)},
                {'appversion':version,'token':token}, decode=decode)
        if not cache:
            return await fetch()
        # Separate viewers and login sessions without writing a token to disk.
        scope = hashlib.sha256(token.encode()).hexdigest()
        return await self.cached('recent', f'{viewer}/{scope}/{sid}/{page}/{size}', SHORT, fetch)


def success(response):
    code = response.get('statusCode')
    if code != 0:
        message = str(response.get('errorMessage') or '').lower()
        auth = code in (401, 403) or any(word in message for word in ('token', '登录', '未授权'))
        raise PlatformError('auth' if auth else 'business')
    return response.get('data')


class Runtime:
    """Bridge the local HTTP server's handler threads to one owning event loop."""
    def __init__(self):
        self.lock = threading.Lock()
        self.loop = None

    def run(self, fn, *args, **kwargs):
        with self.lock:
            if self.loop is None:
                self.loop = asyncio.new_event_loop()
                threading.Thread(target=self.loop.run_forever, daemon=True).start()
                async def create():
                    return Platform()
                try:
                    self.platform = asyncio.run_coroutine_threadsafe(create(), self.loop).result()
                except Exception:
                    self.loop.call_soon_threadsafe(self.loop.stop)
                    self.loop = None
                    raise
        return asyncio.run_coroutine_threadsafe(fn(self.platform, *args, **kwargs), self.loop).result()

    def close(self):
        if self.loop:
            asyncio.run_coroutine_threadsafe(self.platform.close(), self.loop).result()
            self.loop.call_soon_threadsafe(self.loop.stop)


runtime = Runtime()
