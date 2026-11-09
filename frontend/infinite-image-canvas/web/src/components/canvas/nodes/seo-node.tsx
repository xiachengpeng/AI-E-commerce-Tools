import { useState } from "react";
import { SearchCheck } from "lucide-react";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import type { CanvasNodeContext } from "@/types/canvas-plugin";
import { makeSeoResult, recordSeoUpload, sameSeoSource, selectSeoImage } from "@/integration/seo-node.mjs";

const NODE_TYPE = "ecommerce:image-seo";
type HostUploader = {
    recognizeImageWithVisionAI: (url: string, options: { targetLang: string }) => Promise<{title:string; altText:string; slug:string}>;
    getImageInlineData: (url: string) => Promise<{mimeType:string; data:string} | null>;
    openUniversalImageUploader: (options: Record<string, unknown>) => Promise<void>;
};
function uploader(): HostUploader {
    const host = window.parent as Window & {universalUploader?: HostUploader};
    if (host === window || !host.universalUploader) throw new Error("图床功能未加载，请在电商工具箱中打开画布。");
    return host.universalUploader;
}

function SeoContent({ ctx }: {ctx: CanvasNodeContext}) {
    const [lang, setLang] = useState(ctx.node.metadata?.seo?.lang || "en");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const source = selectSeoImage(ctx.getUpstream()).source;
    const saved = ctx.node.metadata?.seo;
    const seo = source && saved && saved.sourceId === source.id && saved.sourceKey === source.storageKey ? saved : undefined;
    const update = (field: "title" | "altText" | "slug", value: string) => {
        if (seo) ctx.updateMetadata({seo:{...seo, [field]:value}});
    };
    const generate = async () => {
        const selection = selectSeoImage(ctx.getUpstream());
        if (!selection.source) {setError(selection.error); return;}
        setError(""); setBusy(true);
        try {
            const result = await uploader().recognizeImageWithVisionAI(selection.source.url, {targetLang:lang});
            if (!ctx.getNode(ctx.node.id) || !sameSeoSource(selection.source, ctx.getUpstream())) throw new Error("连接的图片已变化，请重新生成。");
            const previous = ctx.getNode(ctx.node.id)?.metadata?.seo;
            const next = makeSeoResult(selection.source, result, lang);
            if (previous && previous.sourceId === selection.source.id && previous.sourceKey === selection.source.storageKey) next.uploads = previous.uploads || {};
            ctx.updateMetadata({seo:next});
        } catch (err) {setError(err instanceof Error ? err.message : "SEO 生成失败，请重试。");}
        finally {setBusy(false);}
    };
    const upload = async () => {
        const selection = selectSeoImage(ctx.getUpstream());
        if (!selection.source || !seo) {setError("请先连接图片并生成 SEO 信息。"); return;}
        const sourceSnapshot = selection.source;
        setError(""); setBusy(true);
        try {
            const host = uploader();
            const image = await host.getImageInlineData(sourceSnapshot.url);
            if (!image?.data) throw new Error("无法读取图片，请重新连接。");
            if (!ctx.getNode(ctx.node.id) || !sameSeoSource(sourceSnapshot, ctx.getUpstream())) throw new Error("连接的图片已变化，请重新操作。");
            await host.openUniversalImageUploader({imageData:`data:${image.mimeType};base64,${image.data}`, filename:`${seo.slug}.png`, title:seo.title, altText:seo.altText, sourceModule:"canvas", onSuccess:(result:{remote_url?:string}, destination:{storageType:string;configId:number|null;title:string;altText:string;filename:string}) => {
                const current = ctx.getNode(ctx.node.id)?.metadata?.seo;
                if (result.remote_url && current && current.sourceId === sourceSnapshot.id && current.sourceKey === sourceSnapshot.storageKey && sameSeoSource(sourceSnapshot, ctx.getUpstream())) ctx.updateMetadata({seo:recordSeoUpload({...current,title:destination.title,altText:destination.altText,slug:destination.filename.replace(/\.[^/.]+$/, "")},destination,result.remote_url)});
            }});
        } catch (err) {setError(err instanceof Error ? err.message : "无法打开图床上传。");}
        finally {setBusy(false);}
    };
    const fieldStyle = {background:ctx.theme.toolbar.panel, color:ctx.theme.node.text, borderColor:ctx.theme.toolbar.border};
    const stopControlDrag = (event: React.MouseEvent | React.PointerEvent) => { if ((event.target as HTMLElement).closest('button,input,textarea,select,a')) event.stopPropagation(); };
    return <div className="flex h-full w-full flex-col gap-2 overflow-auto p-4 text-xs" style={{color:ctx.theme.node.text}} onMouseDown={stopControlDrag} onPointerDown={stopControlDrag}>
        <div className="flex items-center justify-between gap-2"><strong className="text-sm">图片 SEO 信息</strong><select aria-label="SEO 语言" value={lang} onChange={e=>setLang(e.target.value)} className="rounded border px-2 py-1" style={fieldStyle}><option value="en">英文</option><option value="zh">中文</option><option value="th">泰文</option><option value="ja">日文</option><option value="de">德文</option><option value="fr">法文</option><option value="es">西班牙文</option></select></div>
        <div className="opacity-65">{source ? `已连接：${ctx.getNode(source.id)?.title || "图片"}` : "将一张图片连接到节点左侧"}</div>
        {seo ? <>
            <label>标题<input aria-label="SEO 标题" value={seo.title} onChange={e=>update("title",e.target.value)} className="mt-1 w-full rounded border px-2 py-1.5" style={fieldStyle}/></label>
            <label>Alt 文本<textarea aria-label="Alt 文本" value={seo.altText} onChange={e=>update("altText",e.target.value)} rows={2} className="mt-1 w-full resize-none rounded border px-2 py-1.5" style={fieldStyle}/></label>
            <label>文件名<input aria-label="SEO 文件名" value={seo.slug} onChange={e=>update("slug",e.target.value)} className="mt-1 w-full rounded border px-2 py-1.5" style={fieldStyle}/></label>
            {Object.entries(seo.uploads || {}).map(([destination,url])=><div key={destination} className="break-all"><span className="opacity-65">{destination}：</span><a href={url} target="_blank" rel="noreferrer" className="text-blue-500 underline">{url}</a></div>)}
        </> : <div className="opacity-60">生成标题、Alt 文本和文件名，确认后可上传到云图床。</div>}
        {error && <div role="alert" className="text-red-500">{error}</div>}
        <div className="mt-auto flex gap-2"><button type="button" disabled={busy} onClick={()=>void generate()} className="rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50">{busy ? "处理中…" : seo ? "重新生成" : "生成 SEO"}</button><button type="button" disabled={busy || !seo} onClick={()=>void upload()} className="rounded border px-3 py-2 disabled:opacity-50" style={fieldStyle}>选择图床上传</button></div>
    </div>;
}
export function registerSeoNode() {
    registerNodeDefinitions([{type:NODE_TYPE,title:"图片 SEO",description:"生成图片 SEO 信息并上传图床",icon:<SearchCheck className="size-4"/>,defaultSize:{width:380,height:390},Content:SeoContent,showInCreateMenu:false,hidePanel:true,resource:(node)=>node.metadata?.seo ? {kind:"text",text:`标题：${node.metadata.seo.title}\nAlt：${node.metadata.seo.altText}`} : null}], "ecommerce");
}
export {NODE_TYPE as SEO_NODE_TYPE};
