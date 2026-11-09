import {useEffect,useState} from 'react';
import {canvasPersistence} from './runtime.mjs';

type StorageStatus={kind:string;projectId:string|null;message:string};
export function StorageStatusBanner() {
    const [status,setStatus]=useState<StorageStatus>(()=>canvasPersistence.status());
    useEffect(()=>canvasPersistence.subscribe(setStatus),[]);
    useEffect(()=>{
        const onLeave=(event:BeforeUnloadEvent)=>{if(['saving','error'].includes(canvasPersistence.status().kind)){event.preventDefault();event.returnValue='';}};
        window.addEventListener('beforeunload',onLeave);
        return ()=>window.removeEventListener('beforeunload',onLeave);
    },[]);
    if(status.kind!=='error') return null;
    return <div role="alert" style={{position:'fixed',zIndex:10000,left:12,right:12,top:8,padding:12,background:'#fff1f2',color:'#881337',border:'1px solid #fda4af',borderRadius:8}}>
        画布保存或读取失败：{status.message}。请保留当前页面并检查本地服务。
        {status.projectId && <button type="button" onClick={()=>void canvasPersistence.retry(status.projectId).catch(()=>{})}>重试保存</button>}
    </div>;
}
