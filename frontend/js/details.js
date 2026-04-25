
// ====== 详情页模块配置逻辑 ======
function initModules() {
    const grid = document.getElementById('moduleGrid');
    if (!grid) return;
    grid.innerHTML = '';
    modules.forEach(mod => {
        const activeClasses = mod.active ? 'border-blue-500 bg-blue-50 shadow-sm' : 'border-gray-200 bg-white hover:border-blue-300';
        const titleClasses = mod.active ? 'text-blue-600' : 'text-gray-700';
        const iconHTML = mod.active ? `<i class="ph-fill ph-check-circle text-blue-500 absolute top-2 right-2 text-sm"></i>` : '';

        let countControlHTML = '';
        if (mod.active) {
            countControlHTML = `
                <div class="mt-2 pt-2 border-t border-blue-100 flex items-center justify-between" onclick="event.stopPropagation()">
                    <span class="text-[10px] text-gray-500">张数</span>
                    <div class="flex items-center bg-white rounded border border-gray-200">
                        <button onclick="updateModuleCount('${mod.id}', -1)" class="w-6 h-5 flex items-center justify-center text-gray-400 hover:text-blue-600 disabled:opacity-30" ${mod.count <= 1 ? 'disabled' : ''}><i class="ph ph-minus text-[10px]"></i></button>
                        <span class="text-[10px] font-bold w-4 text-center">${mod.count}</span>
                        <button onclick="updateModuleCount('${mod.id}', 1)" class="w-6 h-5 flex items-center justify-center text-gray-400 hover:text-blue-600 disabled:opacity-30" ${mod.count >= 5 ? 'disabled' : ''}><i class="ph ph-plus text-[10px]"></i></button>
                    </div>
                </div>`;
        }

        grid.insertAdjacentHTML('beforeend', `
            <div onclick="toggleModule('${mod.id}')" class="relative cursor-pointer border rounded-lg p-2.5 transition-all flex flex-col justify-between ${activeClasses}">
                ${iconHTML}
                <div>
                    <div class="text-xs font-bold ${titleClasses} mb-0.5">${mod.title}</div>
                    <div class="text-[10px] text-gray-400 truncate pr-4">${mod.subtitle}</div>
                </div>
                ${countControlHTML}
            </div>`);
    });
}

function toggleModule(id) {
    const mod = modules.find(m => m.id === id);
    if (mod) { mod.active = !mod.active; initModules(); }
}

function updateModuleCount(id, delta) {
    const mod = modules.find(m => m.id === id);
    if (mod) {
        let newCount = mod.count + delta;
        if (newCount >= 1 && newCount <= 5) { mod.count = newCount; initModules(); }
    }
}

function toggleCustomRatio() {
    const select = document.getElementById('aspectRatioSelect');
    const container = document.getElementById('customRatioContainer');
    if (select.value === 'custom') {
        container.classList.remove('hidden'); container.classList.add('grid');
    } else {
        container.classList.add('hidden'); container.classList.remove('grid');
    }
}

// ====== 图像上传处理 ======
function handleImageUpload(event) {
    const file = event.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = e => {
            currentUploadedBase64 = e.target.result;
            document.getElementById('uploadedImagePreview').src = currentUploadedBase64;
            document.getElementById('imagePreviewContainer').classList.remove('hidden');
            document.getElementById('imagePreviewContainer').classList.add('flex');
            showToast('主图素材上传成功', 'success');
        }
        reader.readAsDataURL(file);
    }
}

function removeImage() {
    currentUploadedBase64 = null;
    document.getElementById('imageUpload').value = '';
    document.getElementById('imagePreviewContainer').classList.add('hidden');
    document.getElementById('imagePreviewContainer').classList.remove('flex');
}

