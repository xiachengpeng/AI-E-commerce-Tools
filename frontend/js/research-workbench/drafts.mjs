// BEGIN STANDALONE DRAFT EXPORT
/** Version 1 source form DTOs. No live form restoration or command replay. */
const MAX_BUNDLE_BYTES=1048576,MAX_DRAFT_BYTES=65536,MAX_DRAFTS=100;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH=/^(?:[a-f0-9]{64}|change:[0-9]{1,8}:[a-f0-9]{1,8}:[a-f0-9]{1,8})$/i;
const rules='min_active_days min_creatives min_margin_percent min_aov max_aov max_weight_kg max_direct_share_percent quote_valid_days test_score backup_score scan_batch_limit daily_scan_budget max_depth expansion_limit ai_daily_limit reason';
const schemas={
 new_project:['title direction market','create_project'],
 add_keyword:['text type meaning source_id source_quote','add_keyword'],edit_keyword:['text type meaning source_id source_quote','edit_keyword'],new_search_entry:['text type meaning','add_keyword'],
 configure_rules:[rules,'configure_rules'],configure_collection:['meta trends','configure_collection'],add_product:['name','add_product'],delete_project:['title',null],
 merge_products:['target_product_id reason','merge_products'],split_product_offer:['reason','split_product_offer'],link_product_offers:['second_product_id name reason','link_product_offers'],
 confirm_product:['name reason relevance_confirmed','confirm_product'],confirm_creatives:['active_days','confirm_creatives'],
 triage_retained:['reason_choice reason','triage_product'],triage_observing:['reason_choice reason','triage_product'],triage_rejected:['reason_choice reason','triage_product'],triage_product:['reason_choice reason','triage_product'],restore_product:['reason','restore_product'],
 funnel:['hook creative_formats scenarios angles cta trust faq bundle notes confirmed','funnel'],
 add_creative_reference:['source_ad_id observed_at format hook pattern_note category audience pain_point scene angle cta duration_seconds notes','add_creative_reference'],
 record_funnel_investigation:['area status method observed_at reason notes','record_funnel_investigation'],logistics_profile:['carrier service observed_at volumetric_divisor_cm3_per_kg confirmed','set_logistics_profile'],
 add_sales_estimate:['traffic_evidence_id cvr_low cvr_base cvr_high cvr_source','add_sales_estimate'],
 economics:['unit_price quantity aov goods_cost shipping packaging tax ad_cost payment_percent payment_fixed reserve_percent weight_kg package_length_cm package_width_cm package_height_cm quote_date bundle_reason logistics_risk compliance_risk ip_risk fragile battery liquid powder magnetic oversized quote_confirmed certification_required certification_verified','economics'],
 decide:['pool reason','decide'],test_plan:['budget days success_cpa stop_loss notes approved','test_plan'],
 test_result:['period_start period_end spend impressions clicks add_to_carts checkouts orders revenue refunds confirmed','test_result'],revise_test_result:['period_start period_end spend impressions clicks add_to_carts checkouts orders revenue refunds confirmed reason','revise_test_result'],void_test_result:['reason','void_test_result'],review:['conclusion lessons next_keywords','review'],
 trends_import:['query market window observed_at confirmed',null]
};
const aliases={
 '添加初始关键词':'add_keyword','从线索继续扩词':'add_keyword','修改待审核关键词':'edit_keyword','换一个搜索入口':'new_search_entry','项目规则与预算':'configure_rules','设置采集模式':'configure_collection','添加具体产品':'add_product',
 '广告与漏斗拆解':'funnel','记录创意参考':'add_creative_reference','记录漏斗调查':'record_funnel_investigation','核算这笔订单是否值得做':'economics','做出人工决策':'decide','确认测试计划':'test_plan','记录真实测试结果':'test_result','修订测试结果':'revise_test_result','记录复盘，回流下一轮关键词':'review','导入 Google Trends 周度 CSV':'trends_import'
};
const evidenceBase='observed_at conclusion notes confirmed review_due_at valid_until';
for(const [name,channel,extra] of [['Meta 广告','meta','advertiser_count brand_concentration differentiation'],['Google Trends','trends','query window'],['Pinterest','pinterest','not_applicable reason'],['TikTok','tiktok','not_applicable reason'],['Amazon','amazon','not_applicable reason'],['Similarweb','similarweb','direct_share monthly_visits traffic_scope traffic_period not_applicable reason']])schemas['补充 '+name+' 证据']=[evidenceBase+' '+extra,'evidence'];
const booleanFields=new Set('relevance_confirmed confirmed not_applicable quote_confirmed certification_required certification_verified approved'.split(' '));
function plain(value){return value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));}
function checkTree(value,depth=0){
 if(depth>8)throw Error('invalid_schema');
 if(value===null||typeof value==='boolean')return;
 if(typeof value==='string'){if(value.length>10000||/[<>]|&(?:lt|gt);|javascript:|data:|https?:\/\/|\bBearer\s+|-----BEGIN .*PRIVATE KEY/i.test(value))throw Error('unsafe_text');return;}
 if(typeof value==='number'&&Number.isFinite(value))return;
 if(!plain(value)&&!Array.isArray(value))throw Error('invalid_schema');
 for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))){
  if(key==='length'&&Array.isArray(value))continue;
  if(!Object.hasOwn(descriptor,'value')||/^(?:__proto__|prototype|constructor)$/i.test(key))throw Error('invalid_schema');
  checkTree(descriptor.value,depth+1);
 }
}
function origin(value){if(typeof value!=='string'||value.length>300)throw Error('source_origin');const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.origin!==value||u.username||u.password)throw Error('source_origin');return value;}
function sourceKey(key){
 if(typeof key!=='string'||key.length>1024)throw Error('unknown_key');
 const quick=key.match(/^rabbit-hole:command:([^:]+):(.+)$/);
 if(quick){if(!UUID.test(quick[1])||!HASH.test(quick[2]))throw Error('unknown_key');return {project:quick[1],quick:true,fields:[],action:null};}
 if(!key.startsWith('rabbit-hole:draft:'))throw Error('unknown_key');
 const parts=JSON.parse(key.slice(18));if(!Array.isArray(parts)||parts.length!==4||parts.some(x=>typeof x!=='string')||!(['new'].includes(parts[0])||UUID.test(parts[0]))||[parts[1],parts[3]].some(x=>x!==''&&!UUID.test(x)))throw Error('unknown_key');
 const kind=aliases[parts[2]]||parts[2];let schema=schemas[kind];if(parts[2].startsWith('删除项目：')&&parts[2].length<=220)schema=schemas.delete_project;
 if(!schema)throw Error('unknown_kind');const fields=schema[0].split(' ');
 if(kind==='confirm_creatives')for(let n=1;n<=100;n++)fields.push(`creative_${n}_id`,`creative_${n}_distinct`,`creative_${n}_active`);
 return {project:parts[0],product:parts[1],kind,fields,action:schema[1]};
}
function validateRecord(record){
 if(!plain(record)||Object.keys(record).some(k=>!['key','data'].includes(k)))throw Error('invalid_schema');
 const spec=sourceKey(record.key),d=record.data;if(!plain(d)||Object.keys(d).some(k=>!(spec.quick?['command_id','submittedHash','uncertain','digest','version']:['values','command_id','submittedHash','uncertain','digest','version']).includes(k)))throw Error('invalid_fields');
 if(!UUID.test(d.command_id)||!(d.submittedHash==null||typeof d.submittedHash==='string'&&HASH.test(d.submittedHash))||typeof d.uncertain!=='boolean'||(d.digest!==undefined&&!(typeof d.digest==='string'&&/^[a-f0-9]{64}$/i.test(d.digest)))||(d.version!==undefined&&(!Number.isSafeInteger(d.version)||d.version<0)))throw Error('invalid_identity');
 if(!spec.quick){if(!plain(d.values))throw Error('invalid_values');for(const [k,v] of Object.entries(d.values)){if(!spec.fields.includes(k))throw Error('unknown_field');const bool=booleanFields.has(k)||/^creative_\d+_(?:distinct|active)$/.test(k);if(typeof v!==(bool?'boolean':'string'))throw Error('invalid_value_type');}}
 if(new TextEncoder().encode(JSON.stringify(record)).length>MAX_DRAFT_BYTES)throw Error('draft_too_large');
 return spec;
}
function decodeBundle(input){
 if(typeof input==='string'){if(new TextEncoder().encode(input).length>MAX_BUNDLE_BYTES)throw Error('bundle_too_large');input=JSON.parse(input);}
 // Envelope origin is not form text; validate it separately, before recursive DTO checks.
 if(!plain(input))throw Error('invalid_bundle');
 for(const descriptor of Object.values(Object.getOwnPropertyDescriptors(input)))if(!Object.hasOwn(descriptor,'value'))throw Error('invalid_bundle');
 if(Object.keys(input).some(k=>!['version','source_origin','drafts'].includes(k))||input.version!==1||!Array.isArray(input.drafts)||input.drafts.length>MAX_DRAFTS)throw Error('invalid_bundle');
 origin(input.source_origin);checkTree(input.drafts);if(new TextEncoder().encode(JSON.stringify(input)).length>MAX_BUNDLE_BYTES)throw Error('bundle_too_large');return input;
}
export function exportDrafts(storage,{sourceOrigin=globalThis.location?.origin}={}){
 const drafts=[];origin(sourceOrigin);
 for(let i=0;i<(storage?.length||0);i++){
  const key=storage.key(i);if(typeof key!=='string'||!key.startsWith('rabbit-hole:draft:')&&!key.startsWith('rabbit-hole:command:'))continue;
  sourceKey(key);const raw=storage.getItem(key);if(typeof raw!=='string'||new TextEncoder().encode(raw).length>MAX_DRAFT_BYTES)throw Error('draft_too_large');
  const record={key,data:JSON.parse(raw)};checkTree(record);validateRecord(record);drafts.push(record);
 }
 return decodeBundle({version:1,source_origin:sourceOrigin,drafts});
}
// END STANDALONE DRAFT EXPORT
export async function importDrafts(input,context){
 const result={accepted:[],needs_review:[],rejected:[]};let bundle;
 try{bundle=decodeBundle(input);for(const record of bundle.drafts)validateRecord(record);}catch{result.rejected.push({reason:'invalid_or_unsafe_bundle'});return result;}
 const active=()=>context.isCurrent?.()!==false&&!context.signal?.aborted;
 if((context.state?.importedDrafts?.length||0)+bundle.drafts.length>MAX_DRAFTS){result.rejected.push({reason:'review_archive_limit'});return result;}
 const entries=[],seen=new Set();
 for(const inputRecord of bundle.drafts){
  if(!active())return result;
  const draft=JSON.parse(JSON.stringify(inputRecord)),spec=sourceKey(draft.key),base={draft,source_origin:bundle.source_origin,mode:'read_only_draft'};
  let item;
  const existing=(context.state?.importedDrafts||[]).some(x=>x.draft?.key===draft.key||x.draft?.data?.command_id===draft.data.command_id);
  if(seen.has(draft.key)||seen.has(draft.data.command_id)||existing||context.state?.drafts?.[draft.key]||context.storage?.getItem(draft.key)!=null){item={...base,reason:'existing_main_draft'};}
  else try{
   const submitted=Boolean(draft.data.submittedHash||draft.data.digest||draft.data.uncertain);
   let receipt;
   // Identity reconciliation precedes version checks. No POST, retry or new UUID.
   if(submitted&&spec.project!=='new')receipt=await context.readReceipt(spec.project,draft.data.command_id,context.signal);
   if(!active())return result;
   if(receipt?.state==='committed'){
    const match=receipt.contract_version===1&&receipt.project_id===spec.project&&receipt.command_id===draft.data.command_id&&typeof receipt.digest==='string'&&/^[a-f0-9]{64}$/i.test(receipt.digest)&&typeof receipt.action==='string'&&/^[a-z_]{1,40}$/.test(receipt.action)&&(!spec.action||receipt.action===spec.action);
    if(!match||draft.data.digest&&draft.data.digest!==receipt.digest)item={...base,reason:'receipt_mismatch'};
    else{item={...base,mode:'receipt_only',receipt:{contract_version:1,project_id:receipt.project_id,command_id:receipt.command_id,state:'committed',action:receipt.action,digest:receipt.digest}};if(!draft.data.digest||!spec.action)item.reason='committed_content_unverified';}
   }else if(submitted)item={...base,reason:'submission_not_reconciled'};
   else if(spec.project==='new')item=base;
   else if(draft.data.version===undefined)item={...base,reason:'missing_source_version'};
   else{const project=await context.readProject(spec.project,context.signal);if(!active())return result;item=project.id===spec.project&&project.version===draft.data.version?base:{...base,reason:'source_version_changed'};}
  }catch{item={...base,reason:'reconciliation_unavailable'};}
  if(!active())return result;seen.add(draft.key);seen.add(draft.data.command_id);if(!existing&&!entries.some(x=>x.draft.key===draft.key||x.draft.data.command_id===draft.data.command_id))entries.push(item);result[item.reason?'needs_review':'accepted'].push(item);
 }
 if(active()&&entries.length){context.state.importedDrafts=[...(context.state.importedDrafts||[]),...entries];}
 return result;
}
