const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../web.js'), 'utf8');
class Element {
  constructor() { this.children = []; this.textContent = ''; this.value = ''; this.dataset = {}; this.handlers = {}; this.classList = {toggle() {},add() {}}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.textContent = ''; }
  addEventListener(event, fn) { this.handlers[event] = fn; }
  querySelector(selector) { const index = selector.match(/data-index="(\d+)"/)[1]; return this.children.find(child => String(child.dataset.index) === index); }
  querySelectorAll(selector) { return selector === 'button' ? this.children.filter(child => child.tagName === 'button') : []; }
  click() {}
  setAttribute(name, value) { this[name] = value; }
}
const text = element => [element.textContent, ...element.children.map(text)].join('\n');
const record = {startTime:'2026-11-18 23:26:00',mode:'完美官匹Pro',team:2,winTeam:2,score1:4,score2:13,kill:20,death:4,assist:4,adpr:115,rws:22.48,pwRating:1.85,we:13.3,pvpNormalRank:25162,honor:'1,2,3,4,5,6,7'};
const active = {pvpScore:2450,historyPeakScore:1887,historyRankState:'available',recentMatches:Array.from({length:10},(_,i)=>({...record,startTime:`2026-11-${String(18-i).padStart(2,'0')} 23:26:00`})),matchMessage:''};
const empty = {pvpScore:0,recentMatches:[],matchMessage:'近期无对局记录'};
const failed = {error:'网络失败'};
// Exercise the production event stream contract. Backend tests cover which upstream requests produce these events.
function harness(backend) {
  const elements = new Map(), calls = [];
  const get = id => {
    assert.notEqual(id, 'matches');
    if (!elements.has(id)) elements.set(id,new Element());
    return elements.get(id);
  };
  const sandbox = {
    document:{getElementById:get, querySelector:() => ({content:'test'}), createElement:tag => {
      const el = new Element(); el.tagName = tag; return el;
    }},
    performance, AbortController, requestAnimationFrame:fn=>fn(), setInterval() {},
    fetch:async (url, options) => {
      const body = JSON.parse(options.body), path=url.slice(5);
      calls.push({path,body});
      let value = {};
      if (path==='auth/status') value={loggedIn:true};
      else if (!['batch/cancel','batch/timing'].includes(path)) value=await backend(path,body,get);
      return {ok:!value.error,json:async()=>value};
    }
  };
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, 'Object.assign(globalThis,{rankForScoreTest:rankForScore,tableTest:matchTable,outcomeTest:matchOutcome,highlightTest:matchHighlights,officialTierTest:officialRankTier,latestOfficialTest:latestOfficialRank});})();'),sandbox);
  return {get,calls,sandbox,elements};
}
async function scenario(fixtures, expected, fuzzy = false) {
  const names=['同名测试'];
  const players=fixtures.map((f,i)=>({...f,steamId:String(76561198000000000n+BigInt(i))}));
  const selected=players.some(p=>p.recentMatches?.length) ? players.filter(p=>p.recentMatches?.length!==0) : players;
  const {get,elements,sandbox,calls}=harness((path,body)=>{
    if(path==='parse') return {names};
    if(path==='batch/start') return {batch:'one'};
    const data=fuzzy ? {needsChoice:true,candidates:[{pvpNickName:'相似名字',steamId:'1'}],message:'请选择'} :
      {players:selected.map(p=>p.error?{...p,error:'近期对局查询失败'}:p),message:`显示 ${selected.length} 个`};
    return {events:[{kind:'base',index:0,data}],cursor:1,done:true};
  });
  for (const [score,tier] of [[0,'gray'],[4999,'gray'],[5000,'light-blue'],[9999,'light-blue'],[10000,'blue'],[14999,'blue'],[15000,'purple'],[19999,'purple'],[20000,'magenta'],[24999,'magenta'],[25000,'red'],[29999,'red'],[30000,'gold'],[100000,'gold'],[null,null],[-1,null],[true,null],[3.5,null],['20000',null]]) assert.equal(sandbox.officialTierTest(score),tier);
  assert.equal(sandbox.latestOfficialTest([{pvpNormalRank:null},{pvpNormalRank:0},{pvpNormalRank:20000}]).score,0);
  assert.equal(sandbox.latestOfficialTest(Array(10).fill({pvpNormalRank:null}).concat([{pvpNormalRank:20000}])),null);
  assert.equal(sandbox.latestOfficialTest([{pvpNormalRank:NaN},{pvpNormalRank:true},{pvpNormalRank:-5},{pvpNormalRank:'25000'}]),null);
  assert.equal(sandbox.latestOfficialTest(null),null);
  for (const [winner,label] of [[1,'胜'],[2,'负'],[-1,'平'],[0,'平'],[null,'--']]) assert.equal(sandbox.outcomeTest({team:1,winTeam:winner})[0],label);
  assert.equal(sandbox.outcomeTest({winTeam:1})[0],'--');
  const table = sandbox.tableTest([{...record,pwRating:.75},{...record,pwRating:0,kill:0,death:0,assist:0},{mode:'完美官匹Pro'}], 'test');
  const flat = e => [e,...e.children.flatMap(flat)];
  assert.equal(flat(table).filter(e=>e.className==='metric-below').length,2);
  assert.match(text(table),/0\/0\/0/);
  assert.match(text(table),/-- : --/);
  assert.match(text(table),/13 : 4/);
  assert.match(text(table),/MVP[\s\S]*准[\s\S]*狙[\s\S]*突[\s\S]*残[\s\S]*助[\s\S]*闪/);
  assert.doesNotMatch(text(sandbox.highlightTest({honor:'21,99',kill:100})),/MVP|准/);
  assert.equal(sandbox.highlightTest({honor:'1,1',mvp:true}).children.length,1);
  for (const [score, icon] of [[0,'none'],[1,'D'],[1000,'D'],[1001,'C'],[1150,'C'],[1151,'C1'],[1300,'C1'],[1301,'C11'],[1450,'C11'],[1451,'B'],[1600,'B'],[1601,'B1'],[1750,'B1'],[1751,'B11'],[1900,'B11'],[1901,'A'],[2050,'A'],[2051,'A1'],[2200,'A1'],[2201,'A11'],[2400,'A11'],[2401,'S'],[5000,'S'],[null,null],[-1,null],['1000',null]]) {
    assert.equal(sandbox.rankForScoreTest(score).icon,icon,`rank boundary ${score}`);
  }
  await get('query').handlers.click();
  const display = text(get('results'));
  if (fuzzy) {
    assert.equal(calls.filter(c=>c.path==='batch/start').length,1); assert.match(display,/请选择/); return;
  }
  assert.match(display, new RegExp(`显示 ${expected} 个`));
  const flatten = element => [element, ...element.children.flatMap(flatten)];
  const peakBadges = flatten(get('results')).filter(element => element.className === 'rank-icon history-rank');
  const officialBadges = flatten(get('results')).filter(element => element.className === 'official-rank');
  const expectedOfficial = fixtures.filter(f => f.recentMatches?.slice(0,10).some(r => Number.isInteger(r.pvpNormalRank) && r.pvpNormalRank >= 0)).length;
  assert.equal(officialBadges.length,expectedOfficial);
  if (officialBadges.length) { assert.match(display,/25,162/); assert.doesNotMatch(display,/26,000/); }
  else assert.doesNotMatch(display,/官匹分/);
  assert.equal(peakBadges.length, fixtures.filter(f => f.historyRankState === 'available').length);
  if (peakBadges.length) assert.match(display, /1887/);
  if (fixtures.some(f => f.recentMatches?.length)) {
    for (const expected of ['日期','类型','胜/败','比分','K/D/A','ADR','RWS','RATING PRO','WE','级别','高光']) assert.ok(display.includes(expected), expected);
    assert.doesNotMatch(display, /赛季场次|胜率|爆头率|均值|WE 制胜评价/);
  }
  assert.equal(elements.has('download'), false);
  assert.doesNotMatch(display, /7656119|平台昵称|封禁|分数变化/);
  if (fixtures.some(f => f.error)) assert.match(display,/查询失败/);
  get('exclude-players').value = '其他玩家\n 同名测试 \n同名测试';
  get('exclude-players').handlers.input();
  assert.notEqual(get('results').children[0].hidden,true,'editing filter must preserve existing results');
  const previousCalls = calls.filter(c=>c.path==='batch/start').length;
  await get('query').handlers.click();
  assert.equal(calls.filter(c=>c.path==='batch/start').length,previousCalls);
  assert.equal(get('results').children.length,0);
  assert.match(get('progress').textContent,/未查询任何玩家/);
  get('exclude-players').value = '';
  get('exclude-players').handlers.input();
  await get('query').handlers.click();
  assert.equal(calls.filter(c=>c.path==="batch/start").length,previousCalls * 2,'clearing filter must query players again');
}
async function filteringScenario(mode) {
  const names = ['ARRYJW','大禄鸠叔叔','ARRYJW2'];
  let parseError=false, batch=[];
  const {get,calls}=harness((path,body,get)=>{
    if(path==='parse'){
      assert.equal(get('exclude-players').disabled,true);
      assert.equal(body.mode,mode);
      return parseError ? {error:'输入格式错误'} : {names};
    }
    if(path==='batch/start') {batch=body.names;return {batch:'batch'};}
    return {events:batch.map((n,index)=>({kind:'base',index,data:{name:n,steamId:n,...active}})),cursor:batch.length,done:true};
  });
  get('mode').value = mode;
  get('players').value = mode === 'status' ? '# userid name uniqueid\n# 1 "ARRYJW" STEAM_1:0:1' : names.join('\n');
  get('exclude-players').value = ' ARRYJW \r\n\n大禄鸠叔叔\nARRYJW\n不在查询中';
  get('exclude-players').handlers.input();
  const queryNames = () => calls.filter(c=>c.path==='batch/start').flatMap(c=>c.body.names);
  const rankNames = () => calls.filter(c=>c.path==='match-ranks');
  await get('query').handlers.click();
  assert.deepEqual(queryNames(),['ARRYJW2'],'exact matching skips excluded queries and preserves similar names');
  assert.deepEqual(rankNames(),[],'reuse match records; no separate official-score request');
  assert.equal(get('results').children.length,1);
  assert.match(get('count').textContent,/查询 1 个昵称 · 已跳过 2 个/);
  assert.equal(get('exclude-players').disabled,false);
  const resultText = text(get('results'));
  get('exclude-players').value = names.join('\n');
  get('exclude-players').handlers.input();
  assert.equal(text(get('results')),resultText,'filter edits must not remove existing results');
  assert.notEqual(get('results').children[0].hidden,true);
  await get('query').handlers.click();
  assert.deepEqual(queryNames(),['ARRYJW2'],'all excluded sends no player requests');
  assert.deepEqual(rankNames(),[]);
  assert.equal(get('results').children.length,0);
  assert.match(get('count').textContent,/查询 0 个昵称 · 已跳过 3 个/);
  assert.notEqual(get('query').disabled,true);
  assert.equal(get('exclude-players').disabled,false);
  get('exclude-players').value = '';
  await get('query').handlers.click();
  assert.deepEqual(queryNames(),['ARRYJW2',...names]);
  assert.deepEqual(rankNames(),[]);
  parseError = true;
  await get('query').handlers.click();
  assert.notEqual(get('query').disabled,true,'parse failures must unlock query button');
  assert.equal(get('exclude-players').disabled,false,'parse failures must unlock filter input');
  assert.match(get('progress').textContent,/输入格式错误/);
}
async function candidateFilteringScenario() {
  const queries=[];
  const {get}=harness((path,body)=>{
    if(path==='parse') return {names:['输入昵称']};
    if(path==='batch/start'){queries.push(body);return {batch:'choice'};}
    const data=queries.at(-1).steamId? {steamId:'1',...empty} :
      {needsChoice:true,message:'请选择',candidates:[{pvpNickName:'候选玩家',steamId:'1'}]};
    return {events:[{kind:'base',index:0,data}],cursor:1,done:true};
  });
  await get('query').handlers.click();
  const button = get('results').children[0].querySelectorAll('button')[0];
  for (const excluded of ['候选玩家','输入昵称']) {
    get('exclude-players').value = excluded;
    await button.handlers.click();
    assert.equal(queries.length,1,'candidate clicks must also skip excluded names');
  }
  get('exclude-players').value = '';
  await button.handlers.click();
  assert.equal(queries.length,2,'removing candidate from filter allows querying');
}
async function progressiveAndCancellation() {
  let pending, turn=0;
  const {get,calls}=harness((path,body)=>{
    if(path==='parse') return {names:['slow','fast']};
    if(path==='batch/start') return {batch:String(++turn)};
    if(body.batch==='2') return {events:[{kind:'base',index:0,data:{name:'new',steamId:'new',...empty}}],cursor:1,done:true};
    if(body.cursor===0) return {events:[{kind:'base',index:1,data:{name:'fast',steamId:'f',historyRankState:'pending',
      recentMatches:[{...record,honor:'',detailState:'pending'}]}}],cursor:1,done:false};
    return new Promise(resolve => {pending=resolve;});
  });
  const before=get('query').handlers.click();
  await new Promise(resolve=>setImmediate(resolve));
  const [slow,fast]=get('results').children;
  assert.match(text(slow),/等待/);assert.match(text(fast),/加载中/);
  assert.match(text(fast),/20\/4\/4/);
  const finish=pending;
  finish({events:[{kind:'history',index:1,steamId:'f',data:{historyRankState:'unavailable'}},
    {kind:'detail',index:1,steamId:'f',position:0,data:{...record,detailState:'ready'}}],cursor:3,done:false});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(get('results').children[1],fast);
  assert.match(text(fast),/历史分数查询暂时失败/);assert.match(text(fast),/准/);
  get('cancel').handlers.click();
  await get('query').handlers.click();
  pending({events:[{kind:'base',index:0,data:{error:'stale'}}],cursor:4,done:true});
  await before;
  assert.doesNotMatch(text(get('results')),/stale/);
  assert.ok(calls.some(c=>c.path==='batch/cancel' && c.body.batch==='1'));
}
(async () => {
  await progressiveAndCancellation();
  await filteringScenario('names');
  await filteringScenario('status');
  await candidateFilteringScenario();
  await scenario([active,empty],1);
  await scenario([active,active],2);
  await scenario([empty,empty],2);
  await scenario([active,empty,failed],2);
  await scenario([empty,failed],2);
  await scenario([{recentMatches:null,matchMessage:'请先登录并确认自己的 SteamID'}, {recentMatches:null,matchMessage:'请先登录并确认自己的 SteamID'}],2);
  await scenario([active,empty],2,true);



  await scenario([{...active,recentMatches:active.recentMatches.map(r=>({...r,pvpNormalRank:null}))},empty],1);
  console.log('PASS: excluded names send no player or rank requests; multiline/exact matching, names/status modes, all-filtered batches, clear and requery, candidate selection, error recovery; existing rank/stat/duplicate regressions');
})().catch(error => { console.error(error); process.exitCode = 1; });
