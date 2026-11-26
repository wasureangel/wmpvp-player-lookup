import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,renameSync,unlinkSync,statSync} from 'node:fs';
import {basename,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from '../../scripts/build.mjs';

const repository=fileURLToPath(new URL('../../',import.meta.url));
const legacy={
  'core.js':['9748e7492de6c89ef0800012ad237a7b5b4867f5'],
  'handler.js':['934ad2f35e5b9e79c8537b5b9a216b19e9717c62'],
  'session.js':['28c682539970dbb0e8c5510cc5837066fc120fd4'],
  'platform.js':['132e2de9893015411ec8bfbd7fc5fd1498742529','2b89e828ba313cd1b2edfe94efb26e559ba49c36']
};
const modules=[...Object.keys(legacy),'batches.js','engine.js'];
const parts=['server','dist'];
const journal=site=>join(site,'.query-releases');
const pointer=site=>join(journal(site),'active');
function current(site) {return existsSync(pointer(site))?readFileSync(pointer(site),'utf8').trim():'';}
function location(site,id) {
  if (!/^release-[A-Za-z0-9_-]+$/.test(id)) throw Error('没有可用的升级记录');
  return join(journal(site),id);
}
function mark(site,id) {
  if (!id) {unlinkSync(pointer(site));return;}
  writeFileSync(pointer(site)+'.tmp',id+'\n');renameSync(pointer(site)+'.tmp',pointer(site));
}
function fingerprint(file) {
  const bytes=readFileSync(file);
  return createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
}

export async function prepare(site) {
  const previous=current(site);
  const expected=previous?JSON.parse(readFileSync(join(location(site,previous),'manifest.json'),'utf8')):legacy;
  for (const [name,hashes] of Object.entries(expected)) {
    if (!hashes.includes(fingerprint(join(site,'server',name)))) throw Error('服务端文件与已知版本不同，请保留并核对 '+name);
  }
  for (const name of ['listen.mjs','dist/index.html','dist/app.js']) if (!statSync(join(site,name)).isFile()) throw Error('缺少 '+name);
  mkdirSync(journal(site),{recursive:true,mode:0o700});
  const stage=mkdtempSync(join(journal(site),'release-')),manifest={};
  for (const part of parts) cpSync(join(site,part),join(stage,'new-'+part),{recursive:true});
  for (const name of modules) {
    const src=join(repository,'server',name);
    cpSync(src,join(stage,'new-server',name));
    manifest[name]=[fingerprint(src)];
  }
  await build(pathToFileURL(join(stage,'new-dist')+'/'));
  writeFileSync(join(stage,'manifest.json'),JSON.stringify(manifest));
  writeFileSync(join(stage,'previous'),previous);
  return basename(stage);
}

export function activate(site,id) {
  const stage=location(site,id);
  if (current(site)!==readFileSync(join(stage,'previous'),'utf8')) throw Error('活动版本已变化');
  mark(site,id);
  for (const part of parts) {
    renameSync(join(site,part),join(stage,'old-'+part));
    renameSync(join(stage,'new-'+part),join(site,part));
  }
}
export function restore(site) {
  const id=current(site),stage=location(site,id);
  for (const part of [...parts].reverse()) {
    const old=join(stage,'old-'+part),live=join(site,part);
    if (existsSync(old)) {
      if (existsSync(live)) renameSync(live,join(stage,'replaced-'+part));
      renameSync(old,live);
    }
  }
  mark(site,readFileSync(join(stage,'previous'),'utf8').trim());
}
if (import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [action,dir,id]=process.argv.slice(2),site=resolve(dir);
  if (action==='prepare') console.log(await prepare(site));
  else if (action==='activate') activate(site,id);
  else if (action==='restore') restore(site);
  else throw Error('未知升级操作');
}
