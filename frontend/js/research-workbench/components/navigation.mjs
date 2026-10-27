import {el,button} from './elements.mjs';
/** Shared navigation stays in normal flow; only anchored menu panels float. */
export function renderWorkbenchNavigation(context){
 const {state,root,life}=context,list=root.querySelector('[data-rw-projects]'),menus=[];
 const back=button(context,'← 返回',()=>context.goBack(),'rw-back-button');back.setAttribute('aria-label','返回上一页');back.title='返回上一个研究页面；未保存内容按现有草稿规则保留';back.disabled=state.view==='projects'&&!state.navigationTrail?.length;
 const links=[['全部项目','projects'],['结论与复盘','reports'],['研究工具与日志','settings'],['研究历史','history']].map(([label,view])=>{
  const b=button(context,label,()=>context.navigate(view),'rw-nav-link');b.dataset.rwView=view;b.setAttribute('aria-current',state.view===view?'page':'false');return b;
 });
 function menu(label,cls,nodes){
  const host=el(context,'details','rw-navigation-menu '+cls),summary=el(context,'summary','',label),panel=el(context,'div','rw-navigation-panel');
  panel.append(...nodes);host.append(summary,panel);menus.push(host);
  life.listen(host,'toggle',()=>{if(host.open)for(const other of menus)if(other!==host)other.open=false;});
  life.listen(host,'keydown',event=>{if(event.key==='Escape'){event.preventDefault();host.open=false;summary.focus();}});return host;
 }
 const projects=state.projects.map(project=>{const b=button(context,project.title||'未命名项目',()=>context.openProject(project.id),'rw-nav-project');b.dataset.rwProject=project.id;if(state.project?.id===project.id)b.setAttribute('aria-current','page');return b;});
 const chooser=menu(state.project?'项目：'+state.project.title:'选择研究项目','rw-project-chooser',[...projects,button(context,'＋ 新建研究',()=>context.openForm({kind:'new_project'}),'rw-nav-create')]);
 list.replaceChildren(back,...links);
 if(state.project){
  const section=(label,value)=>button(context,label,()=>{state.projectSection=value;context.navigate('project');});
  list.append(menu('项目工具','rw-project-tools',[
   section('搜索词','keywords'),section('线索与素材','leads'),button(context,'选品队列',()=>{state.product=null;context.navigate('triage');}),
   button(context,'研究任务',()=>context.navigate('actions')),button(context,'关键词路径',()=>context.navigate('paths')),
   button(context,'项目规则与预算',()=>context.openForm({kind:'configure_rules'})),button(context,'设置采集模式',()=>context.openForm({kind:'configure_collection'})),button(context,'飞书同步与状态',()=>context.navigate('sync'))
  ]));
 }
 list.append(chooser);root.dataset.compactNavigation=String(state.view!=='projects');
 const crumb=root.querySelector('[data-rw-breadcrumb]');if(crumb){crumb.textContent='选品研究'+(state.project?' / '+state.project.title:'');crumb.title=crumb.textContent;}
 const doc=root.ownerDocument;
 if(doc.addEventListener)life.listen(doc,'click',event=>{for(const host of menus)if(host.open&&!host.contains(event.target))host.open=false;});
}
