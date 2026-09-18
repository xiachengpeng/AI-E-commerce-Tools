/**
 * 全局历史记录中心逻辑
 */

let currentHistoryModule = 'analysis'; // 默认标签
let _history_cache = []; // 全局缓存，防止 DOM 溢出
let isHistoryBatchMode = false; // 是否处于批量删除模式
let selectedHistoryIds = new Set(); // 当前选中的历史记录 ID 集合

function formatImgSrc(src) {
    if (!src) return '';
    if (typeof src === 'string') {
        if (src.startsWith('data:image') || src.startsWith('http')) return src;
        if (src.startsWith('/static')) return API_BASE + src;
    }
    return src;
}

function escapeHistoryHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[char]);
}

function formatHistoryImgSrc(src) {
    const formatted = formatImgSrc(src);
    if (typeof formatted !== 'string') return '';
    const trimmed = formatted.trim();
    if (
        /^https?:\/\//i.test(trimmed) ||
        /^data:image\/(?:gif|jpe?g|png|webp);base64,/i.test(trimmed)
    ) {
        return trimmed;
    }
    return '';
}

function getHistoryModuleForActiveTab(tabId) {
    const map = {
        'analysis': 'analysis',
        'generate': 'render',
        'listing': 'listing',
        'ads': 'ads',
        'square-redraw': 'square-redraw',
        'watermark-removal': 'watermark-removal',
        'translate': 'translation',
        'text-translate': 'text-translation'
    };
    return map[tabId] || null;
}

function toggleGlobalHistory(forceState) {
    const panel = document.getElementById('globalHistoryPanel');
    if (!panel) return;
    const btn = document.getElementById('btnOpenHistory');
    const shouldOpen = typeof forceState === 'boolean' ? forceState : !panel.classList.contains('open');

    panel.classList.toggle('open', shouldOpen);
    if (btn && btn.classList) {
        if (typeof btn.classList.toggle === 'function') {
            btn.classList.toggle('active', shouldOpen);
        } else if (shouldOpen) {
            btn.classList.add?.('active');
        } else {
            btn.classList.remove?.('active');
        }
    }

    if (shouldOpen) {
        const activeTab = (typeof localStorage !== 'undefined' && localStorage.getItem('activeMainTab')) || 'analysis';
        const mappedMod = getHistoryModuleForActiveTab(activeTab);
        if (mappedMod) {
            currentHistoryModule = mappedMod;
        }
        loadGlobalHistory(currentHistoryModule);
    }
}

function switchHistoryTab(module) {
    currentHistoryModule = module;
    selectedHistoryIds.clear();
    isHistoryBatchMode = false;
    loadGlobalHistory(module);
}

function updateHistoryBatchUI() {
    const toolbar = document.getElementById('historyToolbar');
    const batchBar = document.getElementById('historyBatchBar');
    const toggleBtn = document.getElementById('historyBatchToggleBtn');
    const selectAllCb = document.getElementById('historySelectAllCheckbox');
    const countBadge = document.getElementById('historySelectedCount');
    const deleteBtn = document.getElementById('historyBatchDeleteBtn');
    const totalCountEl = document.getElementById('historyItemCount');

    const totalCount = Array.isArray(_history_cache) ? _history_cache.length : 0;
    if (totalCountEl) {
        totalCountEl.textContent = `共 ${totalCount} 条记录`;
    }

    if (toggleBtn) {
        toggleBtn.disabled = totalCount === 0;
        toggleBtn.classList.toggle('opacity-50', totalCount === 0);
        toggleBtn.classList.toggle('cursor-not-allowed', totalCount === 0);
    }

    if (isHistoryBatchMode) {
        toolbar?.classList.add('hidden');
        batchBar?.classList.remove('hidden');
        if (countBadge) countBadge.textContent = `已选 ${selectedHistoryIds.size} 项`;
        if (deleteBtn) {
            deleteBtn.disabled = selectedHistoryIds.size === 0;
            deleteBtn.innerHTML = `<i class="ph ph-trash"></i> <span>删除所选${selectedHistoryIds.size > 0 ? ` (${selectedHistoryIds.size})` : ''}</span>`;
        }
        if (selectAllCb) {
            selectAllCb.checked = totalCount > 0 && selectedHistoryIds.size === totalCount;
            selectAllCb.indeterminate = selectedHistoryIds.size > 0 && selectedHistoryIds.size < totalCount;
        }
    } else {
        toolbar?.classList.remove('hidden');
        batchBar?.classList.add('hidden');
    }
}

