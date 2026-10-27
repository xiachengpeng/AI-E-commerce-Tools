import { el, button, marketNames, typeNames } from '../components/elements.mjs';
import { fields, createForm } from '../components/forms.mjs';
import { submitCommand, submitMutation } from '../services/commands.mjs';
import {frameProductForm,icon} from '../components/presentation.mjs';
export const ruleNames={min_active_days:'首次投放距今最低天数',min_creatives:'最低独立活跃创意数',min_margin_percent:'最低订单贡献率（%）',min_aov:'最低客单价（USD）',max_aov:'最高客单价（USD）',max_weight_kg:'最高订单重量（kg）',max_direct_share_percent:'最高直接流量占比（%）',quote_valid_days:'报价有效天数',test_score:'测试候选最低分（/25）',backup_score:'备选最低分（/25）',scan_batch_limit:'单次批量扫描上限',daily_scan_budget:'每日扫描预算',max_depth:'扩词最大深度',expansion_limit:'每个来源最多扩词数',ai_daily_limit:'每日AI请求上限（含重试）'};
export function render(context, spec=context.state.form||{kind:'new_project'}) {
    const p=context.state.project,word=spec.keyword,product=spec.product,parent=spec.parent;
    let title,help,defs,initial={},action,payload=data=>data,projectId=p?.id;
    if(spec.kind==='new_project'){
        projectId=null;title='开始一项新研究';help='先确定卖给哪个国家、想研究什么。例如：面向美国 DIY 车主，寻找火花塞间隙工具的零售机会。已有商品也可先写名称，创建后添加商品链接。广告和趋势按目标市场查询；研究其他国家请新建项目。';
        defs=fields([['title','项目名称'],['direction','研究方向与目标','textarea'],['market','目标市场','select',true,Object.fromEntries(Object.entries(marketNames).map(([code,name])=>[code,name+' · '+code]))]]);
    }else if(['add_keyword','edit_keyword','new_search_entry'].includes(spec.kind)){
        action=spec.kind==='edit_keyword'?'edit_keyword':'add_keyword';title=word?'修改待审核关键词':parent?'从线索继续扩词':spec.kind==='new_search_entry'?'换一个搜索入口':'添加初始关键词';
        help=parent?'请选择当前商品的单一来源并粘贴原文引用。扩展词必须重新选择当前来源。':'先用常见入口词找广告：类目、功能、人群、痛点、场景都可以；如 pet、foldable、dog owners、road trip。品牌请输入真实名称。程序会自动补一对英文双引号，保存后需审核再搜索。';
        defs=fields([['text','广告搜索词'],['type','关键词类型','select',true,typeNames],['meaning','中文解释','text',false]]);initial=word||{type:spec.type||(parent?'pain':'category')};
        if(parent){const sources=product?.expansion_sources||[];if(!sources.length)return el(context,'p','rw-muted','当前商品没有可用来源，需先补采证据再修改扩展词。');
            defs.push(...fields([['source_id','引用来源','select',true,Object.fromEntries(sources.map(s=>[s.source_id,`${s.source_kind==='landing'?'商品页':'广告 '+(s.ad_id||'')} · 身份版本 ${s.identity_revision}`]))],['source_quote','来源原文','textarea']]));
            payload=data=>({...data,source_kind:sources.find(s=>s.source_id===data.source_id)?.source_kind,...(word?{keyword_id:word.id}:{parent_id:parent.id,product_id:product.id})});
        }else if(word)payload=data=>({...data,keyword_id:word.id});
    }else if(spec.kind==='configure_rules'){
        title='项目规则与预算 · v'+p.rules_version;help='只影响本项目。保存后相关评分、决策与测试审批需重新核对；历史证据和真实测试记录保留。目标市场按项目固定，关键证据确认要求不能关闭。不自动开始研究。';action='configure_rules';
        defs=fields([...Object.entries(ruleNames).map(([key,label])=>[key,label,'number']),['reason','调整理由（保存到版本历史）','textarea']]);initial=p.rules||{};payload=({reason,...rules})=>({rules,reason});for(const def of defs){def.group=['min_active_days','min_creatives'].includes(def.key)?'选品标准 · 广告初筛':['min_margin_percent','min_aov','max_aov','max_weight_kg'].includes(def.key)?'选品标准 · 利润与风险':['test_score','backup_score','quote_valid_days'].includes(def.key)?'选品标准 · 评分与时效':def.key==='max_direct_share_percent'?'选品标准 · 更多规则':/scan|budget/.test(def.key)?'采集与预算':/depth|expansion|ai_/.test(def.key)?'扩词与 AI 上限':'选品标准 · 调整理由';}
    }else if(spec.kind==='configure_collection'){
        title='设置采集模式';help='各来源独立选择；失败不自动切换。已排队任务沿用原模式；修改模式后重新提交，会按当前模式创建新任务。';action='configure_collection';defs=fields([['meta','Meta 广告来源','select',true,{ui:'UI 自动化',api:'API（Apify）'}],['trends','Trends 来源','select',true,{ui:'UI 自动化',api:'API（SerpApi）'}]]);initial=p.collection_modes||{};
    }else if(spec.kind==='add_product'){
        title='添加具体产品';help='优先填写商品详情页。分类页或首页不代表一个具体产品，稍后仍需核实。';action='add_product';defs=fields([['name','产品名称'],['url','商品链接','url']]);
    }else if(spec.kind==='delete_project'){
        title='删除项目：'+p.title;help='将删除本工作台的项目、关键词、商品档案、任务和日志，无法在界面撤销。已同步的飞书记录、来源平台数据、存储附件及备份不会删除。请输入完整项目名称确认。';defs=fields([['title','输入项目名称：'+p.title]]);
    }else throw Error('未知研究表单');
    if(context.designDirectForms&&!parent&&['add_keyword','edit_keyword','new_search_entry'].includes(spec.kind)){const meaning=defs.find(d=>d.key==='meaning');if(meaning)meaning.type='textarea';}
    const key='rabbit-hole:draft:'+JSON.stringify([projectId||'new','',spec.kind,word?.id||parent?.id||'']);
    const form=createForm(context,{title,help,defs,initial,key,projectId,returnView:spec.returnView,onCancel:spec.onCancel,onDiscard:spec.returnView?()=>context.navigate(spec.returnView):undefined,submit:async(data,draft,persist)=>{
        if(spec.kind==='delete_project'){
            await context.api.request('/projects/'+encodeURIComponent(p.id),{method:'DELETE',body:{version:draft.version,title:data.title},signal:context.life.signal});
            if(!context.life.active)return;context.state.projects=context.state.projects.filter(item=>item.id!==p.id);context.state.project=null;
        }else{
            const result=spec.kind==='new_project'?await submitMutation(context.api,'/projects',data,draft,persist):await submitCommand(context.api,{project_id:p.id,version:draft.version,action,payload:payload(data),draft},persist);
            if(!context.life.active)return;context.state.project=result;const index=context.state.projects.findIndex(item=>item.id===result.id);if(index<0)context.state.projects.push(result);else context.state.projects[index]=result;
        }
    }});
    if(spec.kind==='new_project'){attachDirectionAssist(context,form);styleNewResearch(context,form);}
    if(['add_keyword','edit_keyword','new_search_entry'].includes(spec.kind)&&!parent&&form.host.querySelectorAll){
      const hints={text:'输入英文搜索词，程序会自动补充英文双引号。',type:'选择最符合的类型，便于后续分析。',meaning:'简要说明该搜索词的含义，便于理解。'};
      for(const [key,hint] of Object.entries(hints)){const input=form.inputs.get(key);if(input)input.parentElement.append(el(context,'small','rw-keyword-field-help',hint));}
      const text=form.inputs.get('text'),meaning=form.inputs.get('meaning');if(text)text.placeholder='例如：spark plug gap tool';if(meaning)meaning.placeholder='例如：用于检测和调整火花塞间隙的工具';
      if(!word)form.form.querySelector('button[type=submit]')?.replaceChildren(el(context,'span','','保存为待审核'));
    }

    if(spec.kind==='configure_rules'&&form.host.querySelectorAll){for(const [group,number,title] of [['选品标准 · 广告初筛',1,'广告粗筛'],['选品标准 · 利润与风险',2,'利润与流量'],['选品标准 · 评分与时效',3,'决策阈值']]){const legend=form.host.querySelector('[data-form-group=\"'+group+'\"]>legend');if(legend)legend.replaceChildren(el(context,'span','rw-rule-section-number',number),el(context,'span','',title));}form.form.querySelector('button[type=submit]')?.replaceChildren(el(context,'span','','保存规则变更'));form.host.querySelector('h1').textContent='项目规则、预算与采集方式';const aside=form.host.querySelector('.rw-form-assistance');aside.replaceChildren(el(context,'h2','','规则变更影响'));for(const [symbol,label,note] of [['shield-check','证据确认要求保留','保存规则不会代替人工核实来源，也不会自动通过评分。'],['arrows-clockwise','评分与决定需要重新核对','资料、时效与门槛变化后，旧判断保留供参考。'],['archive','历史数据完整保留','已有证据、真实测试与审计记录不会因调整规则被删除。']]){const row=el(context,'div','rw-rule-impact');row.append(icon(context,symbol),el(context,'strong','',label),el(context,'p','rw-muted',note));aside.append(row);}aside.append(el(context,'h3','','当前保存的采集方式'));for(const [key,label] of [['meta','Meta 广告'],['trends','Google Trends']])aside.append(el(context,'p','rw-muted',label+' · '+(p.collection_modes?.[key]==='api'?'API 服务':p.collection_modes?.[key]==='ui'?'UI 自动化':'未记录，请核对项目配置')));aside.append(button(context,'调整采集方式',()=>context.openForm({kind:'configure_collection'})));}
    if(spec.kind==='configure_rules'&&form.host.querySelectorAll){
      const profit=form.host.querySelector('[data-form-group="选品标准 · 利润与风险"]'),score=form.host.querySelector('[data-form-group="选品标准 · 评分与时效"]'),more=form.host.querySelector('[data-form-group="选品标准 · 更多规则"]');
      if(profit){const range=el(context,'div','rw-rule-aov-range');range.append(el(context,'span','rw-rule-range-title','客单价范围（USD）'));for(const [key,label] of [['min_aov','最低'],['max_aov','最高']]){const input=form.inputs.get(key),wrap=input.parentElement;wrap.replaceChildren(el(context,'span','',label),input);range.append(wrap);}const weight=form.inputs.get('max_weight_kg')?.parentElement;if(weight)weight.before(range);else profit.append(range);}
      if(score)for(const key of ['test_score','backup_score','quote_valid_days'])score.append(form.inputs.get(key).parentElement);
      if(more){const disclosure=el(context,'details','rw-rule-more');disclosure.append(el(context,'summary','','展开更多规则'));more.before(disclosure);disclosure.append(more);if(score)score.after(disclosure);}
      for(const [key,note] of Object.entries({min_active_days:'单位：天',min_creatives:'单位：个',min_margin_percent:'单位：%',max_weight_kg:'单位：kg',test_score:'满分25分',backup_score:'满分25分',quote_valid_days:'单位：天'}))form.inputs.get(key)?.parentElement.append(el(context,'small','rw-rule-unit-help',note));
      const range=profit?.querySelector('.rw-rule-aov-range');if(range)range.append(el(context,'small','rw-rule-unit-help rw-rule-range-unit','最低与最高值均按 USD 填写'));
      const aside=form.host.querySelector('.rw-form-assistance'),impact=el(context,'div','rw-rule-impact');impact.append(icon(context,'target'),el(context,'strong','','仅影响本项目'),el(context,'p','rw-muted','本次修改只对“'+p.title+'”生效，不影响其他项目。'));aside.querySelector('h2')?.after(impact);
    }
    if(spec.kind==='configure_collection')form.host.append(button(context,'返回项目规则',()=>context.openForm({kind:'configure_rules'})));

    if(parent&&product&&form.host.querySelectorAll){
        form.host.classList.add('rw-expansion-editor');
        frameProductForm(context,product,form.host,title);
        const aside=form.host.querySelector('.rw-form-assistance'),sourceInput=form.inputs.get('source_id'),right=el(context,'section','rw-expansion-writing');form.form.before(right);right.append(form.form);
        const saved=p.keywords.filter(k=>k.product_id===product.id),savedCard=el(context,'section','rw-expansion-saved');savedCard.append(el(context,'h2','','可用的新词（'+saved.length+'）'));if(saved.length){const table=el(context,'table','rw-table'),head=el(context,'tr');for(const label of ['新词','类型','中文解释','状态'])head.append(el(context,'th','',label));table.append(head);for(const word of saved){const row=el(context,'tr');for(const value of [word.text,typeNames[word.type]||word.type||'未记录',word.meaning||'未填写',word.approved?'已审核':'待审核'])row.append(el(context,'td','',value));table.append(row);}savedCard.append(table);}else savedCard.append(el(context,'p','rw-muted','还没有从当前商品保存新词。'));right.insertBefore(savedCard,right.firstChild);
        const showSource=()=>{const source=product.expansion_sources.find(s=>s.source_id===sourceInput.value);aside.replaceChildren(el(context,'h2','','原文来源'),el(context,'p','rw-muted','请从这份原文选取真实片段；切换来源不会自动改写引用或搜索词。'),el(context,'blockquote','rw-source-reading',source?.text||'当前来源原文待补充'),el(context,'p','rw-muted','来源只用于理解和引用；广告观察不能代替商品、需求或盈利确认。'));};
        context.life.listen(sourceInput,'change',showSource);showSource();
    }
    return form.host;
}
export function attachDirectionAssist(context, {form,inputs,persist}) {
    const title=inputs.get('title'),market=inputs.get('market'),direction=inputs.get('direction');
    const status=el(context,'p','rw-muted'),preview=el(context,'div','rw-panel');status.setAttribute('role','status');status.setAttribute('aria-live','polite');preview.hidden=true;
    const use=value=>{direction.value=value;persist();preview.hidden=true;status.textContent='已填写研究目标，可继续修改后保存。';direction.focus();};
    const assist=button(context,'AI 帮写',async()=>{
        const requestedTitle=title.value.trim(),requestedMarket=market.value,original=direction.value;
        preview.hidden=true;if(!requestedTitle){status.textContent='请先填写项目名称，再点击 AI 帮写。';title.focus();return;}
        if(requestedTitle.length>200){status.textContent='项目名称最多200字，请缩短后再帮写。';return;}
        status.textContent='正在根据项目名称和目标市场生成研究目标…';
        try{const result=await context.api.request('/project-direction',{method:'POST',body:{title:requestedTitle,market:requestedMarket},signal:context.life.signal});
            if(!context.life.active)return;if(title.value.trim()!==requestedTitle||market.value!==requestedMarket){status.textContent='项目名称或市场已改变，请重新点击 AI 帮写。';return;}
            if(typeof result.direction!=='string'||!result.direction.trim()||result.direction.length>1000)throw Error('AI 未返回有效的研究目标，请重试。');
            const draft=result.direction.trim();if(!original.trim()&&!direction.value.trim())use(draft);
            else{preview.replaceChildren(el(context,'b','','AI 建议草稿'),el(context,'p','',draft),button(context,'使用这段建议',()=>{
                if(title.value.trim()!==requestedTitle||market.value!==requestedMarket){status.textContent='项目名称或市场已改变，请重新帮写。';preview.hidden=true;return;}use(draft);
            }));preview.hidden=false;status.textContent='已生成建议，原内容保留。可选择使用这段建议。';}
        }catch(error){if(context.life.active)status.textContent='AI 帮写失败：'+error.message;}
    });assist.textContent='辅助梳理方向';assist.setAttribute('aria-label','AI 帮写');const helper=el(context,'div','rw-direction-assist');const copy=el(context,'div');copy.append(el(context,'strong','','需要梳理思路？'),el(context,'p','rw-muted','帮你整理目标人群、使用场景和关键词，明确研究方向。'));helper.append(icon(context,'lightbulb'),copy,assist);form.querySelector('.rw-form-footer')?.before(helper);form.append(status,preview);
}

