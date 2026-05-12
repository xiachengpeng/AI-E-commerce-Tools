
// ====== 详情页模块配置逻辑 ======
const DETAIL_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const DETAIL_MAX_TASKS = 24;
const DETAIL_MAX_UPLOAD_IMAGES = 6;

function detailEscapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]));
}

function getSelectedOptionLabel(selectId) {
    const select = document.getElementById(selectId);
    return select?.options?.[select.selectedIndex]?.text || select?.value || '';
}

function normalizeAspectRatio(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    if (width > 50 || height > 50) return null;
    return `${width}:${height}`;
}

function getDetailConfig() {
    let ratioVal = document.getElementById('aspectRatioSelect')?.value || '1:1';
    if (ratioVal === 'custom') {
        ratioVal = `${document.getElementById('customRatioW')?.value || ''}:${document.getElementById('customRatioH')?.value || ''}`;
    }
    const aspectRatio = normalizeAspectRatio(ratioVal);
    if (!aspectRatio) {
        showToast('请填写有效的宽高比，例如 3:4', 'error');
        return null;
    }

    const region = document.getElementById('regionSelect')?.value || 'Global Market';
    return {
        imageStyle: document.getElementById('imageStyleSelect')?.value || '',
        imageStyleLabel: getSelectedOptionLabel('imageStyleSelect'),
        platform: document.getElementById('platformSelect')?.value || '',
        platformLabel: getSelectedOptionLabel('platformSelect'),
        region,
        regionLabel: getSelectedOptionLabel('regionSelect'),
        marketTone: MARKET_TONE_MAP?.[region] || MARKET_TONE_MAP?.["Global Market"] || '',
        language: document.getElementById('languageSelect')?.value || 'English',
        languageLabel: getSelectedOptionLabel('languageSelect'),
        aspectRatio,
        marketingTheme: document.getElementById('marketingThemeSelect')?.value || 'none',
        marketingThemeLabel: getSelectedOptionLabel('marketingThemeSelect')
    };
}

function setModuleStatus(uniqueId, status, message = '') {
    const badge = document.getElementById(`status-badge-${uniqueId}`);
    if (!badge) return;
    const styles = {
        pending: 'bg-slate-100 text-slate-500 border-slate-200',
        loading: 'bg-blue-50 text-blue-600 border-blue-100',
        success: 'bg-emerald-50 text-emerald-600 border-emerald-100',
        fallback: 'bg-amber-50 text-amber-700 border-amber-100',
        error: 'bg-red-50 text-red-600 border-red-100'
    };
    const labels = {
        pending: '等待中',
        loading: '生成中',
        success: '已完成',
        fallback: '降级图',
        error: '失败'
    };
    badge.className = `text-[10px] font-black px-2 py-0.5 rounded-full border ${styles[status] || styles.pending}`;
    badge.textContent = message || labels[status] || labels.pending;
}

function getModuleSeo(uniqueId) {
    return {
        titleTarget: document.getElementById(`seo-title-target-${uniqueId}`)?.value || '',
        titleZh: document.getElementById(`seo-title-zh-${uniqueId}`)?.value || '',
        altTarget: document.getElementById(`alt-text-target-${uniqueId}`)?.value || '',
        altZh: document.getElementById(`alt-text-zh-${uniqueId}`)?.value || ''
    };
}

function setModuleSeo(uniqueId, seo = {}) {
    const fields = {
        [`seo-title-target-${uniqueId}`]: seo.titleTarget || seo.seoTitle?.target || '',
        [`seo-title-zh-${uniqueId}`]: seo.titleZh || seo.seoTitle?.zh || '',
        [`alt-text-target-${uniqueId}`]: seo.altTarget || seo.altText?.target || '',
        [`alt-text-zh-${uniqueId}`]: seo.altZh || seo.altText?.zh || ''
    };
    Object.entries(fields).forEach(([id, value]) => {
        const el = document.getElementById(id);
        if (el) el.value = value;
    });
}

function getModuleImageSrc(uniqueId) {
    return document.getElementById(`content-mod-${uniqueId}`)?.querySelector('img')?.src || '';
}

