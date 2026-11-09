/** Restore exported image references under a newly created project. */
export function rewriteImportedProject(project,newId,mapping) {
  if (!project || typeof project!=='object' || !Array.isArray(project.nodes) || !Array.isArray(project.connections)) throw Error('画布文件无效');
  if (project.nodes.some(node=>['video','audio'].includes(node.type))) throw Error('此版本仅支持导入图片画布');
  function visit(value) {
    if (typeof value==='string' && value.startsWith('image:')) {
      const item=mapping.get(value);if(!item)throw Error('画布文件缺少图片');return item.storageKey;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value!=='object') return value;
    const result={};
    for(const [key,child] of Object.entries(value)) if(key!=='nodeCanvasTaskId') result[key]=visit(child);
    if (typeof value.storageKey==='string' && value.storageKey.startsWith('image:')) {
      const item=mapping.get(value.storageKey);if(!item)throw Error('画布文件缺少图片');
      if ('content' in value) result.content=item.url;
      if ('dataUrl' in value) result.dataUrl=item.url;
    }
    return result;
  }
  return {...visit(project),id:newId};
}

export async function blobToBase64(blob) {
  const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';
  for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
  return btoa(binary);
}
