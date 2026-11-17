import {AppError,field,steamId,parseNames} from './core.js';
import {configuration,readSession,sessionCookie,authStatus,passwordMatches,SESSION_SECONDS} from './session.js';
import {queryPlayer,historyBatch,matchList,passport,login} from './platform.js';

// This is a supplementary per-isolate limit, not a globally consistent quota.
// The access password and official CAPTCHA are the primary access controls.
const attempts = new Map();
function limit(request, category, maximum, seconds) {
  const address = request.headers.get('CF-Connecting-IP') || 'local';
  const key = address + ':' + category, now = Date.now();
  let entry = attempts.get(key);
  if (!entry || entry.until <= now) entry = {count:0,until:now+seconds*1000};
  if (++entry.count > maximum) throw new AppError('操作过于频繁，请稍后再试。',429);
  if (attempts.size >= 2048 && !attempts.has(key)) attempts.delete(attempts.keys().next().value);
  attempts.set(key,entry);
}

async function readBody(request) {
  const reader=request.body?.getReader();
  if (!reader) throw new AppError('请求内容不能为空');
  const parts=[];let size=0;
  while(true) {
    const {done,value}=await reader.read();if(done)break;
    size+=value.byteLength;
    if(size>100000){await reader.cancel();throw new AppError('输入内容过长',413);}
    parts.push(value);
  }
  const bytes=new Uint8Array(size);let offset=0;
  for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
  try {
    const data=JSON.parse(new TextDecoder().decode(bytes));
    if(!data||Array.isArray(data)||typeof data!=='object')throw new Error();
    return data;
  } catch {throw new AppError('输入格式不正确');}
}

function response(data,status=200) {
  return new Response(JSON.stringify(data),{status,headers:{
    'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'Vary':'Cookie',
  }});
}

export async function handleRequest(request,env,{fetcher=fetch}={}) {
  try {
    const url=new URL(request.url),path=url.pathname;
    if(request.method!=='POST')return response({error:'仅支持 POST 请求'},405);
    if(url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new AppError('请使用 HTTPS 访问',403);
    // The header is a public request marker. Origin + JSON + SameSite cookies
    // enforce the actual cross-site request boundary; no wildcard CORS is sent.
    if(request.headers.get('Origin')!==url.origin||request.headers.get('X-App-Token')!=='pages-client-v1'||
       request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/json')throw new AppError('请从本站页面发起请求',403);
    configuration(env);
    const data=await readBody(request);
    let session=await readSession(request,env),changed=false,result;
    if(path==='/api/auth/status')return response(authStatus(session));
    if(path==='/api/access/unlock') {
      limit(request,'unlock',10,300);
      if(!await passwordMatches(field(data,'password',200),env.SITE_PASSWORD))throw new AppError('访问口令不正确',401);
      session={access:true,expires:Date.now()+SESSION_SECONDS*1000};changed=true;
      result=authStatus(session);
    } else {
      if(!session?.access)return response({error:'请先输入站点访问口令',accessRequired:true},401);
      if(path==='/api/parse')result=parseNames(data);
      else if(path==='/api/query') {limit(request,'query',60,60);result=await queryPlayer(data,session,fetcher);}
      else if(path==='/api/history') {limit(request,'history',120,60);result=await historyBatch(data,fetcher);}
      else if(path==='/api/auth/captcha') {
        limit(request,'captcha',10,60);
        const captcha=await passport('/initcaptcha',undefined,fetcher);
        if(typeof captcha.capTicket!=='string'||!captcha.capTicket)throw new AppError('官方未返回验证票据',502);
        result={capTicket:captcha.capTicket};
      } else if(path==='/api/auth/sms') {
        const mobile=field(data,'mobile',11),ticket=field(data,'ticket',4096),code=field(data,'code',4096);
        if(!/^\d{11}$/.test(mobile)||!ticket||!code)throw new AppError('请核对手机号并完成人机验证');
        if(Date.now()-(session.lastSms||0)<60000)throw new AppError('请等待 60 秒后再发送短信',429);
        limit(request,'sms',1,60);
        await passport('/securitycode?'+new URLSearchParams({mobilePhone:mobile,secCode:code,capTicket:ticket,reason:'1'}),undefined,fetcher);
        session={...session,lastSms:Date.now()};changed=true;
        result={message:'验证码已发送，请查看手机短信'};
      } else if(path==='/api/auth/login') {
        limit(request,'login',10,300);
        session={access:true,expires:Date.now()+SESSION_SECONDS*1000,...await login(data,fetcher)};changed=true;
        result=authStatus(session);
      } else if(path==='/api/auth/steamid') {
        const sid=steamId(field(data,'steamId',17));
        await matchList(sid,{...session,steamId:sid},fetcher);
        session={...session,steamId:sid,matchesVerified:true};changed=true;
        result=authStatus(session);
      } else if(path==='/api/auth/logout') {
        session=null;changed=true;result=authStatus(null);
      } else throw new AppError('接口不存在',404);
    }
    const output=response(result);
    if(changed)output.headers.set('Set-Cookie',await sessionCookie(request,session,env));
    return output;
  } catch(error) {
    return response({error:error instanceof AppError?error.message:'平台暂时无响应或返回异常，请稍后重试'},error instanceof AppError?error.status:502);
  }
}

export const onRequest=context=>handleRequest(context.request,context.env);
