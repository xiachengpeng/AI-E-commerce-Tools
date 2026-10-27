'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
async function copyResources(source,target,names=['backend','frontend','browsers','browser-inventory.json']) {
 await fs.mkdir(target,{recursive:true});
 for(const name of names)await fs.cp(path.join(source,name),path.join(target,name),{recursive:true,verbatimSymlinks:true});
}
module.exports={copyResources};
