/**
 * 图片翻译模块逻辑 - 增强版 (与参考 index_.html 同步)
 */

let transImages = [];
let transRunning = false;

// 目标语言配置
const TRANS_LANG_OPTIONS = [
    { value: 'English', label: '英文', short: 'EN' },
    { value: 'Japanese', label: '日文', short: 'JA' },
    { value: 'Spanish', label: '西语', short: 'ES' },
    { value: 'German', label: '德语', short: 'DE' },
    { value: 'French', label: '法语', short: 'FR' },
    { value: 'Korean', label: '韩语', short: 'KO' },
    { value: 'Arabic', label: '阿语', short: 'AR' },
    { value: 'Portuguese', label: '葡语', short: 'PT' },
    { value: 'Russian', label: '俄语', short: 'RU' },
    { value: 'Italian', label: '意语 (IT)', short: 'IT' },
];

// 点击外部关闭下拉菜单
window.addEventListener('click', (e) => {
    const dropdown = document.getElementById('langDropdown');
    const menu = document.getElementById('langDropdownMenu');
    if (dropdown && !dropdown.contains(e.target)) {
        if (menu) menu.classList.remove('open');
    }
});

function initTransLangTags() {
    const wrap = document.getElementById('transLangTags');
    if (!wrap) return;
    wrap.innerHTML = '';
    TRANS_LANG_OPTIONS.forEach(lang => {
        const div = document.createElement('div');
        div.className = 'lang-option';
        div.innerHTML = `<label class="flex items-center gap-2 p-2 hover:bg-gray-50 rounded cursor-pointer"><input type="checkbox" value="${lang.value}" ${lang.value === 'English' ? 'checked' : ''} onchange="updateLangDropdownLabel();updateTransStartBtn()"> <span class="text-xs text-gray-700">${lang.label}</span><span class="ml-auto text-[10px] text-gray-400 font-bold">${lang.short}</span></label>`;
        wrap.appendChild(div);
    });
    updateLangDropdownLabel();
}

function toggleLangDropdown() {
    document.getElementById('langDropdownMenu')?.classList.toggle('open');
}

function updateLangDropdownLabel() {
    const selected = getSelectedTransLangs();
    const trigger = document.getElementById('langDropdownTrigger');
    const label = document.getElementById('langDropdownLabel');
    if (!trigger || !label) return;

    if (selected.length === 0) {
        label.textContent = '目标语言';
        trigger.classList.remove('has-selection');
    } else {
        const names = selected.map(v => {
            const o = TRANS_LANG_OPTIONS.find(l => l.value === v);
            return o ? o.short : v.slice(0, 2).toUpperCase();
        });
        label.innerHTML = names.map(n => `<span class="lang-chip">${n}</span>`).join('');
        trigger.classList.add('has-selection');
    }
}

function clearLangSelection() {
    document.querySelectorAll('#transLangTags input[type=checkbox]').forEach(el => el.checked = false);
    updateLangDropdownLabel();
    updateTransStartBtn();
}

function getSelectedTransLangs() {
    return [...document.querySelectorAll('#transLangTags input[type=checkbox]:checked')].map(el => el.value);
}

function handleTransImageUpload(event) {
    loadTransFiles([...event.target.files]);
    event.target.value = '';
}

function handleTransDrop(event) {
    event.preventDefault();
    document.getElementById('transDropZone').classList.remove('drop-zone-active');
    loadTransFiles([...event.dataTransfer.files].filter(f => f.type.startsWith('image/')));
}

function loadTransFiles(files) {
    if (!files.length) return;
    let loaded = 0;
    files.forEach(file => {
        const reader = new FileReader();
        reader.onload = e => {
            const id = 'ti_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
            transImages.push({ id, name: file.name, base64: e.target.result, mimeType: file.type, status: 'waiting' });
            loaded++;
            if (loaded === files.length) {
                renderTransCards();
                updateTransStartBtn();
                showToast(`已添加 ${files.length} 张图片`, 'success');
            }
        };
        reader.readAsDataURL(file);
    });
}

