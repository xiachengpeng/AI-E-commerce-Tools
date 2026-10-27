import {el} from './elements.mjs';
export const isMismatch=product=>!product.identification?.relevance_confirmed&&product.identification?.relevance_result==='mismatch';

/** Present three results while retaining the original confirmation boolean. */
export function frameIdentityResult(context,form,inputs){
 const choice=inputs?.get('relevance_result'),confirmed=inputs?.get('relevance_confirmed');if(!choice||!confirmed)return;
 const wrap=choice.parentElement;wrap.classList.add('rw-identity-result');confirmed.parentElement.hidden=true;
 const note=el(context,'p','rw-identity-result-note');note.setAttribute('role','status');wrap.append(note);
 if(choice.value==='unverified'&&confirmed.checked)choice.value='matched';
 const paint=()=>{confirmed.checked=choice.value==='matched';wrap.dataset.result=choice.value;note.textContent=choice.value==='mismatch'?'请记录哪里不一致。保存后保留线索与原因，不能继续扩词；可修改准确链接后重新核对，不会自动删除或淘汰。':choice.value==='matched'?'确认商品外观、型号或落地页与广告对应，再选择实际核对依据。':'图片打不开、链接不明确或证据不足时选此项。先保留待核对，不会按一致继续研究。';};
 context.life.listen(choice,'change',()=>{paint();confirmed.dispatchEvent(new Event('change'));});paint();
 form.querySelector('.rw-identity-question')?.after(wrap);
}
