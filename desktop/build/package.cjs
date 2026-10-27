'use strict';
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {copyResources}=require('./copy-resources.cjs');
(async()=>{
 const root=path.resolve(__dirname,'../..');
 const resources=path.join(root,'desktop/resources');
 // Build-tools are private to this workspace, not a runtime dependency.
 const python=process.env.DESKTOP_BUILD_PYTHON||path.join(root,'.venv/bin/python');
 const check=spawnSync(python,[path.join(root,'scripts/desktop/verify_bundle.py'),resources],{stdio:'inherit'});
 if(check.status!==0)throw Error('Bundle verification failed');
 const {packager}=await import('@electron/packager');
 const output=await packager({dir:path.join(root,'desktop'),name:'AI E-commerce Tools',platform:'darwin',arch:'arm64',
  out:path.join(root,'desktop/release'),overwrite:false,asar:true,appBundleId:'local.ai-ecommerce-tools.desktop',
  appCategoryType:'public.app-category.business',extraResource:[],
  afterCopyExtraResources:[async ({buildPath})=>{
   const bundled=path.join(buildPath,'AI E-commerce Tools.app/Contents/Resources');
   await copyResources(resources,bundled);
   const verified=spawnSync(python,[path.join(root,'scripts/desktop/verify_bundle.py'),bundled],{stdio:'inherit'});
   if(verified.status!==0)throw Error('Packaged resource verification failed');
  }],

  ignore:[/^\/resources(?:\/|$)/,/^\/release(?:\/|$)/,/^\/\.build(?:-tools)?(?:\/|$)/,/^\/tests(?:\/|$)/],
  osxSign:{identity:'-',identityValidation:false,type:'development',hardenedRuntime:false,preAutoEntitlements:false,preEmbedProvisioningProfile:false,optionsForFile:()=>({hardenedRuntime:false,timestamp:'none'})},
  prune:true});
 for(const directory of output){
  const verified=spawnSync('codesign',['--verify','--deep','--strict',path.join(directory,'AI E-commerce Tools.app')],{stdio:'inherit'});
  if(verified.status!==0)throw Error('Development signature verification failed');
 }
 console.log(output.join('\n'));
})().catch(()=>{console.error('Desktop packaging failed; inspect local build output.');process.exitCode=1;});
