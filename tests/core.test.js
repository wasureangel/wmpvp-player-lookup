import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNames,summarizeRecent,latestOfficialRank,historyPeak,mapLimit,steamId} from '../server/core.js';

test('recent statistics use ten per-match values, and draws count as losses', () => {
  const rows = Array.from({length:10}, (_, index) => ({team:2,winTeam:index<7?2:index===7?-1:1,
    kill:20,death:10,we:8,pwRating:1.2,headShotRatio:.5,adpr:80,rws:10}));
  rows[0].kill=10; rows[0].death=20;
  rows.push({team:2,winTeam:2,we:999});
  const result=summarizeRecent(rows);
  assert.equal(result.games,10);
  assert.equal(result.winrate,.7);
  assert.equal(result.kd,1.85);
  assert.equal(result.adr,80);
  assert.ok(Math.abs(result.rating_pro-1.2)<1e-12);
  assert.equal(summarizeRecent([{team:1,winTeam:-1},{team:2,winTeam:0}]).winrate,0);
});

test('missing or invalid values never become zero or a partial average', () => {
  assert.equal(summarizeRecent([]),null);
  const result=summarizeRecent([{team:1,winTeam:1,kill:1,death:1,we:0},{team:2,kill:2,death:0,we:10}]);
  assert.equal(result.we,5);
  assert.equal(result.winrate,null);
  assert.equal(result.kd,null);
  assert.equal(result.adr,null);
  for(const invalid of [null,undefined,NaN,Infinity,-1,true,'1']) {
    assert.equal(summarizeRecent([{we:invalid}]).we,null);
  }
});

test('official rank is the newest valid score in the first ten matches', () => {
  const rows=[{pvpNormalRank:null},{pvpNormalRank:25162,startTime:'test',mode:'Pro'},{pvpNormalRank:26000}];
  assert.deepEqual(latestOfficialRank(rows),{score:25162,time:'test',mode:'Pro'});
  assert.equal(latestOfficialRank(Array(10).fill({}).concat([{pvpNormalRank:30000}])),null);
  assert.equal(latestOfficialRank([{pvpNormalRank:0}]).score,0);
  assert.equal(latestOfficialRank([{pvpNormalRank:true},{pvpNormalRank:-1}]),null);
});

test('history peaks only include valid returned scores', () => {
  assert.equal(historyPeak([1528,2852,1887]),2852);
  assert.equal(historyPeak([null,true,'9999',-1]),null);
  assert.equal(historyPeak([]),null);
  assert.equal(historyPeak([0]),0);
});

test('name parsing handles multiline and game-console text with limits', () => {
  assert.deepEqual(parseNames({text:'同名\n 第二名 \n同名'}),{names:['同名','第二名']});
  assert.deepEqual(parseNames({mode:'status',text:"[Client] 3 07:20 21 0 active 786432 ' 玩家名'\n[Client] 4 03:10 0 0 active 12 'BOT'"}),{names:['玩家名']});
  assert.throws(()=>parseNames({text:Array.from({length:21},(_,i)=>String(i)).join('\n')}));
  assert.throws(()=>parseNames({text:''}));
  assert.equal(steamId('76561199148425546'),'76561199148425546');
  assert.throws(()=>steamId('http://localhost'));
});

test('limited parallelism keeps results in their original order', async () => {
  let current=0,peak=0;
  const result=await mapLimit([1,2,3,4,5],2,async value=>{
    current++;peak=Math.max(peak,current);
    await new Promise(resolve=>setTimeout(resolve,2));
    current--;return value*2;
  });
  assert.deepEqual(result,[2,4,6,8,10]);
  assert.equal(peak,2);
});