// ====== 生成逻辑 ======
async function generateSellingPoints() {
    const logMsg = "开始提取核心卖点...";
    console.log(`%c[详情页] ${logMsg}`, "color: #6366f1; font-weight: bold;");
    remoteLog(logMsg);
    const btn = document.getElementById('aiWriteBtn');
    const textArea = document.getElementById('sellingPointsText');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="loader w-3 h-3 border-2 border-blue-500 border-t-transparent mr-1"></span> 生成中...';
    btn.disabled = true;

    let parts = [{
        text: `你是一名资深跨境电商运营与视觉营销文案专家，擅长将产品视觉信息转化为高转化详情页内容。

请基于我提供的商品图片，对产品进行专业分析，并输出适用于独立站/跨境电商详情页的“核心卖点文案”。

【分析要求】
1. 仔细观察图片，准确识别：
   - 商品类型
   - 材质/做工
   - 外观设计特点
   - 核心功能及使用方式
2. 结合电商用户视角，挖掘真实使用价值，而非表面描述

【输出内容】
1. 商品名称（简洁、具备电商属性）
2. 核心卖点（3-4点，条列形式）
   - 每一点需具备“功能 + 用户价值”表达（避免空泛）
   - 突出差异化与解决问题能力
3. 适用人群（明确细分人群）
4. 使用场景（具体生活或使用情境）

【写作要求】
- 语言具有销售力与说服力（偏向转化导向）
- 符合跨境电商（Shopify / Amazon / TikTok）的表达风格
- 避免空洞词汇，如“高品质”“优质”等无具体支撑描述
- 输出为清晰结构化文本（不要markdown格式）

请基于图片内容进行合理推断，不要编造明显不符合图片的信息。` }];
    if (currentUploadedBase64) {
        parts.push({ inlineData: { mimeType: currentUploadedBase64.split(';')[0].split(':')[1], data: currentUploadedBase64.split(',')[1] } });
    } else { showToast('未上传图片，将仅使用预设文案测试', 'info'); }

    try {
        const payload = { contents: [{ role: "user", parts: parts }] };
        remoteLog(`正在提取产品卖点 (视觉解析模式)...`);
        const res = await callAI(TEXT_MODEL, payload);
        const text = res.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
            textArea.value = text;
            showToast('卖点提取成功', 'success');
            remoteLog(`卖点提取成功: ${text.substring(0, 50)}...`);
        }
    } catch (err) {
        console.error(err); showToast('生成失败', 'error');
        remoteLog(`卖点提取失败: ${err.message}`);
    } finally {
        btn.innerHTML = origHtml; btn.disabled = false;
    }
}

async function generateSEOMetadata(task, sellingPoints) {
    const prompt = `你是一个专业的电商SEO专家。我正在为电商详情页的“${task.title}”模块生成一张商品图片。
产品核心信息：${sellingPoints.substring(0, 300)}

请用【English】为这张图片配发SEO数据，并提供【中文对照】：
1. seoTitle：简短且包含核心关键词的图片标题。
2. altText：用于无障碍浏览及搜索引擎抓取的图片 Alt 属性文本。

必须严格返回JSON结构，不要输出任何 Markdown 标记，直接输出：
{
  "seoTitle": {"target": "English Title", "zh": "中文对照标题"},
  "altText": {"target": "English Alt Text", "zh": "中文对照alt描述"}
}`;

    try {
        remoteLog(`正在为模块 [${task.title}] 生成 SEO 元数据...`);
        const res = await callAI(TEXT_MODEL, {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        });
        const text = res.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
            const data = JSON.parse(text);
            const getVal = (obj) => typeof obj === 'string' ? { target: obj, zh: '' } : { target: obj?.target || '', zh: obj?.zh || '' };

            const titleData = getVal(data.seoTitle);
            const altData = getVal(data.altText);

            const tTarget = document.getElementById(`seo-title-target-${task.uniqueId}`);
            const tZh = document.getElementById(`seo-title-zh-${task.uniqueId}`);
            const aTarget = document.getElementById(`alt-text-target-${task.uniqueId}`);
            const aZh = document.getElementById(`alt-text-zh-${task.uniqueId}`);

            if (tTarget) tTarget.value = titleData.target;
            if (tZh) tZh.value = titleData.zh;
            if (aTarget) aTarget.value = altData.target;
            if (aZh) aZh.value = altData.zh;
            remoteLog(`模块 [${task.title}] SEO 元数据生成成功`);
        }
    } catch (e) {
        console.warn("SEO Gen Fail:", e);
        remoteLog(`模块 [${task.title}] SEO 生成失败: ${e.message}`);
    }
}

