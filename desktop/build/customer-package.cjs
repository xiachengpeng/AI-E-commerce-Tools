'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
function customerOptions(config){
 const name='AI E-commerce Tools Customer';
 return {dir:config.shell,name,platform:'darwin',arch:'arm64',
  electronVersion:'44.9.1',electronZipDir:config.electron_zip_dir,
  appVersion:config.version,buildVersion:config.version,appBundleId:'local.ai-ecommerce-tools.customer',
  appCategoryType:'public.app-category.business',out:config.output,overwrite:false,asar:true,prune:false,extraResource:[],
  afterCopyExtraResources:[async({buildPath})=>{
   const root=path.join(buildPath,name+'.app/Contents/Resources');
   for(const entry of ['backend','frontend','browsers','browser-inventory.json','release.json'])
    await fs.cp(path.join(config.resources,entry),path.join(root,entry),{recursive:true,verbatimSymlinks:true});
  }],
  osxSign:{identity:'-',identityValidation:false,type:'development',hardenedRuntime:false,
   preAutoEntitlements:false,preEmbedProvisioningProfile:false,optionsForFile:()=>({hardenedRuntime:false,timestamp:'none'})}};
}
module.exports={customerOptions};
if(require.main===module)(async()=>{
 const config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
 const {packager}=await import(pathToFileURL(path.join(config.node_modules,'@electron/packager/dist/index.js')).href);
 const outputs=await packager(customerOptions(config));
 console.log(outputs.join('\n'));
})().catch(error=>{console.error(error);process.exitCode=1;});