function renderTransCards() {
    const empty = document.getElementById('transEmptyState');
    const list = document.getElementById('transTaskList');
    const footer = document.getElementById('transFooter');
    const container = document.getElementById('transCardContainer');

    if (!transImages.length) {
        empty.classList.remove('hidden');
        list.classList.add('hidden');
        footer.classList.add('hidden');
        return;
    }

    empty.classList.add('hidden');
    list.classList.remove('hidden');
    footer.classList.remove('hidden');

    document.getElementById('transQueueCount').textContent = `(${transImages.length})`;
    document.getElementById('transFileCount').textContent = `${transImages.length} 张`;

    transImages.forEach(img => {
        if (document.getElementById(`trans-card-${img.id}`)) return;
        container.insertAdjacentHTML('beforeend', `
            <div id="trans-card-${img.id}" class="trans-card fade-in">
                <div class="flex-shrink-0 self-center">
                    <input type="checkbox" id="trans-check-${img.id}" data-imgid="${img.id}" class="w-4 h-4 rounded accent-blue-600 cursor-pointer" onclick="event.stopPropagation()" onchange="updateTransSelection()">
                </div>
                <div class="trans-card-thumb" onclick="openTransPreview('${img.id}')">
                    <img src="${img.base64}">
                    <div class="trans-card-thumb-overlay"><i class="ph ph-arrows-out text-white text-xl"></i></div>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-3 mb-2">
                        <span class="font-black text-slate-800 truncate text-sm tracking-tight">${img.name}</span>
                        <span id="trans-card-badge-${img.id}" class="text-[10px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded-lg font-black uppercase tracking-widest flex-shrink-0">Waiting</span>
                    </div>
                    <div id="trans-card-progress-wrap-${img.id}" class="hidden mb-2">
                        <div class="trans-progress-bar w-full mb-1"><div id="trans-card-progress-${img.id}" class="trans-progress-fill" style="width:0%"></div></div>
                        <span id="trans-card-step-${img.id}" class="step-badge">准备中...</span>
                    </div>
                    <div id="trans-card-langs-${img.id}" class="flex flex-wrap gap-2 mt-1"></div>
                </div>
                <div class="flex flex-col items-end gap-2 flex-shrink-0 min-w-[100px]">
                    <button onclick="event.stopPropagation();removeTransImage('${img.id}')" class="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"><i class="ph ph-trash text-sm"></i></button>
                    <button id="trans-card-retrans-${img.id}" onclick="event.stopPropagation();retransCard('${img.id}')" class="hidden flex items-center gap-1.5 bg-amber-50 text-amber-600 hover:bg-amber-500 hover:text-white text-xs font-bold px-3 py-1.5 rounded-xl transition-all border border-amber-200"><i class="ph ph-arrows-clockwise text-sm"></i> 重新生成</button>
                    <button id="trans-card-export-${img.id}" onclick="event.stopPropagation();exportTransCard('${img.id}')" class="hidden flex items-center gap-1.5 bg-slate-50 text-slate-600 hover:bg-slate-600 hover:text-white text-xs font-bold px-3 py-1.5 rounded-xl transition-all border border-slate-200"><i class="ph ph-download-simple text-sm"></i> 导出</button>
                    <button id="trans-card-preview-${img.id}" onclick="openTransPreview('${img.id}')" class="hidden flex items-center gap-1.5 bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white text-xs font-bold px-3 py-1.5 rounded-xl transition-all"><i class="ph ph-eye text-sm"></i> 预览</button>
                </div>
            </div>`);
    });
    updateTransFooterCount();
}

function removeTransImage(id) {
    transImages = transImages.filter(i => i.id !== id);
    document.getElementById(`trans-card-${id}`)?.remove();
    renderTransCards();
    updateTransStartBtn();
    updateTransSelection();
}

async function downloadSelectedTrans() {
    const checked = [...document.querySelectorAll('#transCardContainer input[type=checkbox][data-imgid]:checked')];
    if (!checked.length) return;
    const langs = getSelectedTransLangs();
    let total = 0;
    for (const cb of checked) {
        const img = transImages.find(i => i.id === cb.dataset.imgid);
        if (!img) continue;
        for (const lang of langs) {
            const slotId = `trans-slot-${img.id}-${lang.replace(/\s/g, '')}`;
            const imgEl = document.getElementById(`${slotId}-img`);
            if (!imgEl || imgEl.tagName !== 'IMG') continue;
            const link = document.createElement('a');
            link.download = `${img.name.replace(/\.[^.]+$/, '')}-${lang.slice(0, 2)}-AI译图.png`;
            link.href = imgEl.src;
            link.click();
            total++;
            await new Promise(r => setTimeout(r, 300));
        }
    }
    showToast(total ? `已下载 ${total} 张译图` : '所选任务暂无已生成的译图', total ? 'success' : 'error');
}

