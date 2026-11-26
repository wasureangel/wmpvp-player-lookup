export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function field(data, key, limit = 200) {
  const value = data[key] ?? '';
  if (typeof value !== 'string' || value.length > limit) throw new AppError('输入内容格式不正确');
  return value.trim();
}

export function steamId(value) {
  if (!/^\d{17}$/.test(value)) throw new AppError('玩家标识应为 17 位数字');
  return value;
}

export const scoreValue = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function historyPeak(scores) {
  if (!Array.isArray(scores)) return null;
  const valid = scores.map(scoreValue).filter(value => value !== null);
  return valid.length ? Math.max(...valid) : null;
}

export function parseNames(data) {
  const text = field(data, 'text', 60000);
  let names;
  if (data.mode === 'status') {
    const pattern = /^\[Client\]\s+\d+\s+(?:\d{1,2}:\d{2}|\d+)\s+\d+\s+\d+\s+(\w+)(?:\s+\d+)?\s+'(.*)'\s*$/;
    names = text.split(/\r?\n/).flatMap(line => {
      const match = line.trim().match(pattern);
      const name = match?.[2].trim().replace(/^['"]+|['"]+$/g, '');
      return match?.[1] === 'active' && name && name !== 'BOT' ? [name] : [];
    });
  } else names = text.split(/\r?\n/).map(name => name.trim()).filter(Boolean);
  names = [...new Set(names)];
  if (!names.length || names.length > 20 || names.some(name => name.length > 100)) throw new AppError('请输入 1–20 个昵称，每行一个；status 模式请粘贴完整玩家行');
  return {names};
}

export function summarizeRecent(matches) {
  const recent = matches.slice(0, 10);
  if (!recent.length) return null;
  const mean = values => values.every(value => scoreValue(value) !== null) ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const outcomes = recent.map(match => [1, 2].includes(match.team) && [-1, 0, 1, 2].includes(match.winTeam) ? Number(match.team === match.winTeam) : null);
  const kd = recent.map(match => scoreValue(match.kill) !== null && scoreValue(match.death) !== null && match.death > 0 ? match.kill / match.death : null);
  const stats = {games:recent.length, winrate:mean(outcomes), kd:mean(kd)};
  for (const [target, source] of [['we','we'],['rating_pro','pwRating'],['headshot','headShotRatio'],['adr','adpr'],['rws','rws']]) {
    stats[target] = mean(recent.map(match => target === 'headshot' && match[source] > 1 ? null : match[source]));
  }
  return stats;
}

export function latestOfficialRank(matches) {
  const match = matches.slice(0, 10).find(row => Number.isInteger(row.pvpNormalRank) && row.pvpNormalRank >= 0);
  return match ? {score:match.pvpNormalRank, time:match.startTime || '', mode:match.mode || ''} : null;
}

export async function mapLimit(items, limit, fn) {
  const result = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({length:Math.min(limit, items.length)}, async () => {
    while (cursor < items.length) { const index = cursor++; result[index] = await fn(items[index], index); }
  }));
  return result;
}
