/** Read-only checks of saved, product-bound observations; no fetch, AI or gate mutation. */
export function boundCreativeAds(project,product){
 const seen=new Set(),ads=[];
 for(const binding of product.candidate_sources||[]){const ad=project.keywords?.find(w=>w.id===binding.keyword_id)?.ads?.find(a=>a.id===binding.ad_id);if(ad&&!seen.has(ad.id)){seen.add(ad.id);ads.push(ad);}}
 return ads;
}
function dateOnly(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return NaN;
 const parsed=Date.parse(value);return Number.isFinite(parsed)&&new Date(parsed).toISOString().slice(0,10)===value?parsed:NaN;
}
function matchesSavedSource(saved,id){
 try{const url=new URL(saved?.source_url);return ['facebook.com','www.facebook.com'].includes(url.hostname)&&url.pathname.replace(/\/$/,'')==='/ads/library'&&url.searchParams.get('id')===id;}catch{return false;}
}
export function creativeEvidence(project,product,{now=Date.now()}={}){
 const identity=product.identification||{},current=identity.identity_revision===product.identity_revision&&identity.relevance_confirmed===true;
 const rows=boundCreativeAds(project,product).map(ad=>({id:ad.id,ad,saved:null}));
 for(const saved of identity.creatives||[]){let row=rows.find(row=>row.id===saved.id);if(!row){row={id:saved.id,ad:null,saved:null};rows.push(row);}if(!row.saved)row.saved=saved;}
 const mediaSeen=new Map();
 for(const row of rows){
  const ad=row.ad,observed=Date.parse(ad?.observed_at||''),start=dateOnly(ad?.start_date);
  row.fresh=Number.isFinite(observed)&&observed<=now+300000&&now-observed<=86400000;
  row.ageDays=Number.isFinite(start)&&Number.isFinite(observed)&&start<=observed?Math.floor((observed-start)/86400000):null;
  row.active=typeof ad?.currently_active==='boolean'?ad.currently_active:typeof ad?.active==='boolean'?ad.active:null;
  const media=(ad?.media||[]).filter(item=>['image','video'].includes(item.kind)&&typeof item.url==='string'&&/^https?:\/\//.test(item.url));row.hasMedia=media.length>0;
  const signature=media.length?JSON.stringify([...new Set(media.map(item=>item.kind+':'+item.url))].sort()):null;
  row.duplicateOf=signature?mediaSeen.get(signature)||null:null;if(signature&&!row.duplicateOf)mediaSeen.set(signature,row.id);
  // Different delivery URLs/advertisement IDs are never evidence of distinct visuals.
  row.confirmed=Boolean(current&&matchesSavedSource(row.saved,row.id)&&row.saved?.distinct===true&&row.saved.active===true&&row.fresh&&row.active===true&&row.hasMedia&&!row.duplicateOf);
  row.status=row.duplicateOf?'duplicate':!row.hasMedia?'missing_media':!row.fresh?'stale':row.active===false?'inactive':row.active===null?'unknown':row.confirmed?'confirmed':'review';
 }
 const requiredCount=Number.isInteger(project.rules?.min_creatives)&&project.rules.min_creatives>0?project.rules.min_creatives:3;
 const requiredDays=Number.isFinite(project.rules?.min_active_days)?project.rules.min_active_days:30;
 const active=rows.filter(row=>row.fresh&&row.active===true),ages=active.map(row=>row.ageDays).filter(Number.isFinite),confirmedCount=rows.filter(row=>row.confirmed).length;
 return {rows,requiredCount,requiredDays,ageDays:ages.length?Math.max(...ages):null,activeCount:active.length,confirmedCount,missingCount:Math.max(0,requiredCount-confirmedCount),pendingCount:rows.filter(row=>row.status==='review').length,duplicateCount:rows.filter(row=>row.duplicateOf).length,missingMediaCount:rows.filter(row=>!row.hasMedia).length,checkedAt:new Date(now).toISOString()};
}
