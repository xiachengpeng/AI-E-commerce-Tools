let squareRedrawImages = [];
let squareRedrawBatchId = null;
let squareRedrawFilter = 'all';
let squareRedrawTargetAspectRatio = '1:1';
let squareRedrawRenderSignature = '';
let squareRedrawRunning = false;
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

function readImageDimensions(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => reject(new Error('图片尺寸读取失败'));
        img.src = dataUrl;
    });
}

async function loadSquareRedrawFiles(files) {
    if (!files.length) return;
    if (files.length > 100) {
        showToast('每批最多上传 100 张图片，请拆批处理', 'error');
        return;
    }

    squareRedrawImages = [];
    try {
        for (const file of files) {
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = e => resolve(e.target.result);
                reader.onerror = () => reject(new Error('图片读取失败'));
                reader.readAsDataURL(file);
            });
            const size = await readImageDimensions(dataUrl);
            squareRedrawImages.push({
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
    }

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
    if (!el) return;
    el.innerHTML = `
        <span>总数 ${summary.total}</span>
        <span>待重绘 ${summary.ready}</span>
        <span>处理中 ${summary.running}</span>
        <span>成功 ${summary.done}</span>
        <span>失败 ${summary.failed}</span>
        <span>跳过 ${summary.skipped}</span>
    `;
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
        done: '完成',
        failed: '失败',
        skipped_square: '已符合目标，跳过',
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
}

function refreshSquareRedrawLocalSkipStatuses() {
    if (squareRedrawBatchId) return;
    squareRedrawImages = squareRedrawImages.map(item => ({
        ...item,
        status: squareRedrawImageMatchesTarget(item.width, item.height) ? 'skipped_square' : 'ready',
    }));
}

function setSquareRedrawAspectRatio(ratio) {
    if (squareRedrawBatchId) {
        showToast('当前批次已创建，如需改尺寸请重新上传一批图片', 'error');
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
    if (squareRedrawBatchId) {
        showToast('当前批次已创建，如需改尺寸请重新上传一批图片', 'error');
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
    list.innerHTML = squareRedrawVisibleItems().map(item => {
        const preview = item.output_url ? formatSquareRedrawUrl(item.output_url) : item.source_url;
        const error = item.error_message ? `<div class="text-[11px] text-red-500 mt-1">${escapeSquareRedrawHtml(item.error_message)}</div>` : '';
        const statusClass = squareRedrawStatusBadgeClass(item.status);
        const resultLabel = item.status === 'done' ? '点击查看前后对比' : '点击查看预览';
        const deleteDisabled = item.status === 'running' ? 'disabled' : '';
        return `
            <div class="square-redraw-card">
                <button type="button" onclick="openSquareRedrawPreview('${item.id}')"
                    class="square-redraw-thumb">
                    <img src="${preview}" alt="${escapeSquareRedrawHtml(item.filename)}">
                    <span class="square-redraw-thumb-overlay">
                        <i class="ph ph-arrows-out text-white text-lg"></i>
                    </span>
                </button>
                <button type="button" onclick="openSquareRedrawPreview('${item.id}')" class="square-redraw-info">
                    <div class="square-redraw-title">${escapeSquareRedrawHtml(item.filename)}</div>
                    <div class="square-redraw-meta">${item.width || '-'} x ${item.height || '-'} · ${resultLabel}</div>
                    ${error}
                </button>
                <span class="square-redraw-badge ${statusClass}">${squareRedrawStatusLabel(item.status)}</span>
                <button type="button" onclick="openSquareRedrawPreview('${item.id}')"
                    class="square-redraw-preview-btn" title="查看对比">
                    <i class="ph ph-eye text-base"></i>
                </button>
                <button type="button" onclick="removeSquareRedrawImage('${item.id}')" ${deleteDisabled}
                    class="square-redraw-delete-btn" title="删除">
                    <i class="ph ph-trash text-base"></i>
                </button>
            </div>
        `;
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
    sourceImg.src = item.source_url;

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
                <div class="text-xs text-red-300">${escapeSquareRedrawHtml(item.error_message || '请重跑失败项')}</div>
            </div>
        `;
    } else {
        resultHtml = `
            <div class="h-full min-h-[260px] flex flex-col items-center justify-center gap-2 text-center text-slate-300">
                <i class="ph ph-hourglass text-4xl"></i>
                <div class="text-sm font-black">${squareRedrawStatusLabel(item.status)}</div>
                <div class="text-xs">生成完成后这里会显示 1:1 方图</div>
            </div>
        `;
    }

    resultWrap.innerHTML = resultHtml;
    document.getElementById('squareRedrawPreviewMeta').textContent = `${item.width || '-'} x ${item.height || '-'} · 目标 ${squareRedrawTargetAspectRatio} · ${squareRedrawStatusLabel(item.status)}`;
    modal.classList.remove('hidden');
}

function closeSquareRedrawPreview() {
    document.getElementById('squareRedrawPreviewModal')?.classList.add('hidden');
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
    if (url.startsWith('/static')) return API_BASE + url;
    return url;
}

function updateSquareRedrawActions() {
    const startBtn = document.getElementById('squareRedrawStartBtn');
    const retryBtn = document.getElementById('squareRedrawRetryBtn');
    const downloadBtn = document.getElementById('squareRedrawDownloadBtn');
    const summary = squareRedrawSummary();
    if (startBtn) startBtn.disabled = !squareRedrawImages.length || squareRedrawRunning;
    if (retryBtn) retryBtn.disabled = squareRedrawRunning || !squareRedrawBatchId || summary.failed === 0;
    if (downloadBtn) downloadBtn.disabled = squareRedrawRunning || !squareRedrawBatchId || (summary.done + summary.skipped === 0);
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

    const payload = {
        target_aspect_ratio: squareRedrawTargetAspectRatio,
        images: squareRedrawImages.map(item => ({
            filename: item.filename,
            image_data: item.image_data,
            width: item.width,
            height: item.height,
        })),
    };

    const response = await fetch(`${API_BASE}/api/square-redraw/batches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (data.status !== 'success') {
        showToast(data.message || '创建重绘任务失败', 'error');
        return;
    }
    applySquareRedrawBatch(data.data);
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
    if (item.status === 'running') {
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
                await refreshSquareRedrawBatch();
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
    await refreshSquareRedrawBatch();
    updateSquareRedrawActions();
    showToast(`重绘完成：成功 ${successCount}，失败 ${errorCount}`, errorCount ? 'warning' : 'success');
}

async function retrySquareRedrawFailed() {
    if (!squareRedrawBatchId) return;
    if (squareRedrawRunning) return;
    const response = await fetch(`${API_BASE}/api/square-redraw/batches/${squareRedrawBatchId}/retry-failed`, { method: 'POST' });
    const data = await response.json();
    if (data.status !== 'success') {
        showToast(data.message || '重跑失败项失败', 'error');
        return;
    }
    applySquareRedrawBatch(data.data);
    await runSquareRedrawQueue();
}

function downloadSquareRedrawZip() {
    if (!squareRedrawBatchId) return;
    window.location.href = `${API_BASE}/api/square-redraw/batches/${squareRedrawBatchId}/download`;
}
