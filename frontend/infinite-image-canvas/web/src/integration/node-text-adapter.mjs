/** Reserve all requests before dispatch, then recover by operation key without replay. */
export function createNodeTextAdapter({api,repository,confirm,newId=()=>crypto.randomUUID()}) {
  async function prepare({project,nodeId,prompt,retryPrompt=prompt,referenceKeys,count,providerId,model,reasoningEffort='auto'}) {
    if(!project?.id || !project.nodes?.some(n=>n.id===nodeId) || !prompt?.trim()) throw Error('请选择文本节点并填写生成要求');
    if(!Number.isInteger(count)||count<1||count>15) throw Error('生成次数无效');
    if(!providerId) throw Error('请先在系统设置中配置并选择文本渠道');
    const reference_ids=referenceKeys.map(key=>{const m=/^image:([A-Za-z0-9_-]{1,64}):((?:result-)?[a-f0-9]{32})$/.exec(key);if(!m||m[1]!==project.id)throw Error('参考图片不属于当前画布');return m[2]});
    const snapshot=structuredClone(project), saved=await repository.save(snapshot);
    const {provider}=await api.textPreflight(providerId,model);
    if(model && provider.model!==model) throw Error('渠道模型已变更，请重新选择');
    if(!await confirm({provider,count,referenceCount:reference_ids.length}))return null;
    const keys=Array.from({length:count},()=>newId()),node=snapshot.nodes.find(n=>n.id===nodeId);
    const node_context={batch_id:keys[0],node_id:nodeId,project_revision:saved.revision,node_revision:JSON.stringify(node),connections:snapshot.connections||[],selected_provider_id:provider.id,selected_model:provider.model,reasoning_effort:reasoningEffort,retry_prompt:retryPrompt};
    const requests=keys.map(operation_key=>({operation_key,prompt,reference_ids,expected_provider:provider,provider_id:provider.id,model:provider.model,node_context}));
    const reserved=[];
    try {for(const req of requests){const result=await api.reserveText(project.id,req);if(result.status!=='prepared')throw Error('任务状态异常，请核对任务记录');reserved.push(req)}}
    catch(error){for(const req of reserved)try{await api.cancelReservation(project.id,req.operation_key)}catch{}throw error}
    return {projectId:project.id,requests};
  }
  async function execute(run,index,signal) {
    const req=run.requests[index];let task;
    try {task=await api.submitText(run.projectId,req,signal)} catch(error){if(error.status>=400&&error.status<500)throw error;try{task=await api.status(run.projectId,req.operation_key)}catch{throw Error('生成结果不确定，请在任务记录中核对')}}
    if(task.status==='complete' && task.result_text)return task;
    if(task.status==='failed')throw Error(task.error_message || '文本任务失败，请检查服务配置后重试');
    throw Error(task.error_message || '服务商尚未返回最终结果，请在任务记录中核对');
  }
  return {prepare,execute};
}
