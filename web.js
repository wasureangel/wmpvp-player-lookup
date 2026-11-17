(() => {
const $ = id => document.getElementById(id);
const rows = new Map();
let busy = false, captcha = null, captchaTicket = '', smsUntil = 0;
async function api(path, data = {}) {
  const response = await fetch('/api/' + path, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-App-Token': document.querySelector('meta[name="app-token"]').content}, body: JSON.stringify(data)});
  const value = await response.json();
  if (!response.ok) { if (value.accessRequired) authView(value); throw new Error(value.error || '请求失败'); }
  if (path === 'query' && value.historyPending) Object.assign(value, await loadHistory(value.steamId));
  if (path === 'query' && value.steamId && value.stats && !Object.prototype.hasOwnProperty.call(value, 'officialRank')) {
    // Reuse the authenticated inspection endpoint without restarting the local service.
    // This read is optional: it must never discard otherwise successful player results.
    value.officialRank = null;
    try {
      const matches = await api('match-ranks', {steamId: value.steamId});
      value.officialRank = latestOfficialRank(matches.records);
      // Older running servers reject the -1 draw marker. Use the same ten-match
      // record list to fill only a missing win rate without clearing the login.
      if (value.stats.winrate === null) value.stats.winrate = recentWinrate(matches.records, value.stats.games);
    } catch (_) { /* No verified score: leave the badge absent. */ }
  }
  return value;
}
async function loadHistory(steamId) {
  let peak=null,checked=0,total=null,offset=0,complete=false;
  try {
    for(let page=0;page<25;page++) {
      const batch=await api('history',{steamId,offset});
      if(typeof batch.peak==='number'&&Number.isFinite(batch.peak)) peak=peak===null?batch.peak:Math.max(peak,batch.peak);
      checked+=batch.checked;total=batch.total;
      if(batch.nextOffset===null){complete=checked===total;break;}
      if(!Number.isInteger(batch.nextOffset)||batch.nextOffset<=offset)break;
      offset=batch.nextOffset;
    }
  } catch { /* Preserve verified earlier batches and report incomplete coverage. */ }
  return {historyPeakScore:peak,historySeasonsChecked:checked,historySeasonsTotal:total,
    historyRankState:complete?(peak===null?'empty':'available'):(checked?'partial':'unavailable')};
}
function recentWinrate(records, games) {
  if (!Array.isArray(records) || !Number.isInteger(games) || games < 1 || games > 10) return null;
  const recent = records.slice(0, 10);
  if (recent.length !== games || recent.some(match => !match || ![1, 2].includes(match.team) || ![-1, 0, 1, 2].includes(match.winTeam))) return null;
  return recent.filter(match => match.team === match.winTeam).length / recent.length;
}
function latestOfficialRank(records) {
  if (!Array.isArray(records)) return null;
  // The match-list endpoint returns newest first. Search only its first ten records.
  const match = records.slice(0, 10).find(record => record && Number.isInteger(record.pvpNormalRank) && record.pvpNormalRank >= 0);
  return match ? {score:match.pvpNormalRank, time:match.startTime || '', mode:match.mode || ''} : null;
}
function officialRankTier(score) {
  if (!Number.isInteger(score) || score < 0) return null;
  return ['gray','light-blue','blue','purple','magenta','red','gold'][Math.min(Math.floor(score / 5000), 6)];
}
function message(id, text, error = false) { $(id).textContent = text; $(id).classList.toggle('error', error); }
function node(tag, text, className) { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; }
function rankForScore(score) {
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0) return {label:'分数暂不可用', icon:null};
  if (score === 0) return {label:'未定级', icon:'none'};
  const tiers = [[1000,'D','D'],[1150,'C','C'],[1300,'C+','C1'],[1450,'C+（金色）','C11'],[1600,'B','B'],[1750,'B+','B1'],[1900,'B+（金色）','B11'],[2050,'A','A'],[2200,'A+','A1'],[2400,'A+（金色）','A11']];
  const tier = tiers.find(([maximum]) => score <= maximum);
  return tier ? {label:tier[1],icon:tier[2]} : {label:'S',icon:'S'};
}
function excludedNames() { return new Set($('exclude-players').value.split(/\r?\n/).map(name => name.trim()).filter(Boolean)); }
function updateVisibility() {
  const excluded = excludedNames(); let hidden = 0;
  for (const [name, row] of rows) {
    const article = $('results').querySelector('[data-index="' + row.index + '"]');
    if (article) article.hidden = excluded.has(name);
    if (excluded.has(name)) hidden++;
  }
  $('filter-status').textContent = excluded.size ? `已设置 ${excluded.size} 个过滤昵称；当前隐藏 ${hidden} 组结果。` : '每行一个昵称，完全匹配；清空即可恢复显示。';
  if (rows.size) $('count').textContent = `${rows.size} 个昵称 · 显示 ${rows.size - hidden} 组，过滤 ${hidden} 组`;
}
$('exclude-players').addEventListener('input', updateVisibility);
function authView(data) {
  const locked=!!data.accessRequired;
  $('site-access').hidden=!locked;
  $('query').disabled=busy||locked;
  $('auth-badge').textContent = locked ? '站点未解锁' : data.loggedIn ? '已登录' : '未登录';
  $('login-form').hidden = locked || data.loggedIn; $('logged-in').hidden = locked || !data.loggedIn;
  $('my-steamid').value = data.steamId || '';
  $('manual-account').hidden = Boolean(data.steamId);
  $('account').textContent = data.matchesVerified ? '战绩接口已验证，可查询近期表现。' : '官方登录已完成，战绩权限尚未验证。';
}
$('unlock').addEventListener('click', async () => {
  $('unlock').disabled=true;
  try { authView(await api('access/unlock',{password:$('site-password').value})); $('site-password').value=''; message('access-message',''); }
  catch(e){message('access-message',e.message,true);}
  finally{$('unlock').disabled=false;}
});
function selectRecentPlayers(players) {
  const hasRecent = players.some(player => player.stats && player.stats.games > 0);
  // Only a successful empty response proves there are no recent matches.
  return hasRecent ? players.filter(player => player.matchMessage !== '近期无对局记录') : players;
}
async function resolveDuplicates(name, result) {
  if (!result.needsChoice || result.candidates.length < 2 || !result.candidates.every(candidate => candidate.pvpNickName === name)) return result;
  const candidates = [...new Map(result.candidates.map(candidate => [candidate.steamId, candidate])).values()];
  const players = [];
  for (const [index, candidate] of candidates.entries()) {
    message('progress', `正在检查「${name}」的同名账号 ${index + 1} / ${candidates.length}`);
    try {
      players.push(await api('query', {name, steamId: candidate.steamId, matches: true}));
    } catch (e) {
      players.push({name, error: '近期对局查询失败：' + e.message});
    }
    if (index < candidates.length - 1) await new Promise(resolve => setTimeout(resolve, 600));
  }
  const selected = selectRecentPlayers(players);
  const filtered = players.length - selected.length;
  return {name, players: selected, message: `找到 ${players.length} 个同名账号，显示 ${selected.length} 个` + (filtered ? `；已筛掉 ${filtered} 个无近期对局的账号。` : '。')};
}
function rankBadge(rank) {
    const badge = node('span', '', 'rank-icon');
    const letter = node('img', '', rank.icon === 'S' ? 'rank-s' : 'rank-letter');
    letter.alt = rank.label;
    letter.src = rank.icon === 'S' ? '/rank-assets/s-brass.png' : `/rank-assets/${rank.icon}.svg`;
    if (rank.icon !== 'S') {
      const background = node('img', '', 'rank-background'); background.alt = '';
      background.src = `/rank-assets/${['C11','B11','A11'].includes(rank.icon) ? rank.icon : 'ABC'}_bg.svg`;
      badge.append(background);
    }
    badge.append(letter);
    return badge;
}
function appendPlayerStats(container, data) {
  if (data.error) { container.append(node('p', data.error, 'error')); return; }
  const card = node('div', '', 'player-card');
  const header = node('div', '', 'player-heading');
  const identity = node('div', '', 'identity');
  const displayName = data.pvpNickName || data.name || '玩家';
  const avatarWrap = node('span', displayName.slice(0, 1), 'avatar');
  avatarWrap.setAttribute('aria-hidden', 'true');
  if (typeof data.avatar === 'string' && /^https:\/\//i.test(data.avatar)) {
    const avatar = node('img', '', 'avatar-image'); avatar.alt = ''; avatar.src = data.avatar;
    avatar.referrerPolicy = 'no-referrer'; avatar.loading = 'lazy';
    avatar.addEventListener('error', () => avatar.remove()); avatarWrap.append(avatar);
  }
  const who = node('div', '', 'identity-copy');
  who.append(node('h3', displayName), node('span', '完美平台', 'identity-caption'));
  identity.append(avatarWrap, who); header.append(identity);
  const ranks = node('div', '', 'ranks');
  if (data.officialRank && officialRankTier(data.officialRank.score)) {
    const official = node('div', '', 'official-rank');
    const line = node('div', '', 'official-value');
    const badge = node('div', '', 'official-score tier-' + officialRankTier(data.officialRank.score));
    badge.append(node('strong', data.officialRank.score.toLocaleString('en-US')));
    line.append(badge);
    official.append(line, node('span', '官匹分', 'rank-caption'));
    official.title = `近 10 场中最新有值的记录${data.officialRank.time ? '：' + data.officialRank.time : ''}${data.officialRank.mode ? ' · ' + data.officialRank.mode : ''}；不代表实时分数`;
    official.tabIndex = 0; ranks.append(official); header.classList.add('has-official-rank');
  }
  for (const [label, score, historical] of [['天梯历史', data.historyPeakScore, true], ['天梯当前', data.pvpScore, false]]) {
    const rank = rankForScore(score), block = node('div', '', 'rank-block');
    if (historical) {
      const coverage = data.historySeasonsTotal ? `已查询 ${data.historySeasonsChecked} / ${data.historySeasonsTotal} 个赛季。` : '';
      block.title = coverage + '取各赛季返回记录的最高分；接口记录可能不完整。'; block.tabIndex = 0;
    }
    const line = node('div', '', 'rank-value');
    if (rank.icon) {
      const badge = rankBadge(rank);
      if (historical) badge.className = 'rank-icon history-rank';
      line.append(badge);
    }
    line.append(node('strong', rank.icon ? (score === 0 ? '未定级' : String(score)) : '--'));
    block.append(line, node('span', label, 'rank-caption')); ranks.append(block);
  }
  header.append(ranks); card.append(header);
  if (data.historyRankState === 'partial') card.append(node('p', '部分历史赛季未能查到，历史分数仅基于已返回记录，可稍后重查。', 'data-notice'));
  if (data.historyRankState === 'unavailable') card.append(node('p', '历史分数查询暂时失败，可稍后重查。', 'data-notice'));
  if (data.historyRankState === 'empty') card.append(node('p', '已查询的赛季中没有可用的历史分数记录。', 'data-notice'));
  if (data.stats) {
    const s = data.stats, body = node('div', '', 'performance');
    const featured = node('div', '', 'featured-metrics');
    featured.append(metric('WE 制胜评价', s.we, 1, '', true), metric('Rating Pro', s.rating_pro, 2, '', true));
    const grid = node('div', '', 'metric-grid');
    grid.append(metric('场次', s.games, 0), metric('胜率', s.winrate, 1, '%'),
      metric('爆头率', s.headshot, 1, '%'), metric('ADR', s.adr, 1),
      metric('K/D', s.kd, 2), metric('RWS', s.rws, 2));
    body.append(featured, grid); card.append(body);
    const note = node('div', '', 'sample-note');
    note.append(node('span', `最近 ${s.games} 场${s.games < 10 ? ' · 不足 10 场，按实际场数统计' : '比赛'}`));
    note.append(node('span', '表现指标为逐场均值；胜率按胜场计算'));
    card.append(note);
    if (['we','rating_pro','headshot','adr','kd','rws','winrate'].some(key => !Number.isFinite(s[key]))) {
      card.append(node('p', '部分比赛的数据缺失或无法计算，对应指标显示 --。', 'data-notice'));
    }
  }
  if (data.matchMessage) card.append(node('p', data.matchMessage, 'data-notice'));
  if (!data.stats && !data.matchMessage) card.append(node('p', '暂未取得近期战绩。', 'data-notice'));
  container.append(card);
}
function metric(label, value, decimals, suffix = '', featured = false) {
  const item = node('div', '', featured ? 'featured-metric' : 'metric');
  const valid = typeof value === 'number' && Number.isFinite(value);
  item.append(node('span', label, 'metric-label'));
  const number = node('div', '', featured ? 'metric-ring' : 'metric-number');
  const threshold = label === 'Rating Pro' ? 1 : label === '胜率' ? 0.5 : null;
  if (valid && threshold !== null && value !== threshold) {
    number.className += value < threshold ? ' metric-below' : ' metric-above';
  }
  if (featured) { const ring = node('span', '', 'ring-decoration'); ring.setAttribute('aria-hidden', 'true'); number.append(ring); }
  const scaled = value * (suffix === '%' ? 100 : 1);
  const rounded = Math.round((scaled + Number.EPSILON * Math.max(1, Math.abs(scaled))) * 10 ** decimals) / 10 ** decimals;
  number.append(node('strong', valid ? rounded.toFixed(decimals) : '--'));
  if (valid && suffix) number.append(node('small', suffix));
  item.append(number);
  const explanations = {'ADR':'逐场平均每回合伤害的均值', 'K/D':'逐场击杀数 ÷ 死亡数的均值；有零死亡或缺失数据时暂不计算',
    'RWS':'逐场 RWS（回合胜利贡献）的均值', '爆头率':'逐场爆头率的均值', 'WE 制胜评价':'逐场 WE 评价的均值',
    'Rating Pro':'逐场完美 Rating Pro 的均值', '场次':'本次统计的最近比赛数量，最多 10 场', '胜率':'胜场数 ÷ 本次统计场数；平局按输计算，计入总场数'};
  item.title = explanations[label]; item.tabIndex = 0;
  return item;
}
function render(name, data) {
  const article = $('results').querySelector('[data-index="' + rows.get(name).index + '"]');
  article.replaceChildren();
  article.setAttribute('aria-busy', 'false');
  if (data.error) { article.append(node('h3', name), node('p', data.error, 'error')); return; }
  if (data.players) {
    article.append(node('p', data.message));
    data.players.forEach((player, index) => {
      const section = node('section', '');
      section.append(node('p', `同名账号 ${index + 1}`, 'hint'));
      appendPlayerStats(section, {name, ...player});
      article.append(section);
    });
    return;
  }
  if (data.needsChoice) {
    article.append(node('h3', name));
    article.append(node('p', data.message));
    for (const candidate of data.candidates) {
      const button = node('button', candidate.pvpNickName, 'candidate');
      button.addEventListener('click', async () => {
        article.querySelectorAll('button').forEach(b => b.disabled = true);
        try {
          const result = await api('query', {name: candidate.pvpNickName, steamId: candidate.steamId, matches: true});
          rows.get(name).data = result; render(name, result);
        } catch (e) { article.append(node('p', e.message, 'error')); article.querySelectorAll('button').forEach(b => b.disabled = false); }
      });
      article.append(button);
    }
    return;
  }
  appendPlayerStats(article, data);
}
$('mode').addEventListener('change', () => $('players').placeholder = $('mode').value === 'status' ? '粘贴游戏控制台 status 的完整输出' : '输入玩家昵称，每行一个');
$('query').addEventListener('click', async () => {
  if (busy) return; busy = true; $('query').disabled = true;
  try {
    const {names} = await api('parse', {mode: $('mode').value, text: $('players').value});
    rows.clear(); $('results').replaceChildren();
    for (const [index, name] of names.entries()) {
      rows.set(name, {index, data: {name}});
      const article = node('article', '', 'player'); article.dataset.index = index;
      article.setAttribute('aria-busy', 'true');
      const waiting = node('div', '', 'player-card loading-card');
      waiting.append(node('h3', name), node('p', '等待查询近期比赛…'));
      const skeleton = node('div', '', 'loading-bars'); skeleton.setAttribute('aria-hidden', 'true');
      skeleton.append(node('span', ''), node('span', ''), node('span', '')); waiting.append(skeleton);
      article.append(waiting); $('results').append(article);
    }
    updateVisibility();
    for (const [index, name] of names.entries()) {
      message('progress', `正在查询 ${index + 1} / ${names.length}：${name}（包含历史赛季，首次查询稍慢）`);
      let result;
      try { result = await resolveDuplicates(name, await api('query', {name, matches: true})); }
      catch (e) { result = {name, error: e.message}; }
      rows.get(name).data = result; render(name, result);
      if (index < names.length - 1) await new Promise(resolve => setTimeout(resolve, 600));
    }
    updateVisibility();
    message('progress', '本批查询结束，请查看结果与需要确认的玩家。');
  } catch (e) { message('progress', e.message, true); }
  finally { busy = false; $('query').disabled = false; }
});
function loadScript(src) { return new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = src; script.onload = resolve; script.onerror = () => { script.remove(); reject(new Error('官方验证组件加载失败，请稍后重试')); }; document.head.append(script); }); }
$('send-code').addEventListener('click', async () => {
  if (Date.now() < smsUntil) return;
  const mobile = $('mobile').value.trim();
  if (!/^\d{11}$/.test(mobile)) return message('auth-message', '请输入 11 位手机号', true);
  $('send-code').disabled = true; message('auth-message', '正在加载官方人机验证…');
  try {
    if (!window.jQuery) await loadScript('https://partner.wmpvp.com/jquery-1.8.3.min.js');
    if (!window.WanmeiCaptcha) await loadScript('https://cstatic.games.wanmei.com/captchas/ai/js/wanmeiCaptcha.min.js');
    const response = await api('auth/captcha'); captchaTicket = response.capTicket;
    $('captcha-container').replaceChildren();
    captcha = new WanmeiCaptcha({containerId: 'captcha-container'});
    captcha.init({appId: '20041', capTicket: captchaTicket, capType: 'popup', bindBtn: '#captcha-trigger', zoom: 1, initCallback: () => { $('captcha-trigger').click(); message('auth-message', '请在弹出的官方验证框中完成验证。'); }, callback: async () => {
      message('auth-message', '验证通过，正在发送短信…');
      try {
        const result = await api('auth/sms', {mobile, ticket: captchaTicket, code: captcha.getValidateResult()});
        smsUntil = Date.now() + 60000; message('auth-message', result.message);
      } catch (e) { message('auth-message', e.message, true); }
    }});
  } catch (e) { message('auth-message', e.message, true); }
  finally { $('send-code').disabled = false; }
});
setInterval(() => { const seconds = Math.ceil((smsUntil - Date.now()) / 1000); if (seconds > 0) { $('send-code').disabled = true; $('send-code').textContent = `${seconds}s 后重试`; } else if ($('send-code').textContent.includes('s 后重试')) { $('send-code').disabled = false; $('send-code').textContent = '发送验证码'; } }, 1000);
$('login').addEventListener('click', async () => {
  $('login').disabled = true;
  try { const result = await api('auth/login', {mobile: $('mobile').value.trim(), code: $('sms-code').value.trim()}); authView(result); $('sms-code').value = ''; $('mobile').value = ''; message('auth-message', '登录成功，请验证自己的 SteamID 和战绩权限。'); }
  catch (e) { message('auth-message', e.message, true); }
  finally { $('login').disabled = false; }
});
$('verify').addEventListener('click', async () => { $('verify').disabled = true; try { authView(await api('auth/steamid', {steamId: $('my-steamid').value.trim()})); message('auth-message', '战绩权限验证成功。'); } catch (e) { message('auth-message', e.message, true); } finally { $('verify').disabled = false; } });
$('logout').addEventListener('click', async () => { try { authView(await api('auth/logout')); message('auth-message', '已退出当前登录。'); } catch (e) { message('auth-message', e.message, true); } });
api('auth/status').then(authView).catch(e => message('auth-message', e.message, true));
})();
