let squareRedrawImages = [];
let squareRedrawBatchId = null;
let squareRedrawFilter = 'all';
let squareRedrawTargetAspectRatio = '1:1';
let squareRedrawRenderSignature = '';
let squareRedrawRunning = false;
let squareRedrawLoading = false;
let squareRedrawPreviewTrigger = null;
const SQUARE_REDRAW_SUPPORTED_RATIOS = ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

function initSquareRedrawControls() {
    syncSquareRedrawTargetControls();
    renderSquareRedrawList();
    updateSquareRedrawActions();
}

function handleSquareRedrawUpload(event) {
    loadSquareRedrawFiles([...event.target.files]);
    event.target.value = '';
}

function handleSquareRedrawDrop(event) {
    event.preventDefault();
    loadSquareRedrawFiles([...event.dataTransfer.files].filter(file => file.type.startsWith('image/')));
}

function handleSquareRedrawImagePaste(files) {
    const raw = Array.isArray(files) ? files : Array.from(files || []);
    const valid = raw.filter(file => file && file.type && file.type.startsWith('image/'));
    if (valid.length) {
        loadSquareRedrawFiles(valid);
        return true;
    }
    return false;
}

function handleSquareRedrawPaste(event) {
    const files = typeof extractImageFilesFromClipboard === 'function'
        ? extractImageFilesFromClipboard(event)
        : Array.from(event?.clipboardData?.files || []).filter(f => f.type && f.type.startsWith('image/'));
    if (files.length) {
        event.preventDefault();
        handleSquareRedrawImagePaste(files);
    }
}


function readImageDimensions(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => reject(new Error('图片尺寸读取失败'));
        img.src = dataUrl;
    });
}

