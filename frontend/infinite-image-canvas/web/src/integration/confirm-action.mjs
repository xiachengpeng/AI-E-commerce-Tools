/** Ant Design modal works inside the sandboxed app iframe; native dialogs are blocked. */
export function confirmCanvasAction(modal,content) {
  return new Promise(resolve=>modal.confirm({title:'确认本次操作',content,okText:'确认',cancelText:'取消',onOk:()=>resolve(true),onCancel:()=>resolve(false)}));
}
