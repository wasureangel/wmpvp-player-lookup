import {setTimeout as delay} from 'node:timers/promises';
import {randomBytes} from 'node:crypto';
import {Engine} from '../server/engine.js';
import {createServer} from '../listen.mjs';
import {sessionCookie} from '../server/session.js';

export async function fixture() {
  const port=18873,origin='http://127.0.0.1:'+port;
  const env={SITE_PASSWORD:randomBytes(16).toString('hex'),SESSION_SECRET:randomBytes(32).toString('hex')};
  const base=76561198000000000n;
  const engine=new Engine({path:':memory:',log:()=>{},fetcher:async(url,init)=>{
    await delay(120,undefined,{signal:init.signal});
    const data=JSON.parse(init.body||'{}'),ok=data=>Response.json({statusCode:0,data});
    if (url.endsWith('/user')) {
      const sid=(base+BigInt(data.keyword.split('-')[1])).toString();
      return Response.json({code:1,result:[{steamId:sid,pvpNickName:data.keyword,pvpScore:1800}]});
    }
    if (url.endsWith('/list')) {
      const sid=init.body.match(/"toSteamId":(\d+)/)[1];
      return ok({matchList:Array.from({length:10},(_,i)=>({matchId:i?sid+'-'+i:'shared',mode:'完美官匹Pro',
        team:1,winTeam:1,endTime:'2026-01-10 09:00:00',kill:20,death:10,assist:5,pwRating:1.2}))});
    }
    if (url.endsWith('/match')) return ok({players:Array.from({length:10},(_,i)=>({
      playerId:(base+BigInt(i)).toString(),adpr:80,we:12,rws:10,honor:'2'}))});
    if (url.endsWith('/csgoSeasons')) return ok(Array.from({length:25},(_,i)=>({season:'S'+i,endTime:'2020-01-01 00:00:00'})));
    if (url.endsWith('/pvpDetailStats')) return ok({seasonId:data.csgoSeasonId,historyScores:[1900,2000]});
    throw Error('Unexpected fixture request');
  }});
  const server=createServer({origin,env,engine,localDesktop:true});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(port,'127.0.0.1',resolve));
  const header=await sessionCookie(new Request(origin),{access:true,token:'synthetic',steamId:String(base),expires:Date.now()+600000},env);
  return {origin,cookie:{url:origin,name:'wmpvp_dev_session',value:header.split(';')[0].split('=')[1]},
    close(){server.closeAllConnections();server.close();engine.db.close();}};
}