function updateTransStartBtn() {
    const btn = document.getElementById('transStartBtn');
    if (btn) btn.disabled = !transImages.length || !getSelectedTransLangs().length || transRunning;
}

function updateTransSelection() {
    const checkboxes = document.querySelectorAll('#transCardContainer input[type=checkbox][data-imgid]');
    const checked = [...checkboxes].filter(c => c.checked);
    if (document.getElementById('transSelectedCount')) document.getElementById('transSelectedCount').textContent = `已选 ${checked.length} 项`;
    const btn = document.getElementById('transBatchDownloadBtn');
    if (btn) {
        btn.disabled = checked.length === 0;
    }
}

function toggleSelectAllTrans(checked) {
    document.querySelectorAll('#transCardContainer input[type=checkbox][data-imgid]').forEach(c => c.checked = checked);
    updateTransSelection();
}

async function exportTransCard(imgId) {
    const img = transImages.find(i => i.id === imgId);
    if (!img) return;
    const langs = getSelectedTransLangs();
    let count = 0;
    for (const lang of langs) {
        const slotId = `trans-slot-${imgId}-${lang.replace(/\s/g, '')}`;
        const imgEl = document.getElementById(`${slotId}-img`);
        if (!imgEl || imgEl.tagName !== 'IMG') continue;
        const link = document.createElement('a');
        link.download = `${img.name.replace(/\.[^.]+$/, '')}-${lang.slice(0, 2)}-AI译图.png`;
        link.href = imgEl.src;
        link.click();
        count++;
        await new Promise(r => setTimeout(r, 300));
    }
    showToast(count ? `已导出 ${count} 张译图` : '暂无已生成的译图', count ? 'success' : 'error');
}

async function exportAllTrans() {
    const langs = getSelectedTransLangs();
    let total = 0;
    for (const img of transImages) {
        if (!document.getElementById(`trans-card-badge-${img.id}`)?.textContent.includes('完成')) continue;
        for (const lang of langs) {
            const slotId = `trans-slot-${img.id}-${lang.replace(/\s/g, '')}`;
            const imgEl = document.getElementById(`${slotId}-img`);
            if (!imgEl || imgEl.tagName !== 'IMG') continue;
            const link = document.createElement('a');
            link.download = `${img.name.replace(/\.[^.]+$/, '')}-${lang.slice(0, 2)}-AI译图.png`;
            link.href = imgEl.src;
            link.click();
            total++;
            await new Promise(r => setTimeout(r, 300));
        }
    }
    showToast(total ? `全部导出完成，共 ${total} 张` : '暂无已完成的译图', total ? 'success' : 'error');
}

function updateTransFooterCount() {
    let done = 0, running = 0, pending = 0;
    transImages.forEach(img => {
        const t = document.getElementById(`trans-card-badge-${img.id}`)?.textContent.trim();
        if (t?.includes('完成')) done++;
        else if (t === '翻译中') running++;
        else pending++;
    });
    if (document.getElementById('transDoneCount')) document.getElementById('transDoneCount').textContent = done;
    if (document.getElementById('transRunningCount')) document.getElementById('transRunningCount').textContent = running;
    if (document.getElementById('transPendingCount')) document.getElementById('transPendingCount').textContent = pending;
}

function openTransPreview(imgId) {
    const img = transImages.find(i => i.id === imgId);
    if (!img) return;
    document.getElementById('previewModalTitle').textContent = img.name;
    document.getElementById('previewOrigImg').src = img.base64;
    const wrap = document.getElementById('previewResultsWrap');
    wrap.innerHTML = '';

    const langs = getSelectedTransLangs();
    if (!langs.length) {
        wrap.innerHTML = '<div class="flex items-center justify-center h-40 text-slate-300 text-sm">暂无翻译结果</div>';
    } else {
        langs.forEach(lang => {
            const langInfo = TRANS_LANG_OPTIONS.find(l => l.value === lang) || { label: lang, short: lang.slice(0, 2).toUpperCase() };
            const slotId = `trans-slot-${imgId}-${lang.replace(/\s/g, '')}`;
            const imgEl = document.getElementById(`${slotId}-img`);
            const errEl = document.getElementById(`${slotId}-img-error`);

            let displayHtml = `<div class="flex flex-col items-center gap-2 text-slate-300 py-8"><i class="ph ph-hourglass text-3xl"></i><span class="text-xs">尚未生成</span></div>`;

            if (imgEl) {
                displayHtml = `<img src="${imgEl.src}" class="w-full h-full object-contain rounded-2xl">`;
            } else if (errEl) {
                displayHtml = `<div class="flex flex-col items-center gap-2 text-red-400 py-8 text-center px-4"><i class="ph ph-warning-circle text-3xl"></i><span class="text-xs font-bold">生成失败</span><span class="text-[10px] text-red-300">${errEl.textContent}</span></div>`;
            }

            wrap.insertAdjacentHTML('beforeend', `
                <div class="flex flex-col gap-2 mb-4">
                    <div class="flex justify-between items-center px-1">
                        <span class="text-[10px] font-black text-blue-500 uppercase tracking-widest">→ ${langInfo.label} (${langInfo.short})</span>
                        ${imgEl ? `<button onclick="downloadTransResult('${slotId}-img','${img.name}-${langInfo.short}')" class="text-[10px] text-blue-600 hover:underline font-bold flex items-center gap-1"><i class="ph ph-download-simple"></i> 导出</button>` : ''}
                    </div>
                    <div class="rounded-2xl border-4 border-white shadow-xl overflow-hidden bg-slate-100" style="min-height:120px;display:flex;align-items:center;justify-content:center">${displayHtml}</div>
                </div>`);
        });
    }
    document.getElementById('transPreviewModal').classList.remove('hidden');
}