async function generateAIPage() {
    const activeModules = modules.filter(m => m.active);
    if (!activeModules.length) { showToast('请至少选择一个模块', 'error'); return; }
    if (!currentUploadedBase64) { showToast('请先上传一张主图素材', 'error'); return; }

    const sellingPoints = document.getElementById('sellingPointsText').value;
    if (!sellingPoints) { showToast('请填写核心卖点', 'error'); return; }

    const startMsg = `开始详情页全案生成流程 | 模块总数: ${activeModules.length} | 并发控制: ${CONCURRENCY_LIMIT}`;
    console.log(`%c[详情页] ${startMsg}`, "color: #4f46e5; font-weight: bold;");
    remoteLog(startMsg);

    let ratioVal = document.getElementById('aspectRatioSelect').value;
    if (ratioVal === 'custom') ratioVal = `${document.getElementById('customRatioW').value}:${document.getElementById('customRatioH').value}`;

    const config = {
        imageStyle: document.getElementById('imageStyleSelect').value,
        platform: document.getElementById('platformSelect').value,
        language: document.getElementById('languageSelect').value,
        aspectRatio: ratioVal,
        marketingTheme: document.getElementById('marketingThemeSelect').value
    };

    const base64Data = currentUploadedBase64.split(',')[1];
    const mimeType = currentUploadedBase64.split(';')[0].split(':')[1];

    globalGenContext = {
        base64Data, mimeType, sellingPoints, config, tasks: {},
        longImageOrder: []
    };

    let taskQueue = [];
    activeModules.forEach(mod => {
        for (let i = 0; i < mod.count; i++) {
            const task = { ...mod, uniqueId: `${mod.id}_${i}`, displayTitle: mod.count > 1 ? `${mod.title} 0${i + 1}` : mod.title, variant: i, totalVariants: mod.count };
            taskQueue.push(task);
            globalGenContext.tasks[task.uniqueId] = task;
            globalGenContext.longImageOrder.push(task.uniqueId);
        }
    });

    document.getElementById('showcaseArea').classList.add('hidden');
    const resArea = document.getElementById('resultArea');
    resArea.classList.remove('hidden'); resArea.classList.add('flex');

    const container = document.getElementById('modulesResultContainer');
    container.innerHTML = '';

    const ratioStr = config.aspectRatio.replace(':', '/');
    taskQueue.forEach(task => {
        container.innerHTML += `
            <div id="result-mod-${task.uniqueId}" class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden flex flex-col group">
                <div class="bg-gray-50/80 px-5 py-3 border-b border-gray-100 flex justify-between items-center backdrop-blur">
                    <div class="flex items-center gap-2">
                        <span class="w-1.5 h-4 bg-blue-500 rounded-full"></span>
                        <span class="font-bold text-gray-700 text-sm">${task.displayTitle}</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="text-xs text-gray-400 mr-2">${task.subtitle}</span>
                        <button id="regen-btn-${task.uniqueId}" onclick="generateSingleWrap('${task.uniqueId}', true)" class="hidden flex items-center justify-center w-7 h-7 rounded bg-white border border-gray-200 text-gray-500 hover:text-blue-600 transition-colors shadow-sm" title="重绘图像"><i class="ph ph-arrows-clockwise text-sm"></i></button>
                    </div>
                </div>
                <div id="content-mod-${task.uniqueId}" class="p-6 flex flex-col items-center justify-center relative bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMCIgaGVpZ2h0PSIyMCI+PHJlY3Qgd2lkdGg9IjIwIiBoZWlnaHQ9IjIwIiBmaWxsPSIjZmZmIi8+PGNpcmNsZSBjeD0iMTAiIGN5PSIxMCIgcj0iMSIgZmlsbD0iI2YxZjFmMSIvPjwvc3ZnPg==')]" style="aspect-ratio: ${ratioStr}; min-height: 200px;">
                    <span class="loader border-blue-500 border-t-transparent w-8 h-8 mb-3"></span><span class="text-sm text-gray-500 font-medium tracking-wide">AI引擎构图中...</span>
                </div>
                <div class="border-t border-gray-100 bg-slate-50 p-4 flex flex-col gap-3">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-1.5"><i class="ph-fill ph-link text-blue-500"></i><span class="text-xs font-black text-gray-700 uppercase tracking-widest">SEO Meta-Data</span></div>
                        <button onclick="downloadModule('${task.uniqueId}', '${task.displayTitle}')" class="text-xs flex items-center gap-1 text-gray-500 hover:text-indigo-600 font-bold bg-white border border-gray-200 px-2 py-1 rounded shadow-sm transition-all active:scale-95"><i class="ph ph-download-simple"></i> 单存</button>
                    </div>
                    <div class="flex flex-col gap-2.5">
                        <div class="flex items-center gap-2">
                            <span class="text-[10px] font-bold text-gray-400 w-6">Title</span>
                            <div class="relative flex-1">
                                <input type="text" id="seo-title-target-${task.uniqueId}" class="w-full text-xs pl-2 pr-8 py-1.5 border border-gray-200 rounded outline-none focus:border-blue-400 bg-white shadow-inner" placeholder="English Title" readonly>
                                <button onclick="copyText('seo-title-target-${task.uniqueId}')" class="absolute inset-y-0 right-0 pr-2 flex items-center text-gray-400 hover:text-blue-600"><i class="ph ph-copy"></i></button>
                            </div>
                            <div class="relative flex-1">
                                <input type="text" id="seo-title-zh-${task.uniqueId}" class="w-full text-xs pl-2 pr-8 py-1.5 border border-gray-200 rounded outline-none focus:border-blue-400 bg-white shadow-inner text-gray-500" placeholder="中文标题" readonly>
                            </div>
                        </div>
                        <div class="flex items-start gap-2">
                            <span class="text-[10px] font-bold text-gray-400 w-6 mt-1">Alt</span>
                            <div class="relative flex-1">
                                <textarea id="alt-text-target-${task.uniqueId}" class="w-full text-xs pl-2 pr-8 py-1.5 border border-gray-200 rounded outline-none focus:border-blue-400 bg-white shadow-inner resize-none hide-scroll" rows="2" placeholder="English Alt" readonly></textarea>
                                <button onclick="copyText('alt-text-target-${task.uniqueId}')" class="absolute top-1 right-0 pr-2 flex items-start text-gray-400 hover:text-blue-600"><i class="ph ph-copy"></i></button>
                            </div>
                            <div class="relative flex-1">
                                <textarea id="alt-text-zh-${task.uniqueId}" class="w-full text-xs pl-2 pr-8 py-1.5 border border-gray-200 rounded outline-none focus:border-blue-400 bg-white shadow-inner resize-none hide-scroll text-gray-500" rows="2" placeholder="中文描述" readonly></textarea>
                            </div>
                        </div>
                    </div>
                </div>
            </div>`;
    });

    const btn = document.getElementById('generateBtn');
    const origBtnHtml = btn.innerHTML;
    btn.innerHTML = '<span class="loader mr-2 border-white border-t-transparent w-4 h-4"></span> 正在启动并发渲染引擎...';
    btn.disabled = true;

    const activeTasks = [];
    let completedCount = 0;

    for (let i = 0; i < taskQueue.length; i++) {
        if (activeTasks.length >= CONCURRENCY_LIMIT) {
            await Promise.race(activeTasks);
        }

        const task = taskQueue[i];
        const submitMsg = `正在提交任务 [${task.title}] (${i + 1}/${taskQueue.length})`;
        console.log(`%c[详情页] ${submitMsg}`, "color: #8b5cf6;");
        remoteLog(submitMsg);

        const taskPromise = (async () => {
            try {
                await generateSingleWrap(task.uniqueId);
                const finishMsg = `模块 [${task.title}] 渲染成功`;
                console.log(`%c[详情页] ${finishMsg}`, "color: #10b981;");
                remoteLog(finishMsg);
            } catch (e) {
                console.error(`Task ${task.uniqueId} failed:`, e);
                remoteLog(`模块 [${task.title}] 渲染异常: ${e.message}`);
            } finally {
                completedCount++;
                btn.innerHTML = `<span class="loader mr-2 border-white border-t-transparent w-4 h-4"></span> 正在并行渲染 (${completedCount}/${taskQueue.length})...`;
            }
        })();

        activeTasks.push(taskPromise);
        taskPromise.finally(() => {
            const idx = activeTasks.indexOf(taskPromise);
            if (idx > -1) activeTasks.splice(idx, 1);
        });

        if (i < taskQueue.length - 1) {
            await new Promise(r => setTimeout(r, STAGGER_DELAY));
        }
    }

    await Promise.all(activeTasks);
    btn.innerHTML = origBtnHtml; btn.disabled = false;
    showToast('全案模块生成完毕！', 'success');
    remoteLog(`详情页全案生成结束`);
}

