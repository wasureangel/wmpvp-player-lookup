import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Engine} from '../server/engine.js';
import {handleRequest} from '../server/handler.js';
import {basic,detail,history,matchList} from '../server/platform.js';
import {sessionCookie} from '../server/session.js';

const sid='76561198000000001', other='76561198000000002', auth={steamId:sid,token:'fictional-token'};
const env={SITE_PASSWORD:'test-only-site-password',SESSION_SECRET:'01'.repeat(32)},origin='https://lookup.test';
function engine(t,fetcher,extra={}) {
  const e=new Engine({fetcher,path:':memory:',log:()=>{},...extra});
  t.after(()=>e.db.close());return e;
}
const ok=data=>Response.json({statusCode:0,data});
function candidate(id,name) {return {steamId:id,pvpNickName:name,pvpScore:2001};}

test('encrypted browser sessions isolate batches and ignore spoofed body auth and owner',async t=>{
  let seenToken;
  const e=engine(t,async(url,init)=>{
    if (url.endsWith('/user')) return Response.json({code:1,result:[candidate(sid,'Alice')]});
    if (url.endsWith('/list')) {seenToken=init.headers.token;return ok({matchList:[{matchId:'m1',kill:20,honor:'1'}]});}
    if (url.endsWith('/match')) return ok({players:[{playerId:sid,adpr:85,honor:'4'}]});
    if (url.endsWith('/csgoSeasons')) return ok([{season:'S1'}]);
    return ok({seasonId:'S1',historyScores:[1820]});
  });
  const call=async(path,data,cookie='')=>{
    const req=new Request(origin+'/api/'+path,{method:'POST',headers:{origin,'content-type':'application/json','x-app-token':'pages-client-v1',cookie},body:JSON.stringify(data)});
    const out=await handleRequest(req,env,{engine:e});
    return {status:out.status,value:await out.json(),cookie:out.headers.get('set-cookie')?.split(';')[0]};
  };
  const oldCookie=async()=> (await sessionCookie(new Request(origin),{access:true,...auth,expires:Date.now()+60000},env)).split(';')[0];
  const a=await oldCookie(),b=await oldCookie();
  assert.notEqual(a,b);
  assert.equal((await call('batch/start',{names:['Alice']})).status,401);
  const {batch}=(await call('batch/start',{names:['Alice'],auth:{token:'spoof'},owner:'b'},a)).value;
  assert.ok(batch);
  for (const route of ['poll','cancel']) assert.equal((await call('batch/'+route,{batch,owner:a},b)).status,404);
  let cursor=0,done=false;const events=[];
  while (!done) {
    const out=await call('batch/poll',{batch,cursor},a);
    assert.equal(out.status,200);events.push(...out.value.events);({done,cursor}=out.value);
  }
  assert.equal(events[0].kind,'base');
  assert.equal(events[0].data.recentMatches[0].detailState,'pending');
  assert.equal(events.find(v=>v.kind==='detail').data.honor,'1,4');
  assert.equal(events.find(v=>v.kind==='history').data.historyPeakScore,1820);
  assert.equal(seenToken,auth.token);
  assert.equal((await call('auth/logout',{},a)).status,200);
  assert.equal((await call('batch/poll',{batch},a)).status,404);
});

test('global priority and cancellation apply across callers',async t=>{
  let active=0,peak=0;const order=[];
  const e=engine(t,async url=>{
    active++;peak=Math.max(peak,active);order.push(new URL(url).pathname);
    await delay(15);active--;return ok({});
  },{limit:2});
  const send=(name,priority,signal)=>e.request('fixture','https://api.wmpvp.com/'+name,undefined,{}, {priority,signal});
  const c=new AbortController();
  const calls=[send('a',1),send('b',1),send('hist',2),send('detail',1),send('basic',0)];
  const stopped=assert.rejects(send('cancelled',0,c.signal));c.abort();
  await Promise.all([...calls,stopped]);
  assert.equal(peak,2);assert.deepEqual(order,['/a','/b','/basic','/detail','/hist']);
});

test('shared match and season reads persist across reopen, base filter retains failed candidates',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'lookup-test-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const counts={},fetcher=async(url,init)=>{
    const path=new URL(url).pathname.split('/').pop();counts[path]=(counts[path]||0)+1;
    if (path==='user') return Response.json({code:1,result:[sid,other,'76561198000000003'].map(id=>candidate(id,'dup'))});
    if (path==='list') {
      if (init.body.includes('76561198000000003')) return new Response(null,{status:403});
      return ok({matchList:init.body.includes('"toSteamId":'+other)?[]:[{matchId:'shared',endTime:'2020-01-01',pvpNormalRank:null,kill:0}]});
    }
    if (path==='match') return ok({players:[{playerId:sid,kill:90,honor:'1',adpr:80},{playerId:other,adpr:100}]});
    if (path==='csgoSeasons') return ok([{season:'S1',endTime:'2020-01-01 00:00:00'},{season:'S2'}]);
    const season=JSON.parse(init.body).csgoSeasonId;
    if (season==='S2') return ok({seasonId:'mismatch'});
    return ok({seasonId:season,historyScores:[2700,1200]});
  };
  const make=()=>new Engine({path:join(dir,'db'),fetcher,log:()=>{}});
  const e=make();
  let m;
  try {
    const result=await basic('dup','',auth,e);
    assert.deepEqual(result.players.map(v=>v.steamId),[sid,'76561198000000003']);
    assert.equal(counts.match,undefined);assert.equal(counts.pvpDetailStats,undefined);
    m=result.players[0].recentMatches[0];
    const [a,b]=await Promise.all([detail(m,sid,e),detail(m,other,e)]);
    assert.equal(counts.match,1);assert.equal(a.kill,0);assert.equal(b.adpr,100);
    const [h]=await Promise.all([history(sid,e),history(sid,e)]);
    assert.equal(counts.pvpDetailStats,2);assert.equal(h.historyRankState,'partial');assert.equal(h.historyPeakScore,2700);
  } finally {e.db.close();}
  const fresh=make();
  try {
    await detail(m,sid,fresh);await history(sid,fresh);
    assert.equal(counts.match,1);assert.equal(counts.pvpDetailStats,3);
    await matchList(sid,auth,fresh);assert.equal(counts.list,3);
    await matchList(sid,{...auth,token:'other'},fresh);assert.equal(counts.list,4);
  } finally {fresh.db.close();}
});