function closeTransPreview() {
    document.getElementById('transPreviewModal').classList.add('hidden');
}

async function downloadTransResult(imgId, filename) {
    const el = document.getElementById(imgId);
    if (!el || el.tagName !== 'IMG') { showToast('图片尚未生成', 'error'); return; }
    try {
        const link = document.createElement('a');
        link.download = `${filename}-AI译图.png`;
        link.href = el.src;
        link.click();
        showToast('下载成功', 'success');
    } catch (e) { showToast('下载失败', 'error'); }
}

async function startTranslation() {
    const langs = getSelectedTransLangs();
    if (!langs.length) { showToast('请选择至少一种目标语言', 'error'); return; }
    if (!transImages.length) { showToast('请先上传图片', 'error'); return; }

    const logMsg = `开始并发翻译流程 | 目标语言: ${langs.join(', ')}`;
    remoteLog(logMsg);

    transRunning = true;
    updateTransStartBtn();
    const btn = document.getElementById('transStartBtn');
    const origBtnHtml = btn.innerHTML;
    btn.innerHTML = `<span class="loader w-3 h-3 border-white border-t-transparent mr-1 border-2"></span> 翻译中...`;

    const styleStrength = document.getElementById('styleStrength').value;
    let done = 0;

    const allTasks = [];
    for (const img of transImages) {
        const badge = document.getElementById(`trans-card-badge-${img.id}`);
        if (badge && badge.textContent.includes('完成')) continue;
        for (const lang of langs) {
            allTasks.push({ img, lang });
        }
    }

    if (!allTasks.length) {
        transRunning = false;
        updateTransStartBtn();
        btn.innerHTML = origBtnHtml;
        showToast('没有需要处理的新任务', 'info');
        return;
    }

    const activeTasks = [];
    const imgProgress = {};

    for (let i = 0; i < allTasks.length; i++) {
        if (activeTasks.length >= CONCURRENCY_LIMIT) {
            await Promise.race(activeTasks);
        }

        const { img, lang } = allTasks[i];
        remoteLog(`正在提交翻译任务: ${img.name} -> ${lang} (${i + 1}/${allTasks.length})`);
        if (!imgProgress[img.id]) imgProgress[img.id] = 0;

        const badge = document.getElementById(`trans-card-badge-${img.id}`);
        const progWrap = document.getElementById(`trans-card-progress-wrap-${img.id}`);
        if (badge && !badge.textContent.includes('翻译中')) {
            badge.textContent = '翻译中';
            badge.className = 'text-[10px] bg-blue-100 text-blue-700 px-2 py-0.5 rounded-lg font-black uppercase tracking-widest flex-shrink-0';
        }
        if (progWrap) progWrap.classList.remove('hidden');

        const taskPromise = (async () => {
            try {
                const langInfo = TRANS_LANG_OPTIONS.find(l => l.value === lang) || { label: lang, short: lang.slice(0, 2).toUpperCase() };
                const slotId = `trans-slot-${img.id}-${lang.replace(/\s/g, '')}`;

                if (!document.getElementById(slotId)) {
                    const ghost = document.createElement('div');
                    ghost.id = slotId; ghost.className = 'hidden';
                    ghost.innerHTML = `<div id="${slotId}-content"></div><div id="${slotId}-actions"></div>`;
                    document.body.appendChild(ghost);
                }

                const stepEl = document.getElementById(`trans-card-step-${img.id}`);
                if (stepEl) stepEl.textContent = `正在翻译 ${langInfo.label}...`;

                await translateSingleImageToLang(img, lang, langInfo, slotId, styleStrength);

                done++;
                imgProgress[img.id]++;

                const progBar = document.getElementById(`trans-card-progress-${img.id}`);
                if (progBar) progBar.style.width = `${Math.round((imgProgress[img.id] / langs.length) * 100)}%`;

                const langsRow = document.getElementById(`trans-card-langs-${img.id}`);
                if (langsRow && !document.getElementById(`lang-tag-card-${slotId}`)) {
                    const imgEl = document.getElementById(`${slotId}-img`);
                    if (imgEl) {
                        langsRow.insertAdjacentHTML('beforeend', `<button id="lang-tag-card-${slotId}" onclick="openTransPreview('${img.id}')" class="flex items-center gap-1 text-[11px] bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 rounded-full font-bold hover:bg-green-100 transition-colors"><i class="ph ph-check-circle text-green-500"></i> ${langInfo.label}</button>`);
                    } else {
                        langsRow.insertAdjacentHTML('beforeend', `<span id="lang-tag-card-${slotId}" onclick="openTransPreview('${img.id}')" class="flex items-center gap-1 text-[11px] bg-red-50 text-red-600 border border-red-200 px-2 py-0.5 rounded-full font-bold cursor-pointer hover:bg-red-100"><i class="ph ph-warning-circle"></i> ${langInfo.label}</span>`);
                    }
                }

                if (imgProgress[img.id] === langs.length) {
                    if (badge) {
                        badge.textContent = '✓ 完成';
                        badge.className = 'text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded-lg font-black uppercase tracking-widest flex-shrink-0';
                    }
                    if (stepEl) stepEl.textContent = '处理完成';
                    setTimeout(() => { if (progWrap) progWrap.classList.add('hidden'); }, 1000);
                    ['preview', 'export', 'retrans'].forEach(action => {
                        document.getElementById(`trans-card-${action}-${img.id}`)?.classList.remove('hidden');
                    });
                }
                btn.innerHTML = `<span class="loader w-3 h-3 border-white border-t-transparent mr-1 border-2"></span> ${done}/${allTasks.length}`;
            } catch (err) { console.error(err); }
        })();

        activeTasks.push(taskPromise);
        taskPromise.finally(() => {
            const idx = activeTasks.indexOf(taskPromise);
            if (idx > -1) activeTasks.splice(idx, 1);
        });

        if (i < allTasks.length - 1) {
            await new Promise(r => setTimeout(r, STAGGER_DELAY));
        }
    }
    await Promise.all(activeTasks);

    transRunning = false;
    btn.innerHTML = origBtnHtml;
    updateTransFooterCount();
    updateTransStartBtn();
    showToast(`全部翻译完成！共处理 ${done} 个任务`, 'success');
}