async function generateSingleWrap(uniqueId, skipSEO = false) {
    const task = globalGenContext.tasks[uniqueId];
    if (!task) return;

    remoteLog(`开始渲染模块: ${task.title}`);
    const contentDiv = document.getElementById(`content-mod-${uniqueId}`);
    if (!contentDiv) return;

    contentDiv.innerHTML = `<span class="loader border-blue-500 border-t-transparent w-8 h-8 mb-3"></span><span class="text-sm text-gray-500 font-medium">AI引擎构图中...</span>`;
    document.getElementById(`regen-btn-${uniqueId}`)?.classList.add('hidden');
    contentDiv.classList.add('p-6', 'flex-col', 'items-center', 'justify-center');

    const { base64Data, mimeType, sellingPoints, config } = globalGenContext;

    const themeContext = config.marketingTheme !== 'none' ? `5. Marketing Theme: ${config.marketingTheme} - It is CRITICAL to integrate this theme naturally into the visual.` : '';

    let prompt = `Task: Professional e-commerce section for "${task.title}". Req: ${task.prompt}. Context: ${sellingPoints.substring(0, 150)}.
CONSTRAINTS:
1. Target Platform: ${config.platform}
2. Language: ALL text MUST be ${config.language}
3. Aspect Ratio: ${config.aspectRatio}
4. Aesthetic Style: ${config.imageStyle} - CRITICAL to follow this vibe.
${themeContext}
${task.totalVariants > 1 ? `6. Variation: version ${task.variant + 1}/${task.totalVariants}. Make it unique.` : ''}`;

    let parts = [{ text: prompt }, { inlineData: { mimeType, data: base64Data } }];
    const payload = { contents: [{ role: "user", parts: parts }], generationConfig: { responseModalities: ['IMAGE'] } };

    try {
        const promises = [callAI(IMAGE_MODEL, payload)];
        if (!skipSEO) {
            promises.push(generateSEOMetadata(task, sellingPoints));
        }

        const results = await Promise.all(promises);
        const imgRes = results[0];

        const imagePart = imgRes.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
        if (imagePart?.inlineData) {
            const generatedSrc = `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
            contentDiv.innerHTML = `<img src="${generatedSrc}" class="w-full h-full object-cover">`;
            contentDiv.classList.remove('p-6', 'flex-col', 'items-center', 'justify-center');
            contentDiv.style.padding = '0';
        } else throw new Error("No image data in response");

    } catch (error) {
        console.warn(`[Fallback] Module rendering via code CSS:`, error);
        remoteLog(`模块 [${task.title}] 触发 Fallback 渲染`);
        renderMockModule(contentDiv, task, sellingPoints, config, currentUploadedBase64);
        if (!skipSEO) {
            await generateSEOMetadata(task, sellingPoints);
        }
    }

    document.getElementById(`regen-btn-${uniqueId}`)?.classList.remove('hidden');
}

function renderMockModule(container, task, points, config, imgSrc) {
    if (!container) return;
    const ratioStr = config.aspectRatio.replace(':', '/');
    const themeTag = config.marketingTheme !== 'none' ? `<div class="absolute top-4 left-4 bg-orange-500 text-white text-[9px] font-black px-2 py-1 rounded shadow-lg uppercase tracking-tighter z-10 animate-bounce">${config.marketingTheme} EDITION</div>` : '';

    let content = `<div class="w-full h-full flex flex-col items-center justify-center p-8 text-center bg-gradient-to-br from-slate-50 to-slate-100 relative overflow-hidden">
        ${themeTag}
        <img src="${imgSrc}" class="h-3/5 object-contain drop-shadow-2xl mb-6 max-w-full transform hover:scale-105 transition-transform duration-700">
        <h3 class="text-xl font-black text-slate-800 tracking-wider uppercase">${task.title}</h3>
        <div class="w-12 h-1 bg-blue-500 my-3 rounded-full"></div>
        <p class="text-[10px] text-slate-500 mt-1 max-w-xs leading-relaxed font-medium">${points.substring(0, 80)}...</p>
        <div class="mt-6 flex items-center gap-2">
            <span class="px-3 py-1 bg-white border border-slate-200 rounded-full text-[9px] font-black text-slate-400 uppercase tracking-widest">${config.imageStyle.split(',')[0]}</span>
            <span class="w-1 h-1 rounded-full bg-slate-300"></span>
            <span class="text-[9px] font-black text-blue-500 uppercase">${config.platform}</span>
        </div>
    </div>`;
    container.innerHTML = `<div class="w-full h-full overflow-hidden" style="aspect-ratio: ${ratioStr};">${content}</div>`;
    container.classList.remove('p-6', 'flex-col', 'items-center', 'justify-center');
    container.style.padding = '0';
}

function resetView() {
    document.getElementById('resultArea').classList.add('hidden');
    document.getElementById('resultArea').classList.remove('flex');
    document.getElementById('showcaseArea').classList.remove('hidden');
    setTimeout(() => { document.getElementById('showcaseArea').classList.remove('opacity-0'); }, 50);
}

async function downloadModule(modId, modTitle, isBatch = false) {
    const el = document.getElementById(`content-mod-${modId}`);
    if (!el) return;
    try {
        if (!isBatch) showToast(`正在打包...`, 'info');
        const canvas = await html2canvas(el, { useCORS: true, scale: 2, backgroundColor: '#ffffff' });
        const link = document.createElement('a');

        let baseFilename = modTitle;
        const seoInput = document.getElementById(`seo-title-target-${modId}`);
        if (seoInput && seoInput.value && seoInput.value.length > 2) {
            const parsedTitle = seoInput.value.trim().replace(/[/\\?%*:|"<>]/g, '-');
            if (parsedTitle) baseFilename = parsedTitle;
        }

        const pad = n => n.toString().padStart(2, '0');
        const d = new Date();
        const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;

        link.download = `${baseFilename}_${ts}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
        if (!isBatch) showToast('下载成功', 'success');
    } catch (e) { console.error(e); if (!isBatch) showToast('下载失败', 'error'); }
}

async function downloadAllModules() {
    if (!globalGenContext || !Object.keys(globalGenContext.tasks).length) return;
    showToast('开始批量打包，请耐心等待...', 'info');
    const ids = Object.keys(globalGenContext.tasks);
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        await downloadModule(id, globalGenContext.tasks[id].displayTitle, true);
        await new Promise(r => setTimeout(r, 600));
    }
    showToast('全部下载完毕！', 'success');
}