test('all seven honors, ties, list precision, missing detail',async t=>{
  const players=Array.from({length:10},(_,i)=>({playerId:i===0?sid:String(i),headShot:3,snipeNum:3,entryKill:3,endGame:3,flashSuccess:3,assist:3,pvpMvp:i===0,we:1}));
  const e=engine(t,async()=>ok({players}));
  const m={matchId:'m',mode:'完美官匹Pro',we:13.45};
  const a=await detail(m,sid,e);
  assert.deepEqual(a.derivedHonors,['2','3','4','5','6','7']);assert.equal(a.pvpMvp,true);assert.equal(a.we,13.45);
  assert.equal((await detail(m,'missing',e)).detailState,'unavailable');
});

test('authorization and long Retry-After never retry or send queued traffic during cooldown',async t=>{
  let calls=0;
  const e=engine(t,async()=>++calls===1?new Response(null,{status:403}):new Response(null,{status:429,headers:{'Retry-After':'120'}}));
  const read=()=>e.request('recent','https://api.wmpvp.com/list');
  await assert.rejects(read(),{kind:'auth'});await assert.rejects(read(),{kind:'rate'});await assert.rejects(read(),{kind:'cooldown'});
  assert.equal(calls,2);
});

test('singleflight aborts only when last waiter leaves and expired values refresh',async t=>{
  const e=engine(t,()=>{}),a=new AbortController(),b=new AbortController();
  let requests=0;
  const load=async signal=>{requests++;await delay(10,undefined,{signal});return 42;};
  const p=e.cached('recent','x',1,a.signal,load),q=e.cached('recent','x',1,b.signal,load);
  a.abort();await assert.rejects(p);assert.equal(await q,42);assert.equal(requests,1);
  await delay(10);assert.equal(await e.cached('recent','x',1,undefined,load),42);assert.equal(requests,2);
});

test('unlock, captcha, SMS, login, verification and logout keep credentials out of responses',async t=>{
  const calls=[];
  const e=engine(t,async(url,init)=>{
    calls.push(new URL(url).pathname);
    if (url.endsWith('initcaptcha')) return Response.json({code:0,capTicket:'fixture-ticket'});
    if (url.includes('/securitycode?')) return Response.json({code:0});
    if (url.endsWith('/account/login')) return Response.json({code:0,result:{loginResult:{accountInfo:{...auth}}}});
    if (url.endsWith('/user/login')) return Response.json({result:{user:{steamId:sid}}});
    assert.equal(init.headers.token,auth.token);
    return ok({matchList:[]});
  });
  let cookie='';
  async function call(path,data={},from=origin) {
    const req=new Request(origin+'/api/'+path,{method:'POST',headers:{origin:from,'content-type':'application/json','x-app-token':'pages-client-v1',cookie},body:JSON.stringify(data)});
    const response=await handleRequest(req,env,{engine:e});
    if(response.headers.has('set-cookie')) cookie=response.headers.get('set-cookie').split(';')[0];
    const value=await response.json();
    assert.ok(!JSON.stringify(value).includes(auth.token));assert.ok(!cookie.includes(auth.token));
    return {value,status:response.status};
  }
  assert.equal((await call('auth/status')).value.accessRequired,true);
  assert.equal((await call('access/unlock',{password:env.SITE_PASSWORD},'https://wrong.test')).status,403);
  assert.equal((await call('access/unlock',{password:env.SITE_PASSWORD})).value.accessRequired,false);
  assert.equal((await call('auth/captcha')).value.capTicket,'fixture-ticket');
  assert.equal((await call('auth/sms',{mobile:'00000000000',code:'fixture',ticket:'fixture-ticket'})).status,200);
  assert.equal((await call('auth/login',{mobile:'00000000000',code:'000000'})).value.loggedIn,true);
  assert.equal((await call('auth/steamid',{steamId:sid})).value.matchesVerified,true);
  assert.equal((await call('auth/logout')).value.accessRequired,true);
  assert.equal((await call('batch/start',{names:['x']})).status,401);
  assert.deepEqual(calls,['/initcaptcha','/securitycode','/account/login','/thirdparty/steamcn/user/login','/api/csgo/home/match/list']);
});
