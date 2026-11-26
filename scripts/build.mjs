import {mkdir,cp,copyFile,readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export function page(html,online) {
  html=html.replace('__CSRF__','pages-client-v1').replace('凭据仅在本机服务内存中保留。','登录凭据保存在此浏览器的加密会话中。');
  return online?html.replace('本机运行','在线查询').replace('仅在本机使用','每个浏览器独立登录')
    .replace('退出本机登录','退出登录').replace('缓存在本机','缓存在服务器'):html;
}

export async function build(target=new URL('../dist/',import.meta.url)) {
  const root=new URL('../',import.meta.url);
  await mkdir(target,{recursive:true});
  await writeFile(new URL('index.html',target),page(await readFile(new URL('web.html',root),'utf8'),true));
  for (const [src,dst] of [['web.js','app.js'],['web.css','app.css']]) await copyFile(new URL(src,root),new URL(dst,target));
  await cp(new URL('rank-assets/',root),new URL('rank-assets/',target),{recursive:true});
}
if (import.meta.url===pathToFileURL(process.argv[1]).href) await build();
