/** Prepare and reserve every charged operation before the UI changes. */
export function createNodeGenerationAdapter({api,repository,confirm,newId=()=>crypto.randomUUID()}) {
  /** @param {{project:any,nodeId:string,prompt:string,retryPrompt?:string,referenceKeys:string[],count:number,maskKey?:string|null,providerId?:number|null,model?:string|null,imageSettings?:{size:string,quality:string,background:string}|null}} input */
  async function prepare({project,nodeId,prompt,retryPrompt=prompt,referenceKeys,count,maskKey=null,providerId=null,model=null,imageSettings=null}) {
    if (!project?.id || !project.nodes?.some(node=>node.id===nodeId) || typeof prompt!=='string' || !prompt.trim()) throw Error('请选择有效节点并填写图片要求');
    if (!Number.isInteger(count) || count<1 || count>15) throw Error('生成数量无效');
    const references=referenceKeys.map(key=>{
      const match=/^image:([A-Za-z0-9_-]{1,64}):((?:result-)?[a-f0-9]{32})$/.exec(key);
      if (!match || match[1]!==project.id) throw Error('参考图片不属于当前画布');return match[2];
    });
    let maskId=null;
    if(maskKey){const match=/^image:([A-Za-z0-9_-]{1,64}):((?:result-)?[a-f0-9]{32})$/.exec(maskKey);if(!match||match[1]!==project.id)throw Error('遮罩不属于当前画布');maskId=match[2];}
    const snapshot=structuredClone(project), saved=await repository.save(snapshot);
    const operation=maskId?'edit':'generate';
    const check=await api.preflight(operation,references.length,Boolean(maskId),providerId,model);
    if (!check.supported) throw Error(check.reason || '当前图片服务不支持此操作');
    if (!await confirm({provider:check.provider,count,referenceCount:references.length,hasMask:Boolean(maskId)})) return null;
    const node=snapshot.nodes.find(node=>node.id===nodeId);
    const image_settings=imageSettings || {size:node.metadata?.size||'auto',quality:node.metadata?.quality||'auto',background:node.metadata?.background||''};
    const operationKeys=Array.from({length:count},()=>newId());
    const context={batch_id:operationKeys[0],node_id:nodeId,project_revision:saved.revision,node_revision:JSON.stringify(node),connections:snapshot.connections||[],selected_provider_id:check.provider.id,selected_model:check.provider.model,image_settings,retry_prompt:retryPrompt};
    const requests=operationKeys.map(operation_key=>({operation_key,operation,prompt,reference_ids:[...references],mask_id:maskId,expected_provider:check.provider,node_context:context,provider_id:providerId,model}));
    const reserved=[];
    try {
      for (const request of requests) {
        const result=await api.reserve(snapshot.id,request);
        if(result.status!=='prepared') throw Error('任务预留状态异常，请核对后再操作');
        reserved.push(request);
      }
    } catch(error) {
      for(const request of reserved) {try{await api.cancelReservation(snapshot.id,request.operation_key);}catch{}}
      throw error;
    }
    return {projectId:snapshot.id,nodeId,requests};
  }
  async function execute(run,index,signal) {
    const request=run?.requests?.[index];
    if (!request) throw Error('图片任务不存在');
    let task;
    try { task=await api.submit(run.projectId,request,signal); }
    catch(error) {
      if (error.status>=400 && error.status<500) throw error;
      try { task=await api.status(run.projectId,request.operation_key); }
      catch { throw Error('生成结果不确定，请核对任务记录后再操作'); }
    }
    if(task.status==='complete' && task.result_asset_id) return {dataUrl:api.assetUrl(run.projectId,task.result_asset_id),task};
    if(task.status==='failed') throw Error(task.error_message || '图片任务失败，请检查服务配置后重试');
    throw Error(task.error_message || '服务商尚未返回最终结果，请核对任务记录后再操作');
  }
  return {prepare,execute};
}
