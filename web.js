(() => {
const $ = id => document.getElementById(id);
const rows = new Map();
let generation = 0;
const sessions = new Set();
let captcha = null, captchaTicket = '', smsUntil = 0;
async function api(path, data = {}, signal) {
  const response = await fetch('/api/' + path, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-App-Token': document.querySelector('meta[name="app-token"]').content}, signal, body: JSON.stringify(data)});
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '请求失败');
  return value;
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
function updateFilterStatus() {
  const excluded = excludedNames();
  $('filter-status').textContent = excluded.size ? `已设置 ${excluded.size} 个过滤昵称；下次查询时直接跳过，不影响已有结果。` : '每行一个昵称，完全匹配；点击查询时跳过这些玩家。';
}
$('exclude-players').addEventListener('input', updateFilterStatus);
function authView(data) {
  $('auth-badge').textContent = data.loggedIn ? '已登录' : '未登录';
  $('login-form').hidden = data.loggedIn; $('logged-in').hidden = !data.loggedIn;
  $('my-steamid').value = data.steamId || '';
  $('manual-account').hidden = Boolean(data.steamId);
  $('account').textContent = data.matchesVerified ? '战绩接口已验证，可查询近期表现。' : '官方登录已完成，战绩权限尚未验证。';
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
  function rankBlock(label, score, historical) {
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
    line.append(node('strong', rank.icon ? (score === 0 ? '未定级' : String(score)) : (historical && data.historyRankState === 'pending' ? '加载中…' : '--')));
    block.append(line, node('span', label, 'rank-caption')); return block;
  }
  const history = node('div', '', 'rank-slot');
  history.append(rankBlock('天梯历史', data.historyPeakScore, true));
  ranks.append(history, rankBlock('天梯当前', data.pvpScore, false));
  header.append(ranks); card.append(header);
  const notice = node('p', '', 'data-notice');
  card.append(notice);
  function updateHistory(patch) {
    Object.assign(data, patch);
    history.replaceChildren(rankBlock('天梯历史', data.historyPeakScore, true));
    const notices = {partial:'部分历史赛季未能查到，历史分数仅基于已返回记录，可稍后重查。',
      unavailable:'历史分数查询暂时失败，可稍后重查。', empty:'已查询的赛季中没有可用的历史分数记录。'};
    notice.textContent = notices[data.historyRankState] || '';
    notice.hidden = !notice.textContent;
  }
  updateHistory({});
  const recent = Array.isArray(data.recentMatches) ? data.recentMatches.slice(0, 10) : [];
  const updates = [];
  if (recent.length) card.append(matchTable(recent, displayName, updates));
  if (data.matchMessage) card.append(node('p', data.matchMessage, 'data-notice'));
  if (!recent.length && !data.matchMessage) card.append(node('p', '暂未取得近期战绩。', 'data-notice'));
  container.append(card);
  return {history: updateHistory, detail: (position, patch) => updates[position]?.(patch)};
}
function matchNumber(value, decimals = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '--';
  return (Math.round((value + Number.EPSILON * Math.max(1, value)) * 10 ** decimals) / 10 ** decimals).toFixed(decimals);
}
function matchOutcome(match) {
  if (![1, 2].includes(match.team)) return ['--', 'unknown'];
  if ([-1, 0].includes(match.winTeam)) return ['平', 'draw'];
  if (![1, 2].includes(match.winTeam)) return ['--', 'unknown'];
  return match.team === match.winTeam ? ['胜', 'win'] : ['负', 'loss'];
}
function matchLevel(match) {
  if (match.mode === '完美官匹Pro' || officialRankTier(match.pvpNormalRank)) {
    const tier = officialRankTier(match.pvpNormalRank);
    const badge = node('span', '', 'official-score match-official tier-' + (tier || 'unknown'));
    badge.append(node('strong', tier ? match.pvpNormalRank.toLocaleString('en-US') : '---'));
    badge.title = tier ? '该场记录的官匹分' : '该场未返回官匹分';
    return badge;
  }
  const rank = rankForScore(match.pvpScore);
  if (!rank.icon) return node('span', '--', 'muted');
  const level = node('span', '', 'match-ladder');
  level.append(rankBadge(rank));
  level.title = `${rank.label} · ${match.pvpScore === 0 ? '未定级' : match.pvpScore + ' 分'}`;
  return level;
}
function matchHighlights(match) {
  // Official honor codes; use recorded awards, never infer from kill counts.
  const honors = {'1':['MVP','MVP 之最'], '2':['准','精准之最'], '3':['狙','狙击之最'],
    '4':['突','突破之最'], '5':['残','残局获胜最多'], '6':['闪','闪白之最'], '7':['助','助攻之最']};
  const ids = new Set((typeof match.honor === 'string' ? match.honor.split(',') : []).map(id => id.trim()));
  if (match.mvp === true || match.pvpMvp === true) ids.add('1');
  const list = node('div', '', 'match-highlights');
  for (const id of ['1','2','3','4','5','7','6']) {
    if (!ids.has(id)) continue;
    const [label, title] = honors[id], badge = node('span', label, 'highlight honor-' + id);
    badge.title = title; badge.setAttribute('aria-label', title); badge.tabIndex = 0; list.append(badge);
    if (Array.isArray(match.derivedHonors) && match.derivedHonors.includes(id)) badge.title += '；原高光标记缺失，按本场十人数据补全，并列取记录顺序第一位';
  }
  if (match.detailState === 'pending' || match.detailState === 'unavailable') {
    list.append(node('span', match.detailState === 'pending' ? '加载中…' : '详情未取得', 'muted'));
  } else if (!list.children.length) list.append(node('span', '--', 'muted'));
  return list;
}
function matchTable(matches, displayName, updates = []) {
  const wrap = node('div', '', 'match-table-wrap');
  wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', `${displayName}的近十场战绩，可横向滚动`);
  const table = node('table', '', 'match-table');
  table.append(node('caption', `最近 ${matches.length} 场比赛${matches.length < 10 ? ' · 不足 10 场' : ''}`));
  const head = node('thead', ''), headings = node('tr', '');
  for (const title of ['日期','类型','胜/败','比分','K/D/A','ADR','RWS','RATING PRO','WE','级别','高光']) {
    const th = node('th', title); th.setAttribute('scope', 'col'); headings.append(th);
  }
  head.append(headings); table.append(head);
  const body = node('tbody', '');
  for (const match of matches) {
    const tr = node('tr', '');
    const displayedTime = match.endTime || match.startTime;
    const time = typeof displayedTime === 'string' ? displayedTime.match(/^\d{4}-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/) : null;
    const date = node('td', time ? `${time[1]}/${time[2]} ${time[3]}` : '--', 'match-date'); date.title = `${match.endTime ? '结束时间' : '开始时间（结束时间缺失）'}：${displayedTime || '--'}`;
    const type = node('td', '', 'match-type'), typeInner = node('span', '', 'match-mode');
    if (typeof match.mapLogo === 'string' && /^https:\/\//i.test(match.mapLogo)) {
      const logo = node('img', '', 'match-map'); logo.src = match.mapLogo; logo.alt = ''; logo.title = match.mapName || '';
      logo.loading = 'lazy'; logo.referrerPolicy = 'no-referrer'; logo.addEventListener('error', () => logo.remove()); typeInner.append(logo);
    }
    typeInner.append(node('span', match.mode || '--')); type.append(typeInner);
    const [outcome, state] = matchOutcome(match), outcomeCell = node('td', ''); outcomeCell.append(node('span', outcome, 'match-outcome ' + state));
    // Client reference rows show team 2 : team 1; outcome still uses team IDs.
    const score = node('td', `${matchNumber(match.score2)} : ${matchNumber(match.score1)}`); score.title = '队伍 2 : 队伍 1（客户端显示顺序）';
    const kda = node('td', ''), adr = node('td', ''), rws = node('td', ''), rating = node('td', '');
    const we = node('td', '', 'match-we'), level = node('td', '', 'match-level'), highlights = node('td', '');
    level.append(matchLevel(match));
    function update(patch) {
      const number = (v, digits) => v == null && patch.detailState === 'pending' ? '…' : matchNumber(v, digits);
      kda.textContent = [patch.kill, patch.death, patch.assist].map(v => number(v, 0)).join('/');
      adr.textContent = number(patch.adpr, 0); rws.textContent = number(patch.rws, 2);
      we.textContent = number(patch.we, 1); rating.textContent = number(patch.pwRating, 2);
      rating.className = typeof patch.pwRating === 'number' && Number.isFinite(patch.pwRating) && patch.pwRating >= 0 && patch.pwRating !== 1
        ? (patch.pwRating < 1 ? 'metric-below' : 'metric-above') : '';
      highlights.replaceChildren(matchHighlights(patch));
    }
    update(match); updates.push(update);
    tr.append(date, type, outcomeCell, score, kda, adr, rws, rating, we, level, highlights); body.append(tr);
  }
  table.append(body); wrap.append(table); return wrap;
}
function render(name, data, version) {
  const {article, views} = rows.get(name);
  article.replaceChildren(); views.clear();
  article.setAttribute('aria-busy', 'false');
  if (data.error) { article.append(node('h3', name), node('p', data.error, 'error')); return; }
  if (data.needsChoice) {
    article.append(node('h3', name), node('p', data.message));
    for (const candidate of data.candidates) {
      const button = node('button', candidate.pvpNickName, 'candidate');
      button.addEventListener('click', async () => {
        if (version !== generation) return;
        const excluded = excludedNames();
        if (excluded.has(name) || excluded.has(candidate.pvpNickName)) {
          message('progress', `已跳过「${candidate.pvpNickName}」：该玩家在过滤名单中。`); return;
        }
        article.querySelectorAll('button').forEach(b => b.disabled = true);
        await watch([name], [candidate.pvpNickName], version, candidate.steamId);
      });
      article.append(button);
    }
    return;
  }
  if (data.players) article.append(node('p', data.message));
  (data.players || [data]).forEach((player, index) => {
    const section = node('section', '');
    if (data.players) section.append(node('p', `同名账号 ${index + 1}`, 'hint'));
    article.append(section);
    player.officialRank = latestOfficialRank(player.recentMatches);
    const card = appendPlayerStats(section, player);
    if (card) views.set(player.steamId, {data:player, card});
  });
}

function stopPending(names, label) {
  for (const name of names) {
    const row = rows.get(name);
    if (!row) continue;
    if (!row.received) {
      row.article.replaceChildren(node('h3', name), node('p', label, 'data-notice'));
      row.article.setAttribute('aria-busy','false');
    }
    for (const {data, card} of row.views.values()) {
      if (data.historyRankState === 'pending') card.history({historyRankState:'unavailable'});
      (data.recentMatches || []).forEach((m,i) => {
        if (m.detailState === 'pending') { m.detailState = 'unavailable'; card.detail(i,m); }
      });
    }
  }
}

function cancel() {
  generation++;
  for (const session of sessions) {
    session.controller.abort();
    if (session.batch) api('batch/cancel', {batch:session.batch}).catch(() => {});
  }
  sessions.clear();
  stopPending(rows.keys(), '查询已取消');
  $('cancel').hidden = true; $('exclude-players').disabled = false;
}

async function watch(keys, names, version, steamId = '', started = performance.now()) {
  const session = {controller:new AbortController()};
  sessions.add(session); $('cancel').hidden = false;
  const current = () => version === generation;
  // Sample after the DOM update. The next frame is the browser's opportunity to paint it.
  function timing(event) {
    requestAnimationFrame(() => {
      if (current()) api('batch/timing', {event, ms:Math.round(performance.now()-started), players:names.length}).catch(() => {});
    });
  }
  let cursor = 0, resolved = 0, visible = false;
  try {
    const response = await api('batch/start', {names, steamId});
    session.batch = response.batch;
    if (!current()) { await api('batch/cancel', {batch:session.batch}); return; }
    while (current()) {
      const page = await api('batch/poll', {batch:session.batch, cursor}, session.controller.signal);
      if (!current()) return;
      for (const event of page.events) {
        const name = keys[event.index], row = rows.get(name);
        if (event.kind === 'base') {
          render(name, event.data, version);
          row.received = true; resolved++;
          if (!visible && row.views.size) { visible = true; timing('first_player'); }
          if (resolved === names.length) timing('all_basic');
        } else {
          const view = row.views.get(event.steamId);
          if (event.kind === 'detail' && view) {
            view.data.recentMatches[event.position] = event.data;
            view.card.detail(event.position, event.data);
          }
          if (event.kind === 'history' && view) view.card.history(event.data);
        }
      }
      cursor = page.cursor;
      if (page.done) { timing('complete'); break; }
      message('progress', `已返回 ${resolved} / ${names.length} 个昵称的基础结果，详情和历史分正在补充。`);
    }
    if (current()) message('progress', '查询完成。');
  } catch (e) {
    if (current()) {
      stopPending(keys, '查询中断'); message('progress', e.message, true);
      for (const name of keys) rows.get(name)?.article.querySelectorAll('button').forEach(b => b.disabled = false);
    }
  } finally {
    if (session.batch && current()) api('batch/cancel', {batch:session.batch}).catch(() => {});
    sessions.delete(session);
    if (current()) { $('cancel').hidden = !sessions.size; $('exclude-players').disabled = sessions.size > 0; }
  }
}

$('cancel').addEventListener('click', () => { cancel(); message('progress', '查询已取消。'); });
$('mode').addEventListener('change', () => $('players').placeholder = $('mode').value === 'status' ? '粘贴游戏控制台 status 的完整输出' : '输入玩家昵称，每行一个');
$('query').addEventListener('click', async () => {
  cancel();
  const version = generation, started = performance.now(), excluded = excludedNames();
  $('exclude-players').disabled = true; $('cancel').hidden = false;
  message('progress','正在查询…');
  try {
    const {names: parsed} = await api('parse', {mode:$('mode').value, text:$('players').value});
    if (version !== generation) return;
    const names = parsed.filter(n => !excluded.has(n)), skipped = parsed.length - names.length;
    rows.clear(); $('results').replaceChildren();
    $('count').textContent = `查询 ${names.length} 个昵称 · 已跳过 ${skipped} 个`;
    for (const name of names) {
      const article = node('article', '', 'player');
      article.setAttribute('aria-busy', 'true');
      const waiting = node('div', '', 'player-card loading-card');
      waiting.append(node('h3', name), node('p', '等待查询近期比赛…'));
      const skeleton = node('div', '', 'loading-bars'); skeleton.setAttribute('aria-hidden', 'true');
      skeleton.append(node('span', ''),node('span', ''),node('span', '')); waiting.append(skeleton);
      article.append(waiting); $('results').append(article);
      rows.set(name, {article, views:new Map(), received:false});
    }
    if (names.length) await watch(names, names, version, '', started);
    else message('progress', `输入的 ${skipped} 个昵称均在过滤名单中，本次未查询任何玩家。`);
  } catch (e) { if (version === generation) message('progress', e.message, true); }
  finally {
    if (version === generation && !sessions.size) { $('exclude-players').disabled = false; $('cancel').hidden = true; }
  }
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
$('logout').addEventListener('click', async () => { try { authView(await api('auth/logout')); message('auth-message', '已清除本机内存中的登录凭据。'); } catch (e) { message('auth-message', e.message, true); } });
api('auth/status').then(authView).catch(e => message('auth-message', e.message, true));
})();
