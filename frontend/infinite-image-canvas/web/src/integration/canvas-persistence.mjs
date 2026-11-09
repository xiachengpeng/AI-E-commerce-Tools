/** Adapt the upstream canvas store to project-bound durable storage. */
export function createCanvasPersistence(repository) {
  const snapshots=new Map(), listeners=new Set(), archived=new Set(), errors=new Map(), failedArchives=new Set();
  let pending=0, loading=false;
  let state={kind:'idle',projectId:null,message:''};
  const update=()=>{
    const first=errors.entries().next();
    state=!first.done ? {kind:'error',projectId:first.value[0],message:first.value[1]} :
      loading ? {kind:'loading',projectId:null,message:''} : pending ? {kind:'saving',projectId:null,message:''} : {kind:'saved',projectId:null,message:''};
    for(const listener of listeners)listener(state);
  };
  async function track(id,job) {
    pending++;update();
    try{return await job();} catch(error){errors.set(id,error.message);throw error;} finally{pending--;update();}
  }
  async function getItem(_name) {
    loading=true;update();
    try {
      const projects=await repository.load();
      for(const p of projects)snapshots.set(p.id,JSON.stringify(p));
      return {state:{projects,deletedProjects:[]},version:0};
    } catch(error) {errors.set(null,error.message);throw error;} finally {loading=false;update();}
  }
  async function setItem(_name,value) {
    const projects=value?.state?.projects;
    if (!Array.isArray(projects)) throw Error('画布资料无效');
    const jobs=[];
    for (const project of projects) {
      const encoded=JSON.stringify(project);
      if (snapshots.get(project.id)===encoded) continue;
      snapshots.set(project.id,encoded);
      jobs.push(track(project.id,()=>repository.save(project)));
    }
    for (const item of value.state.deletedProjects || []) {
      if (!item?.id || archived.has(item.id) || !snapshots.has(item.id)) continue;
      archived.add(item.id);
      jobs.push(track(item.id,()=>repository.archive(item.id).then(()=>snapshots.delete(item.id)).catch(error=>{failedArchives.add(item.id);throw error;})));
    }
    if (jobs.length) await Promise.all(jobs);
  }
  async function retry(projectId) {
    // Only an explicit retry may clear an error, and only after it succeeds.
    return track(projectId,async()=>{
      if (failedArchives.has(projectId)) {
        if (repository.getError(projectId)) await repository.retry(projectId);
        await repository.archive(projectId);failedArchives.delete(projectId);snapshots.delete(projectId);
      } else await repository.retry(projectId);
      errors.delete(projectId);
    });
  }
  return {getItem,setItem,removeItem:async(_name)=>{throw Error('请通过画布管理界面处理项目');},retry,status:()=>({...state}),subscribe:fn=>{listeners.add(fn);return()=>{listeners.delete(fn);};}};
}
