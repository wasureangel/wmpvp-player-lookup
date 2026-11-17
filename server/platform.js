import {AppError, field, steamId, scoreValue, historyPeak, summarizeRecent, latestOfficialRank, mapLimit} from './core.js';

const APPVERSION = '3.5.4.172';
const API = 'https://api.wmpvp.com';
const SEARCH = 'https://appengine.wmpvp.com/steamcn/app/search/user';
const PASSPORT = 'https://passport.pwesports.cn';
const allowed = new Set([new URL(API).host,new URL(SEARCH).host,new URL(PASSPORT).host,'partner.wmpvp.com']);
const historyCache = new Map();
let seasonsCache;

export async function remote(url, payload, headers = {}, fetcher = fetch) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !allowed.has(target.host)) throw new AppError('不支持的查询地址');
  // Preserve exact numeric SteamIDs on the wire without first coercing to Number.
  const body = payload === undefined ? undefined : JSON.stringify(payload).replace(/"(mySteamId|toSteamId)":"(\d{17})"/g,'"$1":$2');
  const service = target.host === new URL(PASSPORT).host ? '完美登录服务' : '完美数据服务';
  let response, text;
  try {
    response = await fetcher(url, {method:payload === undefined ? 'GET' : 'POST',
      headers:{Accept:'application/json', ...(payload === undefined ? {} : {'Content-Type':'application/json'}), ...headers},
      // Workers supports only manual/follow. Reject 3xx below instead of
      // forwarding login credentials to a redirect destination.
      body, redirect:'manual', signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw new AppError(`${service}返回 HTTP ${response.status}，请稍后重试`, 502);
    text = await response.text();
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (['TimeoutError','AbortError'].includes(error?.name)) throw new AppError(`连接${service}超时（15 秒），请稍后重试`, 504);
    // Do not echo upstream exceptions: URLs may contain phone numbers or tickets.
    throw new AppError(`本站无法连接${service}，请维护者检查 Cloudflare 到官方接口的连接`, 502);
  }
  // Some upstream responses encode IDs as JSON numbers; keep their original digits.
  try {
    return JSON.parse(text.replace(/("(?:steamId|steamId64|playerId|mySteamId|toSteamId)"\s*:\s*)(\d{17})(?=\s*[,}])/g,'$1"$2"'));
  } catch {
    throw new AppError(`${service}未返回有效数据（HTTP ${response.status}），可能是拦截页面或临时异常`, 502);
  }
}

export async function passport(path, payload, fetcher) {
  let result;
  try {
    result = await remote(PASSPORT + path, payload, {platform:'APP',appversion:'3.1.0'}, fetcher);
  } catch (error) {
    if (path === '/initcaptcha' && error instanceof AppError) throw new AppError('获取官方验证码失败：' + error.message, error.status);
    throw error;
  }
  if (result.code !== 0) throw new AppError('官方验证未通过，请核对输入或稍后重试。');
  return result;
}

export async function matchList(sid, auth, fetcher) {
  if (!auth?.token || !/^\d{17}$/.test(auth.steamId || '')) throw new AppError('请先登录并验证战绩权限');
  // Strings preserve all 17 SteamID digits; JavaScript numbers cannot do this safely.
  const result = await remote(API + '/api/csgo/home/match/list', {
    csgoSeasonId:'recent',dataSource:3,mySteamId:auth.steamId,page:1,pageSize:10,pvpType:-1,toSteamId:sid,
  }, {appversion:APPVERSION,token:auth.token}, fetcher);
  if (result.statusCode !== 0 || !Array.isArray(result.data?.matchList)) throw new AppError('战绩查询失败：登录可能过期、账号不匹配或接口不可用');
  return result.data.matchList.slice(0, 10);
}

async function enrichMatch(match, sid, fetcher) {
  const result = {...match};
  if (!/^[A-Za-z0-9@_-]{1,80}$/.test(match.matchId || '')) return result;
  try {
    const response = await remote(API + '/api/v1/csgo/match', {matchId:match.matchId,platform:'admin',dataSource:'3'}, {appversion:APPVERSION}, fetcher);
    const player = response.statusCode === 0 && response.data?.players?.find(player => String(player.playerId) === sid);
    if (player) for (const name of ['we','pwRating','headShotRatio','adpr','rws','kill','death']) {
      if (scoreValue(result[name]) === null) result[name] = player[name];
    }
  } catch { /* Keep confirmed list values when detail is unavailable. */ }
  return result;
}

async function search(name, fetcher) {
  const response = await remote(SEARCH,{keyword:name,page:1},{appversion:APPVERSION,Referer:'https://client.wmpvp.com'},fetcher);
  if (response.code !== 1 || (response.result != null && !Array.isArray(response.result))) throw new AppError('昵称搜索接口返回异常，请稍后重试', 502);
  return (response.result || []).filter(row => /^\d{17}$/.test(String(row.steamId))).map(row => ({
    steamId:String(row.steamId),pvpNickName:String(row.pvpNickName || ''),pvpScore:scoreValue(row.pvpScore),avatar:String(row.pvpAvatar || ''),
  }));
}

