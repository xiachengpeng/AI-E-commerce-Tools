const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
test('customer packaging explicitly enables resource hook and copies release identity',async()=>{
 const {customerOptions}=require('../build/customer-package.cjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'customer-package-'));
 try{
  const resources=path.join(root,'resources');await fs.mkdir(resources);
  for(const name of ['backend','frontend','browsers'])await fs.mkdir(path.join(resources,name));
  await fs.writeFile(path.join(resources,'release.json'),'customer');
  await fs.writeFile(path.join(resources,'browser-inventory.json'),'{}');
  const options=customerOptions({resources,version:'0.2.0'});
  assert.ok(Array.isArray(options.extraResource),'packager skips hooks without this option');
  const buildPath=path.join(root,'staging');
  await fs.mkdir(path.join(buildPath,'AI E-commerce Tools Customer.app/Contents/Resources'),{recursive:true});
  await options.afterCopyExtraResources[0]({buildPath});
  assert.equal(await fs.readFile(path.join(buildPath,'AI E-commerce Tools Customer.app/Contents/Resources/release.json'),'utf8'),'customer');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
