import {createHash} from 'node:crypto';
import {AppError,field,steamId,scoreValue,historyPeak,latestOfficialRank,summarizeRecent} from './core.js';
import {LONG,PlatformError} from './engine.js';

const API='https://api.wmpvp.com', PASSPORT='https://passport.pwesports.cn';
const version={appversion:'3.5.4.172'};
const listKeys='matchId startTime endTime mode mapName mapLogo team winTeam score1 score2 kill death assist rating adpr rws pwRating we pvpScore pvpNormalRank honor mvp pvpMvp headShotRatio rank oldrank deltaRank pvpScoreChange pvpScoreChangeType pvpStars pvpGrading matchType gameMode dataSource status'.split(' ');
const awardKeys=['headShot','snipeNum','entryKill','endGame','flashSuccess','assist'];
const fillKeys=['we','pwRating','headShotRatio','adpr','rws','kill','death','assist'];
const pick=(row,keys)=>Object.fromEntries(keys.filter(k=>Object.hasOwn(row,k)).map(k=>[k,row[k]]));
const honors=value=>(Array.isArray(value)?value:String(value??'').split(',')).map(v=>String(v).trim()).filter(v=>/^[1-7]$/.test(v));
function success(data) {
  if (data?.statusCode!==0) {
    const auth=[401,403].includes(data?.statusCode)||/token|登录|未授权/i.test(data?.errorMessage||'');
    throw new PlatformError(auth?'auth':'business',auth?'登录失效或权限不足':'平台未能完成请求');
  }
  return data.data;
}
function malformed() {throw new PlatformError('format','平台返回的数据异常');}

export function passport(path,payload,engine) {
  return engine.request('passport',PASSPORT+path,payload,{platform:'APP',appversion:'3.1.0'},{attempts:1,decode:r=>{
    if (r?.code!==0) throw new AppError('官方验证未通过，请核对输入或稍后重试。');
    return r;
  }});
}
export async function login(data,engine) {
  const mobile=field(data,'mobile',11),code=field(data,'code',6);
  if (!/^\d{11}$/.test(mobile)||!/^\d{6}$/.test(code)) throw new AppError('请输入手机号和 6 位短信验证码');
  const result=await passport('/account/login',{appId:10,mobilePhone:mobile,securityCode:code},engine);
  const info=result.result?.loginResult?.accountInfo||{};
  if (typeof info.token!=='string'||!info.token||info.token.length>2048) throw new AppError('官方登录未返回可用凭据',502);
  let sid=String(info.steamId||'');
  try {
    const profile=await engine.request('profile','https://partner.wmpvp.com/thirdparty/steamcn/user/login',{}, {Authorization:info.token},{attempts:1});
    sid=String(profile.result?.user?.steamId||sid);
  } catch { /* The user can enter and verify their own SteamID. */ }
  return {token:info.token,steamId:/^\d{17}$/.test(sid)?sid:'',matchesVerified:false};
}

export async function matchList(sid,auth,engine,signal,cache=true) {
  if (!auth?.token||!/^\d{17}$/.test(auth.steamId||'')) throw new AppError('请先登录并确认自己的 SteamID');
  const read=s=>engine.request('recent',API+'/api/csgo/home/match/list',{csgoSeasonId:'recent',dataSource:3,
    mySteamId:auth.steamId,page:1,pageSize:10,pvpType:-1,toSteamId:sid},{...version,token:auth.token},{signal:s,decode:r=>{
      const list=success(r)?.matchList;
      if (!Array.isArray(list)) malformed();
      return list.slice(0,10).map(m=>pick(m,listKeys));
    }});
  if (!cache) return read(signal);
  const scope=createHash('sha256').update(auth.token).digest('hex');
  return engine.cached('recent',scope+'/'+auth.steamId+'/'+sid,60000,signal,read);
}

export async function basic(name,requested,auth,engine,signal,{matches=true,automatic=true}={}) {
  let candidates=[];
  try {
    candidates=await engine.request('search','https://appengine.wmpvp.com/steamcn/app/search/user',{keyword:name,page:1},
      {...version,Referer:'https://client.wmpvp.com'},{signal,decode:r=>{
        if (r.code!==1) throw new AppError('昵称搜索失败',502);
        const unique=new Map();
        for (const row of r.result||[]) {
          const id=String(row.steamId);
          if (/^\d{17}$/.test(id)&&!unique.has(id)) unique.set(id,{steamId:id,pvpNickName:String(row.pvpNickName||''),
            appNickName:String(row.appNickName||''),avatar:String(row.pvpAvatar||''),pvpScore:scoreValue(row.pvpScore)});
        }
        return [...unique.values()];
      }});
  } catch(e) {if (!requested||signal?.aborted) throw e;}
  let selected=candidates.filter(c=>c.pvpNickName===name);
  if (requested) selected=[candidates.find(c=>c.steamId===requested)||{steamId:requested,pvpNickName:name,pvpScore:null}];
  else if (!selected.length || (!automatic&&selected.length!==1)) return {name,needsChoice:true,candidates:selected.length?selected:candidates.slice(0,20),message:candidates.length?'请核对并选择玩家':'未搜索到玩家'};
  const rows=await Promise.all(selected.map(async player=>{
    const row={name,...player,recentMatches:null,historyRankState:'pending',matchMessage:''};
    if (matches) try {
      const records=await matchList(row.steamId,auth,engine,signal);
      row.recentMatches=records.map(m=>({...m,honor:honors(m.honor).join(','),detailState:'pending'}));
      if (!records.length) row.matchMessage='近期无对局记录';
    } catch(e) {if (signal?.aborted) throw e; row.matchMessage=e instanceof AppError?e.message:'近期对局查询失败';}
    return row;
  }));
  if (rows.length===1) return rows[0];
  const keep=rows.some(r=>r.recentMatches?.length)?rows.filter(r=>r.recentMatches?.length!==0):rows;
  return {name,players:keep,message:`找到 ${rows.length} 个同名账号，显示 ${keep.length} 个。`};
}