async function retransCard(imgId) {
    const img = transImages.find(i => i.id === imgId);
    if (!img) return;

    const langs = getSelectedTransLangs();
    if (!langs.length) { showToast('请先选择目标语言', 'error'); return; }

    const styleStrength = document.getElementById('styleStrength').value;
    const badge = document.getElementById(`trans-card-badge-${imgId}`);
    const progWrap = document.getElementById(`trans-card-progress-wrap-${imgId}`);
    const progBar = document.getElementById(`trans-card-progress-${imgId}`);
    const stepEl = document.getElementById(`trans-card-step-${imgId}`);
    const langsRow = document.getElementById(`trans-card-langs-${imgId}`);
    const previewBtn = document.getElementById(`trans-card-preview-${imgId}`);
    const exportBtn = document.getElementById(`trans-card-export-${imgId}`);
    const retransBtn = document.getElementById(`trans-card-retrans-${imgId}`);

    if (badge) { badge.textContent = '翻译中'; badge.className = 'text-[10px] bg-blue-100 text-blue-700 px-2 py-0.5 rounded-lg font-black uppercase tracking-widest flex-shrink-0'; }
    if (progWrap) progWrap.classList.remove('hidden');
    if (langsRow) langsRow.innerHTML = '';
    if (previewBtn) previewBtn.classList.add('hidden');
    if (exportBtn) exportBtn.classList.add('hidden');
    if (retransBtn) retransBtn.classList.add('hidden');

    langs.forEach(lang => {
        const slotId = `trans-slot-${imgId}-${lang.replace(/\s/g, '')}`;
        const existing = document.getElementById(slotId);
        if (existing) existing.remove();
        const ghost = document.createElement('div');
        ghost.id = slotId; ghost.className = 'hidden';
        ghost.innerHTML = `<div id="${slotId}-content"></div><div id="${slotId}-actions"></div>`;
        document.body.appendChild(ghost);
    });

    let langIdx = 0;
    for (const lang of langs) {
        const langInfo = TRANS_LANG_OPTIONS.find(l => l.value === lang) || { label: lang, short: lang.slice(0, 2).toUpperCase() };
        const slotId = `trans-slot-${imgId}-${lang.replace(/\s/g, '')}`;
        if (stepEl) stepEl.textContent = `正在翻译 ${langInfo.label}...`;
        if (progBar) progBar.style.width = `${Math.round((langIdx / langs.length) * 85)}%`;

        await translateSingleImageToLang(img, lang, langInfo, slotId, styleStrength);
        langIdx++;

        if (langsRow) {
            const imgEl = document.getElementById(`${slotId}-img`);
            if (imgEl) {
                langsRow.insertAdjacentHTML('beforeend', `<button id="lang-tag-card-${slotId}" onclick="openTransPreview('${imgId}')" class="flex items-center gap-1 text-[11px] bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 rounded-full font-bold hover:bg-green-100 transition-colors"><i class="ph ph-check-circle text-green-500"></i> ${langInfo.label}</button>`);
            } else {
                langsRow.insertAdjacentHTML('beforeend', `<span id="lang-tag-card-${slotId}" onclick="openTransPreview('${imgId}')" class="flex items-center gap-1 text-[11px] bg-red-50 text-red-600 border border-red-200 px-2 py-0.5 rounded-full font-bold cursor-pointer hover:bg-red-100"><i class="ph ph-warning-circle"></i> ${langInfo.label}</span>`);
            }
        }
    }

    if (progBar) progBar.style.width = '100%';
    if (stepEl) stepEl.textContent = '处理完成';
    if (badge) { badge.textContent = '✓ 完成'; badge.className = 'text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded-lg font-black uppercase tracking-widest flex-shrink-0'; }
    setTimeout(() => { if (progWrap) progWrap.classList.add('hidden'); }, 1000);
    if (previewBtn) previewBtn.classList.remove('hidden');
    if (exportBtn) exportBtn.classList.remove('hidden');
    if (retransBtn) retransBtn.classList.remove('hidden');
    showToast(`${img.name} 重新生成完成`, 'success');
}