export async function queryPlayer(data, auth, fetcher) {
  const name = field(data,'name',100), requestedSid = field(data,'steamId',17);
  if (!name && !requestedSid) throw new AppError('请输入昵称');
  if (requestedSid) steamId(requestedSid);
  const candidates = name ? await search(name, fetcher) : [];
  const exact = candidates.filter(player => player.pvpNickName === name);
  if (!requestedSid && exact.length !== 1) return {name,needsChoice:true,candidates:exact.length ? exact : candidates.slice(0,20),message:candidates.length ? '请核对并选择玩家' : '未搜索到玩家'};
  const picked = requestedSid ? candidates.find(player => player.steamId === requestedSid) || {steamId:requestedSid,pvpNickName:name,pvpScore:null,avatar:''} : exact[0];
  const row = {name,...picked,stats:null,officialRank:null,matchMessage:'',historyPending:true};
  if (data.matches === true) {
    if (!auth?.token || !auth.steamId) row.matchMessage = '请先登录并确认自己的 SteamID';
    else try {
      const matches = await matchList(picked.steamId, auth, fetcher);
      row.officialRank = latestOfficialRank(matches);
      row.stats = summarizeRecent(await mapLimit(matches,3,match => enrichMatch(match,picked.steamId,fetcher)));
      row.matchMessage = row.stats ? '' : '近期无对局记录';
    } catch { row.matchMessage = '战绩查询失败：登录可能过期、账号不匹配或接口不可用'; }
  }
  return row;
}

async function seasons(fetcher) {
  if (seasonsCache?.expires > Date.now()) return seasonsCache.seasons;
  const response = await remote(API + '/api/v2/common/matchdata/csgoSeasons',undefined,{appversion:APPVERSION},fetcher);
  const values = response.statusCode === 0 && Array.isArray(response.data) ? [...new Set(response.data.map(item => item.season).filter(season => typeof season === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(season)))] : [];
  if (!values.length || values.length > 400) throw new AppError('未取得有效的赛季列表', 502);
  seasonsCache = {expires:Date.now()+3600000,seasons:values};
  return values;
}

export async function historyBatch(data, fetcher) {
  const sid = steamId(field(data,'steamId',17));
  const offset = data.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > 400 || offset % 20) throw new AppError('历史查询位置无效');
  const all = await seasons(fetcher);
  if (offset >= all.length) throw new AppError('历史查询已结束');
  const selected = all.slice(offset,offset+20), cacheKey = sid + ':' + selected.join(',');
  if (historyCache.get(cacheKey)?.expires > Date.now()) return historyCache.get(cacheKey).data;
  const results = await mapLimit(selected,3,async season => {
    try {
      const response = await remote(API + '/api/v2/csgo/pvpDetailStats',{steamId64:sid,csgoSeasonId:season},{appversion:APPVERSION},fetcher);
      if (response.statusCode !== 0 || response.data?.seasonId !== season) return {ok:false,peak:null};
      return {ok:true,peak:historyPeak(response.data.historyScores)};
    } catch { return {ok:false,peak:null}; }
  });
  const dataOut = {peak:historyPeak(results.map(item=>item.peak)),checked:results.filter(item=>item.ok).length,
    total:all.length,nextOffset:offset+selected.length < all.length ? offset+selected.length : null};
  if (results.every(item=>item.ok)) {
    if (historyCache.size >= 128) historyCache.delete(historyCache.keys().next().value);
    historyCache.set(cacheKey,{expires:Date.now()+600000,data:dataOut});
  }
  return dataOut;
}

export async function login(data, fetcher) {
  const mobile = field(data,'mobile',11), code = field(data,'code',6);
  if (!/^\d{11}$/.test(mobile) || !/^\d{6}$/.test(code)) throw new AppError('请输入手机号和 6 位短信验证码');
  const result = await passport('/account/login',{appId:10,mobilePhone:mobile,securityCode:code},fetcher);
  const info = result.result?.loginResult?.accountInfo || {};
  if (typeof info.token !== 'string' || !info.token || info.token.length > 2048) throw new AppError('官方登录未返回可用凭据',502);
  let sid = String(info.steamId || '');
  try {
    const profile = await remote('https://partner.wmpvp.com/thirdparty/steamcn/user/login',{}, {Authorization:info.token},fetcher);
    sid = String(profile.result?.user?.steamId || sid);
  } catch { /* The account ID can be entered and verified manually. */ }
  return {token:info.token,steamId:/^\d{17}$/.test(sid) ? sid : '',matchesVerified:false};
}

export function clearCachesForTests() { seasonsCache = undefined; historyCache.clear(); }
