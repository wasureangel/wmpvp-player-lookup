import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {AppError} from './core.js';

export const SECOND = 1000, LONG = 180 * 86400 * SECOND;
export const allowedHosts = new Set(['api.wmpvp.com','appengine.wmpvp.com','passport.pwesports.cn','partner.wmpvp.com']);

export class PlatformError extends AppError {
  constructor(kind, message, status = 502) { super(message,status); this.kind = kind; }
}

function retryAfter(header) {
  if (!header) return null;
  const ms = /^\d+$/.test(header) ? Number(header)*1000 : Date.parse(header)-Date.now();
  return Number.isFinite(ms) ? Math.max(ms,0) : null;
}

// Waiting callers detach independently. The last one stops the shared upstream call.
function waitFor(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve,reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    promise.then(resolve,reject).finally(() => signal.removeEventListener('abort',abort));
  });
}

export class Engine {
  constructor({limit=Number(process.env.WMPVP_CONCURRENCY || 6),
               path=process.env.WMPVP_CACHE_PATH || '.lookup-cache/node.sqlite3',
               fetcher=fetch, log=event=>console.info(JSON.stringify(event))}={}) {
    if (!Number.isInteger(limit) || limit<1 || limit>64) throw Error('WMPVP_CONCURRENCY 应为 1–64');
    this.limit=limit; this.fetcher=fetcher; this.log=log;
    this.active=0; this.queue=[[],[],[]]; this.flights=new Map(); this.cooldown=new Map(); this.metrics=new Map();
    if (path !== ':memory:') mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS results(api TEXT, key TEXT, expires INTEGER, value TEXT, PRIMARY KEY(api,key))');
    this.read=this.db.prepare('SELECT value FROM results WHERE api=? AND key=? AND expires>?');
    this.write=this.db.prepare('INSERT OR REPLACE INTO results VALUES(?,?,?,?)');
    this.purge=this.db.prepare('DELETE FROM results WHERE expires<=?');
    this.nextPurge=0;
  }

  count(api) {
    if (!this.metrics.has(api)) this.metrics.set(api,{requests:0,hits:0,reads:0,retries:0});
    return this.metrics.get(api);
  }

  async cached(api,key,ttl,signal,load) {
    signal?.throwIfAborted();
    const now=Date.now();
    if (now>=this.nextPurge) { this.purge.run(now); this.nextPurge=now+3600000; }
    const row=this.read.get(api,key,now), stats=this.count(api);
    stats.reads++;
    if (row) stats.hits++;
    this.log({api,hit:Boolean(row),hitRate:stats.hits/stats.reads});
    if (row) return JSON.parse(row.value);
    const id=api+'|'+key;
    let flight=this.flights.get(id);
    if (!flight) {
      const ctrl=new AbortController();
      flight={ctrl,waiters:0};
      this.flights.set(id,flight);
      flight.promise=Promise.resolve().then(()=>load(ctrl.signal)).then(value=>{
        ctrl.signal.throwIfAborted();
        this.write.run(api,key,Date.now()+ttl,JSON.stringify(value));
        return value;
      });
    }
    flight.waiters++;
    try { return await waitFor(flight.promise,signal); }
    finally {
      if (--flight.waiters===0) {this.flights.delete(id); flight.ctrl.abort();}
    }
  }

  drain() {
    while (this.active<this.limit) {
      const item=this.queue.find(q=>q.length)?.shift();
      if (!item) return;
      item.enter();
    }
  }

  async slot(priority,signal,work) {
    signal?.throwIfAborted();
    await new Promise((resolve,reject)=>{
      const queue=this.queue[priority];
      const abort=()=>{
        const index=queue.indexOf(item);
        if (index>=0) queue.splice(index,1);
        reject(signal.reason);
      };
      const item={enter:()=>{signal?.removeEventListener('abort',abort); this.active++; resolve();}};
      signal?.addEventListener('abort',abort,{once:true});
      queue.push(item); this.drain();
    });
    try {signal?.throwIfAborted(); return await work();}
    finally {this.active--; this.drain();}
  }

  async request(api,url,payload,headers={}, {priority=0,signal,attempts=2,decode=v=>v}={}) {
    const target=new URL(url);
    if (target.protocol!=='https:' || !allowedHosts.has(target.host)) throw new AppError('不支持的查询地址');
    const body=payload===undefined ? undefined : JSON.stringify(payload).replace(/"(mySteamId|toSteamId)":"(\d{17})"/g,'"$1":$2');
    const stats=this.count(api);
    for (let attempt=1; ; attempt++) {
      let backoff=250*2**(attempt-1);
      try {
        for (;;) {
          const wait=(this.cooldown.get(target.host)||0)-Date.now();
          if (wait>12000) throw new PlatformError('cooldown','平台限流，请稍后重试',429);
          if (wait>0) await delay(wait,undefined,{signal});
          const result=await this.slot(priority,signal,async()=>{
            if (this.cooldown.get(target.host)>Date.now()) return {wait:true};
            const started=performance.now(), count=++stats.requests;
            const timer=AbortSignal.timeout(8000);
            let outcome='ok';
            try {
              const res=await this.fetcher(url,{method:body===undefined?'GET':'POST',body,redirect:'manual',
                headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},
                signal:signal?AbortSignal.any([timer,signal]):timer});
              if (!res.ok) {
                const limited=res.status===429, server=res.status>=500;
                const requested=retryAfter(res.headers.get('Retry-After'));
                if (limited || (server && requested!==null)) {
                  backoff=requested??1000;
                  this.cooldown.set(target.host,Math.max(this.cooldown.get(target.host)||0,Date.now()+backoff));
                }
                await res.body?.cancel();
                const auth=[401,403].includes(res.status);
                throw new PlatformError(limited?'rate':server?'server':auth?'auth':'http',
                  limited?'平台限流，请稍后重试':auth?'登录失效或权限不足':'平台返回 HTTP '+res.status, limited?429:502);
              }
              const text=await res.text();
              let parsed;
              try {parsed=JSON.parse(text.replace(/("(?:steamId|steamId64|playerId|mySteamId|toSteamId)"\s*:\s*)(\d{17})(?=\s*[,}])/g,'$1"$2"'));}
              catch {throw new PlatformError('format','平台返回的数据异常');}
              try {return {value:decode(parsed)};}
              catch (e) {if (e instanceof AppError) throw e; throw new PlatformError('format','平台返回的数据结构异常');}
            } catch (err) {
              if (signal?.aborted) {outcome='cancelled'; throw signal.reason;}
              const failure=err instanceof AppError ? err : new PlatformError(timer.aborted?'timeout':'network',timer.aborted?'平台请求超时':'连接平台失败');
              outcome=failure.kind||'business'; throw failure;
            } finally {this.log({api,count,attempt,ms:Math.round(performance.now()-started),outcome});}
          });
          if (!result.wait) return result.value;
        }
      } catch(err) {
        if (signal?.aborted || attempt>=attempts || backoff>12000 || !['rate','server','network','timeout'].includes(err.kind)) throw err;
        this.log({api,retries:++stats.retries,reason:err.kind});
        await delay(backoff,undefined,{signal});
      }
    }
  }
}
