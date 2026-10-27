const {test}=require('node:test');
const assert=require('node:assert/strict');
test('customer identity uses a stable independent workspace and browser profile',()=>{
 const {distributionPaths}=require('../distribution.cjs');
 const customer=distributionPaths('/Fixture/AppData','customer');
 const self=distributionPaths('/Fixture/AppData','personal');
 assert.equal(customer.data,'/Fixture/AppData/AI E-commerce Tools Customer/workspace');
 assert.equal(customer.profile,'/Fixture/AppData/AI E-commerce Tools Customer/profile');
 assert.equal(self.data,'/Fixture/AppData/AI E-commerce Tools');
 assert.notEqual(customer.data,self.data);
});
