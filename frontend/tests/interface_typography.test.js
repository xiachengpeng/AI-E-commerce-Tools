const test=require('node:test');
const assert=require('node:assert/strict');
const {createInterfaceTypography,scaleFontRules}=require('../js/interface_typography.js');
function fixture(initial){
 const values=new Map(),saved=new Map(initial===undefined?[]:[['ai_ecommerce_interface_font_size',initial]]);
 const document={documentElement:{style:{setProperty:(k,v)=>values.set(k,v)}},styleSheets:[],getElementById:()=>null};
 const storage={getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v)};
 return {document,storage,values,saved};
}
test('interface size persists, restores and resets without touching business storage',()=>{
 const f=fixture();const fonts=createInterfaceTypography(f);fonts.init();
 assert.equal(fonts.size,16);fonts.setSize(20);assert.equal(f.values.get('--app-font-scale'),'1.25');
 assert.equal(createInterfaceTypography(f).size,20);fonts.reset();assert.equal(fonts.size,16);
 assert.deepEqual([...f.saved.keys()],['ai_ecommerce_interface_font_size']);
});
test('invalid values fail closed and unavailable storage still permits session adjustment',()=>{
 const f=fixture('999');const fonts=createInterfaceTypography(f);fonts.init();assert.equal(fonts.size,16);
 assert.equal(fonts.setSize('1000'),false);assert.equal(fonts.size,16);
 f.storage.setItem=()=>{throw Error('blocked');};assert.equal(fonts.setSize(18),true);assert.equal(fonts.size,18);
});
test('font rules retain media scope and importance, skip root/em and apply once',()=>{
 function rule(selector,value,priority=''){return {selectorText:selector,style:{fontSize:value,getPropertyValue:()=>value,getPropertyPriority:()=>priority,setProperty(k,v,p){this.fontSize=v;this.priority=p;}}};}
 const child=rule('.menu','16px','important'),relative=rule('.copy','0.875rem'),em=rule('.inherit','1.2em'),root=rule('html','16px');
 child.cssRules=[];relative.cssRules=[];const sheets=[{cssRules:[{cssRules:[child]},relative,em,root]}];scaleFontRules(sheets);scaleFontRules(sheets);
 assert.equal(child.style.fontSize,'calc(16px * var(--app-font-scale, 1))');assert.equal(child.style.priority,'important');
 assert.equal(relative.style.fontSize,'calc(0.875rem * var(--app-font-scale, 1))');assert.equal(em.style.fontSize,'1.2em');assert.equal(root.style.fontSize,'16px');
});
test('cross origin sheets are safely ignored',()=>{
 assert.doesNotThrow(()=>scaleFontRules([{get cssRules(){throw Error('cross origin');}}]));
});
