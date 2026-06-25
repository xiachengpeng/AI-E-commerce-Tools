let squareRedrawImages = [];
let squareRedrawBatchId = null;
let squareRedrawPollingTimer = null;
let squareRedrawFilter = 'all';

function initSquareRedrawControls() {
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
                status: size.width === size.height ? 'skipped_square' : 'ready',
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
        skipped_square: '已是 1:1，跳过',
    };
    return labels[status] || status;
}

function squareRedrawStatusBadgeClass(status) {
    return `square-redraw-badge-${status || 'ready'}`;
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
        return `
            <div class="square-redraw-card fade-in">
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
            <div class="absolute left-3 top-3 rounded-lg bg-amber-50 px-2 py-1 text-[10px] font-black text-amber-700 border border-amber-100">已是 1:1，未重绘</div>
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
    document.getElementById('squareRedrawPreviewMeta').textContent = `${item.width || '-'} x ${item.height || '-'} · ${squareRedrawStatusLabel(item.status)}`;
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
    if (startBtn) startBtn.disabled = !squareRedrawImages.length;
    if (retryBtn) retryBtn.disabled = !squareRedrawBatchId || summary.failed === 0;
    if (downloadBtn) downloadBtn.disabled = !squareRedrawBatchId || (summary.done + summary.skipped === 0);
}

async function startSquareRedrawBatch() {
    if (!squareRedrawImages.length) {
        showToast('请先上传图片', 'error');
        return;
    }

    const payload = {
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
    startSquareRedrawPolling();
}

function applySquareRedrawBatch(batch) {
    squareRedrawBatchId = batch.id;
    squareRedrawImages = (batch.items || []).map(item => ({
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
    renderSquareRedrawList();
    updateSquareRedrawActions();
}

function startSquareRedrawPolling() {
    stopSquareRedrawPolling();
    squareRedrawPollingTimer = setInterval(refreshSquareRedrawBatch, 2000);
    refreshSquareRedrawBatch();
}

function stopSquareRedrawPolling() {
    if (squareRedrawPollingTimer) clearInterval(squareRedrawPollingTimer);
    squareRedrawPollingTimer = null;
}

async function refreshSquareRedrawBatch() {
    if (!squareRedrawBatchId) return;
    const response = await fetch(`${API_BASE}/api/square-redraw/batches/${squareRedrawBatchId}`);
    const data = await response.json();
    if (data.status !== 'success') return;
    applySquareRedrawBatch(data.data);
    const active = squareRedrawImages.some(item => ['queued', 'running'].includes(item.status));
    if (!active) stopSquareRedrawPolling();
}

async function retrySquareRedrawFailed() {
    if (!squareRedrawBatchId) return;
    const response = await fetch(`${API_BASE}/api/square-redraw/batches/${squareRedrawBatchId}/retry-failed`, { method: 'POST' });
    const data = await response.json();
    if (data.status !== 'success') {
        showToast(data.message || '重跑失败项失败', 'error');
        return;
    }
    applySquareRedrawBatch(data.data);
    startSquareRedrawPolling();
}

function downloadSquareRedrawZip() {
    if (!squareRedrawBatchId) return;
    window.location.href = `${API_BASE}/api/square-redraw/batches/${squareRedrawBatchId}/download`;
}
