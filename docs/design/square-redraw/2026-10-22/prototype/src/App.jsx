import React, { useEffect, useRef, useState } from 'react';

const designs = [
  { name: '双栏工作台', desc: '左侧设置，右侧处理；操作与结果各就各位。', tag: '推荐' },
  { name: '视觉素材台', desc: '图片放在第一位，适合逐张检查处理结果。' },
  { name: '轻量步骤流', desc: '上传、选比例、开始处理，第一次使用也容易理解。' },
];
const ratios = [ ['1:1','方形主图'], ['4:5','商品竖图'], ['3:4','平台辅图'], ['16:9','横向封面'] ];
const allRatios = ['1:1','4:5','3:4','16:9','3:2','2:3','5:4','4:3','9:16','21:9'];
const samples = [
  { id:1, name:'运动鞋_主视图.jpg', photo:'shoe', w:1200,h:1600 },
  { id:2, name:'腕表_商品主图.jpg', photo:'watch', w:1200,h:1200 },
  { id:3, name:'水杯_生活场景.jpg', photo:'bottle', w:1600,h:2000 },
  { id:4, name:'运动鞋_细节图.jpg', photo:'shoe', w:1800,h:1200 },
  { id:5, name:'腕表_竖版素材.jpg', photo:'watch', w:1200,h:1600 },
  { id:6, name:'水杯_展示图.jpg', photo:'bottle', w:1000,h:1000 },
].map(x => ({...x, src:`/assets/${x.photo}.jpg`, status: x.w===x.h?'skipped':'ready'}));
const statuses = { ready:'待重绘', running:'处理中', done:'已完成', failed:'未完成', skipped:'已符合比例' };
const filters = [['all','全部'],['pending','待处理'],['done','成功'],['failed','失败'],['skipped','已跳过']];
function Icon({name,...props}) { return <i className={`ph ph-${name}`} aria-hidden="true" {...props}/>; }
function Btn({icon,children,kind='',className='',...props}) { return <button type="button" className={`btn ${kind} ${className}`} {...props}>{icon&&<Icon name={icon}/>}<span>{children}</span></button>; }
function Badge({status}) { return <span className={`badge ${status}`}>{status==='running'&&<Icon name="circle-notch"/>}{statuses[status]}</span>; }

