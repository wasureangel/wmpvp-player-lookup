import {AppError} from './core.js';

const encoder = new TextEncoder();
export const SESSION_SECONDS = 8 * 60 * 60;
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));

export function configuration(env) {
  if (!/^[a-f0-9]{64}$/i.test(env.SESSION_SECRET || '') || typeof env.SITE_PASSWORD !== 'string' || env.SITE_PASSWORD.length < 16) {
    throw new AppError('站点尚未完成部署配置，请联系维护者。', 503);
  }
}

async function key(env) {
  configuration(env);
  // Rotating either secret also invalidates all previously issued sessions.
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(env.SESSION_SECRET + '\n' + env.SITE_PASSWORD));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt','decrypt']);
}

export async function passwordMatches(actual, expected) {
  const [a, b] = await Promise.all([actual, expected].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  return aa.reduce((difference, value, index) => difference | (value ^ bb[index]), 0) === 0;
}

function cookieName(request) {
  return new URL(request.url).protocol === 'https:' ? '__Host-wmpvp_session' : 'wmpvp_dev_session';
}

export async function sealSession(session, env, origin) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(origin)}, await key(env), encoder.encode(JSON.stringify(session)));
  const value = encode(iv) + '.' + encode(new Uint8Array(encrypted));
  if (value.length > 3800) throw new AppError('官方返回的登录信息过长，暂时无法建立会话。', 502);
  return value;
}

export async function readSession(request, env, now = Date.now()) {
  configuration(env);
  const value = (request.headers.get('Cookie') || '').split(';').map(part => part.trim()).find(part => part.startsWith(cookieName(request) + '='))?.split('=').slice(1).join('=');
  if (!value || value.length > 3800) return null;
  try {
    const [iv, encrypted, extra] = value.split('.');
    if (extra || !iv || !encrypted) return null;
    const raw = await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(iv),additionalData:encoder.encode(new URL(request.url).origin)}, await key(env), decode(encrypted));
    const session = JSON.parse(new TextDecoder().decode(raw));
    if (session.access !== true || !Number.isFinite(session.expires) || session.expires <= now || session.expires > now + SESSION_SECONDS * 1000 + 60000) return null;
    return session;
  } catch { return null; }
}

export async function sessionCookie(request, session, env) {
  const value = session ? await sealSession(session, env, new URL(request.url).origin) : '';
  const maxAge = session ? Math.max(0, Math.floor((session.expires - Date.now()) / 1000)) : 0;
  return `${cookieName(request)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}

export function authStatus(session) {
  return {accessRequired:!session?.access, loggedIn:!!session?.token, steamId:session?.steamId || '', matchesVerified:!!session?.matchesVerified};
}
