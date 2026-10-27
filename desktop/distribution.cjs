'use strict';
const path=require('node:path');
function distributionPaths(appData,channel='personal') {
 const root=path.join(appData,channel==='customer'?'AI E-commerce Tools Customer':'AI E-commerce Tools');
 return {root,data:channel==='customer'?path.join(root,'workspace'):root,profile:path.join(root,'profile')};
}
module.exports={distributionPaths};
