import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRequest} from '../server/handler.js';
import {readSession,sealSession} from '../server/session.js';
import {matchList,queryPlayer,historyBatch,clearCachesForTests,remote} from '../server/platform.js';

const env={SESSION_SECRET:'11'.repeat(32),SITE_PASSWORD:'test-only-password-not-for-deployment'};
const origin='https://lookup.example';
let client=0;
function request(path,data={},cookie='',extra={}) {
  return new Request(origin+'/api/'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-App-Token':'pages-client-v1',Cookie:cookie,'CF-Connecting-IP':'192.0.2.'+(++client),...extra},body:JSON.stringify(data)});
}
const json=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
async function unlock() {
  const result=await handleRequest(request('access/unlock',{password:env.SITE_PASSWORD}),env);
  assert.equal(result.status,200);
  return result.headers.get('Set-Cookie').split(';')[0];
}

test('site gate, same-origin checks and configuration fail closed',async()=>{
  const result=await handleRequest(request('auth/status'),env);
  assert.deepEqual(await result.json(),{accessRequired:true,loggedIn:false,steamId:'',matchesVerified:false});
  assert.equal((await handleRequest(request('query',{name:'test'}),env)).status,401);
  assert.equal((await handleRequest(request('auth/status',{},'',{Origin:'https://other.example'}),env)).status,403);
  assert.equal((await handleRequest(request('auth/status',{},'',{'X-App-Token':''}),env)).status,403);
  assert.equal((await handleRequest(request('auth/status'),{})).status,503);
  assert.equal((await handleRequest(request('access/unlock',{password:'wrong'}),env)).status,401);
});

test('encrypted sessions reject tampering, expiry and a different site origin',async()=>{
  const session={access:true,expires:Date.now()+100000,token:'TEST_ONLY_TOKEN',steamId:'76561199148425546'};
  const sealed=await sealSession(session,env,origin);
  const cookie='__Host-wmpvp_session='+sealed;
  assert.equal((await readSession(request('auth/status',{},cookie),env)).token,'TEST_ONLY_TOKEN');
  assert.equal(await readSession(request('auth/status',{},cookie.slice(0,-8)+'tampered'),env),null);
  assert.equal(await readSession(new Request('https://other.example/api/auth/status',{headers:{Cookie:cookie}}),env),null);
  assert.equal(await readSession(request('auth/status',{},cookie),env,Date.now()+200000),null);
  assert.equal(await readSession(request('auth/status',{},cookie),{...env,SITE_PASSWORD:'another-test-password'}),null);
  assert.ok(!sealed.includes('TEST_ONLY_TOKEN'));
});

test('login belongs to one browser and never returns a raw token',async()=>{
  const gate=await unlock();
  const fetcher=async url=>url.endsWith('/account/login')?json({code:0,result:{loginResult:{accountInfo:{token:'TEST_ONLY_PRIVATE_TOKEN',steamId:'76561199148425546'}}}}):json({result:{user:{steamId:'76561199148425546'}}});
  const result=await handleRequest(request('auth/login',{mobile:'00000000000',code:'000000'},gate),env,{fetcher});
  assert.equal(result.status,200);
  const body=await result.text();
  assert.ok(!body.includes('TEST_ONLY_PRIVATE_TOKEN'));
  const header=result.headers.get('Set-Cookie');
  for(const part of ['HttpOnly','Secure','SameSite=Strict','Path=/'])assert.ok(header.includes(part));
  const cookie=header.split(';')[0];
  assert.equal((await (await handleRequest(request('auth/status',{},cookie),env)).json()).loggedIn,true);
  assert.equal((await (await handleRequest(request('auth/status'),env)).json()).loggedIn,false);
  const loggedOut=await handleRequest(request('auth/logout',{},cookie),env);
  assert.match(loggedOut.headers.get('Set-Cookie'),/Max-Age=0/);
  assert.equal((await loggedOut.json()).loggedIn,false);
});

test('invalid input and oversized requests are rejected without upstream calls',async()=>{
  const cookie=await unlock();
  const fetcher=()=>{throw new Error('must not call upstream');};
  assert.equal((await handleRequest(request('auth/login',{mobile:'bad',code:'bad'},cookie),env,{fetcher})).status,400);
  assert.equal((await handleRequest(request('history',{steamId:'localhost'},cookie),env,{fetcher})).status,400);
  assert.equal((await handleRequest(request('parse',{text:'x'.repeat(100001)},cookie),env,{fetcher})).status,413);
  assert.equal((await handleRequest(request('unknown',{},cookie),env,{fetcher})).status,404);
});

test('SteamIDs retain all digits in requests and numeric responses',async()=>{
  const sid='76561199148425546';let body;
  await matchList(sid,{steamId:sid,token:'TEST_ONLY'},async(_url,options)=>{body=options.body;return json({statusCode:0,data:{matchList:[]}});});
  assert.ok(body.includes('"mySteamId":'+sid));
  assert.ok(body.includes('"toSteamId":'+sid));
  const decoded=await remote('https://api.wmpvp.com/test',undefined,{},async()=>new Response('{"steamId":76561199148425546}'));
  assert.equal(decoded.steamId,sid);
  await assert.rejects(()=>remote('http://localhost/',{},{}));
});

test('player query preserves statistics and official rank from one match-list response',async()=>{
  const sid='76561199148425546';let matchCalls=0;
  const matches=Array.from({length:10},(_,i)=>({matchId:'PVP@'+i,team:1,winTeam:i<7?1:i===7?-1:2,kill:20,death:10,we:8,pwRating:1.2,headShotRatio:.5,adpr:80,rws:10,pvpNormalRank:i===1?25162:null}));
  const fetcher=async url=>{
    if(url.includes('/search/user'))return json({code:1,result:[{steamId:sid,pvpNickName:'Test',pvpScore:1800}]});
    if(url.includes('/home/match/list')){matchCalls++;return json({statusCode:0,data:{matchList:matches}});}
    return json({statusCode:0,data:{players:[]}});
  };
  const result=await queryPlayer({name:'Test',matches:true},{steamId:sid,token:'TEST_ONLY'},fetcher);
  assert.equal(result.stats.winrate,.7);
  assert.equal(result.officialRank.score,25162);
  assert.equal(result.stats.games,10);
  assert.equal(matchCalls,1);
  assert.equal(result.historyPending,true);
});

test('history uses bounded batches and does not silently drop old seasons',async()=>{
  clearCachesForTests();let calls=0;
  const fetcher=async(url,options)=>{
    calls++;
    if(url.endsWith('csgoSeasons'))return json({statusCode:0,data:Array.from({length:45},(_,i)=>({season:'S'+(45-i)}))});
    const season=JSON.parse(options.body).csgoSeasonId;
    return json({statusCode:0,data:{seasonId:season,historyScores:season==='S1'?[2852]:[]}});
  };
  const sid='76561199148425546';
  const first=await historyBatch({steamId:sid},fetcher);
  assert.equal(calls,21);assert.equal(first.nextOffset,20);assert.equal(first.checked,20);
  const second=await historyBatch({steamId:sid,offset:20},fetcher);
  assert.equal(second.nextOffset,40);
  const last=await historyBatch({steamId:sid,offset:40},fetcher);
  assert.equal(last.peak,2852);assert.equal(last.nextOffset,null);assert.equal(last.total,45);
  const before=calls;await historyBatch({steamId:sid,offset:40},fetcher);assert.equal(calls,before);
});
