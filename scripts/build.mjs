import {mkdir,readFile,writeFile,copyFile,cp} from 'node:fs/promises';
const root=new URL('../',import.meta.url),dist=new URL('dist/',root);
await mkdir(dist,{recursive:true});
let html=await readFile(new URL('web.html',root),'utf8');
html=html.replace('__CSRF__','pages-client-v1')
  .replace('本机运行','在线查询')
  .replace('凭据仅在本机服务内存中保留。','登录凭据通过本站接口转发，仅以加密的浏览器会话保存，最长 8 小时有效。')
  .replace('退出本机登录','退出登录')
  .replace('完整历史查询结果在本机内存缓存 10 分钟。','完整历史记录分批查询，成功返回的记录短暂缓存 10 分钟。')
  .replace('仅在本机使用','每个浏览器独立登录');
await writeFile(new URL('index.html',dist),html);
await copyFile(new URL('web.js',root),new URL('app.js',dist));
await copyFile(new URL('web.css',root),new URL('app.css',dist));
await cp(new URL('rank-assets/',root),new URL('rank-assets/',dist),{recursive:true});
await writeFile(new URL('_routes.json',dist),JSON.stringify({version:1,include:['/api/*'],exclude:[]},null,2));
await writeFile(new URL('_headers',dist),`/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Content-Security-Policy: object-src 'none'; base-uri 'self'; frame-ancestors 'none'
  Permissions-Policy: camera=(), microphone=(), geolocation=()
/
  Cache-Control: no-cache
/app.js
  Cache-Control: no-cache
/app.css
  Cache-Control: no-cache
`);
console.log('Built dist/; only /api/* is routed to Pages Functions.');