function toggleHistoryBatchMode(forceState) {
    isHistoryBatchMode = typeof forceState === 'boolean' ? forceState : !isHistoryBatchMode;
    if (!isHistoryBatchMode) {
        selectedHistoryIds.clear();
    }
    updateHistoryBatchUI();
    renderHistoryItems();
}

function toggleHistorySelectAll(checked) {
    if (checked) {
        _history_cache.forEach(item => {
            if (item && item.id != null) selectedHistoryIds.add(item.id);
        });
    } else {
        selectedHistoryIds.clear();
    }
    updateHistoryBatchUI();
    renderHistoryItems();
}

function toggleHistoryItemSelection(id, checked) {
    if (checked) {
        selectedHistoryIds.add(id);
    } else {
        selectedHistoryIds.delete(id);
    }
    updateHistoryBatchUI();
    renderHistoryItems();
}

function handleHistoryItemClick(module, index, id) {
    if (isHistoryBatchMode) {
        toggleHistoryItemSelection(id, !selectedHistoryIds.has(id));
    } else {
        restoreHistoryItemByIndex(module, index);
    }
}

async function deleteHistoryBatchSelected() {
    if (!selectedHistoryIds.size) return;
    const count = selectedHistoryIds.size;
    if (!confirm(`确定要批量删除选中的 ${count} 条历史记录吗？删除后无法恢复。`)) return;

    try {
        const ids = Array.from(selectedHistoryIds);
        let res = await fetch(`${API_BASE}/api/history/${currentHistoryModule}/batch-delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids })
        });

        // 兼容性降级：若后端进程尚未重启加载批量路由 (HTTP 404 或 405)，自动降级为并行单条删除
        if (!res.ok && (res.status === 404 || res.status === 405)) {
            console.warn(`[History] Batch delete endpoint returned ${res.status}, fallback to parallel single deletes`);
            const results = await Promise.allSettled(
                ids.map(id => fetch(`${API_BASE}/api/history/${currentHistoryModule}/${id}`, { method: 'DELETE' }))
            );
            const successCount = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
            if (successCount > 0) {
                showToast(`已成功删除 ${successCount} 条历史记录`, 'success');
                selectedHistoryIds.clear();
                isHistoryBatchMode = false;
                await loadGlobalHistory(currentHistoryModule);
                return;
            }
        }

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            const errMsg = errData.detail || errData.message || `批量删除失败 (HTTP ${res.status})`;
            console.error(`Batch delete history failed: HTTP ${res.status}`, errData);
            showToast(errMsg, 'error');
            return;
        }

        const data = await res.json();
        if (data.status === 'success') {
            showToast(`已成功删除 ${data.deleted_count ?? count} 条历史记录`, 'success');
            selectedHistoryIds.clear();
            isHistoryBatchMode = false;
            await loadGlobalHistory(currentHistoryModule);
        } else {
            showToast(data.message || '批量删除失败', 'error');
        }
    } catch (e) {
        console.error('Batch delete failed:', e);
        showToast('批量删除失败: ' + (e.message || '网络异常'), 'error');
    }
}

async function loadGlobalHistory(module) {
    currentHistoryModule = module;
    const list = document.getElementById('globalHistoryList');
    if (!list) return;
    list.innerHTML = '<div class="text-center py-10"><span class="loader border-blue-500 border-t-transparent w-6 h-6"></span></div>';

    // 更新 UI 状态
    document.querySelectorAll('.history-tab-btn').forEach(btn => {
        const modId = btn.id.replace('hist-tab-', '');
        const map = { 'analysis': 'analysis', 'listing': 'listing', 'translation': 'translation', 'text-translation': 'text-translation', 'ads': 'ads', 'square-redraw': 'square-redraw', 'watermark-removal': 'watermark-removal', 'render': 'render' };
        btn.classList.toggle('active', map[modId] === module);
    });

    try {
        const res = await fetch(`${API_BASE}/api/history/${module}?_t=${Date.now()}`);
        const data = await res.json();
        _history_cache = Array.isArray(data) ? data : [];

        if (!_history_cache.length) {
            isHistoryBatchMode = false;
            selectedHistoryIds.clear();
        }
        updateHistoryBatchUI();
        renderHistoryItems();
    } catch (e) {
        list.innerHTML = '<div class="text-center py-20 text-red-400">加载失败</div>';
        updateHistoryBatchUI();
    }
}

function renderHistoryItems() {
    const list = document.getElementById('globalHistoryList');
    if (!list) return;

    if (!_history_cache || _history_cache.length === 0) {
        list.innerHTML = '<div class="text-center py-20 text-gray-400 text-sm">暂无记录</div>';
        return;
    }

    const module = currentHistoryModule;
    list.innerHTML = _history_cache.map((item, index) => {
        // 极致兼容：依次尝试所有可能的名称字段
        const name = item.query_url ||
            item.product_name ||
            item.task_name ||
            (module === 'square-redraw' && item.batch_id ? `尺寸重绘批次 #${item.batch_id}` : '') ||
            (module === 'watermark-removal' ? item.filename : '') ||
            item.source_text ||
            item.name ||
            item.text ||
            (item.result && (item.result.title?.target || item.result.name)) ||
            '未命名任务';

        const time = item.timestamp ? new Date(item.timestamp).toLocaleString() : '未知时间';

        let subInfo = item.platform ? `平台: ${item.platform}` : (item.target_lang ? `语言: ${item.target_lang}` : (item.style ? `风格: ${item.style}` : ''));

        // 针对文本翻译，把结果摘要放进去
        if (module === 'text-translation' && item.result) {
            const preview = typeof item.result === 'string' ? item.result : (item.result.translated_text || '');
            subInfo += ` | 译文: ${preview.substring(0, 30)}${preview.length > 30 ? '...' : ''}`;
        } else if (module === 'ads') {
            subInfo = [item.platforms, item.region, item.target_lang].filter(Boolean).join(' / ');
        } else if (module === 'square-redraw') {
            const result = item.result || {};
            const summary = result.summary || {};
            subInfo = `目标 ${item.target_aspect_ratio || result.target_aspect_ratio || '1:1'} | 成功 ${summary.done || 0} | 跳过 ${summary.skipped || 0} | 失败 ${summary.failed || 0}`;
        } else if (module === 'watermark-removal') {
            const result = item.result || {};
            const size = result.width && result.height ? `${result.width} × ${result.height}` : '';
            const regionCount = Array.isArray(result.regions) ? `${result.regions.length} 个区域` : '';
            subInfo = [size, regionCount].filter(Boolean).join(' | ') || '已完成消除';
        }

        // 提取缩略图 (针对翻译和渲染模块)
        let thumb = '';
        if (module === 'square-redraw') {
            const firstImage = (item.result?.items || []).find(img => img.output_url || img.source_url);
            const imgSrc = formatHistoryImgSrc(firstImage?.output_url || firstImage?.source_url);
            if (imgSrc) {
                thumb = `<div class="w-10 h-10 rounded border border-gray-100 overflow-hidden flex-shrink-0 bg-gray-50">
                            <img src="${escapeHistoryHtml(imgSrc)}" class="w-full h-full object-cover">
                         </div>`;
            }
        } else if (module === 'watermark-removal') {
            const imgSrc = formatHistoryImgSrc(item.result?.result_url);
            if (imgSrc) {
                thumb = `<div class="w-10 h-10 rounded border border-gray-100 overflow-hidden flex-shrink-0 bg-gray-50">
                            <img src="${escapeHistoryHtml(imgSrc)}" class="w-full h-full object-cover" alt="">
                         </div>`;
            }
        } else if (module === 'render' || module === 'translation' || module === 'ads') {
            const imgData = item.image_url || item.image_base64 || item.result || item.data || item.metadata_info?.finalImage;
            let imgSrc = formatHistoryImgSrc(typeof imgData === 'string' ? imgData : (imgData && imgData.image));

            if (imgSrc) {
                thumb = `<div class="w-10 h-10 rounded border border-gray-100 overflow-hidden flex-shrink-0 bg-gray-50">
                            <img src="${escapeHistoryHtml(imgSrc)}" class="w-full h-full object-cover">
                         </div>`;
            }
        } else if (module === 'text-translation') {
            thumb = `<div class="w-10 h-10 rounded-lg bg-indigo-50 flex items-center justify-center flex-shrink-0 text-indigo-500">
                        <i class="ph-fill ph-text-t text-base"></i>
                     </div>`;
        }

        const isSelected = selectedHistoryIds.has(item.id);

        return `
            <div class="history-item p-3 border-b border-gray-50 hover:bg-blue-50 cursor-pointer transition-colors flex items-center gap-3 group ${isSelected ? 'bg-indigo-50/90 border-indigo-200 shadow-xs' : ''}"
                 onclick="handleHistoryItemClick('${module}', ${index}, ${item.id})">
                ${isHistoryBatchMode ? `
                    <input type="checkbox" class="history-item-checkbox rounded text-indigo-600 focus:ring-indigo-500 w-4 h-4 shrink-0 cursor-pointer"
                           ${isSelected ? 'checked' : ''}
                           onclick="event.stopPropagation(); toggleHistoryItemSelection(${item.id}, this.checked)">
                ` : ''}
                ${thumb}
                <div class="flex-1 min-w-0">
                    <div class="flex justify-between mb-1">
                        <span class="text-[9px] font-black text-blue-500 uppercase tracking-widest">${module}</span>
                        <span class="text-[9px] text-gray-400">${escapeHistoryHtml(time)}</span>
                    </div>
                    <div class="text-xs font-bold text-gray-800 truncate">${escapeHistoryHtml(name)}</div>
                    ${subInfo ? `<div class="text-[9px] text-gray-400 mt-1">${escapeHistoryHtml(subInfo)}</div>` : ''}
                </div>
                ${!isHistoryBatchMode ? `
                <button onclick="event.stopPropagation(); deleteHistoryItem('${module}', ${item.id})"
                        class="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-50 text-gray-400 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                        title="删除此记录">
                    <i class="ph ph-trash text-base"></i>
                </button>
                ` : ''}
            </div>
        `;
    }).join('');
}


