export function selectMarkdownSource(nodes) {
  const textNodes = nodes.filter(node => node.type === 'text' && node.metadata?.content?.trim());
  if (!textNodes.length) return {error:'请先连接有内容的文本节点'};
  if (textNodes.length !== 1) return {error:'请只连接一条文本后再引用'};
  return {text:textNodes[0].metadata.content};
}
export function safeStickyColor(value) {
  return typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value) ? value : '#fde68a';
}
