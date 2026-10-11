async function run(kind,extra={}){
 if(kind==='trends'&&!extra.query){
  const id=S.project.id,version=S.project.version;
  openForm('采集'+marketNames[S.project.market]+' Google Trends','请输入当地常用产品搜索词，将分别验证过去12个月与5年。'+marketHint(),fields([['query','当地常用产品搜索词']]),async data=>{await api('/projects/'+id+'/actions',{method:'POST',body:JSON.stringify({kind,version,...extra,...data})});});
  return;
 }
 if(S.writeBusy){
  const message='上一项请求尚未完成，请稍后操作。';
  if(kind==='keywords'||kind==='scan_all')setKeywordFeedback('error',message);
  warn(message);return;
 }
 S.writeBusy=true;
 if(kind==='keywords'||kind==='scan_all')setKeywordFeedback('pending',kind==='keywords'?'正在提交 AI 初始词建议请求…':'正在检查已审核词并提交扫描…');
 try{
  const id=S.project.id;
  const outcome=await api('/projects/'+id+'/actions',{method:'POST',body:JSON.stringify({kind,version:S.project.version,command_id:newCommandId(),...extra})});
  let message='已保存执行请求。已加入队列，来源异常会明确提示，不影响已保存证据。';
  if(outcome.disposition==='restarted'&&kind!=='verify')message='已创建新的搜索任务，旧记录保留；本次重新计入扫描与接口预算。';
  if(kind==='verify'){
   message=outcome.count===0?'当前词没有新的待核对商品。可查看疑点列表或重新核对疑点。':outcome.disposition==='unchanged'?'已有自动核对任务，请查看下方进度。':'已提交 '+outcome.count+' 个商品的自动核对；先读取缺失商品页，再对照广告。';
   S.verificationFeedback={projectId:id,keywordId:extra.keyword_id,message};
  }
  if(kind==='landing')message='商品页读取请求已提交。请查看按钮下方的进度与下一步。';
  if(kind==='scan_all'){
   S.batch={projectId:id,...outcome};
   setKeywordFeedback('done',outcome.requested===0?'没有可扫描的已审核词。请先添加关键词并审核通过，再点击扫描。':`扫描请求已处理：${outcome.queued} 个排队中，${outcome.unchanged} 个无需重复，${outcome.failed.length} 个未排队。${outcome.failed.length?'请查看未排队原因。':'可在下方查看自动处理记录。'}`);
   message=`批次检查完成：${outcome.queued} 个已排队、${outcome.unchanged} 个无需重复、${outcome.failed.length} 个未排队。`;
  }else if(kind==='keywords'){
   const unchanged=outcome.disposition==='unchanged';
   setKeywordFeedback('done',unchanged?'这次 AI 请求已存在；请查看下方新词和自动处理记录。':'AI 建议已排队。完成后请在下方审核新词，再开始搜索。',outcome.id);
   if(unchanged)message='AI 请求没有重复入队；请查看已有建议和自动处理记录。';
  }
  S.writeBusy=false;
  await afterSave(message);
 }catch(e){
  if(kind==='keywords'||kind==='scan_all')setKeywordFeedback('error',`${kind==='keywords'?'AI 建议':'批量扫描'}未提交：${e.message}。请检查后重试。`);
  warn(e.message);
 }finally{S.writeBusy=false;}
}
const marketNames={US:'美国',GB:'英国',CA:'加拿大',AU:'澳大利亚',DE:'德国',FR:'法国',JP:'日本'};
const marketOptions=Object.fromEntries(Object.entries(marketNames).map(([code,name])=>[code,name+' · '+code]));
function marketHint(){return ['DE','FR','JP'].includes(S.project?.market)?'优先使用当地语言的常用搜索词；英文可作为补充入口。':'优先使用当地常用英文词；加拿大也可补充法语入口。';}