async function restoreHistoryItemByIndex(module, index) {
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
            if (typeof restoreListingFullState === 'function') {
                restoreListingFullState(dataObj);
                showToast('Listing 历史已完整恢复', 'success');
            } else if (typeof renderListingData === 'function') {
                renderListingData(responseObj);
                showToast('Listing 历史已恢复', 'success');
            }
        }, 150);
    } else if (module === 'ads') {
        switchMainTab('ads');
        if (!responseObj || typeof responseObj !== 'object') {
            showToast('该广告文案历史记录数据格式已失效', 'error');
            return;
        }
        setTimeout(() => {
            if (typeof renderAdsData === 'function') {
                renderAdsData(responseObj);
                const imageSrc = formatImgSrc(dataObj.image_url);
                if (imageSrc) {
                    currentAdsUploadedBase64 = imageSrc;
                    const preview = document.getElementById('adsUploadedImagePreview');
                    const previewWrap = document.getElementById('adsImagePreviewContainer');
                    if (preview) preview.src = imageSrc;
                    if (previewWrap) previewWrap.classList.remove('hidden');
                }
                showToast('广告文案历史已恢复', 'success');
            }
        }, 150);
    } else if (module === 'render') {
        switchMainTab('generate');

        let metadata = dataObj.metadata_info || dataObj.metadata || null;
        if (!metadata && dataObj.id) {
            try {
                const itemRes = await fetch(`${API_BASE}/api/history/render/${dataObj.id}`);
                if (itemRes.ok) {
                    const fullItem = await itemRes.json();
                    if (fullItem) {
                        dataObj.metadata_info = fullItem.metadata_info;
                        dataObj.image_base64 = fullItem.image_base64 || dataObj.image_base64;
                        metadata = fullItem.metadata_info || fullItem.metadata || {};
                    }
                }
            } catch (err) {
                console.warn('[History] 按需拉取详情页项目详情失败:', err);
            }
        }
        metadata = metadata || {};
        let imgData = dataObj.image_base64 || responseObj;
        if (imgData && typeof imgData === 'object') {
            imgData = imgData.image_base64 || imgData.image || imgData.data || imgData.finalImage || '';
        }
        const finalSrc = formatImgSrc(imgData || metadata.finalImage);

        if (metadata && metadata.kind === 'detail-page-project' && typeof renderRestoredDetailProject === 'function') {
            const restored = renderRestoredDetailProject(metadata, finalSrc);
            if (restored) {
                showToast('已还原详情页项目', 'success');
                toggleGlobalHistory();
                return;
            }
        }

        const previewContainer = document.getElementById('longImageCanvas');
        if (previewContainer) {
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
    } else if (module === 'text-translation') {
        switchMainTab('text-translate');
        const input = document.getElementById('transInputText');
        const container = document.getElementById('transResultsContainer');
        const placeholder = document.getElementById('transResultPlaceholder');
        
        if (input) input.value = dataObj.source_text || '';
        if (container) {
            if (placeholder) placeholder.classList.add('hidden');
            container.innerHTML = ''; // 清空当前结果
            
            // 判断结果是否为 JSON 字符串或对象（批量结果）
            let resultsMap = {};
            try {
                if (typeof dataObj.result === 'string' && (dataObj.result.startsWith('{') || dataObj.result.startsWith('['))) {
                    resultsMap = jsonParseSafe(dataObj.result);
                } else if (typeof dataObj.result === 'object') {
                    resultsMap = dataObj.result;
                } else {
                    // 单一结果，包装成 Map 以统一处理
                    resultsMap = { [dataObj.target_lang || 'Target']: dataObj.result };
                }
            } catch (e) {
                resultsMap = { [dataObj.target_lang || 'Target']: dataObj.result };
            }

            // 循环渲染所有语言卡片
            Object.entries(resultsMap).forEach(([langName, text]) => {
                const cardId = `res-card-hist-${Math.random().toString(36).substr(2, 9)}`;
                const cardHtml = `
                    <div id="${cardId}" class="bg-white rounded-xl border border-gray-100 p-6 shadow-sm hover:border-indigo-200 transition-all">
                        <div class="flex justify-between items-center mb-3">
                            <span class="px-3 py-1 bg-indigo-50 text-indigo-600 rounded-full text-[10px] font-black uppercase tracking-widest">${langName}</span>
                            <button onclick="copySingleCard('${cardId}-content')" class="text-indigo-400 hover:text-indigo-600 transition-colors p-1 rounded-md hover:bg-indigo-50">
                                <i class="ph ph-copy text-lg"></i>
                            </button>
                        </div>
                        <div id="${cardId}-content" class="text-gray-700 text-sm leading-relaxed whitespace-pre-wrap">${text || ''}</div>
                    </div>
                `;
                container.insertAdjacentHTML('beforeend', cardHtml);
            });
            
            showToast('已还原文本翻译历史', 'success');
        }
    } else if (module === 'square-redraw') {
        switchMainTab('square-redraw');
        if (!responseObj || typeof responseObj !== 'object') {
            showToast('该尺寸重绘历史记录数据格式已失效', 'error');
            return;
        }
        setTimeout(() => {
            if (typeof applySquareRedrawBatch === 'function') {
                applySquareRedrawBatch(responseObj);
                showToast('已还原尺寸重绘历史', 'success');
            }
        }, 150);
    } else if (module === 'watermark-removal') {
        switchMainTab('watermark-removal');
        if (!responseObj || typeof responseObj !== 'object') {
            showToast('该 AI 消除历史记录数据格式已失效', 'error');
            return;
        }
        try {
            const restored = typeof restoreWatermarkRemovalHistory === 'function'
                && await restoreWatermarkRemovalHistory(responseObj);
            if (!restored) {
                showToast('AI 消除历史恢复失败', 'error');
                return;
            }
            showToast('已还原 AI 消除历史', 'success');
            toggleGlobalHistory();
        } catch (error) {
            console.error('Watermark removal history restore failed:', error);
            showToast('AI 消除历史恢复失败', 'error');
        }
        return;
    }

    toggleGlobalHistory();
}