// ====== 长图拖拽排版台逻辑 ======
function openLongImageBuilder() {
    if (!globalGenContext || !globalGenContext.longImageOrder.length) {
        showToast('尚未生成任何模块', 'error'); return;
    }
    renderSortableList();
    document.getElementById('longImageBuilderModal').classList.remove('hidden');
}

function closeLongImageBuilder() {
    document.getElementById('longImageBuilderModal').classList.add('hidden');
}

function renderSortableList() {
    const list = document.getElementById('sortableList');
    const canvas = document.getElementById('longImageCanvas');
    if (!list || !canvas) return;
    list.innerHTML = '';
    canvas.innerHTML = '';

    globalGenContext.longImageOrder.forEach((id) => {
        const task = globalGenContext.tasks[id];
        if (!task) return;

        const li = document.createElement('div');
        li.className = 'bg-white border border-gray-200 p-3 rounded-lg shadow-sm cursor-move flex items-center gap-3 hover:border-indigo-400 select-none transition-colors';
        li.draggable = true;
        li.dataset.id = id;
        li.innerHTML = `
            <i class="ph ph-dots-six-vertical text-gray-400 text-lg"></i>
            <div class="flex-1 min-w-0">
                <div class="text-xs font-bold text-gray-700 truncate">${task.displayTitle}</div>
                <div class="text-[10px] text-gray-400 truncate">${task.subtitle}</div>
            </div>
        `;

        li.addEventListener('dragstart', (e) => {
            draggedItem = li;
            setTimeout(() => li.classList.add('ghost-item'), 0);
        });

        li.addEventListener('dragend', () => {
            setTimeout(() => {
                draggedItem.classList.remove('ghost-item');
                draggedItem = null;
                updatePreviewOrder();
            }, 0);
        });

        li.addEventListener('dragover', e => e.preventDefault());
        li.addEventListener('dragenter', function (e) {
            e.preventDefault();
            if (this !== draggedItem) this.classList.add('border-indigo-500', 'bg-indigo-50/50');
        });
        li.addEventListener('dragleave', function () {
            this.classList.remove('border-indigo-500', 'bg-indigo-50/50');
        });
        li.addEventListener('drop', function () {
            this.classList.remove('border-indigo-500', 'bg-indigo-50/50');
            if (this !== draggedItem) {
                const allItems = [...list.children];
                const curPos = allItems.indexOf(draggedItem);
                const dropPos = allItems.indexOf(this);
                if (curPos < dropPos) this.parentNode.insertBefore(draggedItem, this.nextSibling);
                else this.parentNode.insertBefore(draggedItem, this);
            }
        });

        list.appendChild(li);

        const contentDiv = document.getElementById(`content-mod-${id}`);
        if (contentDiv) {
            const img = contentDiv.querySelector('img');
            if (img) {
                const cloneImg = document.createElement('img');
                cloneImg.src = img.src;
                cloneImg.className = 'w-full h-auto block m-0 p-0 border-none';
                cloneImg.dataset.id = id;
                cloneImg.crossOrigin = 'anonymous';
                canvas.appendChild(cloneImg);
            }
        }
    });
}

