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
async function scenario(fixtures, expected, fuzzy = false) {
  const elements = new Map();
  const get = id => { assert.notEqual(id, 'matches', 'removed checkbox must not be accessed'); if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const calls = [];
  const candidates = fixtures.map((_, index) => ({pvpNickName:fuzzy ? '相似名字' : '同名测试', steamId:String(76561198000000000n + BigInt(index))}));
  const sandbox = {
    document:{getElementById:get, querySelector:() => ({content:'test'}), createElement:() => new Element()},
    setInterval() {}, setTimeout:fn => {fn();},
    fetch:async (url, options) => {
      const body = JSON.parse(options.body); let result, ok = true;
      if (url.endsWith('/query')) assert.equal(body.matches, true, 'every player query must request recent matches');
      if (url.endsWith('/auth/status')) result = {loggedIn:true,steamId:'76561198000000000',matchesVerified:true};
      else if (url.endsWith('/parse')) result = {names:['同名测试']};
      else if (url.endsWith('/match-ranks')) {
        const fixture = fixtures[candidates.findIndex(c => c.steamId === body.steamId)];
        ok = !fixture.rankError; result = ok ? {records: fixture.rankRecords || []} : {error:'网络失败'};
      }
      else if (!body.steamId) result = {needsChoice:true,candidates,message:'请选择'};
      else { calls.push(body); result = {...fixtures[candidates.findIndex(c => c.steamId === body.steamId)],steamId:body.steamId}; ok = !result.error; }
      return {ok,json:async () => result};
    }
  };
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, 'globalThis.rankForScoreTest = rankForScore;globalThis.tableTest = matchTable;globalThis.outcomeTest = matchOutcome;globalThis.highlightTest = matchHighlights;globalThis.officialTierTest = officialRankTier;globalThis.latestOfficialTest = latestOfficialRank;})();'), sandbox);
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
    assert.equal(calls.length,0); assert.match(display,/请选择/); return;
  }
  assert.equal(calls.length,fixtures.length);
  assert.ok(calls.every(call => call.matches === true), 'same-name checks must always request recent matches');
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
  const previousCalls = calls.length;
  await get('query').handlers.click();
  assert.equal(calls.length,previousCalls,'filtered players must not be queried again');
  assert.equal(get('results').children.length,0,'all filtered must leave no loading cards');
  assert.match(get('progress').textContent,/未查询任何玩家/);
  get('exclude-players').value = '';
  get('exclude-players').handlers.input();
  await get('query').handlers.click();
  assert.equal(calls.length,previousCalls * 2,'clearing filter must query players again');
}
async function filteringScenario(mode) {
  const elements = new Map(), calls = [];
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const names = ['ARRYJW','大禄鸠叔叔','ARRYJW2'];
  let parseError = false;
  const sandbox = {
    document:{getElementById:get,querySelector:() => ({content:'test'}),createElement:tag => { const el = new Element(); el.tagName = tag; return el; }},
    setInterval() {},setTimeout:fn => fn(),
    fetch:async (url, options) => {
      const body = JSON.parse(options.body); calls.push({url,body});
      let result, ok = true;
      if (url.endsWith('/auth/status')) result = {loggedIn:true,matchesVerified:true};
      else if (url.endsWith('/parse')) {
        assert.equal(get('exclude-players').disabled,true,'filter is fixed for the running batch');
        assert.equal(body.mode,mode);
        ok = !parseError;
        result = ok ? {names} : {error:'输入格式错误'};
      }
      else if (url.endsWith('/query')) {
        assert.equal(body.matches,true);
        result = {name:body.name,steamId:body.name,...active};
      }
      else if (url.endsWith('/match-ranks')) result = {records:active.rankRecords};
      else assert.fail(`unexpected API ${url}`);
      return {ok,json:async () => result};
    }
  };
  vm.runInNewContext(source,sandbox);
  get('mode').value = mode;
  get('players').value = mode === 'status' ? '# userid name uniqueid\n# 1 "ARRYJW" STEAM_1:0:1' : names.join('\n');
  get('exclude-players').value = ' ARRYJW \r\n\n大禄鸠叔叔\nARRYJW\n不在查询中';
  get('exclude-players').handlers.input();
  const queryNames = () => calls.filter(call => call.url.endsWith('/query')).map(call => call.body.name);
  const rankNames = () => calls.filter(call => call.url.endsWith('/match-ranks')).map(call => call.body.steamId);
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
  assert.equal(get('query').disabled,false);
  assert.equal(get('exclude-players').disabled,false);
  get('exclude-players').value = '';
  await get('query').handlers.click();
  assert.deepEqual(queryNames(),['ARRYJW2',...names]);
  assert.deepEqual(rankNames(),[]);
  parseError = true;
  await get('query').handlers.click();
  assert.equal(get('query').disabled,false,'parse failures must unlock query button');
  assert.equal(get('exclude-players').disabled,false,'parse failures must unlock filter input');
  assert.match(get('progress').textContent,/输入格式错误/);
}
async function candidateFilteringScenario() {
  const elements = new Map(), queries = [];
  const get = id => { if (!elements.has(id)) elements.set(id,new Element()); return elements.get(id); };
  const sandbox = {
    document:{getElementById:get,querySelector:() => ({content:'test'}),createElement:tag => { const el = new Element(); el.tagName = tag; return el; }},
    setInterval() {},setTimeout:fn => fn(),
    fetch:async (url,options) => {
      const body = JSON.parse(options.body); let result;
      if (url.endsWith('/auth/status')) result = {loggedIn:false};
      else if (url.endsWith('/parse')) result = {names:['输入昵称']};
      else if (url.endsWith('/query')) {
        queries.push(body);
        result = body.steamId ? {name:body.name,...empty} : {needsChoice:true,message:'请选择',candidates:[{pvpNickName:'候选玩家',steamId:'1'}]};
      } else assert.fail(`unexpected API ${url}`);
      return {ok:true,json:async () => result};
    }
  };
  vm.runInNewContext(source,sandbox);
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
(async () => {
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
