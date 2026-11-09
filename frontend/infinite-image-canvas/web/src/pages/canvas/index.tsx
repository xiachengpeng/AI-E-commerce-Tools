import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Button } from "antd";
import { Download, FileUp, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { readZip } from "@/lib/zip";
import { CanvasDeleteProjectsDialog } from "@/components/canvas/canvas-delete-projects-dialog";
import { CanvasProjectCard } from "@/components/canvas/canvas-project-card";
import type { CanvasExportFile } from "@/types/canvas-export";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { hasAgentUrlBootstrap } from "@/lib/agent/agent-url-bootstrap";
import { localApi, canvasPersistence, projectRepository } from "@/integration/runtime.mjs";
import { rewriteImportedProject, blobToBase64 } from "@/integration/canvas-import.mjs";

export default function CanvasPage() {
    const { message } = App.useApp();
    const [archived,setArchived]=useState<{id:string;title:string}[]>([]);
    const [showArchived,setShowArchived]=useState(false);
    const refreshArchived=async()=>{try{const data=await localApi.listArchived();setArchived(data.projects);setShowArchived(true);}catch{message.error("无法读取归档画布");}};
    const restoreArchived=async(id:string)=>{
        if(canvasPersistence.status().kind!=="saved"){message.warning("请等待画布保存完成或先处理保存错误。");return;}
        try{await localApi.restore(id);window.location.reload();}catch{message.error("恢复画布失败，请重试。");}
    };
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const inputRef = useRef<HTMLInputElement>(null);
    const autoOpenRef = useRef(false);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const projects = useCanvasStore((state) => state.projects);
    const createProject = useCanvasStore((state) => state.createProject);
    const importProject = useCanvasStore((state) => state.importProject);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);

    const mode = searchParams.get("mode");
    const agentMode = mode === "new" || mode === "recent" || mode === "choose";
    const agentQuery = agentMode ? `?${searchParams.toString()}` : "";
    const enterProject = (id: string) => {
        const agentHash = hasAgentUrlBootstrap(window.location.hash) ? window.location.hash : "";
        navigate(`/canvas/${id}${agentQuery}${agentHash}`, { replace: Boolean(agentHash) });
    };
    const createAndEnter = () => enterProject(createProject(t("canvas.defaultTitle", { count: projects.length + 1 })));
    const importCanvas = async (file?: File) => {
        if (!file) return;
        let createdCount=0;
        try {
            if(file.size>100_000_000)throw new Error("画布文件过大");
            const zip=await readZip(file),projectFile=zip.get("projects.json");
            if(!projectFile)throw new Error("画布文件缺少项目数据");
            const data=JSON.parse(await projectFile.text()) as CanvasExportFile;
            if(data.app!=="infinite-canvas" || !Array.isArray(data.projects) || !data.projects.length || data.projects.length>50)throw new Error("画布文件无效");
            for(const item of data.projects){
                if(!item.project || !Array.isArray(item.files) || item.files.some(asset=>!asset.storageKey.startsWith("image:") || !zip.has(asset.path))) throw new Error("画布文件缺少图片或包含不支持的媒体");
                for(const asset of item.files){
                    const blob=zip.get(asset.path)!;
                    if(blob.size>25_000_000 || !["image/png","image/jpeg","image/webp"].includes(asset.mimeType))throw new Error("图片格式或大小不受支持");
                }
                const preliminary=new Map(item.files.map(asset=>[asset.storageKey,{storageKey:asset.storageKey,url:""}]));
                rewriteImportedProject(item.project,"preview",preliminary);
            }
            for(const item of data.projects){
                const id=createProject(item.project.title);
                createdCount++;
                const created=useCanvasStore.getState().openProject(id);
                if(!created)throw new Error("画布创建失败");
                await projectRepository.ensure(created);
                const mapping=new Map();
                for(const asset of item.files){
                    const blob=zip.get(asset.path)!;
                    const result=await localApi.upload(id,await blobToBase64(blob),asset.mimeType);
                    mapping.set(asset.storageKey,{storageKey:`image:${id}:${result.id}`,url:localApi.assetUrl(id,result.id)});
                }
                const restored=rewriteImportedProject(item.project,id,mapping);
                useCanvasStore.setState(state=>({projects:state.projects.map(project=>project.id===id ? restored : project)}));
            }
            message.success(t("canvas.imported",{count:data.projects.length}));
        } catch(error) {const reason=error instanceof Error ? error.message : t("canvas.importFailed");message.error(createdCount ? `${reason}；已创建 ${createdCount} 个画布，请检查后再重试，避免重复导入。` : reason);}
        finally {if(inputRef.current)inputRef.current.value="";}
    };

    useEffect(() => {
        if (!hydrated || autoOpenRef.current || (mode !== "new" && mode !== "recent")) return;
        autoOpenRef.current = true;
        enterProject(mode === "new" ? createProject(t("canvas.defaultTitle", { count: projects.length + 1 })) : projects[0]?.id || createProject(t("canvas.defaultTitle", { count: projects.length + 1 })));
    }, [createProject, hydrated, mode, projects, t]);

    if (hydrated && (mode === "new" || mode === "recent")) return <main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">{t("canvas.opening")}</main>;

    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div>
                        <p className="text-xs text-stone-500">{t("canvas.library")}</p>
                        <h1 className="mt-3 text-3xl font-semibold">{t("canvas.title")}</h1>
                    </div>
                    <div className="flex items-center gap-2">
                        {selectedIds.length ? (
                            <>
                                <Button disabled={!hydrated} icon={<Download className="size-4" />} onClick={() => void exportCanvasProjects(projects.filter((project) => selectedIds.includes(project.id)), `${t("canvas.title")}-${selectedIds.length}`)}>
                                    {t("canvas.exportSelected")}
                                </Button>
                                <Button disabled={!hydrated} onClick={() => setDeleteIds(selectedIds)}>
                                    {t("canvas.deleteSelected")}
                                </Button>
                            </>
                        ) : null}
                        {projects.length ? (
                            <Button disabled={!hydrated} onClick={() => setDeleteIds(projects.map((project) => project.id))}>
                                {t("canvas.deleteAll")}
                            </Button>
                        ) : null}
                        <Button disabled={!hydrated} onClick={() => void refreshArchived()}>已归档画布</Button>
                        <Button disabled={!hydrated} icon={<FileUp className="size-4" />} onClick={()=>inputRef.current?.click()}>{t("canvas.import")}</Button>
                        <Button disabled={!hydrated} type="primary" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            {t("canvas.create")}
                        </Button>
                    </div>
                </header>

                {showArchived && <section aria-label="已归档画布"><h2 className="text-lg font-semibold">已归档画布</h2>
                    {archived.length ? archived.map(item=><div key={item.id} className="flex items-center gap-4 py-2"><span>{item.title}</span><Button onClick={()=>void restoreArchived(item.id)}>恢复</Button></div>) : <p>暂无归档画布</p>}
                </section>}
                {!hydrated ? (
                    <section className="flex min-h-[360px] items-center justify-center border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">{t("canvas.loading")}</section>
                ) : projects.length ? (
                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                        {projects.map((project) => (
                            <CanvasProjectCard key={project.id} project={project} />
                        ))}
                    </div>
                ) : (
                    <section className="flex min-h-[360px] flex-col items-center justify-center border-y border-stone-200 text-center dark:border-stone-800">
                        <h2 className="text-xl font-medium">{t("canvas.empty")}</h2>
                        <p className="mt-3 text-sm text-stone-500">{t("canvas.emptyDescription")}</p>
                        <Button type="primary" className="mt-6" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            {t("canvas.create")}
                        </Button>
                    </section>
                )}
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <CanvasDeleteProjectsDialog />
        </main>
    );
}
