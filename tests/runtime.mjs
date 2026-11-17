import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

// Use the same pinned runtime that Wrangler uses for Pages builds.
const require=createRequire(import.meta.resolve('wrangler'));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const root=new URL('../',import.meta.url);
const modules=[{type:'ESModule',path:fileURLToPath(new URL('runtime-entry.js',root)),contents:
  "import {handleRequest} from './server/handler.js'; export default {fetch:handleRequest};"}];
for(const file of ['handler','platform','session','core']) {
  const url=new URL(`server/${file}.js`,root);
  modules.push({type:'ESModule',path:fileURLToPath(url),contents:await readFile(url,'utf8')});
}
const password='test-only-runtime-password';
let calls=0,redirect=false;
const runtime=new Miniflare(convertV4MiniflareOptions({modules,modulesRoot:fileURLToPath(root),compatibilityDate:'2026-11-17',
  bindings:{SESSION_SECRET:'11'.repeat(32),SITE_PASSWORD:password},
  outboundService:request=>{
    calls++;
    assert.equal(request.url,'https://passport.pwesports.cn/initcaptcha');
    assert.equal(request.method,'GET');
    assert.equal(request.headers.get('User-Agent'),'WMPVP-Player-Lookup/1.0');
    assert.equal(request.headers.get('platform'),'APP');
    if(redirect)return new Response(null,{status:302,headers:{Location:'https://unexpected.example/'}});
    return Response.json({code:0,capTicket:'test-runtime-ticket'});
  },
}));
async function post(path,data={},cookie='') {
  return runtime.dispatchFetch('https://runtime.example/api/'+path,{method:'POST',
    headers:{Origin:'https://runtime.example','Content-Type':'application/json','X-App-Token':'pages-client-v1',Cookie:cookie},body:JSON.stringify(data)});
}
try {
  const unlocked=await post('access/unlock',{password});
  assert.equal(unlocked.status,200,await unlocked.text());
  const cookie=unlocked.headers.get('set-cookie').split(';')[0];
  const captcha=await post('auth/captcha',{},cookie);
  const payload=await captcha.json();
  assert.equal(captcha.status,200,JSON.stringify(payload));
  assert.equal(payload.capTicket,'test-runtime-ticket');
  assert.equal(calls,1);
  redirect=true;
  const rejected=await post('auth/captcha',{},cookie);
  assert.equal(rejected.status,502);
  assert.match((await rejected.json()).error,/HTTP 302/);
  assert.equal(calls,2,'Redirect must not forward credentials to another host');
  console.log('PASS: real Workers runtime sends captcha requests and rejects upstream redirects');
} finally {await runtime.dispose();}
