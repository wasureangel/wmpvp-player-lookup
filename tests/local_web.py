import json
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
import player_query as q
import web_app as web
from upstream import Platform, PlatformError

SID = '76561198000000000'
OTHER = '76561198000000001'
AUTH = {'steamId': SID, 'token': 'fixture-token'}


class WebTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.p = Platform(':memory:', transport=httpx.MockTransport(self.respond))
        self.responses = {}
        self.calls = []

    async def asyncTearDown(self):
        web.AUTH.clear()
        await self.p.close()

    def respond(self, request):
        path = request.url.path.rsplit('/', 1)[-1]
        self.calls.append((path, json.loads(request.content) if request.content else {}))
        item = self.responses[path]
        result = item(self.calls[-1][1]) if callable(item) else item
        return httpx.Response(200, json=result)

    async def dispatch(self, path, **data):
        return await web.dispatch(self.p, '/api/' + path, data)

    async def test_parse_and_limits(self):
        self.assertEqual((await self.dispatch('parse', text='a\na\nb'))['names'], ['a','b'])
        with self.assertRaises(ValueError):
            await self.dispatch('parse', text='\n'.join(map(str,range(21))))

    async def test_rank_inspection_requires_login_and_preserves_raw_values(self):
        with self.assertRaises(ValueError):
            await self.dispatch('match-ranks', steamId=OTHER)
        web.AUTH.update(AUTH)
        matches = [{'rank':12345,'oldrank':12000,'deltaRank':345,'pvpScore':1800,'mode':'test'},
                   {'rank':0,'oldrank':0,'deltaRank':None},{'rank':0}]
        self.responses['list'] = {'statusCode':0,'data':{'matchList':[dict(m,token='hidden') for m in matches]}}
        self.assertEqual((await self.dispatch('match-ranks',steamId=OTHER))['records'], matches)
        self.assertEqual(self.calls[0][1]['toSteamId'], int(OTHER))
        self.assertEqual(self.calls[0][1]['pageSize'],10)

    async def test_ambiguous_never_autopicks(self):
        self.responses['user'] = {'code':1,'result':[{'steamId':SID,'pvpNickName':'other'}]}
        self.assertTrue((await q.basic(self.p,'wanted',{}))['needsChoice'])

    async def test_login_hides_token_and_logout_clears(self):
        response = {'result':{'loginResult':{'accountInfo':AUTH}}}
        with patch.object(web, 'passport', new=AsyncMock(return_value=response)), patch.object(self.p,'request',return_value={}):
            result = await self.dispatch('auth/login',mobile='00000000000', code='000000')
        self.assertTrue(result['loggedIn'])
        self.assertNotIn(AUTH['token'], json.dumps(result))
        self.assertFalse(result['matchesVerified'])
        self.assertFalse((await self.dispatch('auth/logout'))['loggedIn'])

    async def test_verify_failure_not_accepted(self):
        web.AUTH.update(AUTH)
        self.responses['list'] = {'statusCode':403}
        with self.assertRaises(ValueError):
            await self.dispatch('auth/steamid', steamId=SID)
        self.assertFalse(web.status()['matchesVerified'])

    async def test_score_matches_selected_id(self):
        self.responses['user'] = {'code':1,'result':[{'steamId':SID,'pvpNickName':'test','pvpScore':900},
                                                     {'steamId':OTHER,'pvpNickName':'test','pvpScore':2431}]}
        row = await q.basic(self.p,'test',{},sid=OTHER)
        self.assertEqual(row['pvpScore'],2431)
        self.assertEqual(row['historyRankState'],'pending')

    def test_score_missing_not_unranked(self):
        for value in [None,True,float('nan'),-1]:
            self.assertIsNone(q.score_value(value))
        self.assertEqual(q.score_value(0),0)

    def test_history_peak_uses_only_valid_history_scores(self):
        self.assertEqual(q.history_peak([1528,1553,1887]),1887)
        self.assertEqual(q.history_peak([0,None,True,-1,'2800',float('nan')]),0)
        for value in [[],None,{'score':3000}]:
            self.assertIsNone(q.history_peak(value))

    async def test_detail_selects_id_and_keeps_list_precision(self):
        self.responses['match'] = {'statusCode':0,'data':{'players':[{'playerId':OTHER,'adpr':900},
                                 {'playerId':SID,'adpr':73,'we':6.5,'pwRating':1.05,'rws':8.4}]}}
        result = await q.match_player(self.p,{'matchId':'PVP@123','we':6.5461},SID)
        self.assertEqual((result['adpr'],result['we']), (73,6.5461))
        self.responses['match'] = {'statusCode':404}
        result = await q.match_player(self.p,{'matchId':'PVP@456','kill':5},SID)
        self.assertEqual((result['kill'],result['detailState']), (5,'unavailable'))

    async def test_authenticated_recent_path_requests_ten_and_enriches_only_ten(self):
        self.responses.update(user={'code':1,'result':[{'steamId':SID,'pvpNickName':'test'}]},
            list={'statusCode':0,'data':{'matchList':[{'matchId':f'm{i}'} for i in range(11)]}},
            match={'statusCode':0,'data':{'players':[{'playerId':SID,'adpr':80}]}},
            csgoSeasons={'statusCode':0,'data':[{'season':'S1'}]},
            pvpDetailStats={'statusCode':0,'data':{'seasonId':'S1','historyScores':[]}})
        web.AUTH.update(AUTH)
        row = await self.dispatch('query', name='test', matches=True)
        self.assertEqual(len(row['recentMatches']),10)
        self.assertEqual([k for k,_ in self.calls].count('match'),10)
        self.assertEqual(next(p['pageSize'] for k,p in self.calls if k=='list'),10)
        self.assertNotIn('stats',row)
        self.assertNotIn('ban',row)

    async def test_history_does_not_fall_back_to_current_or_scorelist(self):
        self.responses['pvpDetailStats'] = {'statusCode':0,'data':{'seasonId':'S25','pvpScore':2500,'scoreList':[{'score':3000}]}}
        self.assertIsNone(await q.season_history_peak(self.p,SID,'S25'))
        self.responses['pvpDetailStats'] = {'statusCode':90003}
        with self.assertRaises(PlatformError):
            await q.season_history_peak(self.p,OTHER,'S25')

    async def test_history_empty_recent_does_not_hide_old_season_peak(self):
        self.responses['csgoSeasons'] = {'statusCode':0,'data':[{'season':s} for s in ('S25','S23','S15')]}
        def stats(body):
            s = body['csgoSeasonId']
            return {'statusCode':0,'data':{'seasonId':s,'historyScores':{'S25':[],'S23':[2687],'S15':[2500,2852]}[s]}}
        self.responses['pvpDetailStats'] = stats
        result = await q.query_history(self.p,SID)
        self.assertEqual((result['historyPeakScore'],result['historyRankState'],result['historySeasonsChecked']), (2852,'available',3))
        self.assertEqual(await q.query_history(self.p,SID),result)
        self.assertEqual(len(self.calls),4)

    async def test_partial_seasons_are_explicit_and_failed_season_retried(self):
        self.responses['csgoSeasons'] = {'statusCode':0,'data':[{'season':'S25'},{'season':'S15'}]}
        self.responses['pvpDetailStats'] = lambda b: ({'statusCode':403} if b['csgoSeasonId']=='S25'
              else {'statusCode':0,'data':{'seasonId':'S15','historyScores':[2852]}})
        result = await q.query_history(self.p,SID)
        self.assertEqual((result['historyRankState'],result['historyPeakScore']),('partial',2852))
        await q.query_history(self.p,SID)
        self.assertEqual(len(self.calls),4)

    async def test_missing_season_catalog_never_claims_full_history(self):
        with patch.object(q,'history_seasons',side_effect=PlatformError('network')), patch.object(q,'season_history_peak',return_value=1528):
            result = await q.query_history(self.p,SID)
        self.assertEqual(result['historyRankState'],'partial')
        self.assertIsNone(result['historySeasonsTotal'])
        self.responses['pvpDetailStats'] = {'statusCode':0,'data':{'seasonId':'S25','historyScores':[9999]}}
        with self.assertRaises(PlatformError):
            await q.season_history_peak(self.p,SID,'S15')

    def test_detail_keeps_zero_and_fills_honors_for_correct_player(self):
        detail={'players':[{'playerId':'other','honor':'1'},{'playerId':SID,'honor':'5,2','assist':4,'adpr':70,'pwRating':1.2}]}
        result=q.merge_detail({'kill':0,'death':0,'pwRating':0},SID,detail)
        self.assertEqual(result['honor'],'5,2')
        self.assertEqual(result['assist'],4)
        self.assertEqual(result['pwRating'],0)

    async def test_records_whitelist_and_detail_failure_preserve_matches(self):
        self.responses.update(user={'code':1,'result':[{'steamId':SID,'pvpNickName':'test'}]},
               list={'statusCode':0,'data':{'matchList':[{'matchId':'PVP@1','kill':5,'honor':'5','token':'hidden','headShotRatio':.5}]}},
               match={'statusCode':3})
        row=await q.basic(self.p,'test',AUTH)
        record=await q.match_player(self.p,row['recentMatches'][0],SID)
        self.assertEqual(record['kill'],5)
        self.assertIsNone(record['adpr'])
        self.assertNotIn('token',record)
        self.assertNotIn('headShotRatio',record)
        self.assertEqual([k for k,_ in self.calls],['user','list','match'])


if __name__ == '__main__':
    unittest.main()
