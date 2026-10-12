/** Small test-only DOM surface; browser acceptance uses Chromium. */
export function fixtureRoot() {
 const doc={activeElement:null};
 class Node extends EventTarget {
  constructor(tag='div'){super();this.tagName=tag.toUpperCase();this.dataset={};this.children=[];this.attributes={};this.className='';this.textContent='';this.ownerDocument=doc;this.value='';this.disabled=false;this.elements={namedItem:key=>this.find(n=>n.name===key)};}
  append(...nodes){for(const n of nodes){n.parentElement=this;this.children.push(n);}}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  setAttribute(k,v){this.attributes[k]=v;if(k.startsWith('data-'))this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=v;}
  hasAttribute(k){return k in this.attributes;}
  find(fn){for(const n of this.children){if(fn(n))return n;const found=n.find?.(fn);if(found)return found;}return null;}
  querySelector(selector){if(selector.startsWith('[data-')){const key=selector.match(/\[data-([^\]]+)\]/)[1].replace(/-([a-z])/g,(_,c)=>c.toUpperCase());return this.find(n=>key in n.dataset);}return this.find(n=>n.tagName===selector.toUpperCase());}
  focus(){doc.activeElement=this;}
  click(){this.dispatchEvent(new Event('click'));}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this);}
  set innerHTML(value){this.replaceChildren();if(value.includes('data-rw-status')){for(const key of ['rwStatus','rwProjects','rwPage']){const node=new Node('div');node.dataset[key]='';this.append(node);}}}
 }
 doc.createElement=tag=>new Node(tag);const root=new Node();return root;
}
