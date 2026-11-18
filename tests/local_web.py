import importlib.util
import json
from pathlib import Path
from unittest.mock import patch
import unittest

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('web', root / 'web_app.py')
web = importlib.util.module_from_spec(spec)
spec.loader.exec_module(web)

class WebTests(unittest.TestCase):
    def tearDown(self):
        web.AUTH.clear()
        web.HISTORY_CACHE.clear()
        web.SEASONS_CACHE.update(expires=0, seasons=[])

    def test_parse_and_limits(self):
        self.assertEqual(web.dispatch('/api/parse', {'text':'a\na\nb'})['names'], ['a','b'])
        with self.assertRaises(ValueError):
            web.dispatch('/api/parse', {'text':'\n'.join(str(n) for n in range(21))})

    def test_rank_inspection_requires_login_and_preserves_raw_values(self):
        with self.assertRaises(ValueError):
            web.dispatch('/api/match-ranks',{'steamId':'76561199148425546'})
        web.AUTH.update(token='TEST_ONLY',steamId='76561198000000000')
        matches=[{'rank':12345,'oldrank':12000,'deltaRank':345,'pvpScore':1800,'mode':'test','token':'DO_NOT_EXPOSE'},
                 {'rank':0,'oldrank':0,'deltaRank':None},{'rank':0}]
        with patch.object(web.lookup,'match_list',return_value=matches) as request:
            result=web.dispatch('/api/match-ranks',{'steamId':'76561199148425546'})
        request.assert_called_once_with('76561199148425546','76561198000000000','TEST_ONLY',page_size=10)
        self.assertEqual(result['records'],[{'rank':12345,'oldrank':12000,'deltaRank':345,'pvpScore':1800,'mode':'test'},
                         {'rank':0,'oldrank':0,'deltaRank':None},{'rank':0}])

    def test_ambiguous_never_autopicks(self):
        with patch.object(web, 'remote', return_value={'code':1,'result':[{'steamId':'76561198000000000','pvpNickName':'other'}]}):
            self.assertTrue(web.query({'name':'wanted'})['needsChoice'])

    def test_login_hides_token_and_logout_clears(self):
        response = {'result':{'loginResult':{'accountInfo':{'token':'TEST_ONLY_SECRET','steamId':'76561198000000000'}}}}
        with patch.object(web, 'passport', return_value=response), patch.object(web, 'remote', return_value={}):
            result = web.dispatch('/api/auth/login', {'mobile':'00000000000','code':'000000'})
        self.assertTrue(result['loggedIn'])
        self.assertNotIn('TEST_ONLY_SECRET', json.dumps(result))
        self.assertFalse(result['matchesVerified'])
        self.assertFalse(web.dispatch('/api/auth/logout', {})['loggedIn'])

    def test_verify_failure_not_accepted(self):
        web.AUTH.update(token='TEST_ONLY_SECRET')
        with patch.object(web.lookup, 'match_list', side_effect=RuntimeError()):
            with self.assertRaises(ValueError):
                web.dispatch('/api/auth/steamid', {'steamId':'76561198000000000'})
        self.assertFalse(web.status()['matchesVerified'])

    def test_score_matches_selected_id(self):
        response = {'code':1, 'result':[
            {'steamId':'76561198000000000','pvpNickName':'test','pvpScore':900},
            {'steamId':'76561198000000001','pvpNickName':'test','pvpScore':2431}]}
        with patch.object(web,'remote',side_effect=[response,{'data':{'list':[]}}]):
            row = web.query({'name':'test','steamId':'76561198000000001'})
        self.assertEqual(row['pvpScore'],2431)

    def test_score_missing_not_unranked(self):
        self.assertIsNone(web.score_value(None))
        self.assertIsNone(web.score_value(True))
        self.assertIsNone(web.score_value(float('nan')))
        self.assertIsNone(web.score_value(-1))
        self.assertEqual(web.score_value(0),0)

    def test_history_peak_uses_only_valid_history_scores(self):
        self.assertEqual(web.history_peak([1528,1553,1887]),1887)
        self.assertEqual(web.history_peak([0, None, True, -1, '2800', float('nan')]),0)
        self.assertIsNone(web.history_peak([]))
        self.assertIsNone(web.history_peak(None))
        self.assertIsNone(web.history_peak({'score':3000}))

    def test_detail_selects_id_and_keeps_list_precision(self):
        detail = {'statusCode':0,'data':{'players':[
            {'playerId':'other','adpr':900},
            {'playerId':'target','adpr':73,'we':6.5,'pwRating':1.05,'rws':8.4,'headShotRatio':.5455}]}}
        with patch.object(web,'remote',return_value=detail):
            player = web.match_player({'matchId':'PVP@123','we':6.5461},'target')
        self.assertEqual(player['adpr'],73)
        self.assertEqual(player['we'],6.5461)
        with patch.object(web,'remote',side_effect=RuntimeError()):
            self.assertEqual(web.match_player({'matchId':'PVP@123','kill':5},'target')['kill'],5)

    def test_authenticated_recent_path_requests_ten_and_enriches_only_ten(self):
        matches = [dict(matchId=f'PVP@{i}',we=5,team=1,winTeam=1) for i in range(11)]
        with patch.object(web.lookup,'match_list',return_value=matches) as listed, \
             patch.object(web,'match_player',side_effect=lambda match,sid: match) as detail:
            result = web.recent_matches('target',{'steamId':'self','token':'TEST_ONLY'})
        listed.assert_called_once_with('target','self','TEST_ONLY',page_size=10)
        self.assertEqual(detail.call_count,10)
        self.assertEqual(len(result),10)

    def test_history_does_not_fall_back_to_current_or_scorelist(self):
        with patch.object(web,'remote',return_value={'statusCode':0,'data':{'seasonId':'S25','pvpScore':2500,'scoreList':[{'score':3000}]}}):
            self.assertIsNone(web.season_history_peak('76561198000000000','S25'))
        with patch.object(web,'remote',return_value={'statusCode':90003,'data':None}):
            with self.assertRaises(ValueError):
                web.season_history_peak('76561198000000000','S25')

    def test_history_empty_recent_does_not_hide_old_season_peak(self):
        def response(url, payload=None, headers=None):
            if url.endswith('csgoSeasons'):
                return {'statusCode':0,'data':[{'season':'S25'},{'season':'S23'},{'season':'S15'}]}
            season = payload['csgoSeasonId']
            return {'statusCode':0,'data':{'seasonId':season,'historyScores':{'S25':[], 'S23':[2687], 'S15':[2500,2852]}[season]}}
        with patch.object(web,'remote',side_effect=response) as remote:
            result = web.query_history('76561199148425546')
            self.assertEqual(result['historyPeakScore'],2852)
            self.assertEqual(result['historyRankState'],'available')
            self.assertEqual(result['historySeasonsChecked'],3)
            calls = remote.call_count
            self.assertEqual(web.query_history('76561199148425546'),result)
            self.assertEqual(remote.call_count,calls)

    def test_partial_seasons_are_explicit_and_not_cached(self):
        def peak(sid, season):
            if season == 'S25': raise RuntimeError('offline')
            return 2852
        with patch.object(web,'history_seasons',return_value=['S25','S15']), patch.object(web,'season_history_peak',side_effect=peak):
            result = web.query_history('target')
        self.assertEqual(result['historyRankState'],'partial')
        self.assertEqual(result['historyPeakScore'],2852)
        self.assertNotIn('target',web.HISTORY_CACHE)

    def test_missing_season_catalog_never_claims_full_history(self):
        with patch.object(web,'history_seasons',side_effect=RuntimeError()), patch.object(web,'season_history_peak',return_value=1528):
            result = web.query_history('target')
        self.assertEqual(result['historyRankState'],'partial')
        self.assertIsNone(result['historySeasonsTotal'])
        with patch.object(web,'remote',return_value={'statusCode':0,'data':{'seasonId':'S25','historyScores':[9999]}}):
            with self.assertRaises(ValueError): web.season_history_peak('target','S15')

    def test_query_returns_individual_games_without_ban_or_summary_queries(self):
        web.AUTH.update(token='TEST_ONLY',steamId='76561198000000000')
        def remote(url, payload=None, headers=None):
            self.assertEqual(url,web.lookup.SEARCH_URL)
            return {'code':1,'result':[{'steamId':'76561198000000001','pvpNickName':'test','pvpScore':1800}]}
        records=[{'kill':20,'death':0,'assist':4,'pwRating':1.85,'adpr':115}]
        with patch.object(web,'remote',side_effect=remote), patch.object(web,'query_history',return_value={}), patch.object(web,'recent_matches',return_value=records) as recent:
            result=web.query({'name':'test','matches':True})
        self.assertEqual(result['recentMatches'],records)
        self.assertNotIn('stats',result)
        self.assertNotIn('ban',result)
        recent.assert_called_once()

    def test_detail_keeps_zero_and_fills_honors_for_correct_player(self):
        detail={'statusCode':0,'data':{'players':[{'playerId':'other','honor':'1'},{'playerId':'target','honor':'5,2','assist':4,'adpr':70,'rws':8,'pwRating':1.2,'mvp':False}]}}
        with patch.object(web,'remote',return_value=detail):
            result=web.match_player({'matchId':'PVP@123','kill':0,'death':0,'pwRating':0},'target')
        self.assertEqual(result['honor'],'5,2')
        self.assertEqual(result['assist'],4)
        self.assertEqual(result['pwRating'],0)
        self.assertNotIn('headShotRatio',result)

    def test_records_whitelist_and_detail_failure_preserve_matches(self):
        raw={'matchId':'PVP@1','kill':5,'honor':'5','token':'SECRET','headShotRatio':.5}
        with patch.object(web.lookup,'match_list',return_value=[raw]), patch.object(web,'remote',side_effect=RuntimeError()):
            records=web.recent_matches('target',{'steamId':'self','token':'TEST'})
        self.assertEqual(len(records),1)
        self.assertEqual(records[0]['kill'],5)
        self.assertIsNone(records[0]['adpr'])
        self.assertNotIn('token',records[0])
        self.assertNotIn('headShotRatio',records[0])

unittest.main()
