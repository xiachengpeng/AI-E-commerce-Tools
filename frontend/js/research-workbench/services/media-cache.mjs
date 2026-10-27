/** Bounded, in-memory media leases. Never persist source URLs or blobs in DTO state. */
export function sourceMediaKey(projectId,wordId,source,sourceId,revision,observedAt,items,index){return projectId+':'+wordId+':'+source+':'+sourceId+':'+JSON.stringify([revision,observedAt,items])+':'+index;}
export function createMediaCache({life,api,owner=globalThis.URL,maxEntries=32,maxBytes=64*1024*1024}) {
 const entries=new Map(),all=new Set();let clock=0;
 function retire(entry){if(entries.get(entry.key)===entry)entries.delete(entry.key);entry.retired=true;if(!entry.refs){if(entry.value)owner.revokeObjectURL(entry.value.url);entry.value=null;all.delete(entry);}}
 function trim(){
  const ready=[...entries.values()].filter(e=>e.value||e.error);let bytes=ready.reduce((n,e)=>n+(e.value?.size||0),0),count=ready.length;
  for(const entry of ready.filter(e=>!e.refs).sort((a,b)=>a.used-b.used)){
   if(count<=maxEntries&&bytes<=maxBytes)break;bytes-=entry.value?.size||0;count--;retire(entry);
  }
 }
 life.track(()=>{for(const entry of all){entry.retired=true;if(entry.value){owner.revokeObjectURL(entry.value.url);entry.value=null;}}entries.clear();all.clear();});
 return {
  async acquire(key,path){
   if(!life.active)return null;
   let entry=entries.get(key);
   if(!entry){
    entry={key,refs:0,used:++clock,value:null,retired:false};entries.set(key,entry);all.add(entry);
    const owned=entry;
    owned.promise=Promise.resolve().then(()=>api.blob(path,{signal:life.signal})).then(blob=>{
     if(!life.active)return null;
     if(!/^(image|video)\//.test(blob.type))throw Error('来源未返回可用媒体');
     owned.value={url:owner.createObjectURL(blob),type:blob.type,size:blob.size};return owned.value;
    }).catch(error=>{owned.error=error;throw error;});
   }
   entry.refs++;entry.used=++clock;let released=false;
   const release=()=>{if(released)return;released=true;entry.refs--;if(entry.retired)retire(entry);else trim();};
   try{const value=await entry.promise;if(!value||!life.active){release();return null;}return {...value,release};}
   catch(error){release();throw error;}
  },
  invalidate(key){const entry=entries.get(key);if(entry)retire(entry);},
  async prefetch(key,path){const lease=await this.acquire(key,path);lease?.release();},
 };
}
