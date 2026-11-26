"""Ordered basic slots and incremental patches. All state belongs to the HTTP pool's event loop."""
import asyncio
import secrets

from player_query import basic, match_player, query_history
from upstream import PlatformError

batches = {}


class Batch:
    def __init__(self, platform, names, auth, sid, verified):
        self.platform = platform
        self.id = secrets.token_urlsafe(18)
        self.events = []
        self.changed = asyncio.Event()
        self.finished = False
        self.timer = None
        self.task = asyncio.create_task(self.run(names, auth, sid, verified))
        self.touch()

    def touch(self):
        if self.timer:
            self.timer.cancel()
        self.timer = asyncio.get_running_loop().call_later(90, self.cancel)

    def cancel(self):
        batches.pop(self.id, None)
        self.timer.cancel()
        self.task.cancel()
        self.changed.set()

    def emit(self, kind, index, **fields):
        self.events.append(dict(kind=kind, index=index, **fields))
        self.changed.set()

    async def history(self, index, row):
        try:
            patch = await query_history(self.platform, row['steamId'])
        except Exception:
            patch = {'historyRankState': 'unavailable'}
        self.emit('history', index, steamId=row['steamId'], data=patch)

    async def detail(self, index, row, position, match):
        try:
            patch = await match_player(self.platform, match, row['steamId'])
        except Exception:
            patch = dict(match, detailState='unavailable')
        self.emit('detail', index, steamId=row['steamId'], position=position, data=patch)

    async def run(self, names, auth, sid, verified):
        pending = iter(enumerate(names))
        background = []

        async def worker():
            for index, name in pending:
                try:
                    data = await basic(self.platform, name, auth, sid=sid, verified=verified)
                except PlatformError as exc:
                    data = {'error': str(exc)}
                except Exception:
                    data = {'error': '玩家查询失败'}
                self.emit('base', index, data=data)
                for row in data.get('players', [data]):
                    if not row.get('steamId'):
                        continue
                    for position, match in enumerate(row.get('recentMatches') or []):
                        background.append(asyncio.create_task(self.detail(index, row, position, match)))
                    background.append(asyncio.create_task(self.history(index, row)))
        try:
            await asyncio.gather(*(worker() for _ in range(min(self.platform.limit, len(names)))))
            await asyncio.gather(*background)
        finally:
            for task in background:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*background, return_exceptions=True)
            self.finished = True
            self.changed.set()

    async def poll(self, cursor):
        if not isinstance(cursor, int) or not 0 <= cursor <= len(self.events):
            raise ValueError('查询进度无效')
        self.touch()
        if cursor == len(self.events) and not self.finished:
            self.changed.clear()
            try:
                await asyncio.wait_for(self.changed.wait(), 8)
            except asyncio.TimeoutError:
                pass
        return {'events': self.events[cursor:], 'cursor': len(self.events), 'done': self.finished}


def start(platform, names, auth, sid='', verified=None):
    if len(batches) >= 64:
        raise ValueError('查询过多，请结束旧查询后重试')
    batch = Batch(platform, names, auth, sid, verified)
    batches[batch.id] = batch
    return {'batch': batch.id}
