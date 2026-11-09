/** Serialize project writes; keep the latest failed draft in memory. */
export function createNodeProjectRepository(api) {
  const entries=new Map();
  const clone=value=>structuredClone(value);
  function assetReferences(value, projectId) {
    const ids=new Set();
    function visit(item) {
      if (typeof item==='string' && item.startsWith('image:')) {
        const match=/^image:([A-Za-z0-9_-]{1,64}):((?:result-)?[a-f0-9]{32})$/.exec(item);
        if (!match || match[1]!==projectId) throw Error('图片引用不属于当前画布');
        ids.add(match[2]);return;
      }
      if (!item || typeof item!=='object') return;
      if (Array.isArray(item)) {item.forEach(visit);return;}
      for (const [key,child] of Object.entries(item)) {
        if (key==='storageKey' && typeof child==='string') {
          const match=/^image:([A-Za-z0-9_-]{1,64}):((?:result-)?[a-f0-9]{32})$/.exec(child);
          if (!match || match[1]!==projectId) throw Error('图片引用不属于当前画布');
          ids.add(match[2]);
        }
        else visit(child);
      }
    }
    visit(value);return [...ids].map(asset_id=>({asset_id}));
  }
  async function load() {
    const list=await api.list();const projects=[];
    for (const row of list.projects) {
      const saved=await api.get(row.id);
      if (saved.format!=='node-v1') throw Error('画布格式不匹配');
      entries.set(saved.id,{revision:saved.revision,tail:Promise.resolve(),error:null,unsaved:null});
      let document=saved.document;
      // A create may have committed just before the process stopped, before its first save.
      if (document && typeof document==='object' && !Array.isArray(document) && Object.keys(document).length===0) {
        const now=new Date().toISOString();
        document={id:saved.id,title:saved.title,createdAt:now,updatedAt:now,nodes:[],connections:[],chatSessions:[],activeChatId:null,backgroundMode:'lines',showImageInfo:false,viewport:{x:0,y:0,k:1}};
      }
      if (!document || document.id!==saved.id || !Array.isArray(document.nodes) || !Array.isArray(document.connections)) throw Error('画布资料不完整，请检查本地数据');
      projects.push(clone(document));
    }
    return projects;
  }
  function save(project) {
    if (!project || typeof project.id!=='string' || !project.id) return Promise.reject(Error('画布编号无效'));
    let entry=entries.get(project.id);
    if (!entry) {entry={revision:null,tail:Promise.resolve(),error:null,unsaved:null};entries.set(project.id,entry);}
    const snapshot=clone(project);entry.unsaved=snapshot;
    const job=entry.tail.then(async()=>{
      if (entry.error) throw entry.error;
      try {
        if (entry.revision===null) {
          const title=snapshot.title||'未命名画布';
          try {const created=await api.create(snapshot.id,title);entry.revision=created.revision;}
          catch (error) {
            // Creation might have committed before its response was lost. Accept only the exact untouched placeholder.
            let existing;try {existing=await api.get(snapshot.id);} catch {throw error;}
            if (existing.id!==snapshot.id || existing.format!=='node-v1' || existing.title!==title || existing.revision!==0 || existing.archived || !existing.document || Object.keys(existing.document).length!==0) throw error;
            entry.revision=0;
          }
        }
        const document={...snapshot,assets:assetReferences(snapshot,snapshot.id)};
        const saved=await api.save(snapshot.id,entry.revision,document);entry.revision=saved.revision;
        if (entry.unsaved===snapshot) entry.unsaved=null;
        return saved;
      } catch(error) {entry.error=error;throw error;}
    });
    entry.tail=job.catch(()=>{});return job;
  }
  async function retry(id) {
    const entry=entries.get(id);
    if (!entry?.unsaved) throw Error('没有待保存的草稿');
    await entry.tail;entry.error=null;return save(entry.unsaved);
  }
  async function archive(id) {
    const entry=entries.get(id);
    if (!entry) throw Error('画布不存在');
    await entry.tail;if(entry.error) throw entry.error;
    await api.archive(id);entries.delete(id);
  }
  async function ensure(project) {
    const entry=entries.get(project.id);
    if (!entry) return save(project);
    await entry.tail;if(entry.error) throw entry.error;
    if(entry.revision===null) return save(project);
  }
  return {load,save,retry,archive,ensure,revision:id=>entries.get(id)?.revision ?? null,getUnsaved:id=>entries.get(id)?.unsaved?clone(entries.get(id).unsaved):null,
    getError:id=>entries.get(id)?.error||null};
}
