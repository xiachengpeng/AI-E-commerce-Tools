const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {copyResources}=require('../build/copy-resources.cjs');
test('resource framework links remain relative and relocatable',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'desktop-resources-'));
 try {
  const src=path.join(root,'source'),out=path.join(root,'app');
  await fs.mkdir(path.join(src,'browsers','Versions','1'),{recursive:true});
  await fs.writeFile(path.join(src,'browsers','Versions','1','binary'),'fixture');
  await fs.symlink('Versions/1/binary',path.join(src,'browsers','binary'));
  await copyResources(src,out,['browsers']);
  assert.equal(await fs.readlink(path.join(out,'browsers','binary')),'Versions/1/binary');
  await fs.rename(src,path.join(root,'source-unavailable'));
  assert.equal(await fs.readFile(path.join(out,'browsers','binary'),'utf8'),'fixture');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
