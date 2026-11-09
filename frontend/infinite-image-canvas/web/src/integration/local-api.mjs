/** Local backend only: all writes are single-attempt and never replayed. */
export function createNodeCanvasTransport(base, fetcher=fetch) {
  const endpoint=new URL(base);
  if (endpoint.protocol!=='http:' || !['127.0.0.1','localhost'].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.port!=='9503') throw Error('画布服务地址无效');
  const root=endpoint.origin+'/api/canvas';
  const segment=value=>encodeURIComponent(value);
  async function request(path,method='GET',body,signal) {
    const response=await fetcher(root+path,{method,...(signal?{signal}:{}),...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
    if (!response.ok) {let message='本地画布请求失败';try{const result=await response.json();if(typeof result.detail==='string')message=result.detail;}catch{}const error=Error(message);error.status=response.status;throw error;}
    return response.json();
  }
  return {
    providers:()=>request('/providers'),
    textProviders:()=>request('/text-providers'),
    textPreflight:(id,model=null)=>request('/text-preflight/'+segment(id),'POST',{model}),
    addTextModel:(id,model)=>request('/text-providers/'+segment(id)+'/models','POST',{model}),
    removeTextModel:(id,model)=>request('/text-providers/'+segment(id)+'/models/'+segment(model),'DELETE'),
    reserveText:(id,body)=>request('/projects/'+segment(id)+'/text-reservations','POST',body),
    submitText:(id,body,signal)=>request('/projects/'+segment(id)+'/text-tasks','POST',body,signal),
    addModel:(id,model)=>request('/providers/'+segment(id)+'/models','POST',{model}),
    removeModel:(id,model)=>request('/providers/'+segment(id)+'/models/'+segment(model),'DELETE'),
    list:()=>request('/projects?format=node-v1'),
    listArchived:()=>request('/projects?format=node-v1&archived=true'),
    get:id=>request('/projects/'+segment(id)),
    create:(id,title)=>request('/projects','POST',{project_id:id,title,format:'node-v1'}),
    archive:id=>request('/projects/'+segment(id)+'/archive','POST',{}),
    restore:id=>request('/projects/'+segment(id)+'/restore','POST',{}),
    save:(id,revision,document)=>request('/projects/'+segment(id),'PUT',{revision,document}),
    upload:(id,data,mime_type)=>request('/projects/'+segment(id)+'/assets','POST',{data,mime_type}),
    assetUrl:(id,asset)=>root+'/projects/'+segment(id)+'/assets/'+segment(asset),
    preflight:(operation,reference_count,has_mask,provider_id=null,model=null)=>request('/preflight','POST',{operation,reference_count,has_mask,provider_id,model}),
    reserve:(id,body)=>request('/projects/'+segment(id)+'/task-reservations','POST',body),
    cancelReservation:(id,key)=>request('/projects/'+segment(id)+'/task-reservations/'+segment(key)+'/cancel','POST',{}),
    submit:(id,body,signal)=>request('/projects/'+segment(id)+'/tasks','POST',body,signal),
    status:(id,key)=>request('/projects/'+segment(id)+'/tasks/by-operation/'+segment(key)),
    tasks:(id,offset=0)=>request('/projects/'+segment(id)+'/tasks?limit=50&offset='+encodeURIComponent(offset)),
    acknowledge:(id,key)=>request('/projects/'+segment(id)+'/tasks/by-operation/'+segment(key)+'/acknowledge','POST',{})
  };
}