async function loadSquareRedrawFiles(files) {
    if (squareRedrawRunning || squareRedrawLoading) {
        showToast('图片正在处理中，请完成后再更换本批图片', 'warning');
        return;
    }
    if (!files.length) return;
    if (files.length > 100) {
        showToast('每批最多上传 100 张图片，请拆批处理', 'error');
        return;
    }

    const nextImages = [];
    squareRedrawLoading = true;
    updateSquareRedrawActions();
    try {
        for (const file of files) {
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = e => resolve(e.target.result);
                reader.onerror = () => reject(new Error('图片读取失败'));
                reader.readAsDataURL(file);
            });
            const size = await readImageDimensions(dataUrl);
            nextImages.push({
                id: `sr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                filename: file.name,
                image_data: dataUrl,
                width: size.width,
                height: size.height,
                status: squareRedrawImageMatchesTarget(size.width, size.height) ? 'skipped_square' : 'ready',
                source_url: dataUrl,
                output_url: '',
                error_message: '',
            });
        }
    } catch (err) {
        showToast(err.message || '图片读取失败', 'error');
        return;
    } finally {
        squareRedrawLoading = false;
        updateSquareRedrawActions();
    }

    squareRedrawImages = nextImages;
    squareRedrawFilter = 'all';
    squareRedrawBatchId = null;
    squareRedrawRenderSignature = '';
    renderSquareRedrawList();
    updateSquareRedrawActions();
    showToast(`已添加 ${squareRedrawImages.length} 张图片`, 'success');
}

function squareRedrawSummary() {
    return {
        total: squareRedrawImages.length,
        ready: squareRedrawImages.filter(item => item.status === 'ready' || item.status === 'queued').length,
        running: squareRedrawImages.filter(item => item.status === 'running').length,
        done: squareRedrawImages.filter(item => item.status === 'done').length,
        failed: squareRedrawImages.filter(item => item.status === 'failed').length,
        skipped: squareRedrawImages.filter(item => item.status === 'skipped_square').length,
    };
}

function renderSquareRedrawSummary() {
    const summary = squareRedrawSummary();
    const el = document.getElementById('squareRedrawSummary');
    if (el) {
        el.innerHTML = `<i class="ph ph-check-circle" aria-hidden="true"></i><strong>${summary.done + summary.skipped} 张可导出</strong><span>含 ${summary.skipped} 张保留原图</span>`;
    }
    const counts = { all: summary.total, pending: summary.ready + summary.running, success: summary.done, failed: summary.failed, skipped: summary.skipped };
    document.querySelectorAll?.('[data-sr-count]').forEach(node => { node.textContent = String(counts[node.dataset.srCount] || 0); });
    document.querySelectorAll?.('[data-sr-filter]').forEach(node => { node.setAttribute('aria-pressed', String(node.dataset.srFilter === squareRedrawFilter)); });
    const count = document.getElementById('squareRedrawQueueCount');
    if (count) count.textContent = String(summary.total);
    for (const id of ['squareRedrawUploadStrip', 'squareRedrawFilters', 'squareRedrawFooter']) {
        const node = document.getElementById(id);
        if (node) summary.total ? node.classList.remove('hidden') : node.classList.add('hidden');
    }
    const progress = document.getElementById('squareRedrawProgress');
    if (progress) {
        const running = squareRedrawRunning || summary.running > 0;
        running ? progress.classList.remove('hidden') : progress.classList.add('hidden');
        progress.innerHTML = `<i class="ph ph-circle-notch" aria-hidden="true"></i><div><strong>正在处理图片 · ${summary.done + summary.failed + summary.skipped}/${summary.total}</strong><span>符合比例的原图自动保留，请等待本批完成。</span></div>`;
    }
    const failure = document.getElementById('squareRedrawFailure');
    if (failure) summary.failed ? failure.classList.remove('hidden') : failure.classList.add('hidden');
    const failureText = document.getElementById('squareRedrawFailureText');
    if (failureText) failureText.textContent = `${summary.failed} 张图片未完成，其余结果已保留`;
    const batchUploadBtn = document.getElementById('squareRedrawBatchUploadBtn');
    if (batchUploadBtn) batchUploadBtn.disabled = squareRedrawRunning || summary.done === 0;
}

function setSquareRedrawFilter(filter) {
    squareRedrawFilter = filter;
    renderSquareRedrawList();
}

function squareRedrawVisibleItems() {
    if (squareRedrawFilter === 'all') return squareRedrawImages;
    if (squareRedrawFilter === 'pending') return squareRedrawImages.filter(item => ['ready', 'queued', 'running'].includes(item.status));
    if (squareRedrawFilter === 'success') return squareRedrawImages.filter(item => item.status === 'done');
    if (squareRedrawFilter === 'failed') return squareRedrawImages.filter(item => item.status === 'failed');
    if (squareRedrawFilter === 'skipped') return squareRedrawImages.filter(item => item.status === 'skipped_square');
    return squareRedrawImages;
}

function squareRedrawStatusLabel(status) {
    const labels = {
        ready: '待重绘',
        queued: '排队中',
        running: '处理中',
        done: '已完成',
        failed: '未完成',
        skipped_square: '已符合比例',
    };
    return labels[status] || status;
}

function squareRedrawStatusBadgeClass(status) {
    return `square-redraw-badge-${status || 'ready'}`;
}

function parseSquareRedrawRatio(ratio = squareRedrawTargetAspectRatio) {
    const parts = String(ratio || '1:1').split(':').map(part => Number(part));
    if (parts.length !== 2 || parts.some(part => !Number.isFinite(part) || part <= 0)) return [1, 1];
    return parts;
}

function squareRedrawImageMatchesTarget(width, height, ratio = squareRedrawTargetAspectRatio) {
    if (!width || !height) return false;
    const [targetWidth, targetHeight] = parseSquareRedrawRatio(ratio);
    return width * targetHeight === height * targetWidth;
}

function syncSquareRedrawTargetControls() {
    const select = document.getElementById('squareRedrawAspectSelect');
    const widthInput = document.getElementById('squareRedrawTargetWidth');
    const heightInput = document.getElementById('squareRedrawTargetHeight');
    const [targetWidth, targetHeight] = parseSquareRedrawRatio();
    if (select) select.value = SQUARE_REDRAW_SUPPORTED_RATIOS.includes(squareRedrawTargetAspectRatio) ? squareRedrawTargetAspectRatio : 'custom';
    if (widthInput) widthInput.value = String(targetWidth);
    if (heightInput) heightInput.value = String(targetHeight);
    const locked = !!squareRedrawBatchId || squareRedrawRunning || squareRedrawLoading;
    for (const control of [select, widthInput, heightInput, document.getElementById('squareRedrawApplyRatioBtn')]) {
        if (control) control.disabled = locked;
    }
    document.querySelectorAll?.('[data-sr-ratio]').forEach(node => {
        node.setAttribute('aria-pressed', String(node.dataset.srRatio === squareRedrawTargetAspectRatio));
        node.disabled = locked;
    });
    const label = document.getElementById('squareRedrawRatioLabel');
    if (label) label.textContent = squareRedrawTargetAspectRatio;
    const hint = document.getElementById('squareRedrawRatioLock');
    if (hint) squareRedrawBatchId ? hint.classList.remove('hidden') : hint.classList.add('hidden');
}

function refreshSquareRedrawLocalSkipStatuses() {
    if (squareRedrawBatchId) return;
    squareRedrawImages = squareRedrawImages.map(item => ({
        ...item,
        status: squareRedrawImageMatchesTarget(item.width, item.height) ? 'skipped_square' : 'ready',
    }));
}

function setSquareRedrawAspectRatio(ratio) {
    if (squareRedrawRunning || squareRedrawLoading) return;
    if (squareRedrawBatchId) {
        showToast('当前批次已锁定尺寸：如需更换目标宽高比，请先清空当前图片列表后重新添加', 'error');
        syncSquareRedrawTargetControls();
        return;
    }
    if (!SQUARE_REDRAW_SUPPORTED_RATIOS.includes(ratio)) return;
    squareRedrawTargetAspectRatio = ratio;
    syncSquareRedrawTargetControls();
    refreshSquareRedrawLocalSkipStatuses();
    renderSquareRedrawList();
    updateSquareRedrawActions();
}

function applySquareRedrawCustomSize() {
    if (squareRedrawRunning || squareRedrawLoading) return;
    if (squareRedrawBatchId) {
        showToast('当前批次已锁定尺寸：如需更换目标宽高比，请先清空当前图片列表后重新添加', 'error');
        syncSquareRedrawTargetControls();
        return;
    }

    const width = Number(document.getElementById('squareRedrawTargetWidth')?.value);
    const height = Number(document.getElementById('squareRedrawTargetHeight')?.value);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        showToast('请输入有效的目标宽高', 'error');
        return;
    }
    const divisor = gcdSquareRedraw(width, height);
    const ratio = `${width / divisor}:${height / divisor}`;
    if (!SQUARE_REDRAW_SUPPORTED_RATIOS.includes(ratio)) {
        showToast(`暂不支持 ${ratio}，请选择常用比例`, 'error');
        return;
    }
    setSquareRedrawAspectRatio(ratio);
    showToast(`目标尺寸已设为 ${ratio}`, 'success');
}

function gcdSquareRedraw(a, b) {
    let x = Math.abs(a);
    let y = Math.abs(b);
    while (y) {
        const next = x % y;
        x = y;
        y = next;
    }
    return x || 1;
}

function renderSquareRedrawList() {
    const empty = document.getElementById('squareRedrawEmptyState');
    const list = document.getElementById('squareRedrawList');
    if (!empty || !list) return;
    renderSquareRedrawSummary();

    if (!squareRedrawImages.length) {
        empty.classList.remove('hidden');
        list.classList.add('hidden');
        list.innerHTML = '';
        return;
    }

    empty.classList.add('hidden');
    list.classList.remove('hidden');
    const visible = squareRedrawVisibleItems();
    if (!visible.length) {
        const names = { pending: '待处理', success: '成功', failed: '失败', skipped: '已跳过' };
        list.innerHTML = `<div class="sr-filter-empty">没有${names[squareRedrawFilter] || '符合筛选条件'}的图片<button type="button" onclick="setSquareRedrawFilter('all')">查看全部图片</button></div>`;
        return;
    }
    list.innerHTML = visible.map(item => {
        const preview = item.output_url ? formatSquareRedrawUrl(item.output_url) : item.source_url;
        const error = item.error_message ? `<span class="sr-error-copy">${escapeSquareRedrawHtml(item.error_message)}</span>` : '';
        const deleteDisabled = squareRedrawRunning || item.status === 'running' ? 'disabled' : '';
        return `
            <div class="square-redraw-card">
                <button type="button" onclick="openSquareRedrawPreview('${item.id}')" class="square-redraw-thumb" aria-label="预览 ${escapeSquareRedrawHtml(item.filename)}">
                    <img src="${escapeSquareRedrawHtml(preview)}" alt="${escapeSquareRedrawHtml(item.filename)}">
                    <span class="square-redraw-thumb-overlay"><i class="ph ph-arrows-out" aria-hidden="true"></i></span>
                </button>
                <button type="button" onclick="openSquareRedrawPreview('${item.id}')" class="square-redraw-info">
                    <strong class="square-redraw-title">${escapeSquareRedrawHtml(item.filename)}</strong>
                    <span class="square-redraw-meta">${item.width || '-'} × ${item.height || '-'}</span>${error}
                </button>
                <span class="square-redraw-badge ${squareRedrawStatusBadgeClass(item.status)}">${squareRedrawStatusLabel(item.status)}</span>
                <div class="sr-row-actions">
                    <button type="button" onclick="openSquareRedrawPreview('${item.id}')" class="square-redraw-preview-btn" title="查看对比" aria-label="查看 ${escapeSquareRedrawHtml(item.filename)} 的对比"><i class="ph ph-arrows-out" aria-hidden="true"></i></button>
                    <details class="sr-item-menu"><summary aria-label="${escapeSquareRedrawHtml(item.filename)} 的更多操作" title="更多操作"><i class="ph ph-dots-three" aria-hidden="true"></i></summary><div>
                        ${item.status === 'done' && item.output_url ? `
                        <button type="button" onclick="uploadSquareRedrawItemToCloud('${item.id}')"><i class="ph ph-cloud-arrow-up" aria-hidden="true"></i>上传至云存储图床</button>
                        <button type="button" onclick="sendSquareRedrawToTranslate('${item.id}')"><i class="ph ph-translate" aria-hidden="true"></i>流转至图片翻译</button>
                        <button type="button" onclick="sendSquareRedrawToDetails('${item.id}')"><i class="ph ph-arrow-square-out" aria-hidden="true"></i>设为详情页主图</button>` : ''}
                        <button type="button" onclick="removeSquareRedrawImage('${item.id}')" ${deleteDisabled} data-sr-status="${escapeSquareRedrawHtml(item.status)}" class="sr-remove-action"><i class="ph ph-trash" aria-hidden="true"></i>删除图片</button>
                    </div></details>
                </div>
            </div>`;
    }).join('');
}

function getSquareRedrawItem(itemId) {
    return squareRedrawImages.find(item => item.id === itemId);
}

function openSquareRedrawPreview(itemId) {
    const item = getSquareRedrawItem(itemId);
    if (!item) return;

    const modal = document.getElementById('squareRedrawPreviewModal');
    const title = document.getElementById('squareRedrawPreviewTitle');
    const sourceImg = document.getElementById('squareRedrawPreviewSourceImg');
    const resultWrap = document.getElementById('squareRedrawPreviewResultWrap');
    if (!modal || !title || !sourceImg || !resultWrap) return;

    title.textContent = item.filename;
    const ratioLabel = document.getElementById('squareRedrawPreviewResultLabel');
    if (ratioLabel) ratioLabel.textContent = `目标比例 · ${squareRedrawTargetAspectRatio}`;
    sourceImg.src = item.source_url;

    const translateBtn = document.getElementById('squareRedrawSendToTranslateBtn');
    if (translateBtn) {
        translateBtn.onclick = () => sendSquareRedrawToTranslate(itemId);
        translateBtn.disabled = !(item.status === 'done' && item.output_url);
    }

    const sendBtn = document.getElementById('squareRedrawSendToDetailsBtn');
    if (sendBtn) {
        sendBtn.onclick = () => sendSquareRedrawToDetails(itemId);
        sendBtn.disabled = !(item.status === 'done' && item.output_url);
    }

    const uploadBtn = document.getElementById('squareRedrawUploadToStorageBtn');
    if (uploadBtn) {
        uploadBtn.onclick = () => uploadSquareRedrawItemToCloud(itemId);
        uploadBtn.disabled = !(item.status === 'done' && item.output_url);
    }

    let resultHtml = '';
    if (item.status === 'done' && item.output_url) {
        resultHtml = `<img src="${formatSquareRedrawUrl(item.output_url)}" class="w-full h-full object-contain">`;
    } else if (item.status === 'skipped_square') {
        resultHtml = `
            <img src="${item.source_url}" class="w-full h-full object-contain">
            <div class="absolute left-3 top-3 rounded-lg bg-amber-50 px-2 py-1 text-[10px] font-black text-amber-700 border border-amber-100">已符合 ${squareRedrawTargetAspectRatio}，未重绘</div>
        `;
    } else if (item.status === 'failed') {
        resultHtml = `
            <div class="h-full min-h-[260px] flex flex-col items-center justify-center gap-2 text-center px-6 text-red-400">
                <i class="ph ph-warning-circle text-4xl"></i>
                <div class="text-sm font-black">生成失败</div>
                <div class="text-xs text-red-300">${escapeSquareRedrawHtml(item.error_message || '请点击顶部【重试失败项】或检查 AI 设置')}</div>
            </div>
        `;
    } else {
        resultHtml = `
            <div class="h-full min-h-[260px] flex flex-col items-center justify-center gap-2 text-center text-slate-300">
                <i class="ph ph-hourglass text-4xl"></i>
                <div class="text-sm font-black">${squareRedrawStatusLabel(item.status)}</div>
                <div class="text-xs">生成完成后这里会显示尺寸重绘结果</div>
            </div>
        `;
    }

    resultWrap.innerHTML = resultHtml;
    document.getElementById('squareRedrawPreviewMeta').textContent = `${item.width || '-'} x ${item.height || '-'} · 目标 ${squareRedrawTargetAspectRatio} · ${squareRedrawStatusLabel(item.status)}`;
    squareRedrawPreviewTrigger = document.activeElement;
    modal.classList.remove('hidden');
    document.getElementById('squareRedrawPreviewCloseBtn')?.focus?.();
}

async function sendSquareRedrawToDetails(itemId) {
    const item = getSquareRedrawItem(itemId);
    if (!item) return;
    const url = item.output_url ? formatSquareRedrawUrl(item.output_url) : item.source_url;
    if (!url) return;
    try {
        let dataUrl = url;
        if (!url.startsWith('data:image')) {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`获取重绘图片失败 (HTTP ${resp.status})`);
            const blob = await resp.blob();
            dataUrl = await new Promise((res, rej) => {
                const reader = new FileReader();
                reader.onload = () => res(reader.result);
                reader.onerror = rej;
                reader.readAsDataURL(blob);
            });
        }
        const setter = (typeof window !== 'undefined' && window.setDetailProductImage) || (typeof globalThis !== 'undefined' && globalThis.setDetailProductImage) || (typeof setDetailProductImage === 'function' ? setDetailProductImage : null);
        if (typeof setter === 'function') {
            setter(dataUrl, item.filename || 'Redrawn Product', true);
            const tabSwitcher = typeof switchMainTab === 'function' ? switchMainTab : (typeof window !== 'undefined' && window.switchMainTab ? window.switchMainTab : (typeof globalThis !== 'undefined' ? globalThis.switchMainTab : null));
            if (tabSwitcher) {
                tabSwitcher('generate');
            }
            if (typeof showToast === 'function') {
                showToast('已成功将重绘图设为详情页主图！', 'success');
            }
        } else {
            if (typeof showToast === 'function') {
                showToast('详情页主图接收接口不可用', 'warning');
            }
        }
    } catch (e) {
        if (typeof showToast === 'function') {
            showToast('传递图片失败: ' + e.message, 'error');
        }
    }
}

function sendSquareRedrawToTranslate(itemId) {
    const item = getSquareRedrawItem(itemId);
    if (!item || item.status !== 'done' || !item.output_url) {
        if (typeof showToast === 'function') {
            showToast('尺寸重绘尚未生成完成，无法流转至图片翻译', 'warning');
        }
        return;
    }

    const targetUrl = typeof formatSquareRedrawUrl === 'function' ? formatSquareRedrawUrl(item.output_url) : item.output_url;
    const transItem = {
        id: 'ti_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        name: item.filename || 'resized_image.png',
        base64: targetUrl,
        mimeType: 'image/png',
        status: 'waiting'
    };

    if (typeof transImages !== 'undefined' && Array.isArray(transImages)) {
        transImages.push(transItem);
    } else if (typeof window !== 'undefined' && Array.isArray(window.transImages)) {
        window.transImages.push(transItem);
    } else if (typeof globalThis !== 'undefined' && Array.isArray(globalThis.transImages)) {
        globalThis.transImages.push(transItem);
    }

    if (typeof renderTransCards === 'function') renderTransCards();
    if (typeof updateTransStartBtn === 'function') updateTransStartBtn();

    const tabSwitcher = typeof switchMainTab === 'function' ? switchMainTab : (typeof window !== 'undefined' && window.switchMainTab ? window.switchMainTab : (typeof globalThis !== 'undefined' ? globalThis.switchMainTab : null));
    if (tabSwitcher) {
        tabSwitcher('translate');
    }

    if (typeof showToast === 'function') {
        showToast('已成功流转至【图片翻译】队列！', 'success');
    }
}

function closeSquareRedrawPreview() {
    document.getElementById('squareRedrawPreviewModal')?.classList.add('hidden');
    squareRedrawPreviewTrigger?.focus?.();
    squareRedrawPreviewTrigger = null;
}

function uploadCurrentSquareRedrawPreviewToCloud() {
    const title = document.getElementById('squareRedrawPreviewTitle')?.textContent;
    const item = squareRedrawImages.find(i => i.filename === title);
    if (item) {
        uploadSquareRedrawItemToCloud(item.id);
    }
}

function uploadSquareRedrawItemToCloud(itemId) {
    const item = getSquareRedrawItem(itemId);
    if (!item || !item.output_url) {
        if (typeof showToast === 'function') showToast('当前图片尚未重绘完成', 'warning');
        return;
    }
    const fullUrl = formatSquareRedrawUrl(item.output_url);
    const baseName = (item.filename || 'image').replace(/\.[^/.]+$/, '');
    if (typeof window !== 'undefined' && typeof window.openUniversalImageUploader === 'function') {
        window.openUniversalImageUploader({
            sourceModule: 'square-redraw',
            imageData: fullUrl,
            filename: `${baseName}_resized.png`,
            title: baseName,
            altText: `${baseName} resized aspect ratio product view`
        });
    } else {
        if (typeof showToast === 'function') showToast('云存储图床托管组件未加载', 'warning');
    }
}

function batchUploadSquareRedrawToCloud() {
    const completed = squareRedrawImages.filter(i => i.status === 'done' && i.output_url);
    if (!completed.length) {
        if (typeof showToast === 'function') showToast('暂无可上传的重绘结果', 'warning');
        return;
    }
    const items = completed.map(i => {
        const baseName = (i.filename || 'image').replace(/\.[^/.]+$/, '');
        return {
            id: i.id,
            filename: `${baseName}_resized.png`,
            imageData: formatSquareRedrawUrl(i.output_url),
            title: baseName,
            altText: `${baseName} resized product view`
        };
    });
    if (typeof window !== 'undefined' && typeof window.openUniversalBatchUploader === 'function') {
        window.openUniversalBatchUploader({
            sourceModule: 'square-redraw',
            items: items
        });
    } else {
        if (typeof showToast === 'function') showToast('云存储图床托管组件未加载', 'warning');
    }
}

function escapeSquareRedrawHtml(value) {
    return String(value || '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
    }[char]));
}

function formatSquareRedrawUrl(url) {
    if (!url) return '';
    if (url.startsWith('data:image') || url.startsWith('http')) return url;
    const base = typeof API_BASE !== 'undefined' ? API_BASE : '';
    if (url.startsWith('/static')) return base + url;
    return url;
}

function updateSquareRedrawActions() {
    const startBtn = document.getElementById('squareRedrawStartBtn');
    const retryBtn = document.getElementById('squareRedrawRetryBtn');
    const downloadBtn = document.getElementById('squareRedrawDownloadBtn');
    const summary = squareRedrawSummary();
    const busy = squareRedrawRunning || squareRedrawLoading;
    if (startBtn) {
        startBtn.disabled = !summary.total || busy || (!!squareRedrawBatchId && summary.ready === 0);
        if (squareRedrawRunning) {
            startBtn.innerHTML = '<i class="ph ph-circle-notch sr-spinning" aria-hidden="true"></i><span>正在处理…</span>';
        } else {
            const text = squareRedrawLoading ? '正在读取图片…' : !summary.total ? '开始重绘' : squareRedrawBatchId ? (summary.ready ? `继续处理 · ${summary.ready} 张` : '本批已处理') : summary.ready ? `开始重绘 · ${summary.ready} 张` : '准备原图 ZIP';
            startBtn.innerHTML = `<i class="ph ph-play" aria-hidden="true"></i><span>${text}</span>`;
        }
    }
    for (const btn of [retryBtn, document.getElementById('squareRedrawInlineRetryBtn')]) {
        if (btn) btn.disabled = busy || !squareRedrawBatchId || summary.failed === 0;
    }
    if (downloadBtn) downloadBtn.disabled = busy || !squareRedrawBatchId || (summary.done + summary.skipped === 0);
    for (const id of ['squareRedrawUpload', 'squareRedrawReplaceBtn']) {
        const el = document.getElementById(id);
        if (el) el.disabled = busy;
    }
    document.getElementById('squareRedrawList')?.querySelectorAll?.('.sr-remove-action').forEach(button => {
        button.disabled = busy || button.dataset.srStatus === 'running';
    });
    syncSquareRedrawTargetControls();
    renderSquareRedrawSummary();
}

function squareRedrawBatchSignature(batchId, targetAspectRatio, images) {
    return JSON.stringify({
        batchId,
        targetAspectRatio,
        items: images.map(item => ({
            id: item.id,
            status: item.status,
            output_url: item.output_url || '',
            error_message: item.error_message || '',
            retry_count: item.retry_count || 0,
        })),
    });
}

async function startSquareRedrawBatch() {
    if (!squareRedrawImages.length) {
        showToast('请先上传图片', 'error');
        return;
    }
    if (squareRedrawRunning) return;

    if (squareRedrawLoading) return;
    if (squareRedrawBatchId) {
        await runSquareRedrawQueue();
        return;
    }
    const payload = {
        target_aspect_ratio: squareRedrawTargetAspectRatio,
        images: squareRedrawImages.map(item => ({
            filename: item.filename, image_data: item.image_data, width: item.width, height: item.height,
        })),
    };
    squareRedrawRunning = true;
    updateSquareRedrawActions();
    try {
        const response = await fetch(`${API_BASE}/api/square-redraw/batches`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (data.status !== 'success') throw new Error(data.message || '创建重绘任务失败');
        applySquareRedrawBatch(data.data);
    } catch (err) {
        showToast(err.message || '创建重绘任务失败，请检查连接后重试', 'error');
        return;
    } finally {
        squareRedrawRunning = false;
        updateSquareRedrawActions();
    }
    await runSquareRedrawQueue();
}

function applySquareRedrawBatch(batch) {
    const nextBatchId = batch.id;
    const nextTargetAspectRatio = batch.target_aspect_ratio || squareRedrawTargetAspectRatio || '1:1';
    const nextImages = (batch.items || []).map(item => ({
        id: `server_${item.id}`,
        filename: item.filename,
        image_data: '',
        width: item.width,
        height: item.height,
        status: item.status,
        source_url: formatSquareRedrawUrl(item.source_url),
        output_url: formatSquareRedrawUrl(item.output_url),
        error_message: item.error_message || '',
    }));

    const nextSignature = squareRedrawBatchSignature(nextBatchId, nextTargetAspectRatio, nextImages);
    squareRedrawBatchId = nextBatchId;
    squareRedrawTargetAspectRatio = nextTargetAspectRatio;
    squareRedrawImages = nextImages;
    syncSquareRedrawTargetControls();
    if (nextSignature !== squareRedrawRenderSignature) {
        squareRedrawRenderSignature = nextSignature;
        renderSquareRedrawList();
    }
    updateSquareRedrawActions();
}

async function removeSquareRedrawImage(itemId) {
    const item = getSquareRedrawItem(itemId);
    if (!item) return;
    if (squareRedrawRunning || item.status === 'running') {
        showToast('图片正在处理中，暂不能删除', 'error');
        return;
    }

    if (!squareRedrawBatchId || !String(itemId).startsWith('server_')) {
        squareRedrawImages = squareRedrawImages.filter(image => image.id !== itemId);
        if (!squareRedrawImages.length) squareRedrawBatchId = null;
        squareRedrawRenderSignature = '';
        closeSquareRedrawPreview();
        renderSquareRedrawList();
        updateSquareRedrawActions();
        return;
    }

    const serverItemId = itemId.replace('server_', '');
    const response = await fetch(`${API_BASE}/api/square-redraw/batches/${squareRedrawBatchId}/items/${serverItemId}`, {
        method: 'DELETE',
    });
    const data = await response.json();
    if (data.status !== 'success') {
        showToast(data.message || '删除图片失败', 'error');
        return;
    }
    closeSquareRedrawPreview();
    applySquareRedrawBatch(data.data);
    showToast('已删除图片', 'success');
}

function markSquareRedrawItemStatus(itemId, status) {
    squareRedrawImages = squareRedrawImages.map(item => item.id === itemId ? { ...item, status } : item);
    squareRedrawRenderSignature = squareRedrawBatchSignature(squareRedrawBatchId, squareRedrawTargetAspectRatio, squareRedrawImages);
    renderSquareRedrawList();
    updateSquareRedrawActions();
}

async function processSquareRedrawServerItem(item) {
    const serverItemId = String(item.id).replace('server_', '');
    markSquareRedrawItemStatus(item.id, 'running');
    const response = await fetch(`${API_BASE}/api/square-redraw/batches/${squareRedrawBatchId}/items/${serverItemId}/process`, {
        method: 'POST',
    });
    const data = await response.json();
    if (data.status !== 'success') {
        throw new Error(data.message || '单图重绘失败');
    }
    applySquareRedrawBatch(data.data);
    const processedItem = (data.data.items || []).find(batchItem => String(batchItem.id) === serverItemId);
    if (processedItem?.status === 'failed') {
        throw new Error(processedItem.error_message || '单图重绘失败');
    }
}

async function refreshSquareRedrawBatch() {
    if (!squareRedrawBatchId) return;
    const response = await fetch(`${API_BASE}/api/square-redraw/batches/${squareRedrawBatchId}`);
    const data = await response.json();
    if (data.status !== 'success') return;
    applySquareRedrawBatch(data.data);
}

async function runSquareRedrawQueue() {
    if (!squareRedrawBatchId) return;
    const queuedItems = squareRedrawImages.filter(item => item.status === 'queued');
    if (!queuedItems.length) {
        saveSquareRedrawHistory();
        updateSquareRedrawActions();
        return;
    }

    const startBtn = document.getElementById('squareRedrawStartBtn');
    const originalStartHtml = startBtn?.innerHTML || '';
    squareRedrawRunning = true;
    updateSquareRedrawActions();

    const activeTasks = [];
    let completedCount = 0;
    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < queuedItems.length; i++) {
        if (activeTasks.length >= CONCURRENCY_LIMIT) {
            await Promise.race(activeTasks);
        }

        const item = queuedItems[i];
        const taskPromise = (async () => {
            try {
                await processSquareRedrawServerItem(item);
                successCount++;
            } catch (err) {
                console.error(err);
                errorCount++;
                try { await refreshSquareRedrawBatch(); } catch (_) { /* Keep the last known results while offline. */ }
                showToast(`${item.filename} 重绘失败`, 'error');
            } finally {
                completedCount++;
                if (startBtn) {
                    startBtn.innerHTML = `<span class="loader mr-2 border-white border-t-transparent w-4 h-4"></span> 并行重绘 ${completedCount}/${queuedItems.length}`;
                }
            }
        })();

        activeTasks.push(taskPromise);
        taskPromise.finally(() => {
            const idx = activeTasks.indexOf(taskPromise);
            if (idx > -1) activeTasks.splice(idx, 1);
        });

        if (i < queuedItems.length - 1) {
            await new Promise(resolve => setTimeout(resolve, STAGGER_DELAY));
        }
    }

    await Promise.all(activeTasks);
    squareRedrawRunning = false;
    if (startBtn) startBtn.innerHTML = originalStartHtml;
    try {
        await refreshSquareRedrawBatch();
    } catch (_) {
        showToast('结果刷新失败，已保留当前图片。请稍后从历史恢复本批次。', 'warning');
    }
    updateSquareRedrawActions();
    saveSquareRedrawHistory();
    showToast(`重绘完成：成功 ${successCount}，失败 ${errorCount}`, errorCount ? 'warning' : 'success');
}

function saveSquareRedrawHistory() {
    if (!squareRedrawBatchId || typeof saveToHistory !== 'function') return;
    const summary = squareRedrawSummary();
    if (summary.done + summary.skipped === 0) return;
    saveToHistory('square-redraw', {
        batch_id: squareRedrawBatchId,
        target_aspect_ratio: squareRedrawTargetAspectRatio,
        result: {
            id: squareRedrawBatchId,
            status: squareRedrawImages.some(item => item.status === 'failed') ? 'failed' : 'done',
            target_aspect_ratio: squareRedrawTargetAspectRatio,
            summary,
            items: squareRedrawImages.map(item => ({
                id: String(item.id).replace('server_', ''),
                filename: item.filename,
                width: item.width,
                height: item.height,
                status: item.status,
                retry_count: item.retry_count || 0,
                source_url: item.source_url,
                output_url: item.output_url,
                error_message: item.error_message || '',
            })),
        },
    });
}

async function retrySquareRedrawFailed() {
    if (!squareRedrawBatchId) return;
    if (squareRedrawRunning || squareRedrawLoading) return;
    squareRedrawRunning = true;
    updateSquareRedrawActions();
    try {
        const response = await fetch(`${API_BASE}/api/square-redraw/batches/${squareRedrawBatchId}/retry-failed`, { method: 'POST' });
        const data = await response.json();
        if (data.status !== 'success') throw new Error(data.message || '重试失败项失败');
        applySquareRedrawBatch(data.data);
    } catch (err) {
        showToast(err.message || '重试失败项失败，请检查连接', 'error');
        return;
    } finally {
        squareRedrawRunning = false;
        updateSquareRedrawActions();
    }
    await runSquareRedrawQueue();
}

async function addImageToSquareRedraw(dataUrl, filename = 'image.png') {
    if (!dataUrl) return false;
    if (squareRedrawRunning || squareRedrawLoading) {
        showToast('图片正在处理中，请完成后再添加图片', 'warning');
        return false;
    }
    try {
        let width = 1000;
        let height = 1000;
        if (typeof readImageDimensions === 'function') {
            try {
                const size = await readImageDimensions(dataUrl);
                width = size.width;
                height = size.height;
            } catch (_) {}
        }
        const item = {
            id: `sr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            filename: filename,
            image_data: dataUrl,
            width: width,
            height: height,
            status: (typeof squareRedrawImageMatchesTarget === 'function' && squareRedrawImageMatchesTarget(width, height)) ? 'skipped_square' : 'ready',
            source_url: dataUrl,
            output_url: '',
            error_message: '',
        };
        squareRedrawImages.push(item);
        squareRedrawBatchId = null;
        squareRedrawRenderSignature = '';
        if (typeof renderSquareRedrawList === 'function') renderSquareRedrawList();
        if (typeof updateSquareRedrawActions === 'function') updateSquareRedrawActions();
        return true;
    } catch (e) {
        console.error('Failed to add image to square redraw:', e);
        return false;
    }
}

