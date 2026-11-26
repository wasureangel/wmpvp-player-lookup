import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {page} from './scripts/build.mjs';
import {handleRequest} from './server/handler.js';
import {configuration} from './server/session.js';

export function createServer({origin,env,localDesktop=false,engine}) {
  configuration(env);
  const site=new URL(origin);
  if (!localDesktop && site.protocol!=='https:') throw Error('服务器访问地址需要 HTTPS');
  const files={'/':['web.html','text/html'],'/app.js':['web.js','text/javascript'],'/app.css':['web.css','text/css']};
  return http.createServer(async(req,res)=>{
    try {
      if (localDesktop && req.headers.host!==site.host) {res.writeHead(403).end();return;}
      if (req.method==='POST' && req.url.startsWith('/api/')) {
        const request=new Request(site.origin+req.url,{method:'POST',headers:req.headers,body:req,duplex:'half'});
        const out=await handleRequest(request,env,{engine,localDesktop});
        res.writeHead(out.status,Object.fromEntries(out.headers));res.end(Buffer.from(await out.arrayBuffer()));return;
      }
      if (req.method!=='GET') {res.writeHead(405).end();return;}
      if (req.url==='/health') {res.writeHead(200,{'Content-Type':'application/json'}).end('{"app":"wmpvp-node"}');return;}
      const asset=/^\/rank-assets\/[\w-]+\.(svg|png)$/.exec(req.url);
      const file=asset?[req.url.slice(1),asset[1]==='svg'?'image/svg+xml':'image/png']:Object.hasOwn(files,req.url)?files[req.url]:null;
      if (!file) {res.writeHead(404).end();return;}
      const bytes=await readFile(new URL(file[0],import.meta.url));
      res.writeHead(200,{'Content-Type':file[1],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer'});
      res.end(req.url==='/'?page(bytes.toString(),!localDesktop):bytes);
    } catch {if (!res.headersSent) res.writeHead(500);res.end();}
  });
}

if (import.meta.url===pathToFileURL(process.argv[1]).href) {
  const port=Number(process.env.WMPVP_PORT||8765);
  const origin=process.env.WMPVP_PUBLIC_ORIGIN||'http://127.0.0.1:'+port;
  const localDesktop=!process.env.WMPVP_PUBLIC_ORIGIN;
  const secrets=localDesktop?{SITE_PASSWORD:randomBytes(24).toString('hex'),SESSION_SECRET:randomBytes(32).toString('hex')}:process.env;
  const server=createServer({origin,env:secrets,localDesktop});
  server.listen(port,'127.0.0.1',()=>{
    console.info('Listening on 127.0.0.1:'+port);
    if (localDesktop && process.argv.includes('--open') && process.platform==='win32')
      spawn('explorer.exe',[origin],{detached:true,stdio:'ignore'}).unref();
  });
}
