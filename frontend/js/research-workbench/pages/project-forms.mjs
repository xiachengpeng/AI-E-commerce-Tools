import { el, button, marketNames, typeNames } from '../components/elements.mjs';
import { fields, createForm } from '../components/forms.mjs';
import { submitCommand, submitMutation } from '../services/commands.mjs';
export const ruleNames={min_active_days:'首次投放距今最低天数',min_creatives:'最低独立活跃创意数',min_margin_percent:'最低订单贡献率（%）',min_aov:'最低客单价（USD）',max_aov:'最高客单价（USD）',max_weight_kg:'最高订单重量（kg）',max_direct_share_percent:'最高直接流量占比（%）',quote_valid_days:'报价有效天数',test_score:'测试候选最低分（/25）',backup_score:'备选最低分（/25）',scan_batch_limit:'单次批量扫描上限',daily_scan_budget:'每日扫描预算',max_depth:'扩词最大深度',expansion_limit:'每个来源最多扩词数',ai_daily_limit:'每日AI请求上限（含重试）'};
export function render(context, spec=context.state.form||{kind:'new_project'}) {
    const p=context.state.project,word=spec.keyword,product=spec.product,parent=spec.parent;
    let title,help,defs,initial={},action,payload=data=>data,projectId=p?.id;
    if(spec.kind==='new_project'){
        projectId=null;title='开始一项新研究';help='选择一个目标市场，广告和趋势都按该国家查询。已有项目的市场保持不变；研究另一个国家请新建项目。';
        defs=fields([['title','项目名称'],['direction','研究方向与目标','textarea'],['market','目标市场','select',true,Object.fromEntries(Object.entries(marketNames).map(([code,name])=>[code,name+' · '+code]))]]);
    }else if(['add_keyword','edit_keyword','new_search_entry'].includes(spec.kind)){
        action=spec.kind==='edit_keyword'?'edit_keyword':'add_keyword';title=word?'修改待审核关键词':parent?'从线索继续扩词':spec.kind==='new_search_entry'?'换一个搜索入口':'添加初始关键词';
        help=parent?'请选择当前商品的单一来源并粘贴原文引用。扩展词必须重新选择当前来源。':'先用常见入口词找广告：类目、功能、人群、痛点、场景都可以；如 pet、foldable、dog owners、road trip。品牌请输入真实名称。程序会自动补一对英文双引号，保存后需审核再搜索。';
        defs=fields([['text','广告搜索词'],['type','关键词类型','select',true,typeNames],['meaning','中文解释','text',false]]);initial=word||{type:spec.type||'pain'};
        if(parent){const sources=product?.expansion_sources||[];if(!sources.length)return el(context,'p','rw-muted','当前商品没有可用来源，需先补采证据再修改扩展词。');
            defs.push(...fields([['source_id','引用来源','select',true,Object.fromEntries(sources.map(s=>[s.source_id,`${s.source_kind==='landing'?'商品页':'广告 '+(s.ad_id||'')} · 身份版本 ${s.identity_revision}`]))],['source_quote','来源原文','textarea']]));
            payload=data=>({...data,source_kind:sources.find(s=>s.source_id===data.source_id)?.source_kind,...(word?{keyword_id:word.id}:{parent_id:parent.id,product_id:product.id})});
        }else if(word)payload=data=>({...data,keyword_id:word.id});
    }else if(spec.kind==='configure_rules'){
        title='项目规则与预算 · v'+p.rules_version;help='只影响本项目。保存后相关评分、决策与测试审批需重新核对；历史证据和真实测试记录保留。目标市场按项目固定，关键证据确认要求不能关闭。不自动开始研究。';action='configure_rules';
        defs=fields([...Object.entries(ruleNames).map(([key,label])=>[key,label,'number']),['reason','调整理由（保存到版本历史）','textarea']]);initial=p.rules||{};payload=({reason,...rules})=>({rules,reason});
    }else if(spec.kind==='configure_collection'){
        title='设置采集模式';help='各来源独立选择；失败不自动切换。已排队任务沿用原模式；修改模式后重新提交，会按当前模式创建新任务。';action='configure_collection';defs=fields([['meta','Meta 广告来源','select',true,{ui:'UI 自动化',api:'API（Apify）'}],['trends','Trends 来源','select',true,{ui:'UI 自动化',api:'API（SerpApi）'}]]);initial=p.collection_modes||{};
    }else if(spec.kind==='add_product'){
        title='添加具体产品';help='优先填写商品详情页。分类页或首页不代表一个具体产品，稍后仍需核实。';action='add_product';defs=fields([['name','产品名称'],['url','商品链接','url']]);
    }else if(spec.kind==='delete_project'){
        title='删除项目：'+p.title;help='将删除本工作台的项目、关键词、商品档案、任务和日志，无法在界面撤销。已同步的飞书记录、来源平台数据、存储附件及备份不会删除。请输入完整项目名称确认。';defs=fields([['title','输入项目名称：'+p.title]]);
    }else throw Error('未知研究表单');
    const key='rabbit-hole:draft:'+JSON.stringify([projectId||'new','',spec.kind,word?.id||parent?.id||'']);
    const form=createForm(context,{title,help,defs,initial,key,projectId,submit:async(data,draft,persist)=>{
        if(spec.kind==='delete_project'){
            await context.api.request('/projects/'+encodeURIComponent(p.id),{method:'DELETE',body:{version:draft.version,title:data.title},signal:context.life.signal});
            if(!context.life.active)return;context.state.projects=context.state.projects.filter(item=>item.id!==p.id);context.state.project=null;
        }else{
            const result=spec.kind==='new_project'?await submitMutation(context.api,'/projects',data,draft,persist):await submitCommand(context.api,{project_id:p.id,version:draft.version,action,payload:payload(data),draft},persist);
            if(!context.life.active)return;context.state.project=result;const index=context.state.projects.findIndex(item=>item.id===result.id);if(index<0)context.state.projects.push(result);else context.state.projects[index]=result;
        }
    }});
    if(spec.kind==='new_project')attachDirectionAssist(context,form);
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
    });form.append(assist,status,preview);
}