/** Reorganize the existing creation controls; no extra fields enter its command. */
function styleNewResearch(context,editor){
 const {host,form,inputs}=editor;if(!host.querySelectorAll)return;
 host.classList.add('rw-new-research');host.querySelector('h1').nextElementSibling.textContent='先确定卖给谁，再寻找值得测试的商品。';
 const title=inputs.get('title'),market=inputs.get('market'),direction=inputs.get('direction');
 const marketHint=el(context,'small','rw-market-help','每个项目仅支持一个目标市场。如需更换国家，请创建新的研究项目。');market.parentElement.append(marketHint);
 const directionGroup=el(context,'fieldset','rw-new-direction'),legend=el(context,'legend','','研究方向与目标'),choices=el(context,'div','rw-start-mode-choices');directionGroup.append(legend,choices);
 const old=direction.parentElement;old.before(directionGroup);directionGroup.append(direction);old.remove();directionGroup.before(market.parentElement);
 for(const [value,label,note] of [['direction','我有研究方向','基于已有想法，寻找合适的商品'],['product','我已有商品','验证该商品的市场机会']]){
  const option=el(context,'label','rw-start-mode'),radio=el(context,'input'),copy=el(context,'span');radio.type='radio';radio.name='ui-research-start-mode';radio.value=value;radio.checked=(context.state.researchStartMode||'direction')===value;copy.append(el(context,'strong','',label),el(context,'small','rw-muted',note));option.append(radio,copy);choices.append(option);
  context.life.listen(radio,'change',()=>{if(radio.checked){context.state.researchStartMode=value;direction.placeholder=value==='product'?'描述你已有的商品和目标客户，创建后补充商品链接。':'描述目标人群、使用场景和研究方向。';}});
 }
 const footer=form.querySelector('.rw-form-footer'),draftNote=form.querySelector('[role=status]');if(draftNote){draftNote.classList.add('rw-new-draft-note');footer.append(draftNote);}footer.querySelector('button[type=submit]')?.replaceChildren(el(context,'span','','创建研究'),icon(context,'arrow-right'));
 const aside=host.querySelector('.rw-form-assistance');aside.replaceChildren(el(context,'h2','','你将得到什么'));
 for(const [number,symbol,label,copy] of [[1,'magnifying-glass','找到商品与广告来源','基于你的方向，发现有潜力的商品，并找到对应的广告素材来源。'],[2,'chart-bar','核实需求与真实成本','了解目标市场的真实需求，并核实商品的规格、成本与供应信息。'],[3,'file-text','保存选品结论','汇总研究结果，形成可执行的选品结论，方便后续参考。']]){const row=el(context,'div','rw-research-benefit'),body=el(context,'div');body.append(el(context,'h3','',label),el(context,'p','',copy));row.append(el(context,'span','rw-benefit-number',number),icon(context,symbol),body);aside.append(row);}
 const caution=el(context,'div','rw-new-caution');caution.append(icon(context,'warning-circle'),el(context,'strong','','请注意'),el(context,'p','','创建研究后，仍需人工审核搜索词和商品信息，不会自动采集数据或自动投放广告。'));aside.append(caution);
}