function updatePreviewOrder() {
    const list = document.getElementById('sortableList');
    const newOrder = [...list.children].map(li => li.dataset.id);
    globalGenContext.longImageOrder = newOrder;

    const canvas = document.getElementById('longImageCanvas');
    const images = [...canvas.children];
    newOrder.forEach(id => {
        const img = images.find(img => img.dataset.id === id);
        if (img) canvas.appendChild(img);
    });
}

async function aiSortLongImage() {
    if (!globalGenContext || !globalGenContext.longImageOrder.length) return;
    const btn = document.getElementById('aiSortBtn');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<i class="ph ph-spinner animate-spin text-sm"></i> 智能计算中...';
    btn.disabled = true;

    const modulesToSort = globalGenContext.longImageOrder.map(id => {
        const task = globalGenContext.tasks[id];
        return { id: id, title: task.title, subtitle: task.subtitle };
    });

    const prompt = `你是一个资深跨境电商运营与高转化详情页架构专家。
目前我有以下详情页模块需要组合成一张长图。请根据“高转化营销逻辑”（如 AIDA 模型）对这些模块进行最优排序。
产品卖点背景：${globalGenContext.sellingPoints.substring(0, 300)}
待排序模块列表：${JSON.stringify(modulesToSort)}
任务要求：
1. 必须返回所有输入的模块 ID，不能遗漏。
2. 严格返回 JSON 数组格式，仅包含排序后的 ID 字符串列表。
直接返回纯净的 JSON 数组，不要任何解释。`;

    try {
        const res = await callAI(TEXT_MODEL, {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        });
        const text = res.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
            const sortedIds = JSON.parse(text);
            if (Array.isArray(sortedIds)) {
                globalGenContext.longImageOrder = sortedIds;
                renderSortableList();
                showToast('AI 智能排序已应用', 'success');
            }
        }
    } catch (err) { console.error(err); showToast('AI 排序失败', 'error'); }
    finally { btn.innerHTML = origHtml; btn.disabled = false; }
}