export async function detail(match,sid,engine,signal) {
  try {
    const id=String(match.matchId||'');
    if (!/^[\w@-]{1,80}$/.test(id)) malformed();
    const players=await engine.cached('detail',id,match.endTime?LONG:60000,signal,s=>engine.request('detail',API+'/api/v1/csgo/match',
      {matchId:id,platform:'admin',dataSource:'3'},version,{priority:1,signal:s,decode:r=>{
        const rows=success(r)?.players;
        if (!Array.isArray(rows)||!rows.length) malformed();
        return rows.map(p=>pick(p,['playerId','honor','mvp','pvpMvp',...fillKeys,...awardKeys]));
      }}));
    const player=players.find(p=>String(p.playerId)===sid);
    if (!player) malformed();
    const row={...match,detailState:'ready',derivedHonors:[]};
    for (const k of fillKeys) if (scoreValue(row[k])===null) row[k]=player[k]??null;
    if (match.mode==='完美官匹Pro' && players.length===10 && players.every(p=>p.playerId&&!honors(p.honor).length)
        && new Set(players.map(p=>String(p.playerId))).size===10) {
      awardKeys.forEach((key,i)=>{
        const values=players.map(p=>scoreValue(p[key])),max=Math.max(...values);
        if (!values.includes(null)&&max>0&&players[values.indexOf(max)]===player) row.derivedHonors.push(String(i+2));
      });
    }
    row.honor=[...new Set([...honors(match.honor),...honors(player.honor),...row.derivedHonors])].join(',');
    for (const flag of ['mvp','pvpMvp']) row[flag]=match[flag]===true||player[flag]===true;
    return row;
  } catch(e) {if (signal?.aborted) throw e; return {...match,detailState:'unavailable'};}
}

async function seasons(engine,signal) {
  return engine.cached('catalog','seasons',600000,signal,s=>engine.request('catalog',API+'/api/v2/common/matchdata/csgoSeasons',
    undefined,version,{priority:2,signal:s,decode:r=>{
      const rows=success(r);
      if (!Array.isArray(rows)||!rows.length||rows.length>400) malformed();
      const unique=new Map();
      for (const v of rows) if (/^[\w-]{1,24}$/.test(v?.season||'')) unique.set(v.season,{id:v.season,
        ended:Date.parse(String(v.endTime||'').replace(' ','T')+'+08:00')<Date.now()});
      if (!unique.size) malformed();
      return [...unique.values()];
    }}));
}

export async function history(sid,engine,signal,offset=null) {
  let all,known=true;
  try {all=await seasons(engine,signal);} catch(e) {if (signal?.aborted) throw e; known=false;all=[{id:'recent',ended:false}];}
  const selected=offset===null?all:all.slice(offset,offset+20);
  const results=await Promise.all(selected.map(async season=>{
    try {
      const peak=await engine.cached('season',sid+'/'+season.id,season.ended?LONG:300000,signal,s=>engine.request('season',
        API+'/api/v2/csgo/pvpDetailStats',{steamId64:sid,csgoSeasonId:season.id},version,{priority:2,signal:s,decode:r=>{
          const data=success(r);
          if (data?.seasonId!==season.id) malformed();
          return historyPeak(data.historyScores);
        }}));
      return {ok:true,peak};
    } catch(e) {if (signal?.aborted) throw e;return {ok:false};}
  }));
  const checked=results.filter(v=>v.ok).length,peak=historyPeak(results.map(v=>v.peak));
  if (offset!==null) return {checked,peak,total:all.length,nextOffset:offset+selected.length<all.length?offset+selected.length:null};
  return {historyPeakScore:peak,historySeasonsChecked:checked,historySeasonsTotal:known?all.length:null,
    historyRankState:known&&checked===all.length?(peak===null?'empty':'available'):(checked?'partial':'unavailable')};
}

export async function queryPlayer(data,auth,engine) {
  const name=field(data,'name',100),sid=field(data,'steamId',17);
  if (!name&&!sid) throw new AppError('请输入昵称');
  const row=await basic(name,sid?steamId(sid):'',auth,engine,undefined,{matches:data.matches===true,automatic:false});
  if (row.needsChoice) return row;
  const [rank,records]=await Promise.all([history(row.steamId,engine),
    Promise.all((row.recentMatches||[]).map(m=>detail(m,row.steamId,engine)))]);
  return {...row,...rank,stats:summarizeRecent(records),recentMatches:row.recentMatches?records:null,officialRank:latestOfficialRank(records)};
}