let squareRedrawDownloading = false;
async function downloadSquareRedrawZip() {
    if (!squareRedrawBatchId || squareRedrawDownloading) return;
    const batchId = squareRedrawBatchId;
    const button = document.getElementById('squareRedrawDownloadBtn');
    const previousLabel = button?.innerHTML;
    squareRedrawDownloading = true;
    if (button) { button.disabled = true; button.textContent = '正在准备 ZIP…'; }
    try {
        // Fetching avoids a cross-port navigation blocked by the desktop host.
        const response = await fetch(`${API_BASE}/api/square-redraw/batches/${batchId}/download`, {redirect:'error'});
        if (!response.ok || !/^application\/(zip|x-zip-compressed)(?:;|$)/i.test(response.headers.get('Content-Type') || '')) {
            throw new Error('ZIP 打包下载未完成，请确认本批有可导出的图片后重试。');
        }
        const blob = await response.blob();
        if (!blob.size) throw new Error('ZIP 文件为空，请重新核对本批结果。');
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url; link.download = `square-redraw-${batchId}.zip`;
        document.body.appendChild(link);
        try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
        showToast('ZIP 已交给下载器，请在下载目录或保存窗口查看', 'success');
    } catch (_) {
        showToast('ZIP 下载未完成，请检查本批图片与本机服务后重试。已有结果已保留。', 'error');
    } finally {
        squareRedrawDownloading = false;
        if (button) button.innerHTML = previousLabel;
        updateSquareRedrawActions();
    }
}