function validateSortedIds(sortedIds, expectedIds) {
    if (!Array.isArray(sortedIds)) return null;
    const expected = new Set(expectedIds);
    const clean = [];
    sortedIds.forEach(id => {
        if (expected.has(id) && !clean.includes(id)) clean.push(id);
    });
    expectedIds.forEach(id => {
        if (!clean.includes(id)) clean.push(id);
    });
    return clean.length === expectedIds.length ? clean : null;
}

function parseImageDataUrl(dataUrl) {
    if (!dataUrl || !dataUrl.includes(',')) return null;
    return {
        mimeType: dataUrl.split(';')[0].split(':')[1],
        data: dataUrl.split(',')[1]
    };
}

async function imageUrlToDataUrl(src) {
    if (!src || src.startsWith('data:image')) return src;
    const response = await fetch(formatImgSrc(src));
    if (!response.ok) throw new Error(`图片读取失败: ${response.status}`);
    const blob = await response.blob();
    return await fileToDataUrl(blob);
}

async function ensureInlineImageData(image) {
    if (!image) return null;
    if (image.data && image.mimeType) return image;
    const dataUrl = await imageUrlToDataUrl(image.base64 || image.imageSrc || '');
    const parsed = parseImageDataUrl(dataUrl);
    if (!parsed) return null;
    return {
        ...image,
        base64: dataUrl,
        mimeType: parsed.mimeType,
        data: parsed.data
    };
}

function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function getPrimaryUploadedImage() {
    if (Array.isArray(currentUploadedImages) && currentUploadedImages.length) {
        return currentUploadedImages[0];
    }
    return currentUploadedBase64 ? {
        id: 'primary_legacy',
        name: '主图',
        base64: currentUploadedBase64,
        isPrimary: true,
        ...parseImageDataUrl(currentUploadedBase64)
    } : null;
}

function getAngleUploadedImages() {
    return Array.isArray(currentUploadedImages) ? currentUploadedImages.slice(1) : [];
}

function renderUploadedImagePreviews() {
    const container = document.getElementById('imagePreviewContainer');
    if (!container) return;

    if (!currentUploadedImages.length) {
        container.innerHTML = '';
        container.classList.add('hidden');
        container.classList.remove('flex');
        return;
    }

    container.classList.remove('hidden');
    container.classList.add('flex');
    container.innerHTML = currentUploadedImages.map((img, index) => `
        <div class="w-[84px] h-[84px] rounded-lg border border-gray-200 bg-gray-50 overflow-hidden relative group shadow-inner">
            <img src="${detailEscapeHtml(img.base64)}" alt="${detailEscapeHtml(img.name || 'Product')}" class="w-full h-full object-cover">
            <span class="absolute left-1 bottom-1 text-[9px] font-black px-1.5 py-0.5 rounded bg-black/60 text-white">${index === 0 ? '主图' : `角度${index}`}</span>
            ${index > 0 ? `<button onclick="setPrimaryImage(${index})" title="设为主图"
                class="absolute left-1 top-1 bg-white/90 text-blue-600 rounded px-1.5 py-0.5 text-[9px] font-black opacity-0 group-hover:opacity-100 transition-opacity">主图</button>` : ''}
            <button onclick="removeImage(${index})"
                class="absolute top-1 right-1 bg-black/60 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"><i
                    class="ph ph-x text-xs"></i></button>
        </div>
    `).join('');
}

function setPrimaryImage(index) {
    if (!Array.isArray(currentUploadedImages) || index <= 0 || index >= currentUploadedImages.length) return;
    const [selected] = currentUploadedImages.splice(index, 1);
    currentUploadedImages.unshift(selected);
    currentUploadedImages = currentUploadedImages.map((img, idx) => ({ ...img, isPrimary: idx === 0 }));
    currentUploadedBase64 = currentUploadedImages[0]?.base64 || null;
    renderUploadedImagePreviews();
    showToast('已设为主图', 'success');
}

