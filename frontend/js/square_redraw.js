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
        return `
            <div class="bg-white border border-slate-200 rounded-xl p-3 flex items-center gap-3">
                <div class="w-20 h-20 rounded-lg bg-slate-100 overflow-hidden flex-shrink-0">
                    <img src="${preview}" class="w-full h-full object-contain">
                </div>
                <div class="min-w-0 flex-1">
                    <div class="font-bold text-sm text-slate-800 truncate">${escapeSquareRedrawHtml(item.filename)}</div>
                    <div class="text-xs text-slate-400 mt-1">${item.width || '-'} x ${item.height || '-'}</div>
                    ${error}
                </div>
                <span class="text-[11px] font-black px-2 py-1 rounded-lg bg-slate-100 text-slate-600">${squareRedrawStatusLabel(item.status)}</span>
            </div>
        `;
    }).join('');
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
