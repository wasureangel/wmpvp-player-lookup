import {createHmac,randomUUID} from 'node:crypto';
import {setMaxListeners} from 'node:events';
import {AppError,field,steamId} from './core.js';
import {basic,detail,history} from './platform.js';

const batches=new Map();
export function sessionOwner(request, env, session) {
  if (session.lookupSessionId) return session.lookupSessionId;
  // Sessions issued by the previous server have no query owner yet.
  const name=new URL(request.url).protocol==='https:'?'__Host-wmpvp_session=':'wmpvp_dev_session=';
  const cookie=(request.headers.get('cookie')||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(name));
  if (!cookie) throw new AppError('请重新解锁站点',401);
  return createHmac('sha256',env.SESSION_SECRET).update(cookie).digest('hex');
}

class Batch {
  constructor(owner) {
    this.owner=owner; this.id=randomUUID(); this.events=[]; this.waiters=new Set();
    this.controller=new AbortController(); this.done=false;
    setMaxListeners(0,this.controller.signal);
    this.touch();
  }
  touch() {clearTimeout(this.timer);this.timer=setTimeout(()=>this.cancel(),90000);this.timer.unref();}
  wake() {for (const finish of this.waiters) finish();}
  emit(kind,index,data,fields={}) {
    if (!this.controller.signal.aborted) {this.events.push({kind,index,data,...fields});this.wake();}
  }
  cancel() {
    clearTimeout(this.timer);batches.delete(this.id);this.controller.abort();this.done=true;this.wake();
  }
  async poll(cursor) {
    if (!Number.isInteger(cursor)||cursor<0||cursor>this.events.length) throw new AppError('查询进度无效');
    this.touch();
    if (!this.done && cursor===this.events.length) {
      if (this.waiters.size>=4) throw new AppError('等待中的查询过多',429);
      await new Promise(resolve=>{
        const finish=()=>{clearTimeout(timer);this.waiters.delete(finish);resolve();};
        const timer=setTimeout(finish,8000);this.waiters.add(finish);
      });
    }
    return {events:this.events.slice(cursor),cursor:this.events.length,done:this.done};
  }
  async run(names,sid,auth,engine) {
    const signal=this.controller.signal, extra=[];
    let next=0;
    const enrich=async(index,row)=>{
      const id=row.steamId;
      await Promise.all([
        history(id,engine,signal).then(v=>this.emit('history',index,v,{steamId:id})),
        ...(row.recentMatches||[]).map((m,position)=>detail(m,id,engine,signal).then(v=>this.emit('detail',index,v,{steamId:id,position})))
      ]);
    };
    const worker=async()=>{
      while (!signal.aborted && next<names.length) {
        const index=next++;
        try {
          const row=await basic(names[index],sid,auth,engine,signal);
          this.emit('base',index,row);
          for (const player of row.players||[row]) {
            if (player.steamId && !signal.aborted) extra.push(enrich(index,player).catch(()=>{
              this.emit('history',index,{historyRankState:'unavailable'},{steamId:player.steamId});
            }));
          }
        } catch(e) {this.emit('base',index,{error:e instanceof AppError?e.message:'玩家查询失败'});}
      }
    };
    try {
      await Promise.all(Array.from({length:Math.min(engine.limit,names.length)},worker));
      await Promise.all(extra);
    } finally {this.done=true;this.wake();}
  }
}

export function cancelOwner(owner) {for (const b of batches.values()) if (b.owner===owner) b.cancel();}

export function batchRequest(path,data,owner,session,engine) {
  if (path==='/api/batch/start') {
    const names=data.names,sid=field(data,'steamId',17);
    if (!Array.isArray(names)||!names.length||names.length>20||names.some(v=>typeof v!=='string'||!v.trim()||v.length>100))
      throw new AppError('请输入 1–20 个昵称');
    if (sid) {steamId(sid);if (names.length!==1) throw new AppError('请只选择一个玩家');}
    if (batches.size>=64||[...batches.values()].filter(b=>b.owner===owner).length>=8) throw new AppError('查询繁忙，请稍后重试',429);
    const batch=new Batch(owner); batches.set(batch.id,batch);
    void batch.run(names,sid,{token:session.token,steamId:session.steamId},engine);
    return {batch:batch.id};
  }
  if (path==='/api/batch/timing') {
    const {event,ms,players}=data;
    if (!['first_player','all_basic','complete'].includes(event)||!Number.isInteger(ms)||ms<0||ms>86400000||
        !Number.isInteger(players)||players<1||players>20) throw new AppError('无效的耗时记录');
    engine.log({event,ms,players}); return {};
  }
  const batch=batches.get(field(data,'batch',64));
  if (!batch||batch.owner!==owner) throw new AppError('查询已结束或过期',404);
  if (path==='/api/batch/cancel') {batch.cancel();return {};}
  return batch.poll(data.cursor??0);
}
