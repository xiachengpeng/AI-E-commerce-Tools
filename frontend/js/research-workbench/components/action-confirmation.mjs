import {el,button,panel,marketNames,notify} from './elements.mjs';
import {createActionService,actionNames,actionStatus,actionResultSummary} from '../services/actions.mjs';
import {createLifecycle} from '../lifecycle.mjs';
import {scanCandidates} from '../services/journey.mjs';

export function renderActionConfirmation(context,selection,onSubmitted) {
 const {state}=context,project=state.project,word=project.keywords?.find(k=>k.id===selection.keyword_id),product=project.products?.find(p=>p.id===selection.product_id);
 const kinds={keywords:'AI 建议初始词',scan:'搜索这个词',scan_all:'扫描全部已审核词',expand:'提取下一层建议',landing:'读取商品页面',verify:'核对商品',trends:'采集 Trends'};
 const confirmedDirection=project.direction||'',confirmedVersion=project.version,confirmedProjectId=project.id;
 if(!kinds[selection.kind])return null;
 const service=createActionService(context),choice=panel(context,'确认本次研究操作',actionNames[selection.kind]);choice.dataset.actionConfirmation='true';
 choice.querySelector('h2').tabIndex=-1;
 choice.append(el(context,'p','',`目标市场：${marketNames[project.market]||project.market}（${project.market}） · ${project.title}`),el(context,'p','',word?'搜索词：'+word.text:product?'商品：'+product.name:'范围：当前研究项目'));
 if(word){const meaning=typeof word.meaning==='string'?word.meaning.trim():'';choice.append(el(context,'p','rw-keyword-meaning',meaning?'中文释义：'+meaning:'中文释义待补充，可在“找线索”中修改补充。'));}
 if(selection.kind==='keywords'){
  const scope=el(context,'section','rw-keyword-confirmation-scope');scope.append(el(context,'h3','','研究方向与目标'),el(context,'p','rw-keyword-confirmation-direction',confirmedDirection||'当前项目未记录研究方向，请先核对项目资料。'));choice.append(scope,el(context,'p','rw-muted','AI 将按以上方向生成当地常用搜索词；建议仍需你审核，不会自动开始采集。'));
 }
 const collectionSource=['scan','scan_all'].includes(selection.kind)?'meta':selection.kind==='trends'?'trends':null,collectionMode=collectionSource?(project.collection_modes?.[collectionSource]||'ui'):null;
 if(collectionSource)choice.append(el(context,'p','',`本次采集方式：${collectionMode==='api'?(collectionSource==='meta'?'API（Apify）':'API（SerpApi）')+' · 可能产生费用':'浏览器采集'}。已排队任务仍按原方式执行。`));
 const batch=selection.kind==='scan_all'?scanCandidates(project):null;
 if(batch)choice.append(el(context,'p','',batch.length?`本次将搜索 ${batch.length} 个词：${batch.map(w=>w.text).join('、')}。已完成、未审核或已归档词不会加入；按项目预算限制执行。`:'本次没有可执行的搜索词。先审核新词；已完成的词请使用“重新搜索并补充”。'));
 if(selection.rescan_of)choice.append(el(context,'p','rw-notice','这是一次新的公开广告搜索，保留上次结果并追加新发现；不保证找到同一商品的更多创意。请先核对页面上选择的采集方式与 API 配置，提交后不会自动更换账号或重复执行。'));
 if(['scan','scan_all'].includes(selection.kind))choice.append(el(context,'p','rw-muted','广告保存后将自动排队读取本批商品页的图片与信息，每词最多20个；使用本地读取，已有资料复用，失败不自动重试，不调用付费商品页接口或 AI。'));
 if(selection.kind==='verify')choice.append(el(context,'p','','仅核对当前词的商品线索，每批最多20个；AI判断不会代替人工事实核实。'));
 choice.append(el(context,'p','rw-muted',['verify','expand','keywords'].includes(selection.kind)?'将调用已配置的 AI，可能产生费用。仅提交一次，结果不确定时先核对。':selection.kind==='scan'?'按当前采集模式和项目预算搜索公开广告，结果是限定样本，不代表全部市场。':'按当前来源与项目预算执行；不会自动发布或投放。'));
 if(selection.landing_mode)choice.append(el(context,'p','rw-muted',selection.landing_mode==='firecrawl'?'商品页通过 Firecrawl 读取，可能消耗账户额度。':'商品页在本机读取，不自动改用付费读取服务。'));
 let query;
 if(selection.kind==='trends'){
  const label=el(context,'label','','当地常用产品搜索词');query=el(context,'input');query.name='initial_trends_query';query.type='text';query.maxLength=200;query.required=true;query.setAttribute('aria-label','首次 Trends 查询词');query.value=selection.query||'';
  context.life.listen(query,'input',()=>{selection.query=query.value;});label.append(query);choice.append(label,el(context,'p','rw-muted','输入1到200字；商品名不会自动代填。'));
 }
 let submitted=false;
 const submit=button(context,'确认提交：'+kinds[selection.kind],async()=>{
  if(submitted)return;
  if(batch&&(!batch.length||state.project?.id!==confirmedProjectId||state.project.version!==confirmedVersion))throw Error('可执行词或项目资料已更新，请取消后重新核对本批范围。');
  if(selection.kind==='keywords'&&(state.project?.id!==confirmedProjectId||state.project.version!==confirmedVersion||(state.project.direction||'')!==confirmedDirection))throw Error('研究方向或项目资料已更新，请取消后重新确认本次操作。');
  if(collectionSource&&(state.project.collection_modes?.[collectionSource]||'ui')!==collectionMode)throw Error('采集方式已变化，请取消并重新打开确认窗口，核对方式后再提交。');const {action_id,...request}=selection;if(query)request.query=query.value.trim();
  context.onActionSubmitting?.(true);
  try{const outcome=await service.enqueue(request);if(!context.life.active)return;submitted=true;choice.replaceChildren(el(context,'p','','请求已保存，正在核对执行状态；不会重复提交。'));await onSubmitted(outcome);}
  finally{context.onActionSubmitting?.(false);}
 },'rw-primary');submit.disabled=!!batch&&!batch.length;choice.append(submit);
 return choice;
}

