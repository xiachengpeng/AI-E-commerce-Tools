'use strict';

function newCommandId(){
 if(crypto.randomUUID)return crypto.randomUUID();
 const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
 const h=Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');
 return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
}
async function submissionFingerprint(content){
 const bytes=new TextEncoder().encode(JSON.stringify(content));
 if(crypto.subtle)return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
 // Change detection only: the backend checks idempotency against the full payload.
 // Never persist raw form contents when LAN HTTP lacks SubtleCrypto.
 let a=2166136261,b=2246822507;for(const x of bytes){a=Math.imul(a^x,16777619);b=Math.imul(b^x,3266489909);}
 return 'change:'+bytes.length+':'+(a>>>0).toString(16)+':'+(b>>>0).toString(16);
}