function getImagesForTask(task) {
    const primaryImage = globalGenContext.primaryImage;
    const angleImages = globalGenContext.angleImages || [];
    const isAngleModule = task.id === 'm4';
    if (!isAngleModule) return primaryImage ? [primaryImage] : [];
    return primaryImage ? [primaryImage, ...angleImages].slice(0, 6) : [];
}

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
async function handleImageUpload(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    const remainingSlots = DETAIL_MAX_UPLOAD_IMAGES - currentUploadedImages.length;
    if (remainingSlots <= 0) {
        showToast(`最多上传 ${DETAIL_MAX_UPLOAD_IMAGES} 张素材`, 'warning');
        event.target.value = '';
        return;
    }
    const selectedFiles = files.slice(0, remainingSlots);
    if (files.length > remainingSlots) {
        showToast(`最多保留 ${DETAIL_MAX_UPLOAD_IMAGES} 张素材，已自动忽略多余图片`, 'warning');
    }

    const validFiles = [];
    for (const file of selectedFiles) {
        if (!file.type.startsWith('image/')) {
            showToast('请上传图片文件', 'error');
            event.target.value = '';
            return;
        }
        if (file.size > DETAIL_IMAGE_MAX_BYTES) {
            showToast('图片过大，请压缩到 8MB 以内', 'error');
            event.target.value = '';
            return;
        }
        validFiles.push(file);
    }

    try {
        const uploaded = await Promise.all(validFiles.map(async (file) => {
            const base64 = await fileToDataUrl(file);
            return {
                id: `detail_img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                name: file.name,
                base64,
                isPrimary: false,
                ...parseImageDataUrl(base64)
            };
        }));
        currentUploadedImages = [...currentUploadedImages, ...uploaded]
            .slice(0, DETAIL_MAX_UPLOAD_IMAGES)
            .map((img, index) => ({ ...img, isPrimary: index === 0 }));
        currentUploadedBase64 = currentUploadedImages[0]?.base64 || null;
        renderUploadedImagePreviews();
        const angleCount = Math.max(0, currentUploadedImages.length - 1);
        showToast(angleCount ? `已上传 ${currentUploadedImages.length} 张素材，多角度图将优先使用角度素材` : '主图素材上传成功', 'success');
    } catch (e) {
        console.error(e);
        showToast('图片读取失败', 'error');
    } finally {
        event.target.value = '';
    }
}

function removeImage(index = null) {
    if (index === null || index === undefined) {
        currentUploadedImages = [];
    } else {
        currentUploadedImages.splice(index, 1);
        currentUploadedImages = currentUploadedImages.map((img, idx) => ({ ...img, isPrimary: idx === 0 }));
    }
    currentUploadedBase64 = currentUploadedImages[0]?.base64 || null;
    document.getElementById('imageUpload').value = '';
    renderUploadedImagePreviews();
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
    const sellingPointImages = [getPrimaryUploadedImage(), ...getAngleUploadedImages().slice(0, 2)].filter(Boolean);
    if (sellingPointImages.length) {
        if (sellingPointImages.length > 1) {
            parts[0].text += `\n\n我同时提供了 ${sellingPointImages.length} 张商品素材。第一张是主图，后续为角度/细节参考。请综合判断，但不要把不同角度误认为不同产品。`;
        }
        sellingPointImages.forEach(img => {
            parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
        });
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
目标平台：${globalGenContext?.config?.platformLabel || globalGenContext?.config?.platform || '跨境电商'}
目标市场：${globalGenContext?.config?.regionLabel || globalGenContext?.config?.region || '全球'}

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
            const seo = {
                titleTarget: titleData.target,
                titleZh: titleData.zh,
                altTarget: altData.target,
                altZh: altData.zh
            };
            setModuleSeo(task.uniqueId, seo);
            task.seo = seo;
            remoteLog(`模块 [${task.title}] SEO 元数据生成成功`);
            return seo;
        }
    } catch (e) {
        console.warn("SEO Gen Fail:", e);
        remoteLog(`模块 [${task.title}] SEO 生成失败: ${e.message}`);
    }
    return null;
}

async function generateAIPage() {
    const activeModules = modules.filter(m => m.active);
    if (!activeModules.length) { showToast('请至少选择一个模块', 'error'); return; }
    const primaryImage = getPrimaryUploadedImage();
    const angleImages = getAngleUploadedImages();
    if (!primaryImage) { showToast('请先上传一张主图素材', 'error'); return; }
    const totalTaskCount = activeModules.reduce((sum, mod) => sum + (mod.count || 1), 0);
    if (totalTaskCount > DETAIL_MAX_TASKS) {
        showToast(`当前共 ${totalTaskCount} 张，建议控制在 ${DETAIL_MAX_TASKS} 张以内`, 'error');
        return;
    }

    const sellingPoints = document.getElementById('sellingPointsText').value;
    if (!sellingPoints) { showToast('请填写核心卖点', 'error'); return; }

    const startMsg = `开始详情页全案生成流程 | 出图总数: ${totalTaskCount} | 并发控制: ${CONCURRENCY_LIMIT}`;
    console.log(`%c[详情页] ${startMsg}`, "color: #4f46e5; font-weight: bold;");
    remoteLog(startMsg);

    const config = getDetailConfig();
    if (!config) return;

    globalGenContext = {
        base64Data: primaryImage.data,
        mimeType: primaryImage.mimeType,
        primaryImage,
        angleImages,
        uploadedImages: [primaryImage, ...angleImages],
        sellingPoints,
        config,
        tasks: {},
        longImageOrder: []
    };

    let taskQueue = [];
    activeModules.forEach(mod => {
        for (let i = 0; i < mod.count; i++) {
            const task = { ...mod, uniqueId: `${mod.id}_${i}`, displayTitle: mod.count > 1 ? `${mod.title} 0${i + 1}` : mod.title, variant: i, totalVariants: mod.count, status: 'pending' };
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
                        <span class="font-bold text-gray-700 text-sm">${detailEscapeHtml(task.displayTitle)}</span>
                        <span id="status-badge-${task.uniqueId}" class="text-[10px] font-black px-2 py-0.5 rounded-full border bg-slate-100 text-slate-500 border-slate-200">等待中</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="text-xs text-gray-400 mr-2">${detailEscapeHtml(task.subtitle)}</span>
                        <button id="regen-btn-${task.uniqueId}" onclick="generateSingleWrap('${task.uniqueId}')" class="hidden flex items-center justify-center w-7 h-7 rounded bg-white border border-gray-200 text-gray-500 hover:text-blue-600 transition-colors shadow-sm" title="重绘图像并刷新 SEO"><i class="ph ph-arrows-clockwise text-sm"></i></button>
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
    let successCount = 0;
    let fallbackCount = 0;
    let errorCount = 0;

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
                const result = await generateSingleWrap(task.uniqueId);
                if (result?.status === 'success') successCount++;
                else if (result?.status === 'fallback') fallbackCount++;
                else errorCount++;
                const finishMsg = `模块 [${task.title}] 渲染成功`;
                console.log(`%c[详情页] ${finishMsg}`, "color: #10b981;");
                remoteLog(finishMsg);
            } catch (e) {
                errorCount++;
                console.error(`Task ${task.uniqueId} failed:`, e);
                setModuleStatus(task.uniqueId, 'error');
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
    const summary = `生成完成：成功 ${successCount}，降级 ${fallbackCount}，失败 ${errorCount}`;
    showToast(summary, errorCount ? 'warning' : (fallbackCount ? 'warning' : 'success'));
    remoteLog(`详情页全案生成结束 | ${summary}`);
}

async function generateSingleWrap(uniqueId, skipSEO = false) {
    const task = globalGenContext.tasks[uniqueId];
    if (!task) return;

    remoteLog(`开始渲染模块: ${task.title}`);
    const contentDiv = document.getElementById(`content-mod-${uniqueId}`);
    if (!contentDiv) return;

    setModuleStatus(uniqueId, 'loading');
    task.status = 'loading';
    task.error = '';
    contentDiv.innerHTML = `<span class="loader border-blue-500 border-t-transparent w-8 h-8 mb-3"></span><span class="text-sm text-gray-500 font-medium">AI引擎构图中...</span>`;
    document.getElementById(`regen-btn-${uniqueId}`)?.classList.add('hidden');
    contentDiv.classList.add('p-6', 'flex-col', 'items-center', 'justify-center');
    contentDiv.style.padding = '';

    const { sellingPoints, config } = globalGenContext;
    const taskImages = (await Promise.all(getImagesForTask(task).map(img => ensureInlineImageData(img)))).filter(Boolean);
    if (!taskImages.length) {
        throw new Error('缺少可用的商品图片素材');
    }
    const isAngleModule = task.id === 'm4';
    const hasAngleReferences = isAngleModule && (globalGenContext.angleImages || []).length > 0;

    const themeContext = config.marketingTheme !== 'none' ? `6. Marketing Theme: ${config.marketingTheme} - It is CRITICAL to integrate this theme naturally into the visual.` : '';
    const variationRule = task.totalVariants > 1 ? `7. Variation: version ${task.variant + 1}/${task.totalVariants}. Make it unique while staying consistent with the same product.` : '';
    const angleRule = isAngleModule
        ? (hasAngleReferences
            ? `9. Multi-angle mode: I provided real angle reference images after the first primary image. Use these references faithfully to build a multi-angle collage. Do not hallucinate different product variants.`
            : `9. Multi-angle mode: Only one primary image is provided. Generate plausible front, side, back, detail, and perspective views from the primary image while preserving the exact product identity, proportions, materials, and colors.`)
        : '';

    let prompt = `Task: Professional e-commerce section for "${task.title}". Req: ${task.prompt}. Context: ${sellingPoints.substring(0, 150)}.
CONSTRAINTS:
1. Target Platform: ${config.platform}
2. Target Market: ${config.region}. Local tone: ${config.marketTone}
3. Language: ALL visible text MUST be ${config.language}
4. Aspect Ratio: ${config.aspectRatio}
5. Aesthetic Style: ${config.imageStyle} - CRITICAL to follow this vibe.
${themeContext}
${variationRule}
8. Keep the source product identity, shape, material, color, and key details stable. Do not invent logos, certifications, medical claims, or impossible performance promises.
${angleRule}`;

    let parts = [{ text: prompt }, ...taskImages.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.data } }))];
    const payload = {
        contents: [{ role: "user", parts: parts }],
        generationConfig: {
            responseModalities: ['IMAGE'],
            imageConfig: { aspectRatio: config.aspectRatio }
        }
    };

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
            task.imageSrc = generatedSrc;
            task.status = 'success';
            task.isFallback = false;
            setModuleStatus(uniqueId, 'success');
        } else throw new Error("No image data in response");

    } catch (error) {
        console.warn(`[Fallback] Module rendering via code CSS:`, error);
        remoteLog(`模块 [${task.title}] 触发 Fallback 渲染`);
        if (isAngleModule && taskImages.length > 1) {
            renderMultiAngleFallback(contentDiv, task, sellingPoints, config, taskImages);
        } else {
            renderMockModule(contentDiv, task, sellingPoints, config, taskImages[0]?.base64 || currentUploadedBase64);
        }
        if (!skipSEO) {
            await generateSEOMetadata(task, sellingPoints);
        }
        task.imageSrc = getModuleImageSrc(uniqueId);
        task.status = 'fallback';
        task.isFallback = true;
        task.error = error.message || String(error);
        setModuleStatus(uniqueId, 'fallback');
    }

    document.getElementById(`regen-btn-${uniqueId}`)?.classList.remove('hidden');
    task.seo = getModuleSeo(uniqueId);
    return { status: task.status, task };
}

function renderMockModule(container, task, points, config, imgSrc) {
    if (!container) return;
    const ratioStr = config.aspectRatio.replace(':', '/');
    const themeTag = config.marketingTheme !== 'none' ? `<div class="absolute top-4 left-4 bg-orange-500 text-white text-[9px] font-black px-2 py-1 rounded shadow-lg uppercase tracking-tighter z-10">${detailEscapeHtml(config.marketingThemeLabel || config.marketingTheme)}</div>` : '';
    const safeTitle = detailEscapeHtml(task.title);
    const safePoints = detailEscapeHtml(points.substring(0, 80));
    const safeStyle = detailEscapeHtml((config.imageStyleLabel || config.imageStyle || '').split(',')[0]);
    const safePlatform = detailEscapeHtml(config.platformLabel || config.platform);
    const safeImg = detailEscapeHtml(imgSrc || '');

    let content = `<div class="w-full h-full flex flex-col items-center justify-center p-8 text-center bg-gradient-to-br from-slate-50 to-slate-100 relative overflow-hidden">
        ${themeTag}
        <img src="${safeImg}" class="h-3/5 object-contain drop-shadow-2xl mb-6 max-w-full transform hover:scale-105 transition-transform duration-700">
        <h3 class="text-xl font-black text-slate-800 tracking-wider uppercase">${safeTitle}</h3>
        <div class="w-12 h-1 bg-blue-500 my-3 rounded-full"></div>
        <p class="text-[10px] text-slate-500 mt-1 max-w-xs leading-relaxed font-medium">${safePoints}...</p>
        <div class="mt-6 flex items-center gap-2">
            <span class="px-3 py-1 bg-white border border-slate-200 rounded-full text-[9px] font-black text-slate-400 uppercase tracking-widest">${safeStyle}</span>
            <span class="w-1 h-1 rounded-full bg-slate-300"></span>
            <span class="text-[9px] font-black text-blue-500 uppercase">${safePlatform}</span>
        </div>
    </div>`;
    container.innerHTML = `<div class="w-full h-full overflow-hidden" style="aspect-ratio: ${ratioStr};">${content}</div>`;
    container.classList.remove('p-6', 'flex-col', 'items-center', 'justify-center');
    container.style.padding = '0';
}

function renderMultiAngleFallback(container, task, points, config, images) {
    if (!container || !images.length) return;
    const ratioStr = config.aspectRatio.replace(':', '/');
    const safeTitle = detailEscapeHtml(task.title);
    const safePoints = detailEscapeHtml(points.substring(0, 70));
    const safeTheme = detailEscapeHtml(config.marketingThemeLabel || '');
    const tiles = images.slice(0, 6).map((img, index) => `
        <div class="relative bg-white rounded-lg overflow-hidden border border-slate-200 shadow-sm">
            <img src="${detailEscapeHtml(img.base64)}" class="w-full h-full object-contain p-2">
            <span class="absolute left-2 bottom-2 bg-slate-900/70 text-white text-[9px] font-black px-2 py-0.5 rounded">${index === 0 ? '主视角' : `角度 ${index}`}</span>
        </div>
    `).join('');

    container.innerHTML = `
        <div class="w-full h-full bg-slate-50 p-5 flex flex-col gap-4" style="aspect-ratio: ${ratioStr};">
            <div class="flex items-center justify-between">
                <div>
                    <div class="text-xl font-black text-slate-800 tracking-wide">${safeTitle}</div>
                    <div class="text-[10px] text-slate-500 mt-1 max-w-lg">${safePoints}...</div>
                </div>
                ${safeTheme ? `<span class="text-[9px] font-black text-orange-600 bg-orange-50 border border-orange-100 rounded px-2 py-1">${safeTheme}</span>` : ''}
            </div>
            <div class="grid grid-cols-3 gap-3 flex-1 min-h-0">${tiles}</div>
        </div>`;
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

function collectCurrentRenderProject(finalImage = '') {
    if (!globalGenContext) return null;
    const taskEntries = Object.entries(globalGenContext.tasks || {});
    const modulesSnapshot = taskEntries.map(([id, task]) => ({
        id,
        title: task.title,
        subtitle: task.subtitle,
        displayTitle: task.displayTitle,
        prompt: task.prompt,
        variant: task.variant,
        totalVariants: task.totalVariants,
        status: task.status || 'pending',
        isFallback: !!task.isFallback,
        error: task.error || '',
        imageSrc: getModuleImageSrc(id) || task.imageSrc || '',
        seo: getModuleSeo(id)
    }));
    return {
        version: 2,
        kind: 'detail-page-project',
        finalImage,
        uploadedImages: (globalGenContext.uploadedImages || []).map(img => ({
            id: img.id,
            name: img.name,
            base64: img.base64,
            mimeType: img.mimeType,
            isPrimary: !!img.isPrimary
        })),
        sellingPoints: globalGenContext.sellingPoints || '',
        config: globalGenContext.config || {},
        longImageOrder: (globalGenContext.longImageOrder || []).slice(),
        modules: modulesSnapshot
    };
}

function renderRestoredDetailProject(project, fallbackImage = '') {
    if (!project || project.kind !== 'detail-page-project' || !Array.isArray(project.modules)) return false;

    const restoredImages = Array.isArray(project.uploadedImages)
        ? project.uploadedImages.map((img, index) => {
            const base64 = formatImgSrc(img.base64 || img.imageSrc || '');
            const parsed = parseImageDataUrl(base64) || {};
            return {
                ...img,
                base64,
                mimeType: img.mimeType || parsed.mimeType || '',
                data: img.data || parsed.data || '',
                isPrimary: index === 0
            };
        }).filter(img => img.base64).slice(0, DETAIL_MAX_UPLOAD_IMAGES)
        : [];
    currentUploadedImages = restoredImages;
    currentUploadedBase64 = restoredImages[0]?.base64 || null;
    renderUploadedImagePreviews();

    const restoredTasks = {};
    const order = Array.isArray(project.longImageOrder) && project.longImageOrder.length
        ? project.longImageOrder
        : project.modules.map(mod => mod.id);

    globalGenContext = {
        base64Data: '',
        mimeType: '',
        primaryImage: restoredImages[0] || null,
        angleImages: restoredImages.slice(1),
        uploadedImages: restoredImages,
        sellingPoints: project.sellingPoints || '',
        config: project.config || { aspectRatio: '1:1', marketingTheme: 'none' },
        tasks: restoredTasks,
        longImageOrder: order
    };

    const sellingInput = document.getElementById('sellingPointsText');
    if (sellingInput) sellingInput.value = project.sellingPoints || '';

    const showcaseArea = document.getElementById('showcaseArea');
    const resultArea = document.getElementById('resultArea');
    const container = document.getElementById('modulesResultContainer');
    if (!container || !resultArea) return false;

    showcaseArea?.classList.add('hidden');
    resultArea.classList.remove('hidden');
    resultArea.classList.add('flex');
    container.innerHTML = '';

    const ratioStr = (project.config?.aspectRatio || '1:1').replace(':', '/');
    project.modules.forEach(mod => {
        const task = { ...mod, uniqueId: mod.id, active: true };
        restoredTasks[mod.id] = task;
        const imageSrc = mod.imageSrc || fallbackImage || project.finalImage || '';
        container.insertAdjacentHTML('beforeend', `
            <div id="result-mod-${detailEscapeHtml(mod.id)}" class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden flex flex-col group">
                <div class="bg-gray-50/80 px-5 py-3 border-b border-gray-100 flex justify-between items-center backdrop-blur">
                    <div class="flex items-center gap-2">
                        <span class="w-1.5 h-4 bg-blue-500 rounded-full"></span>
                        <span class="font-bold text-gray-700 text-sm">${detailEscapeHtml(mod.displayTitle || mod.title || '详情模块')}</span>
                        <span id="status-badge-${detailEscapeHtml(mod.id)}" class="text-[10px] font-black px-2 py-0.5 rounded-full border bg-slate-100 text-slate-500 border-slate-200">等待中</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="text-xs text-gray-400 mr-2">${detailEscapeHtml(mod.subtitle || '')}</span>
                    </div>
                </div>
                <div id="content-mod-${detailEscapeHtml(mod.id)}" class="relative bg-white" style="aspect-ratio: ${ratioStr}; min-height: 200px; padding: 0;">
                    ${imageSrc ? `<img src="${detailEscapeHtml(formatImgSrc(imageSrc))}" class="w-full h-full object-cover">` : '<div class="w-full h-full flex items-center justify-center text-xs text-gray-400">暂无模块图片</div>'}
                </div>
                <div class="border-t border-gray-100 bg-slate-50 p-4 flex flex-col gap-3">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-1.5"><i class="ph-fill ph-link text-blue-500"></i><span class="text-xs font-black text-gray-700 uppercase tracking-widest">SEO Meta-Data</span></div>
                        <button onclick="downloadModule('${detailEscapeHtml(mod.id)}', '${detailEscapeHtml(mod.displayTitle || mod.title || '详情模块')}')" class="text-xs flex items-center gap-1 text-gray-500 hover:text-indigo-600 font-bold bg-white border border-gray-200 px-2 py-1 rounded shadow-sm transition-all active:scale-95"><i class="ph ph-download-simple"></i> 单存</button>
                    </div>
                    <div class="flex flex-col gap-2.5">
                        <div class="flex items-center gap-2">
                            <span class="text-[10px] font-bold text-gray-400 w-6">Title</span>
                            <input type="text" id="seo-title-target-${detailEscapeHtml(mod.id)}" class="flex-1 text-xs px-2 py-1.5 border border-gray-200 rounded bg-white shadow-inner" readonly>
                            <input type="text" id="seo-title-zh-${detailEscapeHtml(mod.id)}" class="flex-1 text-xs px-2 py-1.5 border border-gray-200 rounded bg-white shadow-inner text-gray-500" readonly>
                        </div>
                        <div class="flex items-start gap-2">
                            <span class="text-[10px] font-bold text-gray-400 w-6 mt-1">Alt</span>
                            <textarea id="alt-text-target-${detailEscapeHtml(mod.id)}" class="flex-1 text-xs px-2 py-1.5 border border-gray-200 rounded bg-white shadow-inner resize-none hide-scroll" rows="2" readonly></textarea>
                            <textarea id="alt-text-zh-${detailEscapeHtml(mod.id)}" class="flex-1 text-xs px-2 py-1.5 border border-gray-200 rounded bg-white shadow-inner resize-none hide-scroll text-gray-500" rows="2" readonly></textarea>
                        </div>
                    </div>
                </div>
            </div>`);
        setModuleSeo(mod.id, mod.seo || {});
        setModuleStatus(mod.id, mod.status || (mod.isFallback ? 'fallback' : 'success'));
    });

    renderSortableList();
    return true;
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
                <div class="text-xs font-bold text-gray-700 truncate">${detailEscapeHtml(task.displayTitle)}</div>
                <div class="text-[10px] text-gray-400 truncate">${detailEscapeHtml(task.subtitle)}</div>
            </div>
        `;

        li.addEventListener('dragstart', (e) => {
            draggedItem = li;
            setTimeout(() => li.classList.add('ghost-item'), 0);
        });

        li.addEventListener('dragend', () => {
            setTimeout(() => {
                draggedItem?.classList.remove('ghost-item');
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
            if (draggedItem && this !== draggedItem) {
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
                const currentIds = globalGenContext.longImageOrder.slice();
                const safeOrder = validateSortedIds(sortedIds, currentIds);
                if (!safeOrder) throw new Error('AI 返回的排序结果不完整');
                const changed = safeOrder.some((id, idx) => id !== sortedIds[idx]) || safeOrder.length !== sortedIds.length;
                globalGenContext.longImageOrder = safeOrder;
                renderSortableList();
                showToast(changed ? 'AI 排序已应用，已自动补齐缺失模块' : 'AI 智能排序已应用', 'success');
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

        const finalImage = finalCanvas.toDataURL('image/jpeg', 0.6);
        const project = collectCurrentRenderProject(finalImage);
        // 存档全案
        saveToHistory('render', {
            name: `全案详情页_${ts}`,
            style: globalGenContext?.config?.imageStyleLabel || globalGenContext?.config?.imageStyle || '默认',
            image: finalImage,
            metadata: project || { count: globalGenContext?.longImageOrder?.length || 0 }
        });
    } catch (e) { showToast('导出失败', 'error'); }
    finally { btn.innerHTML = origHTML; btn.disabled = false; }
}
