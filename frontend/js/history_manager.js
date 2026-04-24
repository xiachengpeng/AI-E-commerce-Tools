/**
 * 全局历史记录中心逻辑
 */

let currentHistoryModule = 'analysis'; // 默认标签
let _history_cache = []; // 全局缓存，防止 DOM 溢出

function formatImgSrc(src) {
    if (!src) return '';
    if (typeof src === 'string') {
        if (src.startsWith('data:image') || src.startsWith('http')) return src;
        if (src.startsWith('/static')) return API_BASE + src;
    }
    return src;
}

function toggleGlobalHistory() {
    const panel = document.getElementById('globalHistoryPanel');
    if (!panel) return;
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) {
        loadGlobalHistory(currentHistoryModule);
    }
}

function switchHistoryTab(module) {
    currentHistoryModule = module;
    loadGlobalHistory(module);
}

async function loadGlobalHistory(module) {
    currentHistoryModule = module;
    const list = document.getElementById('globalHistoryList');
    if (!list) return;
    list.innerHTML = '<div class="text-center py-10"><span class="loader border-blue-500 border-t-transparent w-6 h-6"></span></div>';

    // 更新 UI 状态
    document.querySelectorAll('.history-tab-btn').forEach(btn => {
        const modId = btn.id.replace('hist-tab-', '');
        const map = { 'analysis': 'analysis', 'listing': 'listing', 'translation': 'translation', 'render': 'render' };
        btn.classList.toggle('active', map[modId] === module);
    });

    try {
        const res = await fetch(`${API_BASE}/api/history/${module}?_t=${Date.now()}`);
        const data = await res.json();
        _history_cache = data;

        if (!data || data.length === 0) {
            list.innerHTML = '<div class="text-center py-20 text-gray-400 text-sm">暂无记录</div>';
            return;
        }

        list.innerHTML = data.map((item, index) => {
            // 极致兼容：依次尝试所有可能的名称字段
            const name = item.query_url ||
                item.product_name ||
                item.task_name ||
                item.source_text ||
                item.name ||
                item.text ||
                (item.result && (item.result.title?.target || item.result.name)) ||
                '未命名任务';

            const time = item.timestamp ? new Date(item.timestamp).toLocaleString() : '未知时间';
            const subInfo = item.platform ? `平台: ${item.platform}` : (item.target_lang ? `语言: ${item.target_lang}` : (item.style ? `风格: ${item.style}` : ''));

            // 提取缩略图 (针对翻译和渲染模块)
            let thumb = '';
            if (module === 'render' || module === 'translation') {
                const imgData = item.image_base64 || item.result || item.data;
                let imgSrc = formatImgSrc(typeof imgData === 'string' ? imgData : (imgData && imgData.image));
                
                if (imgSrc) {
                    thumb = `<div class="w-10 h-10 rounded border border-gray-100 overflow-hidden flex-shrink-0 bg-gray-50">
                                <img src="${imgSrc}" class="w-full h-full object-cover">
                             </div>`;
                }
            }

            return `
                <div class="history-item p-3 border-b border-gray-50 hover:bg-blue-50 cursor-pointer transition-colors flex gap-3" onclick="restoreHistoryItemByIndex('${module}', ${index})">
                    ${thumb}
                    <div class="flex-1 min-w-0">
                        <div class="flex justify-between mb-1">
                            <span class="text-[9px] font-black text-blue-500 uppercase tracking-widest">${module}</span>
                            <span class="text-[9px] text-gray-400">${time}</span>
                        </div>
                        <div class="text-xs font-bold text-gray-800 truncate">${name}</div>
                        ${subInfo ? `<div class="text-[9px] text-gray-400 mt-1">${subInfo}</div>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) {
        list.innerHTML = '<div class="text-center py-20 text-red-400">加载失败</div>';
    }
}

function restoreHistoryItemByIndex(module, index) {
    const dataObj = _history_cache[index];
    if (!dataObj) return;

    // 尝试从不同字段提取数据内容
    let responseObj = dataObj.data || dataObj.result || dataObj.image_base64;

    // 如果是字符串形式的 JSON，则进行解析
    if (typeof responseObj === 'string' && (responseObj.trim().startsWith('{') || responseObj.trim().startsWith('['))) {
        try { responseObj = JSON.parse(responseObj); } catch (e) { console.error('JSON parse failed for responseObj', e); }
    }

    if (module === 'analysis') {
        switchMainTab('analysis');

        // 确保数据结构完整
        if (!responseObj || typeof responseObj !== 'object') {
            console.error('Invalid analysis history data:', responseObj);
            showToast('该历史记录数据格式已失效', 'error');
            return;
        }

        // 关键修复：重构 xp_renderResults 预期的完整响应对象
        const fullResponse = {
            status: 'success',
            template_type: dataObj.template_type || (responseObj.single_data ? 'single' : 'matrix'),
            data: responseObj
        };

        console.log('[History] Reconstructed Response:', fullResponse);

        setTimeout(() => {
            if (window.xp_renderResults) {
                window.xp_renderResults(fullResponse);
                showToast('竞品分析历史已恢复', 'success');
            } else {
                console.error('window.xp_renderResults not found!');
                showToast('渲染引擎尚未就绪', 'error');
            }
        }, 150);
    } else if (module === 'listing') {
        switchMainTab('listing');
        if (!responseObj) return;
        setTimeout(() => {
            if (typeof renderListingData === 'function') {
                renderListingData(responseObj);
                showToast('Listing 历史已恢复', 'success');
            }
        }, 150);
    } else if (module === 'render') {
        switchMainTab('generate');

        const previewContainer = document.getElementById('longImageCanvas');
        if (previewContainer) {
            let imgData = dataObj.image_base64 || responseObj;
            if (imgData && typeof imgData === 'object') {
                imgData = imgData.image_base64 || imgData.image || imgData.data || imgData;
            }
            const finalSrc = formatImgSrc(imgData);
            previewContainer.innerHTML = `<img src="${finalSrc}" class="w-full shadow-2xl rounded-lg">`;
            document.getElementById('showcaseArea').classList.add('hidden');
            document.getElementById('resultArea').classList.remove('hidden');
            document.getElementById('longImageBuilderModal').classList.remove('hidden');
            showToast('已还原全案排版结果', 'success');
        }
    } else if (module === 'translation') {
        switchMainTab('translate');

        const modal = document.getElementById('transPreviewModal');
        if (modal) {
            let imgData = dataObj.result || responseObj;
            if (imgData && typeof imgData === 'object') {
                imgData = imgData.image || imgData.result || imgData.data || imgData;
            }
            document.getElementById('previewModalTitle').textContent = `历史记录回显: ${dataObj.source_text || '翻译记录'}`;
            const wrap = document.getElementById('previewResultsWrap');
            if (wrap) {
                wrap.innerHTML = `<div class="flex flex-col gap-4 w-full p-2">
                    <div class="flex justify-between items-center">
                        <span class="text-[10px] font-black text-blue-500 uppercase">→ 历史翻译结果 (${dataObj.target_lang || '未知语言'})</span>
                        <button onclick="downloadImage(formatImgSrc('${imgData}'), 'history_trans_${Date.now()}')" class="text-xs text-blue-600 hover:underline font-bold flex items-center gap-1">
                            <i class="ph ph-download-simple"></i> 下载此图
                        </button>
                    </div>
                    <div class="rounded-2xl border-4 border-white shadow-xl overflow-hidden bg-slate-100 flex items-center justify-center">
                        <img src="${formatImgSrc(imgData)}" class="w-full h-auto object-contain">
                    </div>
                </div>`;
            }
            modal.classList.remove('hidden');
            showToast('已还原翻译历史', 'success');
        }
    }

    toggleGlobalHistory();
}

async function saveToHistory(module, data) {
    try {
        await fetch(`${API_BASE}/api/history/${module}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
    } catch (e) {
        console.error('History save failed:', e);
    }
}
