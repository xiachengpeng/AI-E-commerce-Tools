// IDs only cross the frame boundary. Facts are re-read by the main backend.
(() => {
  if (location.pathname !== '/marketing-workbench' || parent === window) return;
  const origins = new Set(['http://127.0.0.1:9502','http://localhost:9502','http://127.0.0.1:9503','http://localhost:9503']);
  let parentOrigin = null;
  const button = document.createElement('button');
  button.textContent = '将当前商品交接到营销工具';
  button.disabled = true;
  document.querySelector('.header-actions').append(button);
  window.addEventListener('message', event => {
    if (event.source !== parent || !origins.has(event.origin) || event.data?.type !== 'marketing:hello' || event.data?.version !== 1) return;
    parentOrigin = event.origin;
    parent.postMessage({type:'research:ready',version:1},parentOrigin);
  });
  button.onclick = () => {
    const product = S.project?.products?.find(p => p.id === S.product);
    if (!parentOrigin || !product || product.merged_into) return;
    parent.postMessage({type:'research:select',version:1,project_id:S.project.id,product_id:product.id,
      source_version:S.project.version,identity_revision:product.identity_revision || 1,market:S.project.market},parentOrigin);
  };
  setInterval(() => { button.disabled = !parentOrigin || !S.product || !S.project; },500);
})();