async function translateSingleImageToLang(img, lang, langInfo, slotId, styleStrength) {
    const contentDiv = document.getElementById(`${slotId}-content`);
    const base64Data = img.base64.split(',')[1];
    const mimeType = img.mimeType;

    const prompt = `Generate a completely NEW image based on this reference.
TASK: Translate all text in the image into ${lang} (${langInfo.label}).
REQUIREMENTS:
1. Completely redraw the image. Do NOT return the original image.
2. Replace the original text with the ${lang} translation.
3. Keep the exact same product, background, style, and typography layout.
OUTPUT: You must generate and return the modified image.`;

    try {
        const payload = {
            contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mimeType, data: base64Data } }] }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
        };

        const result = await callAI(IMAGE_MODEL, payload);

        if (result.error) throw new Error(result.error.message);
        if (!result.candidates || result.candidates.length === 0) {
            throw new Error(result.promptFeedback?.blockReason ? `被安全拦截 (${result.promptFeedback.blockReason})` : "API返回为空");
        }

        const imagePart = result.candidates[0].content?.parts?.find(p => p.inlineData);
        if (imagePart?.inlineData) {
            const generatedSrc = `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
            if (contentDiv) contentDiv.innerHTML = `<img id="${slotId}-img" src="${generatedSrc}" class="w-full rounded object-contain max-h-[280px]">`;

            saveToHistory('translation', {
                source_text: img.name,
                target_lang: langInfo.label,
                result: generatedSrc
            });
        } else {
            throw new Error("模型未返回图像数据");
        }
    } catch (err) {
        console.warn(`[Trans] ${img.name} → ${lang}:`, err.message);
        if (contentDiv) contentDiv.innerHTML = `<div id="${slotId}-img-error" class="hidden">${err.message}</div>`;
    }
}
