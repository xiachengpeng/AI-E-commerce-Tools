/** Keep SEO results attached to the exact image that was analyzed. */
export function selectSeoImage(nodes) {
  const images = nodes.filter(node => node.type === 'image');
  if (images.length > 1) return {error:'请只连接一张图片'};
  const image = images[0];
  if (!image?.metadata?.content || !image.metadata.storageKey) return {error:'请连接一张已保存的图片'};
  return {source:{id:image.id, storageKey:image.metadata.storageKey, url:image.metadata.content}};
}
export function sameSeoSource(source, nodes) {
  const current = selectSeoImage(nodes).source;
  return !!current && current.id === source.id && current.storageKey === source.storageKey;
}
export function makeSeoResult(source, result, lang) {
  if (!result?.title?.trim() || !result?.altText?.trim() || !result?.slug?.trim()) throw Error('AI 返回的 SEO 信息不完整，请重试。');
  return {sourceId:source.id, sourceKey:source.storageKey, title:result.title.trim(), altText:result.altText.trim(), slug:result.slug.trim(), lang, uploads:{}};
}
export function recordSeoUpload(seo, destination, url) {
  if (!destination?.storageType || !url) throw Error('上传结果不完整');
  return {...seo, uploads:{...seo.uploads, [`${destination.storageType}:${destination.configId || 'default'}`]:url}};
}
