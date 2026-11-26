import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepare,activate,restore} from '../deploy/ubuntu/release.mjs';

test('upgrade and rollback preserve listener, custom static files and legacy modules', async t=>{
  const dir=mkdtempSync(join(tmpdir(),'wmpvp-release-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  mkdirSync(join(dir,'server'));mkdirSync(join(dir,'dist'));
  for (const name of ['core','session','handler','platform']) {
    writeFileSync(join(dir,'server',name+'.js'),execFileSync('git',['show','6740770:server/'+name+'.js']));
  }
  const read=p=>readFileSync(join(dir,p),'utf8');
  const put=(p,value)=>writeFileSync(join(dir,p),value);
  for(const f of ['listen.mjs','dist/index.html','dist/app.js','dist/custom.txt']) put(f,'original');
  const original=read('server/handler.js');
  const id=await prepare(dir);
  assert.equal(read('server/handler.js'),original);
  activate(dir,id);
  assert.match(read('server/handler.js'),/batchRequest/);assert.match(read('dist/index.html'),/pages-client-v1/);
  assert.equal(read('dist/custom.txt'),'original');assert.equal(read('listen.mjs'),'original');
  const next=await prepare(dir);activate(dir,next);restore(dir);
  assert.equal(read('.query-releases/active').trim(),id);
  restore(dir);
  assert.equal(read('server/handler.js'),original);assert.equal(read('dist/app.js'),'original');
  assert.equal(existsSync(join(dir,'.query-releases/active')),false);
  put('server/platform.js','local customization');
  await assert.rejects(prepare(dir),/platform.js/);assert.equal(read('server/platform.js'),'local customization');
});
