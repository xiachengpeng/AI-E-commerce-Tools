/** Project identity is captured before any asynchronous work starts. */
export function createNodeAssetRepository(api,getProjectId,ensureProject) {
  function parse(storageKey) {
    const match=/^image:([A-Za-z0-9_-]{1,64}):((?:result-)?[a-f0-9]{32})$/.exec(storageKey || '');
    if (!match) throw Error('图片引用无效');
    return {projectId:match[1],assetId:match[2]};
  }
  async function upload(data,mime,ownerId=getProjectId()) {
    const projectId=ownerId;if(!projectId)throw Error('未选择画布');
    await ensureProject(projectId);
    const asset=await api.upload(projectId,data,mime);
    return {...asset,storageKey:`image:${projectId}:${asset.id}`};
  }
  function url(storageKey){const item=parse(storageKey);return api.assetUrl(item.projectId,item.assetId);}
  return {upload,url,parse};
}

/** Copy an asset into the current project before creating a reference to it. */
export async function prepareCanvasAsset(image,projectId,getBlob,upload,resolveUrl) {
  if (!image.storageKey) return upload(image.dataUrl);
  if (image.storageKey.startsWith(`image:${projectId}:`)) {
    const url=resolveUrl ? await resolveUrl(image.storageKey,image.dataUrl) : image.dataUrl;
    if(!url) throw Error('素材原图不可读取');
    return {url,storageKey:image.storageKey,width:1,height:1,bytes:0,mimeType:'image/png'};
  }
  const blob=await getBlob(image.storageKey);
  if (!blob) throw Error('素材原图不可读取');
  return upload(blob);
}
