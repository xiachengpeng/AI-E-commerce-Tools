import { FileText, StickyNote, Pencil, Eye } from "lucide-react";
import { Streamdown } from "streamdown";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import type { CanvasNodeContext } from "@/types/canvas-plugin";
import { safeStickyColor, selectMarkdownSource } from "@/integration/note-nodes.mjs";
import { useState } from "react";

export const STICKY_NODE_TYPE = "sticky-note:note";
export const MARKDOWN_NODE_TYPE = "markdown:doc";
const colors = ["#fde68a", "#fca5a5", "#fdba74", "#a7f3d0", "#bfdbfe", "#ddd6fe", "#f9a8d4", "#e7e5e4"];
const stop = (event: {stopPropagation:()=>void}) => event.stopPropagation();

function StickyContent({ctx}:{ctx:CanvasNodeContext}) {
    const [palette, setPalette] = useState(false);
    const color = safeStickyColor(ctx.node.metadata?.noteColor);
    const editing = !!ctx.node.metadata?.noteEditing;
    return <div className="relative h-full w-full rounded-[inherit] p-4" style={{background:color,color:'#292524'}}>
        <div className="absolute right-2 top-2 z-10" onMouseDown={stop} onPointerDown={stop} onDoubleClick={stop}>
            <button type="button" aria-label="选择便利贴颜色" title="选择颜色" onClick={()=>setPalette(!palette)} className="h-6 w-6 rounded-full border-2 border-black/25" style={{background:color}} />
            {palette && <div className="absolute right-6 top-7 grid w-[112px] grid-cols-4 gap-1 rounded-lg bg-white p-2 shadow-lg">
                {colors.map(item=><button key={item} type="button" aria-label={`颜色 ${item}`} title={item} className="h-5 w-5 rounded-full border border-black/20" style={{background:item}} onClick={()=>{ctx.updateMetadata({noteColor:item});setPalette(false);}}/>)}
                <label title="自定义颜色" className="h-5 w-5 overflow-hidden rounded-full"><input aria-label="自定义颜色" type="color" value={color} className="h-6 w-6 cursor-pointer" onChange={e=>ctx.updateMetadata({noteColor:e.target.value})}/></label>
            </div>}
        </div>
        {editing ? <textarea aria-label="便利贴内容" autoFocus value={ctx.node.metadata?.content || ""} onChange={e=>ctx.updateMetadata({content:e.target.value})} onBlur={()=>ctx.updateMetadata({noteEditing:false})} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();ctx.updateMetadata({noteEditing:false});}}} onMouseDown={stop} onPointerDown={stop} onWheel={stop} className="h-full w-full resize-none bg-transparent pr-6 text-sm outline-none" placeholder="输入便利贴内容…"/> : <div className="h-full overflow-hidden whitespace-pre-wrap break-words pr-6 text-sm">{ctx.node.metadata?.content || <span className="opacity-55">双击编辑便利贴</span>}</div>}
    </div>;
}
function MarkdownContent({ctx}:{ctx:CanvasNodeContext}) {
    const [error,setError] = useState("");
    const content=ctx.node.metadata?.content || "";
    const editing=!!ctx.node.metadata?.markdownEditing;
    const importText=()=>{const result=selectMarkdownSource(ctx.getUpstream());if(result.error){setError(result.error);return;}ctx.updateMetadata({content:result.text});setError("");};
    if(editing) return <textarea aria-label="Markdown 内容" autoFocus value={content} onChange={e=>ctx.updateMetadata({content:e.target.value})} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();ctx.updateMetadata({markdownEditing:false});}}} onMouseDown={stop} onPointerDown={stop} onWheel={stop} className="h-full w-full resize-none rounded-[inherit] bg-transparent p-4 font-mono text-sm outline-none" style={{color:ctx.theme.node.text}} placeholder="# 输入 Markdown"/>;
    return <div data-canvas-no-zoom className="h-full w-full overflow-auto p-4 text-sm" onWheel={stop} style={{color:ctx.theme.node.text}}>
        {content ? <Streamdown mode="static" controls={false}>{content}</Streamdown> : <div className="flex flex-col items-start gap-3 opacity-75"><span>双击编辑 Markdown，或连接文本节点后引用内容。</span><button type="button" className="rounded border px-2 py-1" style={{borderColor:ctx.theme.node.stroke}} onMouseDown={stop} onPointerDown={stop} onClick={importText}>引用上游文本</button>{error && <span role="alert">{error}</span>}</div>}
    </div>;
}
export function registerNoteNodes() {
    registerNodeDefinitions([
        {type:STICKY_NODE_TYPE,title:"便利贴",icon:<StickyNote className="size-4"/>,description:"记录备注，支持换色",defaultSize:{width:240,height:200},defaultMetadata:{content:"",noteColor:'#fde68a'},minimapColor:'#fde68a',hidePanel:true,showInCreateMenu:false,Content:StickyContent,onDoubleClick:(ctx)=>{ctx.updateMetadata({noteEditing:true});return true;}},
        {type:MARKDOWN_NODE_TYPE,title:"Markdown",icon:<FileText className="size-4"/>,description:"编辑和预览 Markdown",defaultSize:{width:360,height:300},defaultMetadata:{content:""},minimapColor:'#6366f1',hidePanel:true,showInCreateMenu:false,interactionToggle:true,forceInteractive:node=>!!node.metadata?.markdownEditing,Content:MarkdownContent,resource:node=>node.metadata?.content ? {kind:'text',text:node.metadata.content} : null,onDoubleClick:(ctx)=>{ctx.updateMetadata({markdownEditing:true});return true;},toolbar:ctx=>[{id:'markdown-edit',title:ctx.node.metadata?.markdownEditing?'预览 Markdown':'编辑 Markdown',label:ctx.node.metadata?.markdownEditing?'预览':'编辑',icon:ctx.node.metadata?.markdownEditing?<Eye className="size-4"/>:<Pencil className="size-4"/>,onClick:()=>ctx.updateMetadata({markdownEditing:!ctx.node.metadata?.markdownEditing})}]},
    ],"local-notes");
}