if (typeof window !== 'undefined') {
    window.handleSquareRedrawImagePaste = handleSquareRedrawImagePaste;
    window.handleSquareRedrawPaste = handleSquareRedrawPaste;
    window.sendSquareRedrawToDetails = sendSquareRedrawToDetails;
    window.sendSquareRedrawToTranslate = sendSquareRedrawToTranslate;
    window.addImageToSquareRedraw = addImageToSquareRedraw;
    window.uploadSquareRedrawItemToCloud = uploadSquareRedrawItemToCloud;
    window.batchUploadSquareRedrawToCloud = batchUploadSquareRedrawToCloud;
    window.uploadCurrentSquareRedrawPreviewToCloud = uploadCurrentSquareRedrawPreviewToCloud;
    window.setSquareRedrawImages = (imgs) => { squareRedrawImages = imgs; };
    window.getSquareRedrawImages = () => squareRedrawImages;
}
if (typeof globalThis !== 'undefined') {
    globalThis.handleSquareRedrawImagePaste = handleSquareRedrawImagePaste;
    globalThis.handleSquareRedrawPaste = handleSquareRedrawPaste;
    globalThis.sendSquareRedrawToDetails = sendSquareRedrawToDetails;
    globalThis.sendSquareRedrawToTranslate = sendSquareRedrawToTranslate;
    globalThis.addImageToSquareRedraw = addImageToSquareRedraw;
    globalThis.uploadSquareRedrawItemToCloud = uploadSquareRedrawItemToCloud;
    globalThis.batchUploadSquareRedrawToCloud = batchUploadSquareRedrawToCloud;
    globalThis.uploadCurrentSquareRedrawPreviewToCloud = uploadCurrentSquareRedrawPreviewToCloud;
    globalThis.setSquareRedrawImages = (imgs) => { squareRedrawImages = imgs; };
    globalThis.getSquareRedrawImages = () => squareRedrawImages;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        ...(module.exports || {}),
        handleSquareRedrawImagePaste,
        handleSquareRedrawPaste,
        sendSquareRedrawToDetails,
        sendSquareRedrawToTranslate,
        addImageToSquareRedraw,
        uploadSquareRedrawItemToCloud,
        batchUploadSquareRedrawToCloud,
        uploadCurrentSquareRedrawPreviewToCloud,
        setSquareRedrawImages: (imgs) => { squareRedrawImages = imgs; },
        getSquareRedrawImages: () => squareRedrawImages
    };
}

// Keep keyboard interaction inside the comparison while it is open.
if (typeof document !== 'undefined') document.addEventListener?.('keydown', event => {
    const modal = document.getElementById('squareRedrawPreviewModal');
    if (!modal || modal.classList.contains('hidden')) return;
    if (event.key === 'Escape') { event.preventDefault(); closeSquareRedrawPreview(); }
    if (event.key === 'Tab') {
        const controls = Array.from(modal.querySelectorAll('button:not(:disabled)'));
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
});