export function App() {
  const [design,setDesign] = useState(Math.min(2,Math.max(0,Number(new URLSearchParams(location.search).get('design')||1)-1)));
  const [stage,setStage] = useState('prepare');
  const [items,setItems] = useState(samples);
  const [ratio,setRatio] = useState('1:1');
  const [width,setWidth] = useState('1'); const [height,setHeight] = useState('1');
  const [filter,setFilter] = useState('all'); const [font,setFont] = useState(18);
  const [viewport,setViewport] = useState('fluid');
  const [locked,setLocked] = useState(false); const [running,setRunning] = useState(false);
  const [toast,setToast] = useState(''); const [preview,setPreview] = useState(null);
  const fileInput=useRef(); const timer=useRef(); const toastTimer=useRef(); const objectUrls=useRef([]);
  const nextId=useRef(100);
  useEffect(()=>()=>{clearTimeout(timer.current);clearTimeout(toastTimer.current); objectUrls.current.forEach(URL.revokeObjectURL);},[]);
  useEffect(()=>{
    if(!preview)return;
    const fn=e=>{
      if(e.key==='Escape')setPreview(null);
      if(e.key==='Tab'){
        const buttons=[...document.querySelectorAll('.preview-modal button:not(:disabled)')];
        const first=buttons[0],last=buttons.at(-1);
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
      }
    };
    document.addEventListener('keydown',fn);return()=>document.removeEventListener('keydown',fn);
  },[preview]);
  function notify(message) { setToast(message);clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setToast(''),3500); }
  const counts = Object.fromEntries(['ready','running','done','failed','skipped'].map(s=>[s,items.filter(x=>x.status===s).length]));
  const finished=counts.done+counts.skipped;
  const visible = items.filter(x=>filter==='all'||(filter==='pending'?['ready','running'].includes(x.status):x.status===filter));
  function matches(x,r=ratio){const [w,h]=r.split(':').map(Number);return x.w*h===x.h*w;}
  function chooseRatio(r) {
    if(locked||running)return;setRatio(r);const [w,h]=r.split(':');setWidth(w);setHeight(h);
    setItems(prev=>prev.map(x=>({...x,status:matches(x,r)?'skipped':'ready'})));
  }
  function changeStage(s) {
    clearTimeout(timer.current);setRunning(false);setFilter('all');setStage(s);setPreview(null);
    setLocked(['mixed','complete','running'].includes(s));
    const fresh=samples.map(x=>({...x,status:matches(x)?'skipped':'ready'}));
    if(s==='empty')setItems([]);
    else if(s==='mixed')setItems(fresh.map(x=>({...x,status:x.status==='skipped'?'skipped':x.id===3?'failed':'done'})));
    else if(s==='complete')setItems(fresh.map(x=>({...x,status:x.status==='skipped'?'skipped':'done'})));
    else if(s==='running'){setItems(fresh.map(x=>({...x,status:x.status==='skipped'?'skipped':x.id===1?'done':x.id===3?'running':'ready'})));setRunning(true);}
    else setItems(fresh);
  }
  function start(retry=false) {
    if(running||!items.length)return;
    const eligible=items.filter(x=>x.status===(retry?'failed':'ready'));
    if(!eligible.length){notify('没有待处理图片，已符合比例的原图会保留在最终 ZIP 中。');return;}
    const ids=new Set(eligible.map(x=>x.id));setLocked(true);setRunning(true);setStage('running');
    setItems(prev=>prev.map(x=>ids.has(x.id)?{...x,status:'running'}:x));
    timer.current=setTimeout(()=>{
      setItems(prev=>prev.map(x=>ids.has(x.id)?{...x,status:!retry&&x.id===3?'failed':'done'}:x));
      setRunning(false);setStage(!retry&&ids.has(3)?'mixed':'complete');
      notify(retry?'演示：失败项已重新处理。':'演示处理结束；没有调用 AI，也没有产生费用。');
    },1800);
  }
  async function upload(files) {
    if(running){notify('请等待当前演示处理结束，再更换本批图片。');return;}
    const images=Array.from(files).filter(f=>f.type.startsWith('image/'));
    if(!images.length)return;
    if(images.length>100){notify('每批最多 100 张，请分批上传。');return;}
    try{
      const next=await Promise.all(images.map(f=>new Promise((resolve,reject)=>{
        const src=URL.createObjectURL(f);objectUrls.current.push(src);const img=new Image();
        img.onload=()=>{const item={id:nextId.current++,name:f.name,src,w:img.naturalWidth,h:img.naturalHeight};resolve({...item,status:matches(item)?'skipped':'ready'});};
        img.onerror=()=>reject(new Error('图片无法读取，请选择其他文件。'));img.src=src;
      })));
      clearTimeout(timer.current);setItems(next);setLocked(false);setFilter('all');setStage('prepare');
      notify('已在本地预览；更换图片会替换本批列表，不会上传到服务器。');
    }catch(e){notify(e.message);}
  }
  function remove(id){setItems(prev=>prev.filter(x=>x.id!==id));setPreview(null);}
  function mockAction(label){notify(`设计预览：${label}。正式功能将沿用现有实现，本页不调用外部服务。`);}
  function applyCustom(){
    const w=Number(width),h=Number(height);const gcd=(a,b)=>b?gcd(b,a%b):a;
    if(!Number.isInteger(w)||!Number.isInteger(h)||w<=0||h<=0){notify('请输入大于零的整数比例。');return;}
    const d=gcd(w,h),r=`${w/d}:${h/d}`;
    if(!allRatios.includes(r)){notify('暂不支持这个比例，请选择已有比例。');return;}chooseRatio(r);
  }
  function pickFiles(){fileInput.current?.click();}
  const canStart=!running&&counts.ready>0;
  const startButton=<Btn icon={running?'circle-notch':'play'} kind="primary" disabled={!canStart} onClick={()=>start()}>{running?'正在处理…':counts.ready?`开始重绘 · ${counts.ready} 张`:'开始重绘'}</Btn>;
  const exportActions=<div className="export-actions"><Btn icon="arrows-clockwise" kind="quiet" disabled={running||!counts.failed} onClick={()=>start(true)}>重试失败项{counts.failed?` (${counts.failed})`:''}</Btn><span className="action-spacer"/><Btn icon="cloud-arrow-up" disabled={running||!counts.done} onClick={()=>mockAction('上传成功图片')}>上传图床</Btn><Btn icon="download-simple" disabled={running||!finished} onClick={()=>mockAction('下载 ZIP（含已跳过原图）')}>下载 ZIP</Btn></div>;
  const filterBar=<div className="filters" role="tablist" aria-label="图片状态筛选">{filters.map(([s,label])=>{const n=s==='all'?items.length:s==='pending'?counts.ready+counts.running:counts[s];return <button role="tab" aria-selected={filter===s} className={filter===s?'active':''} key={s} onClick={()=>setFilter(s)}>{label}<span>{n}</span></button>;})}</div>;
  const uploadStrip=<div className="upload-strip" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();upload(e.dataTransfer.files);}}><div className="upload-icon"><Icon name="upload-simple"/></div><div><strong>拖入图片，或直接粘贴</strong><p>每批 1–100 张 · 更换图片会替换本批列表</p></div><Btn onClick={pickFiles} disabled={running}>{items.length?'更换本批图片':'选择图片'}</Btn></div>;
  const settings=<section className="ratio-settings" aria-label="目标比例设置"><div className="section-eyebrow">处理设置</div><h2>选择目标比例</h2><p className="muted config-intro">按商品图的使用场景选择。</p><div className="ratio-grid">{ratios.map(([r,name])=><button key={r} className={`ratio-tile ${ratio===r?'selected':''}`} onClick={()=>chooseRatio(r)} disabled={locked||running} aria-pressed={ratio===r}><strong>{r}</strong><span>{name}</span>{ratio===r&&<Icon name="check-circle"/>}</button>)}</div><label className="field-label" htmlFor="all-ratios">所有支持的比例</label><select id="all-ratios" value={ratio} onChange={e=>chooseRatio(e.target.value)} disabled={locked||running}>{allRatios.map(r=><option key={r}>{r}</option>)}</select><label className="field-label" htmlFor="ratio-width">输入宽高比例</label><div className="ratio-inputs"><input aria-label="比例宽" id="ratio-width" type="number" min="1" value={width} onChange={e=>setWidth(e.target.value)} disabled={locked||running}/><span>:</span><input aria-label="比例高" type="number" min="1" value={height} onChange={e=>setHeight(e.target.value)} disabled={locked||running}/><Btn disabled={locked||running} onClick={applyCustom}>应用</Btn></div><p className="ratio-note">这里设置宽高比，不是输出像素尺寸。</p>{locked&&<div className="lock-note"><Icon name="lock-simple"/><span>本批比例已锁定。更换图片后可重新设置。</span></div>}<div className="preserve-note"><Icon name="shield-check"/><div><strong>符合比例的图片自动保留</strong><p>不重复重绘，原图会一并收入 ZIP。</p></div></div></section>;
  const queueTitle=<div className="queue-heading"><h2>图片队列 <span>{items.length}</span></h2><span className="muted">目标比例 <b>{ratio}</b></span></div>;
  const empty=<div className="empty-state" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();upload(e.dataTransfer.files);}}><div className="empty-icon"><Icon name="images"/></div><h2>先放入需要处理的商品图</h2><p>拖拽图片到这里，或按 ⌘V 粘贴。</p><Btn kind="primary" icon="plus" onClick={pickFiles}>选择图片</Btn><small>每批最多 100 张 · 图片仅在本地预览</small></div>;
  const rows=<div className="image-list">{visible.map(item=><div className="image-row" key={item.id}><button className="thumbnail" onClick={()=>setPreview(item)} aria-label={`预览 ${item.name}`}><img src={item.src} alt={item.name}/></button><button className="file-info" onClick={()=>setPreview(item)}><strong>{item.name}</strong><span>{item.w} × {item.h}{design===2?` → ${ratio}`:''}</span>{item.status==='failed'&&<span className="error-copy">生成未完成，可单独重试</span>}</button>{design===2&&<div className={`result-thumb ${item.status}`}><img src={item.src} alt="演示结果使用原图"/><span>{item.status==='done'?'演示结果':item.status==='skipped'?'保留原图':'等待处理'}</span></div>}<Badge status={item.status}/><div className="row-actions"><button title="查看对比" aria-label={`查看 ${item.name} 对比`} onClick={()=>setPreview(item)}><Icon name="arrows-out"/></button><details className="item-menu"><summary aria-label={`${item.name} 更多操作`}><Icon name="dots-three"/></summary><div>{item.status==='done'&&<><button onClick={()=>mockAction('上传此图到图床')}>上传图床</button><button onClick={()=>mockAction('流转至图片翻译')}>图片翻译</button><button onClick={()=>mockAction('设为详情页主图')}>设为详情页主图</button></>}<button disabled={running||item.status==='running'} onClick={()=>remove(item.id)}>移除图片</button></div></details></div></div>)}{!visible.length&&items.length>0&&<div className="filter-empty">这个分类暂时没有图片。<button onClick={()=>setFilter('all')}>查看全部图片</button></div>}</div>;
  const cards=<div className="image-grid">{visible.map(item=><article className="image-card" key={item.id}><button className="card-photo" onClick={()=>setPreview(item)} aria-label={`预览 ${item.name}`}><img src={item.src} alt={item.name}/><span className="preview-affordance"><Icon name="arrows-out"/>查看对比</span></button><div className="card-info"><strong>{item.name}</strong><span>{item.w} × {item.h}</span><div><Badge status={item.status}/><button className="card-detail" aria-label={`查看 ${item.name} 详情`} onClick={()=>setPreview(item)}><Icon name="arrow-up-right"/></button></div></div></article>)}{!visible.length&&items.length>0&&<div className="filter-empty">这个分类暂时没有图片。</div>}</div>;
  return <div className="preview-page" onPaste={e=>{const files=Array.from(e.clipboardData.files);if(files.length){e.preventDefault();upload(files);}}}>
    <header className="preview-toolbar"><div className="preview-title"><Icon name="swatches"/><strong>设计预览</strong><span>不影响现有客户端</span></div><nav aria-label="设计版本">{designs.map((d,i)=><button key={d.name} aria-pressed={design===i} className={design===i?'chosen':''} onClick={()=>{setDesign(i);const u=new URL(location);u.searchParams.set('design',i+1);history.replaceState(null,'',u);}}>{i+1}<span>{d.name}</span>{d.tag&&<em>{d.tag}</em>}</button>)}</nav><div className="preview-settings"><label>状态<select aria-label="预览状态" value={stage} onChange={e=>changeStage(e.target.value)}><option value="empty">首次使用</option><option value="prepare">准备处理</option><option value="running">处理中</option><option value="mixed">部分失败</option><option value="complete">全部完成</option></select></label><label>字号<select aria-label="预览字号" value={font} onChange={e=>setFont(Number(e.target.value))}>{[16,18,20].map(x=><option key={x} value={x}>{x}px</option>)}</select></label><label>画布<select aria-label="预览画布" value={viewport} onChange={e=>setViewport(e.target.value)}><option value="fluid">自适应</option><option value="1280">1280px</option><option value="1024">1024px</option></select></label></div></header>
    <div className="preview-description"><span className="design-number">设计 {design+1}</span><strong>{designs[design].name}</strong><span>{designs[design].desc}</span><span className="demo-chip">示例图片与状态 · 无真实 AI 调用</span></div>
    <div className="canvas-scroll"><div className="app-frame" data-design={design+1} style={{'--ui-font':`${font}px`,width:viewport==='fluid'?'100%':`${viewport}px`}}>
      <aside className="sidebar"><a className="brand" href="#" onClick={e=>{e.preventDefault();notify('当前只预览尺寸重绘页面。');}}><span><Icon name="storefront"/></span><b>AI 电商工具箱</b></a><div className="nav-links">{[['magnifying-glass','选品研究'],['chart-bar','竞品分析'],['article','内容创作']].map(([ic,t])=><button key={t} onClick={()=>notify('本稿只预览尺寸重绘，不切换业务模块。')}><Icon name={ic}/>{t}{t==='内容创作'&&<Icon name="caret-down"/>}</button>)}<div className="nav-group"><span><Icon name="images"/>图片工具<Icon name="caret-down"/></span><button className="nav-child active" aria-current="page"><Icon name="crop"/>尺寸重绘</button><button className="nav-child" onClick={()=>notify('水印消除保留原功能，本稿不展开。')}><Icon name="eraser"/>水印消除</button></div><button onClick={()=>notify('翻译保留原功能，本稿不展开。')}><Icon name="translate"/>翻译<Icon name="caret-down"/></button></div><div className="nav-bottom"><button onClick={()=>mockAction('打开历史批次')}><Icon name="folder"/>档案库</button><button onClick={()=>mockAction('打开现有设置')}><Icon name="gear"/>设置</button><span>本地工作空间</span></div></aside>
      <main className="app-main"><div className="breadcrumb"><span>图片工具</span><Icon name="caret-right"/><strong>尺寸重绘</strong><button onClick={()=>mockAction('打开尺寸重绘历史批次')}><Icon name="clock-counter-clockwise"/>历史批次</button></div>
        <div className="page-heading"><div><div className="section-eyebrow">IMAGE WORKSPACE</div><h1>{design===2?'把商品图，整理成需要的比例':'尺寸重绘'}</h1><p>批量调整商品图比例，让素材适配不同平台。</p></div>{startButton}</div>
        {design===2&&<ol className="workflow-steps"><li className={!items.length?'step-active':''}><span>1</span><div><strong>放入图片</strong><small>{items.length?`已添加 ${items.length} 张`:'上传或粘贴商品图'}</small></div>{items.length>0&&<Icon name="check-circle"/>}</li><li className={items.length&&!locked?'step-active':''}><span>2</span><div><strong>选择比例</strong><small>当前 {ratio}</small></div></li><li className={finished===items.length&&items.length?'step-complete':locked?'step-active':''}><span>3</span><div><strong>处理与导出</strong><small>检查结果，下载素材</small></div></li></ol>}
        <div className="workspace">
          {design===0&&<aside className="config-panel">{settings}</aside>}
          <section className="queue-panel" aria-label="图片工作区">
            {design===2&&<div className="inline-setup"><div><Icon name="crop"/><strong>目标比例</strong></div><select aria-label="目标比例" value={ratio} disabled={locked||running} onChange={e=>chooseRatio(e.target.value)}>{allRatios.map(r=><option key={r} value={r}>{r}{ratios.find(x=>x[0]===r)?` · ${ratios.find(x=>x[0]===r)[1]}`:''}</option>)}</select><details className="advanced-ratio"><summary>输入宽高比例</summary><div><input aria-label="步骤流比例宽" value={width} disabled={locked} onChange={e=>setWidth(e.target.value)}/><span>:</span><input aria-label="步骤流比例高" value={height} disabled={locked} onChange={e=>setHeight(e.target.value)}/><Btn disabled={locked} onClick={applyCustom}>应用</Btn></div></details><span className="muted">{locked?'本批比例已锁定':'符合比例的原图自动保留'}</span></div>}
            {queueTitle}{items.length?uploadStrip:null}{items.length?filterBar:null}
            {running&&<div className="progress-banner" role="status"><Icon name="circle-notch"/><div><strong>正在处理 {counts.running} 张图片</strong><span>已就绪 {finished} / {items.length} 张，处理完成后可检查结果。</span></div><span className="demo-chip">模拟运行</span></div>}
            {!running&&counts.failed>0&&<div className="failure-banner"><Icon name="warning-circle"/><div><strong>{counts.failed} 张图片未完成，其余结果已保留</strong><span>可以只重试失败项，无需重做成功图片。</span></div><button onClick={()=>start(true)}>重试失败项</button></div>}
            {items.length?(design===1?cards:rows):empty}
            {items.length&&design!==2?<footer className="queue-footer"><div className="result-summary"><span className="success-dot"/><strong>{finished} 张可导出</strong><span>含 {counts.skipped} 张保留原图</span></div>{exportActions}</footer>:null}
          </section>
          {design===1&&<aside className="config-panel">{settings}</aside>}
        </div>
        {design===2&&<div className="step-footer"><div className="result-summary"><strong>{finished} / {items.length} 张可导出</strong><span>已符合比例的原图会收入 ZIP</span></div>{exportActions}</div>}
        <div className="workspace-footnote"><Icon name="info"/><span>这是独立设计预览。上传、处理、流转和导出均不会调用业务接口。</span></div>
      </main>
    </div></div>
    <input ref={fileInput} className="sr-only" aria-label="选择本地预览图片" type="file" accept="image/*" multiple onChange={e=>{upload(e.target.files);e.target.value='';}}/>
    {toast&&<div className="toast" role="status"><Icon name="info"/>{toast}</div>}
    {preview&&<div className="modal-backdrop" onClick={()=>setPreview(null)}><section className="preview-modal" role="dialog" aria-modal="true" aria-label="图片前后对比" onClick={e=>e.stopPropagation()}><header><div><h2>{preview.name}</h2><p>演示预览 · 结果区复用原图，没有真实重绘</p></div><button autoFocus className="icon-button" aria-label="关闭对比" onClick={()=>setPreview(null)}><Icon name="x"/></button></header><div className="compare-grid"><div><span>原始图片 · {preview.w} × {preview.h}</span><img src={preview.src} alt="原始商品图"/></div><div><span>目标比例 · {ratio}</span><div className="comparison-stage"><img style={{aspectRatio:ratio.replace(':','/')}} src={preview.src} alt="演示目标比例，使用原图"/></div></div></div><footer><Badge status={preview.status}/>{preview.status==='done'&&<><Btn icon="cloud-arrow-up" onClick={()=>mockAction('上传图床')}>上传图床</Btn><Btn onClick={()=>mockAction('流转至图片翻译')}>图片翻译</Btn><Btn onClick={()=>mockAction('设为详情页主图')}>设为详情页主图</Btn></>}<Btn disabled={running} kind="danger quiet" onClick={()=>remove(preview.id)}>移除图片</Btn><Btn onClick={()=>setPreview(null)}>关闭预览</Btn></footer></section></div>}
  </div>;
}
