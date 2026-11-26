"""Three independently deliverable pieces of a player card."""
import asyncio
from datetime import datetime, timezone, timedelta
import math
import re

import wmpvp_lookup as lookup
from upstream import DETAIL, HISTORY, LONG, SHORT, PlatformError, success

VERSION = {'appversion': lookup.APPVERSION}
API = 'https://api.wmpvp.com'
MATCH_FIELDS = ('matchId', 'startTime', 'endTime', 'mode', 'mapName', 'mapLogo', 'team', 'winTeam',
                'score1', 'score2', 'kill', 'death', 'assist', 'adpr', 'rws', 'pwRating', 'we',
                'pvpScore', 'pvpNormalRank', 'honor', 'derivedHonors', 'mvp', 'pvpMvp')


def score_value(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
        return value
    return None


def history_peak(scores):
    if not isinstance(scores, list):
        return None
    valid = [score for value in scores if (score := score_value(value)) is not None]
    return max(valid) if valid else None


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


def merge_detail(match, sid, detail):
    result = dict(match)
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
    else:
        raise PlatformError('format')
    return result

async def search(platform, name):
    def decode(response):
        if response.get('code') != 1:
            raise PlatformError('business')
        records = response.get('result')
        if records is not None and not isinstance(records, list):
            raise PlatformError('format')
        found = {}
        for item in records or []:
            sid = str(item.get('steamId') or '')
            if re.fullmatch(r'\d{17}', sid) and sid not in found:
                found[sid] = {'steamId': sid, 'pvpNickName': str(item.get('pvpNickName') or ''),
                              'appNickName': str(item.get('appNickName') or ''), 'pvpScore': score_value(item.get('pvpScore')),
                              'avatar': str(item.get('pvpAvatar') or '')}
        return list(found.values())
    return await platform.request('search', lookup.SEARCH_URL, {'keyword': name, 'page': 1},
                                  {**VERSION, 'Referer': 'https://client.wmpvp.com'}, decode=decode)


async def basic(platform, name, auth, *, sid='', matches=True, auto_select=True, verified=None):
    try:
        candidates = await search(platform, name)
    except PlatformError:
        if not sid:
            raise
        candidates = []
    if sid:
        picked = [next((c for c in candidates if c['steamId'] == sid),
                       {'steamId': sid, 'pvpNickName': name, 'pvpScore': None})]
    else:
        picked = [c for c in candidates if c['pvpNickName'] == name]
        if not picked or (len(picked) > 1 and not auto_select):
            return {'name': name, 'needsChoice': True, 'candidates': picked or candidates[:20],
                    'message': '请核对并选择玩家' if candidates else '未搜索到玩家'}

    async def list_only(candidate):
        row = dict(candidate, name=name, recentMatches=None, matchMessage='', historyRankState='pending')
        if not matches:
            return row
        if not auth.get('token') or not auth.get('steamId'):
            row['matchMessage'] = '请先登录并确认自己的 SteamID'
            return row
        try:
            records = await platform.matches(lookup.MATCH_URL, lookup.APPVERSION, candidate['steamId'],
                                             auth['steamId'], auth['token'])
            row['recentMatches'] = [{key: item.get(key) for key in MATCH_FIELDS} for item in records[:10]]
            for item in row['recentMatches']:
                item['honor'] = ','.join(honor_ids(item.get('honor')))
                item['detailState'] = 'pending'
            if not records:
                row['matchMessage'] = '近期无对局记录'
            if verified:
                verified(auth, True)
        except PlatformError as exc:
            row['matchMessage'] = '近期对局查询失败：' + str(exc)
            if verified and exc.kind == 'auth':
                verified(auth, False)
        return row

    players = await asyncio.gather(*(list_only(candidate) for candidate in picked))
    if len(players) == 1:
        return players[0]
    kept = [p for p in players if p['recentMatches'] != []] if any(p['recentMatches'] for p in players) else players
    return {'name': name, 'players': kept, 'message': f'找到 {len(players)} 个同名账号，显示 {len(kept)} 个。'}


async def match_player(platform, match, sid):
    match_id = str(match.get('matchId') or '')
    if not re.fullmatch(r'[A-Za-z0-9@_-]{1,80}', match_id):
        return dict(match, detailState='unavailable')

    def decode(response):
        data = success(response)
        players = data.get('players') if isinstance(data, dict) else None
        if not isinstance(players, list) or not players or not all(isinstance(p, dict) for p in players):
            raise PlatformError('format')
        fields = ('playerId','honor','mvp','pvpMvp','we','pwRating','adpr','rws','kill','death','assist',
                  'headShot','snipeNum','entryKill','endGame','flashSuccess')
        return {'players': [{k: p.get(k) for k in fields} for p in players]}

    async def fetch():
        return await platform.request('detail', API + '/api/v1/csgo/match',
                                      {'matchId': match_id, 'platform':'admin','dataSource':'3'},
                                      VERSION, priority=DETAIL, decode=decode)
    try:
        detail = await platform.cached('detail', match_id, LONG if match.get('endTime') else SHORT, fetch)
        return dict(merge_detail(match, sid, detail), detailState='ready')
    except PlatformError:
        return dict(match, detailState='unavailable')


async def history_seasons(platform):
    def decode(response):
        records = success(response)
        if not isinstance(records, list):
            raise PlatformError('format')
        seasons = {}
        now = datetime.now(timezone(timedelta(hours=8))).replace(tzinfo=None)
        for row in records:
            if not isinstance(row, dict) or not re.fullmatch(r'[A-Za-z0-9_-]{1,24}', str(row.get('season') or '')):
                continue
            try:
                ended = datetime.strptime(row['endTime'], '%Y-%m-%d %H:%M:%S') < now
            except (KeyError, TypeError, ValueError):
                ended = False
            seasons[row['season']] = ended
        if not seasons:
            raise PlatformError('format')
        return seasons
    async def fetch():
        return await platform.request('catalog', API + '/api/v2/common/matchdata/csgoSeasons',
                                      headers=VERSION, priority=HISTORY, decode=decode)
    return await platform.cached('catalog', 'seasons', 600, fetch)


async def season_history_peak(platform, sid, season, ended=False):
    def decode(response):
        data = success(response)
        if not isinstance(data, dict) or data.get('seasonId') != season:
            raise PlatformError('format')
        return history_peak(data.get('historyScores'))
    async def fetch():
        return await platform.request('season', API + '/api/v2/csgo/pvpDetailStats',
                                      {'steamId64': sid, 'csgoSeasonId': season}, VERSION,
                                      priority=HISTORY, decode=decode)
    return await platform.cached('season', f'{sid}/{season}', LONG if ended else 300, fetch)


async def query_history(platform, sid):
    catalog = True
    try:
        seasons = await history_seasons(platform)
    except PlatformError:
        seasons, catalog = {'recent': False}, False
    async def read(season, ended):
        try:
            return True, await season_history_peak(platform, sid, season, ended)
        except PlatformError:
            return False, None
    records = await asyncio.gather(*(read(s, ended) for s, ended in seasons.items()))
    completed = sum(ok for ok, _ in records)
    peak = history_peak([score for _, score in records])
    state = ('available' if peak is not None else 'empty') if catalog and completed == len(seasons) else (
        'partial' if completed else 'unavailable')
    return {'historyPeakScore': peak, 'historyRankState': state, 'historySeasonsChecked': completed,
            'historySeasonsTotal': len(seasons) if catalog else None}
