import asyncio
from collections import Counter
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import httpx
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import player_query as q
import query_batch
from upstream import BASIC, DETAIL, HISTORY, LONG, Platform, PlatformError, retry_after, success


class QueryPerformance(unittest.IsolatedAsyncioTestCase):
    def platform(self, handler, limit=6, db=':memory:'):
        p = Platform(db, limit, httpx.MockTransport(handler))
        self.addAsyncCleanup(p.close)
        return p

    async def test_global_limit_and_priority_across_players(self):
        release = asyncio.Event()
        order, active, peak = [], 0, 0
        async def upstream(req):
            nonlocal active, peak
            active += 1
            peak = max(active, peak)
            order.append(req.url.path)
            await release.wait()
            active -= 1
            return httpx.Response(200,json={})
        p = self.platform(upstream,2)
        def request(label, priority):
            return asyncio.create_task(p.request('test','https://test/'+label,priority=priority))
        tasks = [request('first',DETAIL),request('second',DETAIL)]
        await asyncio.sleep(0)
        tasks += [request('season',HISTORY),request('match',DETAIL),request('base',BASIC)]
        await asyncio.sleep(0)
        self.assertEqual(order,['/first','/second'])
        release.set()
        await asyncio.gather(*tasks)
        self.assertEqual(peak,2)
        self.assertEqual(order[2:],['/base','/match','/season'])

    async def test_persistent_match_and_season_cache_expiry(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db = Path(tmp.name)/'cache.db'
        async def upstream(req):
            body=json.loads(req.content)
            if 'matchId' in body:
                return httpx.Response(200,json={'statusCode':0,'data':{'players':[{'playerId':'a','adpr':20},{'playerId':'b','adpr':40}]}})
            return httpx.Response(200,json={'statusCode':0,'data':{'seasonId':body['csgoSeasonId'],'historyScores':[100]}})
        p = Platform(db, transport=httpx.MockTransport(upstream))
        match = {'matchId':'one','endTime':'2026-01-01'}
        try:
            await asyncio.gather(q.match_player(p,match,'a'),q.match_player(p,match,'b'),
                q.season_history_peak(p,'a','S2',True),q.season_history_peak(p,'a','S2',True))
            self.assertEqual(p.metrics['detail','requests'],1)
            self.assertEqual(p.metrics['season','requests'],1)
        finally:
            await p.close()
        p2=Platform(db,transport=httpx.MockTransport(upstream))
        try:
            self.assertEqual((await q.match_player(p2,match,'b'))['adpr'],40)
            self.assertEqual(await q.season_history_peak(p2,'a','S2',True),100)
            self.assertEqual(p2.metrics['detail','requests'] + p2.metrics['season','requests'],0)
            await q.season_history_peak(p2,'a','S3')
            ttls=dict(p2.db.execute("SELECT key,expires-strftime('%s','now') FROM cache"))
            self.assertGreater(ttls['a/S2'],LONG-5)
            self.assertLess(ttls['a/S3'],305)
            p2.db.execute("UPDATE cache SET expires=0 WHERE key='a/S3'")
            await q.season_history_peak(p2,'a','S3')
            self.assertEqual(p2.metrics['season','requests'],2)
        finally:
            await p2.close()

    async def test_singleflight_cancels_only_when_last_waiter_leaves(self):
        p=self.platform(lambda r:httpx.Response(200,json={}))
        release=asyncio.Event()
        starts=0
        async def fill():
            nonlocal starts
            starts+=1
            await release.wait()
            return 42
        def waiter():
            return asyncio.create_task(p.cached('detail','shared',60,fill))
        first,second=waiter(),waiter()
        await asyncio.sleep(0)
        first.cancel()
        await asyncio.gather(first,return_exceptions=True)
        self.assertFalse(second.done())
        release.set()
        self.assertEqual(await second,42)
        self.assertEqual(starts,1)
        self.assertFalse(p.flights)

    async def test_duplicates_only_enrich_retained_accounts_and_stream_before_history(self):
        cases = [([1,0,'error'],[0,2]),([0,0],[0,1]),([1,1],[0,1])]
        for counts,expected in cases:
            release=asyncio.Event()
            calls=Counter()
            ids=[str(76561198000000000+i) for i in range(len(counts))]
            async def upstream(req):
                path=req.url.path.split('/')[-1]
                body=json.loads(req.content or '{}')
                calls[path]+=1
                if path=='user':
                    data={'code':1,'result':[{'steamId':i,'pvpNickName':'dup'} for i in ids]}
                elif path=='list':
                    sid=str(body['toSteamId'])
                    count=counts[ids.index(sid)]
                    if count=='error':
                        return httpx.Response(403)
                    data={'statusCode':0,'data':{'matchList':[{'matchId':'m'+sid,'kill':12}]*count}}
                elif path=='csgoSeasons':
                    await release.wait()
                    data={'statusCode':0,'data':[{'season':'S1'}]}
                elif path=='pvpDetailStats':
                    self.assertIn(body['steamId64'],[ids[i] for i in expected])
                    data={'statusCode':0,'data':{'seasonId':'S1','historyScores':[2000]}}
                else:
                    return httpx.Response(401)
                return httpx.Response(200,json=data)
            p=self.platform(upstream)
            batch=query_batch.Batch(p,['dup'],{'steamId':ids[0],'token':'fake'},'',None)
            try:
                page=await batch.poll(0)
                base=page['events'][0]['data']
                self.assertFalse(page['done'])
                self.assertEqual([r['steamId'] for r in base['players']],[ids[i] for i in expected])
                self.assertEqual(calls['user'],1)
                self.assertEqual(calls['list'],len(ids))
                release.set()
                await batch.task
                self.assertEqual(calls['pvpDetailStats'],len(expected))
                self.assertEqual(calls['match'],counts.count(1))
                for event in batch.events:
                    if event['kind']=='detail':
                        self.assertEqual((event['data']['kill'],event['data']['detailState']),(12,'unavailable'))
            finally:
                release.set()
                batch.cancel()
                await asyncio.gather(batch.task,return_exceptions=True)

    async def test_cancel_stops_queued_work(self):
        started,release=asyncio.Event(),asyncio.Event()
        calls=[]
        async def upstream(req):
            calls.append(req.url.path)
            started.set()
            await release.wait()
            return httpx.Response(200,json={'code':1,'result':[]})
        p=self.platform(upstream,1)
        b=query_batch.Batch(p,['a','b','c'],{},'',None)
        await started.wait()
        b.cancel()
        await asyncio.gather(b.task,return_exceptions=True)
        self.assertEqual(len(calls),1)
        self.assertFalse(b.events)
        self.assertEqual(p.gate.active,0)

    async def test_short_lived_lists_isolate_sessions_and_drop_unneeded_fields(self):
        async def upstream(req):
            return httpx.Response(200,json={'statusCode':0,'data':{'matchList':[
                {'matchId':'a','pvpNormalRank':0,'rank':1,'token':'never-store-this'}]}})
        p=self.platform(upstream)
        for token in ('test-session-one','test-session-one','test-session-two'):
            records=await p.matches('https://example.com/list','v','1','2',token)
            self.assertEqual(records,[{'matchId':'a','pvpNormalRank':0,'rank':1}])
        self.assertEqual(p.metrics['recent','requests'],2)
        rows=list(p.db.execute("SELECT key,value,expires-strftime('%s','now') FROM cache"))
        self.assertEqual(len(rows),2)
        self.assertNotIn('test-session',str(rows))
        self.assertNotIn('never-store-this',str(rows))
        self.assertTrue(all(0 < ttl <= 61 for _,_,ttl in rows))

    async def test_cancel_last_waiter_aborts_fill_and_next_call_can_retry(self):
        p=self.platform(lambda req:httpx.Response(200,json={}))
        started,stopped=asyncio.Event(),asyncio.Event()
        async def blocked():
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()
        task=asyncio.create_task(p.cached('season','one/S1',60,blocked))
        await started.wait()
        task.cancel()
        await asyncio.gather(task,return_exceptions=True)
        self.assertTrue(stopped.is_set())
        self.assertEqual(p.db.execute('SELECT count(*) FROM cache').fetchone()[0],0)
        async def retry():
            return 1000
        self.assertEqual(await p.cached('season','one/S1',60,retry),1000)

    async def test_error_classes_no_final_sleep_and_no_secret_in_log(self):
        for status,kind,attempts in [(403,'auth',1),(405,'http',1),(503,'server',2),(200,'business',1)]:
            p=self.platform(lambda req: httpx.Response(status,json={'statusCode':123,'errorMessage':'untrusted-secret'}))
            with patch('upstream.asyncio.sleep') as sleep, self.assertLogs('lookup.performance','INFO') as captured:
                with self.assertRaises(PlatformError) as error:
                    await p.request('test','https://example.com/?token=hidden-secret',headers={'token':'other-secret'},decode=success)
                self.assertEqual(error.exception.kind,kind)
                self.assertEqual(p.metrics['test','requests'],attempts)
                self.assertEqual(sleep.await_count,attempts-1)
                self.assertNotIn('secret',' '.join(captured.output))

    async def test_rate_limit_shared_by_host_and_network_retry(self):
        p=self.platform(lambda r: httpx.Response(429,headers={'Retry-After':'120'}))
        with patch('upstream.asyncio.sleep') as sleep:
            for _ in range(2):
                with self.assertRaises(PlatformError) as caught:
                    await p.request('recent','https://example.com/list')
                self.assertEqual(caught.exception.kind,'rate')
            sleep.assert_not_called()
        self.assertEqual(p.metrics['recent','requests'],1)
        self.assertEqual(retry_after('Thu, 01 Jan 1970 00:00:01 GMT'),0)
        self.assertIsNone(retry_after('bad'))
        n=0
        async def unstable(req):
            nonlocal n
            n+=1
            if n==1:
                raise httpx.ConnectError('secret')
            return httpx.Response(200,json={})
        p=self.platform(unstable)
        with patch('upstream.asyncio.sleep') as sleep:
            await p.request('search','https://example.com')
            sleep.assert_awaited_once()
        self.assertEqual(p.metrics['search','retries'],1)

if __name__ == '__main__':
    unittest.main()