async function saveToHistory(module, data) {
    try {
        const res = await fetch(`${API_BASE}/api/history/${module}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!res.ok) {
            console.error(`History save failed: HTTP ${res.status}`);
            showToast('历史记录保存失败', 'error');
            return false;
        }
        return true;
    } catch (e) {
        console.error('History save failed:', e);
        showToast('历史记录保存失败', 'error');
        return false;
    }
}

async function deleteHistoryItem(module, id) {
    if (!confirm('确定要删除这条记录吗？')) return;
    
    try {
        const response = await fetch(`${API_BASE}/api/history/${module}/${id}`, {
            method: 'DELETE'
        });
        if (!response.ok) {
            console.error(`Delete history failed: HTTP ${response.status}`);
            showToast('删除失败', 'error');
            return;
        }
        const data = await response.json();
        if (data.status === 'success') {
            showToast('记录已删除', 'success');
            selectedHistoryIds.delete(id);
            loadGlobalHistory(module); // 刷新列表
        } else {
            showToast('删除失败', 'error');
        }
    } catch (e) {
        console.error('Delete history failed:', e);
        showToast('删除失败', 'error');
    }
}

function getHistoryBatchMode() {
    return isHistoryBatchMode;
}

function getSelectedHistoryIds() {
    return selectedHistoryIds;
}

function setHistoryCache(items) {
    _history_cache = Array.isArray(items) ? items : [];
}

function getHistoryCache() {
    return _history_cache;
}

function getCurrentHistoryModule() {
    return currentHistoryModule;
}

function setCurrentHistoryModule(mod) {
    currentHistoryModule = mod;
}

if (typeof window !== 'undefined') {
    window.toggleGlobalHistory = toggleGlobalHistory;
    window.switchHistoryTab = switchHistoryTab;
    window.loadGlobalHistory = loadGlobalHistory;
    window.renderHistoryItems = renderHistoryItems;
    window.restoreHistoryItemByIndex = restoreHistoryItemByIndex;
    window.saveToHistory = saveToHistory;
    window.deleteHistoryItem = deleteHistoryItem;
    window.toggleHistoryBatchMode = toggleHistoryBatchMode;
    window.toggleHistorySelectAll = toggleHistorySelectAll;
    window.toggleHistoryItemSelection = toggleHistoryItemSelection;
    window.handleHistoryItemClick = handleHistoryItemClick;
    window.deleteHistoryBatchSelected = deleteHistoryBatchSelected;
    window.updateHistoryBatchUI = updateHistoryBatchUI;
    window.getHistoryBatchMode = getHistoryBatchMode;
    window.getSelectedHistoryIds = getSelectedHistoryIds;
    window.setHistoryCache = setHistoryCache;
    window.getHistoryCache = getHistoryCache;
    window.getCurrentHistoryModule = getCurrentHistoryModule;
    window.setCurrentHistoryModule = setCurrentHistoryModule;
}
if (typeof globalThis !== 'undefined') {
    globalThis.toggleGlobalHistory = toggleGlobalHistory;
    globalThis.switchHistoryTab = switchHistoryTab;
    globalThis.loadGlobalHistory = loadGlobalHistory;
    globalThis.renderHistoryItems = renderHistoryItems;
    globalThis.restoreHistoryItemByIndex = restoreHistoryItemByIndex;
    globalThis.saveToHistory = saveToHistory;
    globalThis.deleteHistoryItem = deleteHistoryItem;
    globalThis.toggleHistoryBatchMode = toggleHistoryBatchMode;
    globalThis.toggleHistorySelectAll = toggleHistorySelectAll;
    globalThis.toggleHistoryItemSelection = toggleHistoryItemSelection;
    globalThis.handleHistoryItemClick = handleHistoryItemClick;
    globalThis.deleteHistoryBatchSelected = deleteHistoryBatchSelected;
    globalThis.updateHistoryBatchUI = updateHistoryBatchUI;
    globalThis.getHistoryBatchMode = getHistoryBatchMode;
    globalThis.getSelectedHistoryIds = getSelectedHistoryIds;
    globalThis.setHistoryCache = setHistoryCache;
    globalThis.getHistoryCache = getHistoryCache;
    globalThis.getCurrentHistoryModule = getCurrentHistoryModule;
    globalThis.setCurrentHistoryModule = setCurrentHistoryModule;
    globalThis.getHistoryModuleForActiveTab = getHistoryModuleForActiveTab;
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const panel = document.getElementById('globalHistoryPanel');
            if (panel && panel.classList.contains('open')) {
                toggleGlobalHistory(false);
            }
        }
    });

    window.addEventListener('click', (e) => {
        const panel = document.getElementById('globalHistoryPanel');
        const btn = document.getElementById('btnOpenHistory');
        if (panel && panel.classList.contains('open')) {
            if (!panel.contains(e.target) && (!btn || !btn.contains(e.target))) {
                toggleGlobalHistory(false);
            }
        }
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        toggleGlobalHistory,
        switchHistoryTab,
        loadGlobalHistory,
        renderHistoryItems,
        restoreHistoryItemByIndex,
        saveToHistory,
        deleteHistoryItem,
        toggleHistoryBatchMode,
        toggleHistorySelectAll,
        toggleHistoryItemSelection,
        handleHistoryItemClick,
        deleteHistoryBatchSelected,
        updateHistoryBatchUI,
        getHistoryBatchMode,
        getSelectedHistoryIds,
        setHistoryCache,
        getHistoryCache,
        getCurrentHistoryModule,
        setCurrentHistoryModule,
        getHistoryModuleForActiveTab
    };
}
