import {el,link} from './elements.mjs';
const validAmount=value=>(typeof value==='number'||typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value))&&Number.isFinite(Number(value))&&Number(value)>=0;
const money=(value,code)=>validAmount(value)?(/^[A-Z]{3}$/.test(code||'')?code+' ':'')+Number(value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+(!/^[A-Z]{3}$/.test(code||'')?'（币种待核对）':''):null;

/** Only saved page observations; selection is local viewing state, never an economics edit. */
export function productFacts(context,product){
 const snapshot=product.landing_snapshot;if(!snapshot)return null;
 const card=el(context,'section','rw-product-facts');card.append(el(context,'h3','','商品信息与来源'));
 const body=el(context,'div','rw-product-facts-body');body.append(el(context,'strong','rw-product-facts-title',snapshot.title||'未获取商品页名称'));
 const observed=snapshot.price_observation,raw=observed?observed.amount:snapshot.price,code=observed?.currency||snapshot.price_currency;
 const formatted=validAmount(raw)&&/^[A-Z]{3}$/.test(code||'')?money(raw,code):raw;
 const scalar=typeof formatted==='string'&&formatted.trim()?formatted:typeof formatted==='number'&&Number.isFinite(formatted)?String(formatted):null;
 const options=(Array.isArray(observed?.options)?observed.options:[]).filter(item=>item&&typeof item.id==='string'&&validAmount(item.amount)).slice(0,200);
 const display=el(context,'strong'),row=el(context,'div','rw-product-price');row.append(el(context,'span','rw-muted','页面售价'),display);body.append(row);
 if(options.length){
  const codes=[...new Set(options.map(item=>item.currency))],prices=options.map(item=>Number(item.amount)),low=Math.min(...prices),high=Math.max(...prices);
  const range=codes.length>1?'多套餐 · 多币种':low===high?money(low,codes[0])+(options.length>1?' · 多套餐':''):money(low,codes[0])+'–'+Number(high).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+' · 多套餐';
  display.textContent=range;
  const label=el(context,'label','rw-price-selector','查看套餐'),select=el(context,'select');select.setAttribute('aria-label','查看套餐价格');const all=el(context,'option','','全部套餐（价格概览）');all.value='';select.append(all);
  const table=el(context,'table','rw-variant-prices'),caption=el(context,'caption','','页面套餐报价'),head=el(context,'thead'),header=el(context,'tr');
  for(const text of ['套餐 / 规格','套餐总价','折合单价']){const th=el(context,'th','',text);th.setAttribute('scope','col');header.append(th);}head.append(header);const tbody=el(context,'tbody'),rows=new Map();
  for(const option of options){
   const quantity=Number.isInteger(option.quantity)&&option.quantity>0?option.quantity:null,name=quantity?quantity+' 件装':option.label||'未命名规格',choice=el(context,'option','',name+' · '+money(option.amount,option.currency));choice.value=option.id;select.append(choice);
   const tr=el(context,'tr'),nameCell=el(context,'td');nameCell.append(el(context,'strong','',name));if(quantity&&option.label)nameCell.append(el(context,'small','',option.label));
   const unit=quantity&&validAmount(option.unit_amount)?money(option.unit_amount,option.currency)+' / 件':quantity?'单价待核对':'件数待核对';tr.append(nameCell,el(context,'td','',money(option.amount,option.currency)),el(context,'td','',unit));rows.set(option.id,tr);tbody.append(tr);
  }
  table.append(caption,head,tbody);label.append(select);const note=el(context,'p','rw-price-view-note','选择仅切换查看，不自动填入利润测算；折合单价按页面明确件数计算，未包含运费、税费。');
  context.life.listen(select,'change',()=>{const selected=options.find(item=>item.id===select.value);display.textContent=selected?money(selected.amount,selected.currency):range;for(const [id,tr] of rows)tr.dataset.selected=String(id===select.value);});
  body.append(label,table,note);
 }else display.textContent=scalar??'未获取售价';
 body.append(link(context,'查看商品信息来源',snapshot.final_url||snapshot.source_url||product.url),el(context,'p','rw-muted','商品页观察 · 名称、售价及规格仍需人工核对，不代表已确认的采购成本。'));
 card.append(body);return card;
}
