/** Changes to the source or its inbound links require manual recovery. */
export function canAttachNodeResults(run, projectId, nodes, connections) {
  if (!run?.sourceNode || projectId!==run.projectId) return false;
  if (run.allNodes && JSON.stringify(nodes)!==JSON.stringify(run.allNodes)) return false;
  if (run.allNodes && JSON.stringify(connections)!==JSON.stringify(run.connections)) return false;
  const current=nodes.find(node=>node.id===run.sourceNode.id);
  if (!current || JSON.stringify(current)!==JSON.stringify(run.sourceNode)) return false;
  for (const original of run.referenceNodes || []) {
    const reference=nodes.find(node=>node.id===original.id);
    if (!reference || JSON.stringify(reference)!==JSON.stringify(original)) return false;
  }
  const incoming=connections.filter(link=>link.toNodeId===run.sourceNode.id);
  const original=run.connections.filter(link=>link.toNodeId===run.sourceNode.id);
  return JSON.stringify(incoming)===JSON.stringify(original);
}

/** Match upstream: an empty image node becomes the result; a populated one branches. */
export function groupCanvasResults(source,projectId,results,prompt) {
  if (!results.length) throw Error('没有可用的图片结果');
  const images=results.map(({dataUrl,task,meta})=>({id:task.id,nodeCanvasTaskId:task.id,status:'success',content:dataUrl,storageKey:`image:${projectId}:${task.result_asset_id}`,naturalWidth:meta?.width||0,naturalHeight:meta?.height||0,bytes:0,mimeType:meta?.mimeType||'image/png'}));
  const first=images[0];
  return {reuse:source.type==='image' && !source.metadata?.content,metadata:{...source.metadata,prompt,status:'success',content:first.content,storageKey:first.storageKey,nodeCanvasTaskId:first.nodeCanvasTaskId,naturalWidth:first.naturalWidth,naturalHeight:first.naturalHeight,mimeType:first.mimeType,images,primaryImageId:first.id}};
}

/** Fit the image as the original canvas does, without shifting the node centre. */
export function fitImageNodeFrame(node, image, maxWidth, maxHeight) {
  if (![node?.width,node?.height,image?.width,image?.height,maxWidth,maxHeight].every(value=>Number.isFinite(value) && value>0)) return {position:node.position,width:node.width,height:node.height};
  const scale=Math.min(1,maxWidth/image.width,maxHeight/image.height);
  const width=image.width*scale,height=image.height*scale;
  return {width,height,position:{x:node.position.x+(node.width-width)/2,y:node.position.y+(node.height-height)/2}};
}

/** Repair the old generated-image default frame only, preserving manual sizing. */
export function repairGeneratedImageFrame(node,maxWidth,maxHeight) {
  const meta=node?.metadata || {};
  if(node?.type!=='image' || !meta.nodeCanvasTaskId || meta.freeResize || !meta.naturalWidth || !meta.naturalHeight) return node;
  if(node.width!==maxWidth || node.height!==maxHeight) return node;
  const nodeRatio=node.width/node.height, imageRatio=meta.naturalWidth/meta.naturalHeight;
  if(!Number.isFinite(nodeRatio) || !Number.isFinite(imageRatio) || Math.abs(nodeRatio-imageRatio)<0.001) return node;
  return {...node,...fitImageNodeFrame(node,{width:meta.naturalWidth,height:meta.naturalHeight},maxWidth,maxHeight)};
}
