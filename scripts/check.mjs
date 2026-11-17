import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
async function check(folder) {
  for(const entry of await readdir(folder,{withFileTypes:true})) {
    if(['.git','node_modules','dist','.wrangler'].includes(entry.name))continue;
    const path=new URL(entry.name+(entry.isDirectory()?'/':''),folder);
    if(entry.isDirectory())await check(path);
    else if(/\.(?:js|mjs|cjs)$/.test(entry.name)) {
      const result=spawnSync(process.execPath,['--check',fileURLToPath(path)],{stdio:'inherit'});
      if(result.status!==0)process.exit(result.status||1);
    }
  }
}
await check(root);
console.log('JavaScript syntax checks passed.');