async function executeLongImageDownload() {
    const canvasEl = document.getElementById('longImageCanvas');
    const format = document.getElementById('exportQualitySelect').value;
    const btn = document.getElementById('btnDownloadLong');
    const origHTML = btn.innerHTML;

    btn.disabled = true;
    btn.innerHTML = '<i class="ph ph-spinner animate-spin text-lg"></i> 渲染中...';

    try {
        await new Promise(r => setTimeout(r, 300));
        const finalCanvas = await html2canvas(canvasEl, { useCORS: true, scale: format === 'png' ? 2 : 1.5, backgroundColor: '#ffffff', logging: false });
        const link = document.createElement('a');
        const ts = Date.now();

        if (format === 'png') {
            link.download = `AI详情页长图_${ts}.png`;
            link.href = finalCanvas.toDataURL('image/png');
        } else {
            link.download = `AI详情页长图_${ts}.jpg`;
            link.href = finalCanvas.toDataURL('image/jpeg', 0.85);
        }

        link.click();
        showToast(`导出成功`, 'success');

        // 存档全案
        saveToHistory('render', {
            name: `全案详情页_${ts}`,
            style: globalGenContext?.config?.imageStyle || '默认',
            image: finalCanvas.toDataURL('image/jpeg', 0.6),
            metadata: { count: globalGenContext?.longImageOrder?.length || 0 }
        });
    } catch (e) { showToast('导出失败', 'error'); }
    finally { btn.innerHTML = origHTML; btn.disabled = false; }
}
