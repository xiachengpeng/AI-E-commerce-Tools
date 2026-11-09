import {useCallback,useEffect,useMemo,useState} from 'react';
import {localApi} from './runtime.mjs';
import {taskRecoveryAction} from './task-recovery.mjs';
import {App} from 'antd';
import {confirmCanvasAction} from './confirm-action.mjs';

type Task={id:string;project_id:string;operation_key:string;status:string;result_asset_id:string|null;result_text:string|null;error_message:string|null;reviewed:boolean;request:{prompt?:string;operation?:string;node_context?:{node_id?:string;retry_prompt?:string}}};
type Props={projectId:string;representedIds:string[];onRecover:(task:Task)=>void;onRetry:(task:Task)=>void};
const labels: Record<string,string>={prepared:'待提交',submitted:'生成中',complete:'已完成',unknown:'服务商结果未确认',failed:'生成失败'};
export function NodeTaskPanel({projectId,representedIds,onRecover,onRetry}:Props) {
    const {modal}=App.useApp();
    const [open,setOpen]=useState(false),[offset,setOffset]=useState(0),[tasks,setTasks]=useState<Task[]>([]),[error,setError]=useState('');
    const represented=useMemo(()=>new Set(representedIds),[representedIds]);
    const refresh=useCallback(async()=>{try{const result=await localApi.tasks(projectId,offset);setTasks(result.tasks);setError('');}catch(e){setError(e instanceof Error?e.message:'无法读取任务记录');}},[projectId,offset]);
    useEffect(()=>{if(open)void refresh();},[open,refresh]);
    async function acknowledgeAndRetry(task:Task){
        if(!await confirmCanvasAction(modal,'请确认已核对服务商任务记录，没有可恢复的结果，并接受重新提交可能产生费用。原任务记录会保留。'))return;
        try{await localApi.acknowledge(projectId,task.operation_key);await refresh();setOpen(false);onRetry(task);}catch(e){setError(e instanceof Error?e.message:'无法核对任务');}
    }
    async function cancelPrepared(task:Task){
        if(!await confirmCanvasAction(modal,'取消这条尚未提交的任务？'))return;
        try{await localApi.cancelReservation(projectId,task.operation_key);await refresh();}catch(e){setError(e instanceof Error?e.message:'任务可能已提交，请刷新核对');}
    }
    return <div style={{position:'absolute',right:16,top:14,zIndex:100,color:'#e5e7eb'}}>
        <button type="button" onClick={()=>setOpen(!open)} style={{background:'#27272a',border:'1px solid #52525b',borderRadius:8,padding:'8px 12px'}}>任务记录</button>
        {open && <section role="region" aria-label="生成任务记录" style={{position:'absolute',right:0,top:44,width:340,maxHeight:'70vh',overflow:'auto',padding:14,background:'#18181b',border:'1px solid #52525b',borderRadius:10}}>
            <div style={{display:'flex',justifyContent:'space-between'}}><strong>生成任务记录</strong><button type="button" onClick={()=>void refresh()}>刷新</button></div>
            {error && <p role="alert">{error}</p>}{!tasks.length && !error && <p>本页暂无任务</p>}
            {tasks.map(task=>{const action=taskRecoveryAction(task,represented);return <div key={task.id} style={{padding:'10px 0',borderBottom:'1px solid #3f3f46'}}>
                <div>{labels[task.status]||task.status}{task.reviewed?' · 已核对':''}</div>
                {task.error_message && <p role="alert" style={{margin:'6px 0',color:'#fca5a5',fontSize:13}}>{task.error_message}</p>}
                {action==='restore' && <button type="button" onClick={()=>onRecover(task)}>将结果加入画布</button>}
                {action==='already-added' && <span>已在画布中</span>}
                {action==='review' && <button type="button" style={{margin:'4px 0',background:'#365314',border:'1px solid #65a30d',borderRadius:6,padding:'6px 10px'}} onClick={()=>void acknowledgeAndRetry(task)}>核对后重新生成</button>}
                {action==='retry' && <button type="button" style={{margin:'4px 0',background:'#365314',border:'1px solid #65a30d',borderRadius:6,padding:'6px 10px'}} onClick={()=>{setOpen(false);onRetry(task)}}>重新生成</button>}
                {action==='cancel' && <button type="button" onClick={()=>void cancelPrepared(task)}>取消未提交任务</button>}
                {action==='wait' && <span>任务尚未结束，请刷新核对。</span>}
                <details style={{marginTop:6}}><summary style={{cursor:'pointer',fontSize:12,opacity:.72}}>查看生成提示词</summary><div style={{overflowWrap:'anywhere',whiteSpace:'pre-wrap',fontSize:12,opacity:.78,marginTop:4}}>{task.request?.prompt || '图片任务'}</div></details>
            </div>})}
            <div style={{display:'flex',gap:12,marginTop:12}}><button type="button" disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-50))}>上一页</button><button type="button" disabled={tasks.length<50} onClick={()=>setOffset(offset+50)}>下一页</button></div>
        </section>}
    </div>;
}
