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
  click() {}
  setAttribute(name, value) { this[name] = value; }
}
const text = element => [element.textContent, ...element.children.map(text)].join('\n');
const active = {pvpScore:2450,historyPeakScore:1887,historyRankState:'available',stats:{games:10,winrate:.6,rating_pro:1.20,kd:1.25,we:8.3,headshot:.757,adr:76,rws:9.23},matchMessage:'',rankRecords:[{pvpNormalRank:null},{pvpNormalRank:25162,startTime:'2026-11-18 02:13:00',mode:'完美官匹Pro'},{pvpNormalRank:26000}]};
const empty = {pvpScore:0,stats:null,matchMessage:'近期无对局记录'};
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
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, 'globalThis.rankForScoreTest = rankForScore;globalThis.metricTest = metric;globalThis.officialTierTest = officialRankTier;globalThis.latestOfficialTest = latestOfficialRank;globalThis.recentWinrateTest = recentWinrate;})();'), sandbox);
  const drawCases = [1, 2, -1, 0].map(winTeam => ({team:1,winTeam}));
  assert.equal(sandbox.recentWinrateTest(drawCases,4),.25);
  assert.equal(sandbox.recentWinrateTest(drawCases.slice(2),2),0);
  assert.equal(sandbox.recentWinrateTest(drawCases,10),null);
  assert.equal(sandbox.recentWinrateTest(Array(10).fill({team:2,winTeam:2}).concat([{team:2,winTeam:-1}]),10),1);
  for (const missing of [null, undefined, -2, 99, '1', true]) assert.equal(sandbox.recentWinrateTest([{team:1,winTeam:missing}],1),null);
  assert.equal(sandbox.recentWinrateTest([],0),null);
  assert.equal(sandbox.recentWinrateTest([{winTeam:-1}],1),null);
  for (const [score,tier] of [[0,'gray'],[4999,'gray'],[5000,'light-blue'],[9999,'light-blue'],[10000,'blue'],[14999,'blue'],[15000,'purple'],[19999,'purple'],[20000,'magenta'],[24999,'magenta'],[25000,'red'],[29999,'red'],[30000,'gold'],[100000,'gold'],[null,null],[-1,null],[true,null],[3.5,null],['20000',null]]) assert.equal(sandbox.officialTierTest(score),tier);
  assert.equal(sandbox.latestOfficialTest([{pvpNormalRank:null},{pvpNormalRank:0},{pvpNormalRank:20000}]).score,0);
  assert.equal(sandbox.latestOfficialTest(Array(10).fill({pvpNormalRank:null}).concat([{pvpNormalRank:20000}])),null);
  assert.equal(sandbox.latestOfficialTest([{pvpNormalRank:NaN},{pvpNormalRank:true},{pvpNormalRank:-5},{pvpNormalRank:'25000'}]),null);
  assert.equal(sandbox.latestOfficialTest(null),null);
  assert.match(text(sandbox.metricTest('Rating Pro',1.2449999999999999,2)),/1.25/);
  for (const missing of [null,undefined,NaN,true,'1.2']) assert.match(text(sandbox.metricTest('Rating Pro',missing,2)),/--/);
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
  const expectedOfficial = fixtures.filter(f => f.stats && !f.rankError && f.rankRecords?.some(r => Number.isInteger(r.pvpNormalRank) && r.pvpNormalRank >= 0)).length;
  assert.equal(officialBadges.length,expectedOfficial);
  if (officialBadges.length) { assert.match(display,/25,162/); assert.doesNotMatch(display,/26,000/); }
  else assert.doesNotMatch(display,/官匹分/);
  assert.equal(peakBadges.length, fixtures.filter(f => f.historyRankState === 'available').length);
  if (peakBadges.length) assert.match(display, /1887/);
  if (fixtures.some(f => f.stats)) {
    for (const expected of ['WE 制胜评价','Rating Pro','场次','爆头率','ADR','K/D','RWS','60.0','75.7','1.20','8.3']) assert.ok(display.includes(expected), expected);
    assert.doesNotMatch(display, /赛季场次/);
  }
  assert.equal(elements.has('download'), false);
  assert.doesNotMatch(display, /7656119|平台昵称|封禁|分数变化/);
  if (fixtures.some(f => f.error)) assert.match(display,/查询失败/);
  get('exclude-players').value = '其他玩家\n 同名测试 \n同名测试';
  get('exclude-players').handlers.input();
  assert.ok(get('results').children[0].hidden);
  get('exclude-players').value = '';
  get('exclude-players').handlers.input();
  assert.equal(get('results').children[0].hidden,false);
}
(async () => {
  await scenario([active,empty],1);
  await scenario([active,active],2);
  await scenario([empty,empty],2);
  await scenario([active,empty,failed],2);
  await scenario([empty,failed],2);
  await scenario([{stats:null,matchMessage:'请先登录并确认自己的 SteamID'}, {stats:null,matchMessage:'请先登录并确认自己的 SteamID'}],2);
  await scenario([active,empty],2,true);
  await scenario([{...active,rankRecords:[]},empty],1);
  await scenario([{...active,rankError:true},empty],1);
  await scenario([{...active,stats:{...active.stats,winrate:null},rankRecords:Array.from({length:10},(_,i)=>({team:1,winTeam:i<6?1:i<8?2:-1}))},empty],1);
  console.log('PASS: duplicate policies, rank boundaries, result rendering, multiline filtering and restore, no download dependencies');
})().catch(error => { console.error(error); process.exitCode = 1; });
