import { el } from './elements.mjs';
export function renderEvents(context){const host=el(context,'details');host.append(el(context,'summary','','操作与版本历史'));for(const event of [...(context.state.project.events||[])].reverse().slice(0,20))host.append(el(context,'p','rw-muted',`${event.created_at||event.at||'时间未记录'} · ${event.action||event.type||'更新'} · ${event.actor||'本机用户'}`));return host;}
