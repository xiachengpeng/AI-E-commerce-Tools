const stageNames={start:'开始执行',firecrawl_read:'Firecrawl 云端读取商品页',landing_read:'连接并读取商品页',landing_parsed:'解析完成，保存读取结果',submit:'提交云端任务',submitted:'云端任务已创建',poll:'查询云端状态',download:'读取接口结果',received:'保存采集结果',failed:'执行失败',complete:'完成',stopped:'停止',cloud_abort:'云端停止请求',validated:'校验结果'};
const stageLabel=stage=>stageNames[stage]||stage||'旧记录未保存阶段';
function actionKeyword(action){return action.keyword_text||S.project?.keywords.find(w=>w.id===action.keyword_id)?.text||action.label||action.kind||'未关联关键词';}

const $=id=>document.getElementById(id);
const S={token:'',projects:[],project:null,product:null,step:'identification',view:'projects',actions:[],keywordActions:{},verificationActions:{},productActions:{},landingModes:{},actionCursor:null,actionsLoading:false,actionsError:'',syncRuns:[],busy:false,form:null,feedback:'',batch:null,keywordFeedback:null,secondaryResearchOpen:false,optionalResearchOpen:false,nextFeedback:null,triageSession:{projectId:null,total:0,processed:0},queueLimits:{},researchReview:null,researchReviewId:null,researchReviewLoading:false,researchReviewError:''};
const labels={cloud_running:'Apify 云端运行中 / 等待结果',stopped:'已停止',retryable:'失败 · 可重试',manual_check:'需人工核对',pending:'未开始',needs_input:'待你补充',blocked:'等待来源',passed:'通过',failed:'不通过',not_applicable:'不适用',pending_review:'待审核',ready:'可开始',queued:'排队中',running:'处理中',complete:'已完成',succeeded:'已完成',archived:'不再采用',active:'当前轮次',stale:'已失效',superseded:'已取代',draft:'草稿',confirmed:'已确认',void:'已作废'};
const channels={meta:'Meta 广告',trends:'Google Trends',pinterest:'Pinterest',tiktok:'TikTok',amazon:'Amazon',similarweb:'Similarweb'};
const typeNames={category:'类目',function:'功能',audience:'人群',pain:'痛点',scenario:'场景 / 节日',brand:'品牌 / 产品',pain_scenario:'痛点 + 场景',scenario_audience:'场景 + 人群'};
const dimensionNames={demand_trend:'需求趋势',creative_space:'素材空间',profit_logistics:'利润与物流',competition:'竞争强度',compliance_risk:'合规风险'};
const gateNames={contribution_margin:'贡献毛利率',aov_range:'客单价范围',packed_weight:'订单重量',risk_level:'风险等级',trend_peak:'趋势见顶',similarweb_direct_share:'直接流量占比'};
const researchPhases=[
 {key:'identity',label:'识别商品',steps:['identification']},
 {key:'validation',label:'验证需求与竞争',steps:['coarse','expansion','channels','funnel']},
 {key:'decision',label:'成本评分与决策',steps:['economics','score','decision']},
 {key:'test',label:'测试与复盘',steps:['test','review']},
];
const stateTag=v=>el('span','tag '+v,labels[v]||v||'未开始');
const time=v=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'未记录';
const adAgeDays=identity=>identity.ad_age_days??(identity.active_days>0?identity.active_days:null);
const adAgeLabel=identity=>adAgeDays(identity)===null?'未知':`${adAgeDays(identity)} 天`;
const text=v=>typeof v==='object'?JSON.stringify(v,null,2):String(v??'未记录');