let dialogSequence=0;
/** Keep the live research page mounted; native modal behavior owns focus containment. */
export function createActionDialog(context,selection,{onSubmitted,onCancel}){
 const life=createLifecycle(),dialog=el(context,'dialog','rw-action-dialog'),trigger=context.root.ownerDocument.activeElement;
 dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');
 let submitting=false,closed=false;
 const cancel=button({...context,life},'取消本次操作',()=>{if(!submitting)onCancel();}),close=button({...context,life},'关闭确认窗口',()=>{if(!submitting)onCancel();},'rw-action-dialog-close');close.setAttribute('aria-label','关闭确认窗口');close.textContent='×';
 const status=el(context,'p','rw-action-dialog-status');status.dataset.rwStatus='';status.setAttribute('role','alert');
 const modalContext={...context,root:dialog,life,onActionSubmitting:busy=>{submitting=busy;cancel.disabled=busy;close.disabled=busy;dialog.setAttribute('aria-busy',String(busy));}};
 const choice=renderActionConfirmation(modalContext,selection,onSubmitted);
 if(!choice){life.dispose();return null;}
 const title=choice.querySelector('h2');title.id='rw-action-confirmation-'+(++dialogSequence);dialog.setAttribute('aria-labelledby',title.id);
 const controls=el(context,'div','rw-action-dialog-actions'),submit=choice.querySelector('button');submit.remove();controls.append(cancel,submit);choice.append(status,controls);dialog.append(close,choice);
 life.listen(dialog,'cancel',event=>{event.preventDefault();if(!submitting)onCancel();});
 const controller={dialog,needsPaint:false,close({restoreFocus=true}={}){if(closed)return;closed=true;life.dispose();if(dialog.open&&dialog.close)dialog.close();dialog.remove();if(restoreFocus&&trigger?.isConnected!==false)trigger?.focus?.({preventScroll:true});}};
 const detach=context.life.track(()=>controller.close({restoreFocus:false}));life.track(detach);
 context.root.append(dialog);if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');
 title.focus({preventScroll:true});return controller;
}

export function trackedActionFeedback(state) {
 const tracked=state.lastResearchAction;if(!tracked||tracked.projectId!==state.project?.id)return '';
 const action=(state.actions||[]).find(a=>a.id===tracked.id);
 if(!action)return '研究请求已保存，正在核对执行状态；不会自动重复提交。';
 const name=actionNames[action.kind]||'研究任务';
 return name+' · '+actionStatus(action)+(action.status==='complete'?'：'+actionResultSummary(action):['blocked','failed','stopped'].includes(action.status)?'；已保存资料保留，请查看任务原因与恢复入口。':'；可留在当前页等待结果。');
}

/** Keep keyword feedback at its work area; retain global feedback for other flows. */
export function publishTrackedActionFeedback(context){
 const {state}=context;context.keywordProgress?.update();
 const feedback=trackedActionFeedback(state);if(!feedback)return;
 const tracked=state.lastResearchAction,action=(state.actions||[]).find(a=>a.id===tracked?.id),kind=action?.kind||tracked?.kind;
 const local=state.view==='project'&&state.projectSection==='keywords'&&context.keywordProgress&&kind==='keywords';
 if(local){const status=context.root.querySelector('[data-rw-status]');if(status?.textContent===state.lastResearchFeedback)status.textContent='';}
 else if(feedback!==state.lastResearchFeedback||context.root.querySelector('[data-rw-status]')?.textContent!==feedback)notify(context,feedback);
 state.lastResearchFeedback=feedback;
}
