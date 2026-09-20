function listingTextPair(value) {
    if (typeof value === 'string') return { target: value, zh: '' };
    return {
        target: value?.target || value?.English || value?.english || value?.text || value?.keyword || value?.term || '',
        zh: value?.zh || value?.Chinese || value?.chinese || value?.cn || value?.translation || value?.translation_zh || ''
    };
}

const LISTING_AMAZON_RISK_TERMS = [
    'best',
    '#1',
    'guaranteed',
    'guarantee',
    'cure',
    'treat',
    'prevent',
    'fda approved'
];

const LISTING_REGION_LANGUAGE_MAP = {
    'US Market': 'English',
    'UK Market': 'English',
    'Germany Market': 'German',
    'France Market': 'French',
    'Spain Market': 'Spanish',
    'Italy Market': 'Italian',
    'European Market': 'English',
    'Japan Market': 'Japanese',
    'Southeast Asia Market': 'English',
    'Middle East Market': 'Arabic',
    'Australian Market': 'English',
    'Global Market': 'English'
};
let currentComplianceSuggestions = [];
let currentListingDataText = null;
let currentListingViewMode = 'bilingual';

function getCurrentComplianceSuggestions() {
    return currentComplianceSuggestions;
}

function getCurrentListingData() {
    return currentListingDataText;
}

function setCurrentListingData(data) {
    currentListingDataText = data;
}

function getCurrentListingViewMode() {
    return currentListingViewMode;
}

function getListingUploadedBase64() {
    return currentListingUploadedBase64;
}

function setListingUploadedBase64(data) {
    currentListingUploadedBase64 = data;
}

function getUtf8ByteLength(str) {
    if (!str || typeof str !== 'string') return 0;
    if (typeof TextEncoder !== 'undefined') {
        return new TextEncoder().encode(str).length;
    }
    return encodeURI(str).split(/%..|./).length - 1;
}

const SEARCH_TERMS_STOP_WORDS = new Set([
    'and', 'with', 'for', 'the', 'in', 'on', 'of', 'to', 'a', 'an', 'by', 'from', 'at', 'is', 'it', 'or', 'as', 'are'
]);

function cleanAndDeduplicateSearchTerms(termsStr, titleStr) {
    const titleWords = new Set(
        (titleStr || '')
            .toLowerCase()
            .replace(/[^\w\s\u4e00-\u9fa5\u3040-\u30ff]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 1)
    );

    const rawWords = (termsStr || '')
        .replace(/[^\w\s\u4e00-\u9fa5\u3040-\u30ff]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);

    const selectedWords = [];
    const seen = new Set();
    let currentBytes = 0;

    for (const rawWord of rawWords) {
        const cleanWord = rawWord.trim();
        const lower = cleanWord.toLowerCase();
        if (cleanWord.length <= 1) continue;
        if (SEARCH_TERMS_STOP_WORDS.has(lower)) continue;
        if (titleWords.has(lower)) continue;
        if (seen.has(lower)) continue;

        const wordBytes = getUtf8ByteLength((selectedWords.length > 0 ? ' ' : '') + cleanWord);
        if (currentBytes + wordBytes <= 249) {
            seen.add(lower);
            selectedWords.push(cleanWord);
            currentBytes += wordBytes;
        } else {
            break;
        }
    }

    return {
        terms: selectedWords.join(' '),
        byteLength: currentBytes,
        wordCount: selectedWords.length
    };
}

function setListingViewMode(mode) {
    currentListingViewMode = mode;
    const resArea = document.getElementById('listingResults');
    if (resArea && resArea.classList) {
        resArea.classList.remove('listing-view-target', 'listing-view-zh');
        if (mode === 'target') {
            resArea.classList.add('listing-view-target');
        } else if (mode === 'zh') {
            resArea.classList.add('listing-view-zh');
        }
    }

    const btnBilingual = document.getElementById('btnViewBilingual');
    const btnTarget = document.getElementById('btnViewTarget');
    const btnZh = document.getElementById('btnViewZh');

    const setActive = (btn, active) => {
        if (!btn) return;
        if (active) {
            btn.className = 'px-2.5 py-1 rounded-lg font-bold transition-all bg-white text-indigo-600 shadow-sm flex items-center gap-1 cursor-pointer';
        } else {
            btn.className = 'px-2.5 py-1 rounded-lg font-bold transition-all text-gray-500 hover:text-gray-800 flex items-center gap-1 cursor-pointer';
        }
    };

    setActive(btnBilingual, mode === 'bilingual');
    setActive(btnTarget, mode === 'target');
    setActive(btnZh, mode === 'zh');
}

function copyTextToClipboard(text, successMsg = '已复制到剪贴板') {
    if (!text) {
        if (typeof showToast === 'function') showToast('暂无文本可复制', 'info');
        return;
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
            navigator.clipboard.writeText(text).then(() => {
                if (typeof showToast === 'function') showToast(successMsg, 'success');
            }).catch(() => {
                fallbackCopyText(text, successMsg);
            });
            return;
        } catch (err) {
            fallbackCopyText(text, successMsg);
            return;
        }
    }
    fallbackCopyText(text, successMsg);
}

function fallbackCopyText(text, successMsg) {
    if (typeof document === 'undefined') return;
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.setAttribute('readonly', '');
    textArea.style.position = 'fixed';
    textArea.style.top = '0';
    textArea.style.left = '0';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    if (typeof textArea.focus === 'function') textArea.focus();
    if (typeof textArea.select === 'function') textArea.select();
    if (typeof textArea.setSelectionRange === 'function') textArea.setSelectionRange(0, textArea.value.length);
    let successful = false;
    try {
        successful = document.execCommand('copy');
    } catch (e) {
        successful = false;
    }
    if (textArea.parentNode) {
        textArea.parentNode.removeChild(textArea);
    }
    if (successful) {
        if (typeof showToast === 'function') showToast(successMsg, 'success');
    } else {
        if (typeof showToast === 'function') showToast('复制失败，请手动选择复制', 'error');
    }
}

function downloadTextFile(filename, content, mimeType = 'text/plain;charset=utf-8') {
    if (typeof document === 'undefined') return;
    try {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            if (a.parentNode) a.parentNode.removeChild(a);
            URL.revokeObjectURL(url);
        }, 1500);
    } catch (err) {
        console.error('Download failed:', err);
        if (typeof showToast === 'function') showToast('文件下载失败', 'error');
    }
}

function appendTextBlock(parent, className, text) {
    const el = document.createElement('div');
    el.className = className;
    el.textContent = text || '';
    parent.appendChild(el);
    return el;
}

function renderListingPair(containerId, value, targetClass, zhClass) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const pair = listingTextPair(value);
    container.textContent = '';
    appendTextBlock(container, targetClass, pair.target);
    appendTextBlock(container, zhClass, pair.zh);
}

async function postListingApi(path, payload) {
    const apiBase = typeof API_BASE !== 'undefined' ? API_BASE : (globalThis.API_BASE || '');
    const res = await fetch(`${apiBase}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.status !== 'success') {
        throw new Error(data.message || '请求失败');
    }
    return data.data;
}

function getSelectedListingPlatform() {
    const styleOpt = document.getElementById('listingStyleSelect');
    return styleOpt?.options?.[styleOpt?.selectedIndex]?.value || styleOpt?.value || '';
}

function isAmazonListingPlatform(platform) {
    return (platform || '').toLowerCase().includes('amazon');
}

function syncListingLanguageToRegion() {
    const regionSelect = document.getElementById('listingRegionSelect');
    const languageSelect = document.getElementById('listingLanguageSelect');
    if (!regionSelect || !languageSelect) return;

    const recommendedLanguage = LISTING_REGION_LANGUAGE_MAP[regionSelect.value];
    if (!recommendedLanguage) return;

    const option = Array.from(languageSelect.options).find(item => item.value === recommendedLanguage);
    if (option) languageSelect.value = recommendedLanguage;
}

function initListingControls() {
    const regionSelect = document.getElementById('listingRegionSelect');
    if (regionSelect) {
        regionSelect.addEventListener('change', syncListingLanguageToRegion);
        syncListingLanguageToRegion();
    }
}

function collectListingTargetText(data) {
    const texts = [];
    const pushPair = value => {
        const pair = listingTextPair(value);
        if (pair.target) texts.push(pair.target);
    };

    pushPair(data?.title);
    (data?.bullets || []).forEach(pushPair);
    pushPair(data?.description);
    const keywords = data?.keywords || {};
    (keywords.core || []).forEach(pushPair);
    (keywords.longTail || keywords.long_tail || []).forEach(pushPair);
    (keywords.ads || keywords.ppc || []).forEach(pushPair);
    (data?.qa || []).forEach(item => {
        pushPair(item?.q);
        pushPair(item?.a);
    });
    pushPair(data?.socialMedia || data?.social_script || data?.social);
    return texts;
}

function validateListingRules(data, platform) {
    if (!isAmazonListingPlatform(platform)) return [];

    const warnings = [];
    const title = listingTextPair(data?.title).target;
    if (title.length > 200) {
        warnings.push(`Amazon 标题建议不超过 200 字符，当前 ${title.length} 字符。`);
    }

    const bullets = data?.bullets || [];
    if (bullets.length !== 5) {
        warnings.push(`Amazon 五点描述建议保持 5 条，当前 ${bullets.length} 条。`);
    }
    bullets.forEach((item, index) => {
        const text = listingTextPair(item).target;
        if (text.length > 500) {
            warnings.push(`第 ${index + 1} 条五点描述超过 500 字符，当前 ${text.length} 字符。`);
        }
    });

    const allText = collectListingTargetText(data).join('\n').toLowerCase();
    const hitTerms = LISTING_AMAZON_RISK_TERMS.filter(term => allText.includes(term));
    if (hitTerms.length) {
        warnings.push(`检测到 Amazon 高风险/需谨慎词：${hitTerms.join(', ')}。`);
    }

    return warnings;
}

function renderListingRuleWarnings(data, platform) {
    const container = document.getElementById('listingRuleWarnings');
    if (!container) return;

    const warnings = validateListingRules(data, platform);
    container.textContent = '';
    if (!warnings.length) {
        container.classList.add('hidden');
        return;
    }

    container.classList.remove('hidden');
    appendTextBlock(container, 'font-black mb-2 flex items-center gap-1', '平台规则提醒');
    const ul = document.createElement('ul');
    ul.className = 'list-disc pl-5 space-y-1';
    warnings.forEach(warning => {
        const li = document.createElement('li');
        li.textContent = warning;
        ul.appendChild(li);
    });
    container.appendChild(ul);
}

async function aiFillListingInputs() {
    if (!currentListingUploadedBase64) {
        if (typeof showToast === 'function') showToast('请先上传产品参考图，AI 才能进行视觉解析', 'error');
        return;
    }

    const btn = document.getElementById('aiListingExtractBtn');
    const origHtml = btn ? btn.innerHTML : '';
    const promptBtn = document.getElementById('aiListingExtractPromptBtn');
    const origPromptHtml = promptBtn ? promptBtn.innerHTML : '';

    if (btn) {
        btn.innerHTML = '<span class="loader w-3 h-3 border-2 border-indigo-500 border-t-transparent mr-1"></span> 提取中...';
        btn.disabled = true;
    }
    if (promptBtn) {
        promptBtn.innerHTML = '<span class="loader w-3.5 h-3.5 border-2 border-indigo-500 border-t-transparent mr-1"></span> 正在解析图片特征...';
        promptBtn.disabled = true;
    }

    try {
        const data = await postListingApi('/api/listing/extract', {
            image_data: currentListingUploadedBase64
        });
        const nameInput = document.getElementById('listingName');
        const hasExistingName = nameInput && !!nameInput.value.trim();
        if (!hasExistingName && nameInput && data.name) {
            nameInput.value = data.name;
        }
        const pointsInput = document.getElementById('listingPoints');
        if (pointsInput) pointsInput.value = data.points || '';

        const keywordsInput = document.getElementById('listingKeywords');
        if (keywordsInput && !keywordsInput.value.trim() && data.keywords) {
            keywordsInput.value = data.keywords;
        }

        if (typeof showToast === 'function') {
            if (hasExistingName) {
                showToast('产品特征视觉提取成功 (已保留原产品名称)', 'success');
            } else {
                showToast('产品特征视觉提取成功', 'success');
            }
        }
    } catch (err) {
        if (typeof showToast === 'function') showToast('智能提取失败: ' + err.message, 'error');
    } finally {
        if (btn) {
            btn.innerHTML = origHtml;
            btn.disabled = false;
        }
        if (promptBtn) {
            promptBtn.innerHTML = origPromptHtml;
            promptBtn.disabled = false;
        }
    }
}

function updateListingTitleCounter(text) {
    const counter = document.getElementById('listingTitleCharCount');
    if (!counter) return;
    const len = (text || '').length;
    const platform = getSelectedListingPlatform();
    const isEbay = platform.toLowerCase().includes('ebay');
    const maxLimit = isEbay ? 80 : 200;

    counter.textContent = `${len}/${maxLimit} 字符`;
    if (len > maxLimit) {
        counter.className = 'text-[11px] font-mono font-bold px-2 py-0.5 rounded-md bg-red-100 text-red-700 border border-red-200';
    } else if (len >= maxLimit * 0.85) {
        counter.className = 'text-[11px] font-mono font-bold px-2 py-0.5 rounded-md bg-amber-100 text-amber-700 border border-amber-200';
    } else {
        counter.className = 'text-[11px] font-mono font-bold px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200';
    }
}

function detectSearchTermsRiskWords(text) {
    if (!text || typeof text !== 'string') return [];
    const lower = text.toLowerCase();
    const found = [];
    LISTING_AMAZON_RISK_TERMS.forEach(term => {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escaped}\\b`, 'i');
        if (regex.test(lower)) {
            found.push(term);
        }
    });
    return found;
}

function updateSearchTermsCounter(text) {
    const counter = document.getElementById('listingStByteCount');
    const progressBar = document.getElementById('listingStProgressBar');
    const bytes = getUtf8ByteLength(text || '');
    if (counter) {
        if (bytes > 249) {
            counter.textContent = `${bytes} / 249 Bytes (超标 +${bytes - 249} Bytes ⚠️)`;
            counter.className = 'text-[11px] font-mono font-bold px-2.5 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-300 animate-pulse';
        } else if (bytes >= 200) {
            counter.textContent = `${bytes} / 249 Bytes (极致利用)`;
            counter.className = 'text-[11px] font-mono font-bold px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300';
        } else {
            counter.textContent = `${bytes} / 249 Bytes (安全)`;
            counter.className = 'text-[11px] font-mono font-bold px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200';
        }
    }
    if (progressBar) {
        const pct = Math.min(100, Math.round((bytes / 249) * 100));
        if (progressBar.style) {
            progressBar.style.width = `${pct}%`;
        }
        if (bytes > 249) {
            progressBar.className = 'h-full bg-red-500 rounded-full transition-all duration-300';
        } else if (bytes >= 200) {
            progressBar.className = 'h-full bg-amber-500 rounded-full transition-all duration-300';
        } else {
            progressBar.className = 'h-full bg-emerald-500 rounded-full transition-all duration-300';
        }
    }

    const riskWarning = document.getElementById('listingStRiskWarning');
    const riskTermsText = document.getElementById('listingStRiskTermsText');
    const risks = detectSearchTermsRiskWords(text);
    if (riskWarning) {
        if (risks.length > 0) {
            riskWarning.classList.remove('hidden');
            riskWarning.classList.add('flex');
            if (riskTermsText) riskTermsText.textContent = risks.join(', ');
        } else {
            riskWarning.classList.add('hidden');
            riskWarning.classList.remove('flex');
        }
    }
}

function removeListingSearchTermsRiskWords() {
    const rawText = listingTextPair(currentListingDataText?.searchTerms || currentListingDataText?.search_terms).target || document.getElementById('resListingSearchTerms')?.textContent || '';
    if (!rawText) return;
    let cleaned = rawText;
    LISTING_AMAZON_RISK_TERMS.forEach(term => {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
        cleaned = cleaned.replace(regex, '');
    });
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    if (currentListingDataText) {
        if (!currentListingDataText.searchTerms) currentListingDataText.searchTerms = { target: '', zh: '' };
        currentListingDataText.searchTerms.target = cleaned;
    }
    const el = document.getElementById('resListingSearchTerms');
    if (el) el.textContent = cleaned;
    const input = document.getElementById('editListingSearchTermsInput');
    if (input) input.value = cleaned;
    updateSearchTermsCounter(cleaned);
    if (typeof showToast === 'function') {
        showToast('已成功一键剔除违禁词！', 'success');
    }
}

function renderTitleAlternatives(alternatives) {
    const container = document.getElementById('resListingTitleAlternatives');
    const toggleBtn = document.getElementById('btnToggleTitleAlternatives');
    const countEl = document.getElementById('titleAltCount');
    if (!container) return;

    container.textContent = '';
    const items = Array.isArray(alternatives) ? alternatives : [];
    if (!items.length) {
        if (toggleBtn) toggleBtn.classList.add('hidden');
        container.classList.add('hidden');
        return;
    }

    if (toggleBtn) {
        toggleBtn.classList.remove('hidden');
        toggleBtn.classList.add('flex');
    }
    if (countEl) countEl.textContent = String(items.length);

    items.forEach((alt, idx) => {
        const pair = listingTextPair(alt);
        const card = document.createElement('div');
        card.className = 'bg-indigo-50/40 p-3 rounded-xl border border-indigo-100 flex flex-col md:flex-row md:items-center justify-between gap-3';

        const contentBlock = document.createElement('div');
        contentBlock.className = 'flex-1';

        const badgeRow = document.createElement('div');
        badgeRow.className = 'flex items-center gap-2 mb-1';
        const badge = document.createElement('span');
        badge.className = 'text-[10px] font-bold px-2 py-0.5 rounded bg-indigo-100 text-indigo-700';
        badge.textContent = alt.style || `备选方案 ${idx + 1}`;
        badgeRow.appendChild(badge);

        const charCount = document.createElement('span');
        charCount.className = 'text-[10px] text-gray-400 font-mono';
        charCount.textContent = `${pair.target.length} 字符`;
        badgeRow.appendChild(charCount);
        contentBlock.appendChild(badgeRow);

        appendTextBlock(contentBlock, 'target-text text-sm font-bold text-gray-800 leading-snug', pair.target);
        if (pair.zh) {
            appendTextBlock(contentBlock, 'zh-text text-xs text-gray-400 mt-1', pair.zh);
        }

        const actionBlock = document.createElement('div');
        actionBlock.className = 'flex items-center gap-1 shrink-0';
        const adoptBtn = document.createElement('button');
        adoptBtn.className = 'px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold transition-colors flex items-center gap-1 shadow-sm cursor-pointer';
        adoptBtn.innerHTML = '<i class="ph ph-check"></i> 采纳此标题';
        adoptBtn.onclick = () => adoptTitleAlternative(idx);
        actionBlock.appendChild(adoptBtn);

        card.append(contentBlock, actionBlock);
        container.appendChild(card);
    });
}

function toggleTitleAlternatives() {
    const container = document.getElementById('resListingTitleAlternatives');
    if (!container) return;
    container.classList.toggle('hidden');
}

function adoptTitleAlternative(index) {
    if (!currentListingDataText || !currentListingDataText.titleAlternatives) return;
    const alts = currentListingDataText.titleAlternatives;
    if (!alts[index]) return;

    const oldTitle = listingTextPair(currentListingDataText.title);
    const selectedAlt = alts[index];
    const selectedPair = listingTextPair(selectedAlt);

    currentListingDataText.title = {
        target: selectedPair.target,
        zh: selectedPair.zh
    };
    alts[index] = {
        target: oldTitle.target,
        zh: oldTitle.zh,
        style: selectedAlt.style || '原主标题'
    };

    renderListingData(currentListingDataText);
    if (typeof showToast === 'function') showToast('已采纳备选标题并替换为主标题', 'success');
}

function toggleEditListingTitle() {
    const area = document.getElementById('editListingTitleArea');
    const display = document.getElementById('resListingTitle');
    const input = document.getElementById('editListingTitleInput');
    const btnText = document.getElementById('btnEditTitleText');
    if (!area || !display) return;

    const isEditing = !area.classList.contains('hidden');
    if (isEditing) {
        cancelEditListingTitle();
    } else {
        area.classList.remove('hidden');
        display.classList.add('hidden');
        if (input) input.value = listingTextPair(currentListingDataText?.title).target;
        if (btnText) btnText.textContent = '取消';
        if (input) input.focus();
    }
}

function cancelEditListingTitle() {
    const area = document.getElementById('editListingTitleArea');
    const display = document.getElementById('resListingTitle');
    const btnText = document.getElementById('btnEditTitleText');
    if (area) area.classList.add('hidden');
    if (display) display.classList.remove('hidden');
    if (btnText) btnText.textContent = '编辑';
}

function saveEditListingTitle() {
    const input = document.getElementById('editListingTitleInput');
    if (!input || !currentListingDataText) return;
    const newVal = input.value.trim();
    if (!newVal) {
        if (typeof showToast === 'function') showToast('标题不能为空', 'error');
        return;
    }
    const currentPair = listingTextPair(currentListingDataText.title);
    currentListingDataText.title = { ...currentPair, target: newVal };

    renderListingPair(
        'resListingTitle',
        currentListingDataText.title,
        'target-text text-gray-800 text-lg mb-2',
        'zh-text text-sm text-gray-400 pt-2 border-t border-gray-100 font-normal'
    );
    updateListingTitleCounter(newVal);
    renderListingRuleWarnings(currentListingDataText, getSelectedListingPlatform());
    cancelEditListingTitle();
    if (typeof showToast === 'function') showToast('标题已保存修改', 'success');
}

function onTitleEditInput(val) {
    updateListingTitleCounter(val);
}

function toggleEditListingBullets() {
    const area = document.getElementById('editListingBulletsArea');
    const display = document.getElementById('resListingBullets');
    const container = document.getElementById('editBulletsInputsContainer');
    const btnText = document.getElementById('btnEditBulletsText');
    if (!area || !display) return;

    const isEditing = !area.classList.contains('hidden');
    if (isEditing) {
        cancelEditListingBullets();
    } else {
        area.classList.remove('hidden');
        display.classList.add('hidden');
        if (container) {
            container.textContent = '';
            const bullets = currentListingDataText?.bullets || [];
            bullets.forEach((b, i) => {
                const pair = listingTextPair(b);
                const wrap = document.createElement('div');
                wrap.className = 'space-y-1';
                const label = document.createElement('label');
                label.className = 'text-[11px] font-bold text-gray-600';
                label.textContent = `第 ${i + 1} 条五点描述`;
                const ta = document.createElement('textarea');
                ta.className = 'edit-bullet-input w-full text-xs border border-gray-200 rounded-lg p-2 outline-none focus:border-indigo-400 bg-gray-50/50 resize-none';
                ta.rows = 2;
                ta.value = pair.target;
                wrap.append(label, ta);
                container.appendChild(wrap);
            });
        }
        if (btnText) btnText.textContent = '取消';
    }
}

function cancelEditListingBullets() {
    const area = document.getElementById('editListingBulletsArea');
    const display = document.getElementById('resListingBullets');
    const btnText = document.getElementById('btnEditBulletsText');
    if (area) area.classList.add('hidden');
    if (display) display.classList.remove('hidden');
    if (btnText) btnText.textContent = '编辑';
}

function saveEditListingBullets() {
    if (!currentListingDataText) return;
    const inputs = document.querySelectorAll('.edit-bullet-input');
    const nextBullets = [];
    inputs.forEach((input, i) => {
        const existing = (currentListingDataText.bullets && currentListingDataText.bullets[i]) || {};
        const pair = listingTextPair(existing);
        nextBullets.push({
            target: input.value.trim(),
            zh: pair.zh
        });
    });
    currentListingDataText.bullets = nextBullets;

    const bulletsList = document.getElementById('resListingBullets');
    if (bulletsList) {
        bulletsList.textContent = '';
        nextBullets.forEach((item, index) => {
            const pair = listingTextPair(item);
            const li = document.createElement('li');
            li.className = 'mb-4 bg-gray-50/80 p-3.5 rounded-xl border border-gray-100 group/item transition-all';

            const header = document.createElement('div');
            header.className = 'flex items-center justify-between mb-1.5';
            const num = document.createElement('span');
            num.className = 'text-[10px] font-mono font-bold text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded';
            num.textContent = `Bullet #${index + 1} (${pair.target.length} 字符)`;
            header.appendChild(num);

            const copyBtns = document.createElement('div');
            copyBtns.className = 'flex items-center gap-1 opacity-0 group-hover/item:opacity-100 transition-opacity';
            const cpTarget = document.createElement('button');
            cpTarget.className = 'text-[10px] bg-white border border-gray-200 hover:bg-indigo-50 hover:text-indigo-600 px-1.5 py-0.5 rounded font-bold transition-colors cursor-pointer';
            cpTarget.textContent = '复制外文';
            cpTarget.onclick = () => copySingleBullet(index, 'target');
            const cpZh = document.createElement('button');
            cpZh.className = 'text-[10px] bg-white border border-gray-200 hover:bg-indigo-50 hover:text-indigo-600 px-1.5 py-0.5 rounded font-bold transition-colors cursor-pointer';
            cpZh.textContent = '复制中文';
            cpZh.onclick = () => copySingleBullet(index, 'zh');
            copyBtns.append(cpTarget, cpZh);
            header.appendChild(copyBtns);

            li.appendChild(header);
            appendTextBlock(li, 'target-text font-bold text-gray-700 text-sm leading-relaxed', pair.target);
            appendTextBlock(li, 'zh-text text-xs text-gray-400 mt-2 border-t border-gray-200/60 pt-2', pair.zh);
            bulletsList.appendChild(li);
        });
    }

    renderListingRuleWarnings(currentListingDataText, getSelectedListingPlatform());
    cancelEditListingBullets();
    if (typeof showToast === 'function') showToast('五点描述已保存修改', 'success');
}

function copySingleBullet(index, langType = 'target') {
    const bullets = currentListingDataText?.bullets || [];
    if (!bullets[index]) return;
    const pair = listingTextPair(bullets[index]);
    const text = langType === 'target' ? pair.target : pair.zh;
    copyTextToClipboard(text, `已复制第 ${index + 1} 条五点描述 (${langType === 'target' ? '外文' : '中文'})`);
}

function toggleEditListingDesc() {
    const area = document.getElementById('editListingDescArea');
    const display = document.getElementById('resListingDesc');
    const input = document.getElementById('editListingDescInput');
    const btnText = document.getElementById('btnEditDescText');
    if (!area || !display) return;

    const isEditing = !area.classList.contains('hidden');
    if (isEditing) {
        cancelEditListingDesc();
    } else {
        area.classList.remove('hidden');
        display.classList.add('hidden');
        if (input) input.value = listingTextPair(currentListingDataText?.description).target;
        if (btnText) btnText.textContent = '取消';
        if (input) input.focus();
    }
}

function cancelEditListingDesc() {
    const area = document.getElementById('editListingDescArea');
    const display = document.getElementById('resListingDesc');
    const btnText = document.getElementById('btnEditDescText');
    if (area) area.classList.add('hidden');
    if (display) display.classList.remove('hidden');
    if (btnText) btnText.textContent = '编辑';
}

function saveEditListingDesc() {
    const input = document.getElementById('editListingDescInput');
    if (!input || !currentListingDataText) return;
    const newVal = input.value.trim();
    const currentPair = listingTextPair(currentListingDataText.description);
    currentListingDataText.description = { ...currentPair, target: newVal };

    renderListingPair(
        'resListingDesc',
        currentListingDataText.description,
        'target-text text-gray-700 whitespace-pre-wrap',
        'zh-text text-sm text-gray-400 mt-4 pt-4 border-t border-gray-100 whitespace-pre-wrap'
    );
    const countEl = document.getElementById('listingDescCharCount');
    if (countEl) countEl.textContent = `${newVal.length} 字符`;

    cancelEditListingDesc();
    if (typeof showToast === 'function') showToast('长描述已保存修改', 'success');
}

function onDescEditInput(val) {
    const countEl = document.getElementById('listingDescCharCount');
    if (countEl) countEl.textContent = `${(val || '').length} 字符`;
}

function toggleEditListingSearchTerms() {
    const area = document.getElementById('editListingSearchTermsArea');
    const display = document.getElementById('resListingSearchTerms');
    const input = document.getElementById('editListingSearchTermsInput');
    const btnText = document.getElementById('btnEditSearchTermsText');
    if (!area || !display) return;

    const isEditing = !area.classList.contains('hidden');
    if (isEditing) {
        cancelEditListingSearchTerms();
    } else {
        area.classList.remove('hidden');
        display.classList.add('hidden');
        if (input) input.value = listingTextPair(currentListingDataText?.searchTerms || currentListingDataText?.search_terms).target;
        if (btnText) btnText.textContent = '取消';
        if (input) input.focus();
    }
}

function cancelEditListingSearchTerms() {
    const area = document.getElementById('editListingSearchTermsArea');
    const display = document.getElementById('resListingSearchTerms');
    const btnText = document.getElementById('btnEditSearchTermsText');
    if (area) area.classList.add('hidden');
    if (display) display.classList.remove('hidden');
    if (btnText) btnText.textContent = '编辑';
}

function saveEditListingSearchTerms() {
    const input = document.getElementById('editListingSearchTermsInput');
    if (!input || !currentListingDataText) return;
    const newVal = input.value.trim();
    const currentPair = listingTextPair(currentListingDataText.searchTerms || currentListingDataText.search_terms);
    currentListingDataText.searchTerms = { ...currentPair, target: newVal };

    const el = document.getElementById('resListingSearchTerms');
    if (el) el.textContent = newVal;
    updateSearchTermsCounter(newVal);

    cancelEditListingSearchTerms();
    if (typeof showToast === 'function') showToast('后台搜索词已保存修改', 'success');
}

function onSearchTermsInputChanged(val) {
    updateSearchTermsCounter(val);
}

function optimizeListingSearchTerms() {
    if (!currentListingDataText) return;
    const titleStr = listingTextPair(currentListingDataText.title).target;
    const kw = currentListingDataText.keywords || {};
    const allWordsList = [
        listingTextPair(currentListingDataText.searchTerms || currentListingDataText.search_terms).target,
        ...(kw.core || []).map(k => listingTextPair(k).target),
        ...(kw.longTail || []).map(k => listingTextPair(k).target),
        ...(kw.ads || []).map(k => listingTextPair(k).target)
    ].join(' ');

    const result = cleanAndDeduplicateSearchTerms(allWordsList, titleStr);
    if (!currentListingDataText.searchTerms) {
        currentListingDataText.searchTerms = { target: '', zh: '' };
    }
    currentListingDataText.searchTerms.target = result.terms;

    const el = document.getElementById('resListingSearchTerms');
    if (el) el.textContent = result.terms;
    updateSearchTermsCounter(result.terms);

    if (typeof showToast === 'function') {
        showToast(`已智能清洗去重: ${result.byteLength} 字节 (${result.wordCount} 个词)`, 'success');
    }
}

function copyListingSearchTerms() {
    const text = listingTextPair(currentListingDataText?.searchTerms || currentListingDataText?.search_terms).target || document.getElementById('resListingSearchTerms')?.textContent || '';
    copyTextToClipboard(text, '已复制后台搜索词 (Search Terms)');
}

function collectCurrentListingDataFromDom() {
    if (typeof document === 'undefined') return null;
    const titleEl = document.getElementById('resListingTitle');
    const descEl = document.getElementById('resListingDesc') || document.getElementById('resListingDescription');
    const stEl = document.getElementById('resListingSearchTerms');
    const bulletsEl = document.getElementById('resListingBullets');

    if (!titleEl && !descEl && !bulletsEl) return null;

    const titleTarget = titleEl?.querySelector('.target-text')?.textContent?.trim() || titleEl?.textContent?.trim() || '';
    const titleZh = titleEl?.querySelector('.zh-text')?.textContent?.trim() || '';

    const descTarget = descEl?.querySelector('.target-text')?.textContent?.trim() || descEl?.textContent?.trim() || '';
    const descZh = descEl?.querySelector('.zh-text')?.textContent?.trim() || '';

    const stTarget = stEl?.textContent?.trim() || '';

    const bullets = [];
    if (bulletsEl) {
        const lis = bulletsEl.querySelectorAll('li');
        lis.forEach(li => {
            const bTarget = li.querySelector('.target-text')?.textContent?.trim() || '';
            const bZh = li.querySelector('.zh-text')?.textContent?.trim() || '';
            if (bTarget || bZh) {
                bullets.push({ target: bTarget, zh: bZh });
            }
        });
    }

    if (!titleTarget && !descTarget && !bullets.length) return null;

    return {
        title: { target: titleTarget, zh: titleZh },
        bullets,
        description: { target: descTarget, zh: descZh },
        searchTerms: { target: stTarget, zh: '' }
    };
}

function transferListingToDetails() {
    const d = currentListingDataText || collectCurrentListingDataFromDom();
    if (!d) {
        const toast = typeof showToast === 'function' ? showToast : (typeof window !== 'undefined' && window.showToast ? window.showToast : null);
        if (toast) {
            toast('暂无可用的 Listing 数据', 'warning');
        } else if (typeof alert === 'function') {
            alert('暂无可用的 Listing 数据');
        }
        return;
    }

    const nameEl = document.getElementById('productNameInput');
    const pointsEl = document.getElementById('sellingPointsText');
    const factsEl = document.getElementById('productFactsText');
    const hasExistingContent = (nameEl && nameEl.value && nameEl.value.trim()) || (pointsEl && pointsEl.value && pointsEl.value.trim());

    if (hasExistingContent && typeof confirm === 'function' && !confirm('详情页策划已有填写内容，是否将当前 Listing 数据带入并覆盖？')) {
        return;
    }

    const titlePair = listingTextPair(d.title);
    const chosenTitle = (titlePair.zh || titlePair.target || '').trim();
    if (nameEl && chosenTitle) {
        nameEl.value = chosenTitle.substring(0, 160);
    }

    if (pointsEl) {
        const sections = [];
        const bullets = Array.isArray(d.bullets) ? d.bullets : [];
        const bulletLines = bullets.map(b => {
            const pair = listingTextPair(b);
            const text = pair.zh || pair.target || (typeof b === 'string' ? b : '');
            return text ? `- ${text.trim()}` : '';
        }).filter(Boolean);

        if (bulletLines.length > 0) {
            sections.push(`【核心卖点】\n${bulletLines.join('\n')}`);
        }

        const descPair = listingTextPair(d.description);
        const descText = (descPair.zh || descPair.target || '').trim();
        if (descText) {
            sections.push(`【详细规格与功能说明】\n${descText}`);
        }

        if (sections.length > 0) {
            pointsEl.value = sections.join('\n\n');
        }
    }

    if (factsEl) {
        const facts = [];
        const stPair = listingTextPair(d.searchTerms || d.search_terms);
        const st = (stPair.target || stPair.zh || '').trim();
        if (st) facts.push(`核心搜索词: ${st}`);
        if (d.keywords) {
            if (Array.isArray(d.keywords)) {
                facts.push(`关键词库: ${d.keywords.join(', ')}`);
            } else if (typeof d.keywords === 'object') {
                Object.entries(d.keywords).forEach(([k, v]) => {
                    if (Array.isArray(v) && v.length) facts.push(`${k}: ${v.join(', ')}`);
                    else if (v) facts.push(`${k}: ${v}`);
                });
            }
        }
        if (Array.isArray(d.qa) && d.qa.length) {
            const qaLines = d.qa.map(item => {
                const qPair = listingTextPair(item.q || item.question);
                const aPair = listingTextPair(item.a || item.answer);
                const q = (qPair.zh || qPair.target || '').trim();
                const a = (aPair.zh || aPair.target || '').trim();
                return q && a ? `问: ${q} 答: ${a}` : '';
            }).filter(Boolean);
            if (qaLines.length) {
                facts.push(`买家常见疑问:\n${qaLines.join('\n')}`);
            }
        }
        if (facts.length > 0) {
            factsEl.value = facts.join('\n');
        }
    }

    if (typeof document !== 'undefined') {
        const syncBanner = document.getElementById('detailListingSyncBanner');
        if (syncBanner && syncBanner.classList) {
            syncBanner.classList.remove('hidden');
        }
    }

    const tabSwitcher = typeof switchMainTab === 'function'
        ? switchMainTab
        : (typeof window !== 'undefined' && typeof window.switchMainTab === 'function'
            ? window.switchMainTab
            : (typeof globalThis !== 'undefined' && typeof globalThis.switchMainTab === 'function'
                ? globalThis.switchMainTab
                : null));
    if (tabSwitcher) {
        tabSwitcher('generate');
    }

    const toast = typeof showToast === 'function' ? showToast : (typeof window !== 'undefined' && window.showToast ? window.showToast : null);
    if (toast) {
        toast('已将 Listing 核心文案与买点一键同步至详情页生图策划', 'success');
    }
}

function transferListingToAds() {
    const d = currentListingDataText || collectCurrentListingDataFromDom();
    if (!d) {
        const toast = typeof showToast === 'function' ? showToast : (typeof window !== 'undefined' && window.showToast ? window.showToast : null);
        if (toast) {
            toast('暂无可用的 Listing 数据', 'warning');
        } else if (typeof alert === 'function') {
            alert('暂无可用的 Listing 数据');
        }
        return;
    }

    const nameEl = document.getElementById('adsProductNameInput');
    const hasExistingContent = nameEl && nameEl.value && nameEl.value.trim();

    if (hasExistingContent && typeof confirm === 'function' && !confirm('广告模块已有填写内容，是否将当前 Listing 数据带入并覆盖？')) {
        return;
    }

    const titlePair = listingTextPair(d.title);
    const chosenTitle = (titlePair.zh || titlePair.target || '').trim();

    // 提取五点核心卖点作为广告参考背景
    const bullets = Array.isArray(d.bullets) ? d.bullets : [];
    const sellingPoints = bullets.slice(0, 4).map(b => {
        const pair = listingTextPair(b);
        return pair.zh || pair.target || '';
    }).filter(Boolean).join('\n');

    // 提取目标区域
    const regionSelect = document.getElementById('listingRegionSelect');
    const region = regionSelect ? regionSelect.value : '';

    // 提取已上传商品图
    const imageBase64 = typeof getCurrentListingUploadedBase64 === 'function'
        ? getCurrentListingUploadedBase64()
        : (typeof currentListingUploadedBase64 !== 'undefined' ? currentListingUploadedBase64 : null);

    if (nameEl && chosenTitle) {
        nameEl.value = chosenTitle.substring(0, 200);
    }

    const receiver = typeof receiveAdsTransferData === 'function'
        ? receiveAdsTransferData
        : (typeof window !== 'undefined' && window.receiveAdsTransferData ? window.receiveAdsTransferData : null);
    if (receiver) {
        receiver({
            productName: chosenTitle,
            sellingPoints,
            region,
            imageBase64: imageBase64 || null
        });
    }

    const tabSwitcher = typeof switchMainTab === 'function'
        ? switchMainTab
        : (typeof window !== 'undefined' && typeof window.switchMainTab === 'function'
            ? window.switchMainTab
            : (typeof globalThis !== 'undefined' && typeof globalThis.switchMainTab === 'function'
                ? globalThis.switchMainTab
                : null));
    if (tabSwitcher) {
        tabSwitcher('ads');
    }

    const toast = typeof showToast === 'function' ? showToast : (typeof window !== 'undefined' && window.showToast ? window.showToast : null);
    if (toast) {
        toast('已将 Listing 标题与卖点带入广告文案模块', 'success');
    }
}

function toggleListingCopyDropdown(event) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    const menu = document.getElementById('listingCopyDropdownMenu');
    const exportMenu = document.getElementById('listingExportDropdownMenu');
    if (exportMenu) exportMenu.classList.add('hidden');
    if (menu) {
        menu.classList.toggle('hidden');
    }
}

function toggleListingExportDropdown(event) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    const menu = document.getElementById('listingExportDropdownMenu');
    const copyMenu = document.getElementById('listingCopyDropdownMenu');
    if (copyMenu) copyMenu.classList.add('hidden');
    if (menu) {
        menu.classList.toggle('hidden');
    }
}

function hideListingDropdowns() {
    if (typeof document === 'undefined') return;
    const copyMenu = document.getElementById('listingCopyDropdownMenu');
    const exportMenu = document.getElementById('listingExportDropdownMenu');
    if (copyMenu) copyMenu.classList.add('hidden');
    if (exportMenu) exportMenu.classList.add('hidden');
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('click', (e) => {
        const copyContainer = document.getElementById('listingCopyDropdownContainer');
        const exportContainer = document.getElementById('listingExportDropdownContainer');
        const inCopy = copyContainer && typeof copyContainer.contains === 'function' && copyContainer.contains(e?.target);
        const inExport = exportContainer && typeof exportContainer.contains === 'function' && exportContainer.contains(e?.target);
        if (!inCopy && !inExport) {
            hideListingDropdowns();
        }
    });
}

function copyAllListingText(mode) {
    const d = currentListingDataText || collectCurrentListingDataFromDom();
    if (!d) {
        if (typeof showToast === 'function') showToast('暂无 Listing 数据可复制', 'warning');
        return;
    }
    const title = listingTextPair(d.title);
    const desc = listingTextPair(d.description);
    const st = listingTextPair(d.searchTerms || d.search_terms);
    const bullets = (d.bullets || []).map(b => listingTextPair(b));

    const effectiveMode = mode || (currentListingViewMode === 'zh' ? 'zh' : (currentListingViewMode === 'bilingual' ? 'bilingual' : 'target'));

    let content = '';
    let modeLabel = '纯外文';
    if (effectiveMode === 'target') {
        modeLabel = '纯外文';
        content = `【TITLE】\n${title.target}\n\n` +
            `【BULLETS】\n` +
            bullets.map((b, i) => `${i + 1}. ${b.target}`).join('\n') + '\n\n' +
            `【PRODUCT DESCRIPTION】\n${desc.target}\n\n` +
            `【SEARCH TERMS (249 Bytes)】\n${st.target}`;
    } else if (effectiveMode === 'zh') {
        modeLabel = '纯中文';
        content = `【产品标题】\n${title.zh || title.target}\n\n` +
            `【核心卖点】\n` +
            bullets.map((b, i) => `${i + 1}. ${b.zh || b.target}`).join('\n') + '\n\n' +
            `【产品描述】\n${desc.zh || desc.target}\n\n` +
            `【后台搜索词】\n${st.target}`;
    } else {
        modeLabel = '双语对照';
        content = `【TITLE / 标题】\n外文: ${title.target}\n中文: ${title.zh}\n\n` +
            `【BULLETS / 五点描述】\n` +
            bullets.map((b, i) => `${i + 1}. [外文] ${b.target}\n   [中文] ${b.zh}`).join('\n') + '\n\n' +
            `【DESCRIPTION / 长描述】\n[外文]:\n${desc.target}\n[中文]:\n${desc.zh}\n\n` +
            `【SEARCH TERMS / 后台搜索词】\n${st.target}`;
    }

    copyTextToClipboard(content, `已复制全部 Listing (${modeLabel})`);
}

function exportListingToFile(format = 'txt') {
    const d = currentListingDataText || collectCurrentListingDataFromDom();
    if (!d) {
        if (typeof showToast === 'function') showToast('暂无 Listing 数据可导出', 'warning');
        return;
    }
    const title = listingTextPair(d.title);
    const desc = listingTextPair(d.description);
    const st = listingTextPair(d.searchTerms || d.search_terms);
    const bullets = (d.bullets || []).map(b => listingTextPair(b));
    const rawProdName = (typeof document !== 'undefined' && document.getElementById('listingName')?.value.trim()) || 'listing';
    const safeProdName = (rawProdName.replace(/[/\\?%*:|"<>]/g, '_').trim() || 'listing').slice(0, 50);
    const timestamp = new Date().toISOString().slice(0, 10);

    let content = '';
    let filename = '';
    let mimeType = 'text/plain;charset=utf-8';

    if (format === 'md') {
        filename = `${safeProdName}_listing_${timestamp}.md`;
        mimeType = 'text/markdown;charset=utf-8';
        const langVal = (typeof document !== 'undefined' && document.getElementById('listingLanguageSelect')?.value) || 'English';
        content = `# ${rawProdName} - Product Listing\n\n` +
            `> Generated on: ${new Date().toLocaleString()} | Target Language: ${langVal}\n\n` +
            `## 1. Product Title\n\n` +
            `**Target:** ${title.target}\n\n` +
            `**Chinese:** ${title.zh}\n\n` +
            `---\n\n` +
            `## 2. Key Features & Benefits (Bullets)\n\n` +
            bullets.map((b, i) => `### Bullet ${i + 1}\n- **Target:** ${b.target}\n- **Chinese:** ${b.zh}`).join('\n\n') + '\n\n' +
            `---\n\n` +
            `## 3. Product Description\n\n` +
            `### Target Language\n${desc.target}\n\n` +
            `### Chinese Translation\n${desc.zh}\n\n` +
            `---\n\n` +
            `## 4. Backend Search Terms (249 Bytes Limit)\n\n` +
            `\`\`\`text\n${st.target}\n\`\`\`\n` +
            `*Byte Length: ${getUtf8ByteLength(st.target)} / 249 Bytes*\n\n` +
            `---\n\n` +
            `## 5. Keywords Pyramid\n\n` +
            `- **Core Keywords:** ${(d.keywords?.core || []).map(k => listingTextPair(k).target).join(', ')}\n` +
            `- **Long-tail Keywords:** ${(d.keywords?.longTail || []).map(k => listingTextPair(k).target).join(', ')}\n` +
            `- **PPC/Ads Keywords:** ${(d.keywords?.ads || []).map(k => listingTextPair(k).target).join(', ')}\n`;
    } else if (format === 'html') {
        filename = `${safeProdName}_dtc_listing_${timestamp}.html`;
        mimeType = 'text/html;charset=utf-8';
        content = buildListingDtcHtml(d, (typeof currentDtcHtmlLangMode !== 'undefined' && currentDtcHtmlLangMode) || 'target');
    } else {
        filename = `${safeProdName}_listing_${timestamp}.txt`;
        content = `=====================================================\n` +
            `PRODUCT: ${rawProdName}\n` +
            `DATE: ${new Date().toLocaleString()}\n` +
            `=====================================================\n\n` +
            `[TITLE]\n${title.target}\n(${title.zh})\n\n` +
            `[BULLETS]\n` +
            bullets.map((b, i) => `${i + 1}. ${b.target}\n   ${b.zh}`).join('\n\n') + '\n\n' +
            `[PRODUCT DESCRIPTION]\n${desc.target}\n\n[CHINESE TRANSLATION]\n${desc.zh}\n\n` +
            `[SEARCH TERMS (ST)]\n${st.target}\n(Bytes: ${getUtf8ByteLength(st.target)} / 249 Bytes)\n\n` +
            `=====================================================\n`;
    }

    downloadTextFile(filename, content, mimeType);
    if (typeof showToast === 'function') showToast(`已导出 ${filename}`, 'success');
}

function renderListingData(data) {
    currentListingDataText = data || null;
    if (typeof document === 'undefined') return;
    const emptyEl = document.getElementById('listingEmpty');
    if (emptyEl) emptyEl.classList.add('hidden');

    const resArea = document.getElementById('listingResults');
    if (resArea) {
        resArea.classList.remove('hidden');
        resArea.classList.add('flex');
    }

    const riskBtn = document.getElementById('btnRiskCheck');
    if (riskBtn) riskBtn.classList.remove('hidden');

    const viewModeBar = document.getElementById('listingViewModeBar');
    if (viewModeBar) {
        viewModeBar.classList.remove('hidden');
        viewModeBar.classList.add('flex');
    }
    const exportBar = document.getElementById('listingExportBar');
    if (exportBar) {
        exportBar.classList.remove('hidden');
        exportBar.classList.add('flex');
    }

    // Title
    renderListingPair(
        'resListingTitle',
        data?.title,
        'target-text text-gray-800 text-lg mb-2',
        'zh-text text-sm text-gray-400 pt-2 border-t border-gray-100 font-normal'
    );
    updateListingTitleCounter(listingTextPair(data?.title).target);
    renderTitleAlternatives(data?.titleAlternatives || data?.title_alternatives);
    renderListingTitleComparison();

    // Bullets
    const bullets = document.getElementById('resListingBullets');
    const bulletCountEl = document.getElementById('listingBulletsCount');
    const bulletList = data?.bullets || [];
    if (bulletCountEl) bulletCountEl.textContent = `${bulletList.length} 条`;

    if (bullets) {
        bullets.textContent = '';
        bulletList.forEach((item, index) => {
            const pair = listingTextPair(item);
            const li = document.createElement('li');
            li.className = 'mb-4 bg-gray-50/80 p-3.5 rounded-xl border border-gray-100 group/item transition-all';

            const header = document.createElement('div');
            header.className = 'flex items-center justify-between mb-1.5';
            const num = document.createElement('span');
            num.className = 'text-[10px] font-mono font-bold text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded';
            num.textContent = `Bullet #${index + 1} (${pair.target.length} 字符)`;
            header.appendChild(num);

            const copyBtns = document.createElement('div');
            copyBtns.className = 'flex items-center gap-1 opacity-0 group-hover/item:opacity-100 transition-opacity';
            const regenBtn = document.createElement('button');
            regenBtn.className = 'text-[10px] bg-indigo-50 border border-indigo-200 text-indigo-600 hover:bg-indigo-100 px-1.5 py-0.5 rounded font-bold transition-colors cursor-pointer flex items-center gap-0.5';
            regenBtn.title = 'AI 针对此条五点单独重新润色';
            regenBtn.innerHTML = '<i class="ph ph-arrows-clockwise"></i> 换一换';
            regenBtn.onclick = (e) => {
                if (e && e.stopPropagation) e.stopPropagation();
                triggerBulletRegeneration(index);
            };
            const cpTarget = document.createElement('button');
            cpTarget.className = 'text-[10px] bg-white border border-gray-200 hover:bg-indigo-50 hover:text-indigo-600 px-1.5 py-0.5 rounded font-bold transition-colors cursor-pointer';
            cpTarget.textContent = '复制外文';
            cpTarget.onclick = () => copySingleBullet(index, 'target');
            const cpZh = document.createElement('button');
            cpZh.className = 'text-[10px] bg-white border border-gray-200 hover:bg-indigo-50 hover:text-indigo-600 px-1.5 py-0.5 rounded font-bold transition-colors cursor-pointer';
            cpZh.textContent = '复制中文';
            cpZh.onclick = () => copySingleBullet(index, 'zh');
            copyBtns.append(regenBtn, cpTarget, cpZh);
            header.appendChild(copyBtns);

            li.appendChild(header);
            appendTextBlock(li, 'target-text font-bold text-gray-700 text-sm leading-relaxed', pair.target);
            appendTextBlock(li, 'zh-text text-xs text-gray-400 mt-2 border-t border-gray-200/60 pt-2', pair.zh);

            // 局部精修待审候选对比面板
            const pendingBullet = typeof getPendingRegeneratedSection === 'function' ? getPendingRegeneratedSection('bullet', index) : null;
            if (pendingBullet && pendingBullet.proposed?.bullet) {
                const propPair = listingTextPair(pendingBullet.proposed.bullet);
                const compBox = document.createElement('div');
                compBox.className = 'mt-3 p-3 bg-indigo-50/70 border border-indigo-200 rounded-xl shadow-2xs';
                compBox.innerHTML = `
                    <div class="flex items-center justify-between mb-2.5 pb-2 border-b border-indigo-100 flex-wrap gap-2">
                        <div class="flex items-center gap-1.5 text-xs font-bold text-indigo-900">
                            <i class="ph-bold ph-sparkle text-indigo-600"></i>
                            <span>AI 定向润色候选对比</span>
                        </div>
                        <div class="flex items-center gap-1.5">
                            <button type="button" onclick="acceptRegeneratedSection('bullet', ${index})"
                                class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold text-[11px] shadow-2xs flex items-center gap-1 transition-all cursor-pointer">
                                <i class="ph-bold ph-check"></i> 采纳新版
                            </button>
                            <button type="button" onclick="dismissRegeneratedSection('bullet', ${index})"
                                class="px-2 py-1 bg-white hover:bg-slate-100 text-slate-600 border border-slate-200 rounded-lg font-bold text-[11px] shadow-2xs flex items-center gap-1 transition-all cursor-pointer">
                                <i class="ph-bold ph-x"></i> 保留原版
                            </button>
                        </div>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                        <div class="p-2.5 bg-white/90 rounded-lg border border-slate-200/80">
                            <div class="text-[10px] font-bold text-slate-400 mb-1 flex items-center gap-1">
                                <span class="w-1.5 h-1.5 rounded-full bg-slate-300"></span> 原版本
                            </div>
                            <div class="text-slate-600 leading-relaxed">${escapeListingHtml(pair.target)}</div>
                            ${pair.zh ? `<div class="text-[11px] text-slate-400 mt-1.5 pt-1.5 border-t border-slate-100">${escapeListingHtml(pair.zh)}</div>` : ''}
                        </div>
                        <div class="p-2.5 bg-emerald-50/60 rounded-lg border border-emerald-200">
                            <div class="text-[10px] font-bold text-emerald-700 mb-1 flex items-center justify-between">
                                <span class="flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> ✨ 精修新版</span>
                                <span class="text-[9px] bg-emerald-100 text-emerald-800 font-bold px-1 rounded">新推荐</span>
                            </div>
                            <div class="text-slate-800 font-medium leading-relaxed">${escapeListingHtml(propPair.target)}</div>
                            ${propPair.zh ? `<div class="text-[11px] text-emerald-700/80 mt-1.5 pt-1.5 border-t border-emerald-100">${escapeListingHtml(propPair.zh)}</div>` : ''}
                        </div>
                    </div>
                `;
                li.appendChild(compBox);
            }

            bullets.appendChild(li);
        });
    }

    // Description
    renderListingPair(
        'resListingDesc',
        data?.description,
        'target-text text-gray-700 whitespace-pre-wrap',
        'zh-text text-sm text-gray-400 mt-4 pt-4 border-t border-gray-100 whitespace-pre-wrap'
    );
    const descCharEl = document.getElementById('listingDescCharCount');
    if (descCharEl) descCharEl.textContent = `${listingTextPair(data?.description).target.length} 字符`;

    // Keywords Pyramid
    const renderKeywords = (containerId, items) => {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.textContent = '';
        (items || []).forEach(item => {
            const pair = listingTextPair(item);
            if (!pair.target && !pair.zh) return;
            const li = document.createElement('li');
            const target = document.createElement('span');
            target.className = 'target-text';
            target.textContent = pair.target;
            li.append(target);
            if (pair.zh) {
                const zhWrap = document.createElement('span');
                zhWrap.className = 'text-gray-400 text-[10px] ml-1';
                const zh = document.createElement('span');
                zh.className = 'zh-text';
                zh.textContent = pair.zh;
                zhWrap.append('(', zh, ')');
                li.append(' ', zhWrap);
            }
            container.appendChild(li);
        });
    };

    const keywords = data?.keywords || {};
    renderKeywords('resKwCore', keywords.core);
    renderKeywords('resKwTail', keywords.longTail || keywords.long_tail);
    renderKeywords('resKwAds', keywords.ads || keywords.ppc);

    // Search Terms (ST)
    const stPair = listingTextPair(data?.searchTerms || data?.search_terms);
    const stEl = document.getElementById('resListingSearchTerms');
    if (stEl) stEl.textContent = stPair.target;
    const stZhEl = document.getElementById('resListingSearchTermsZh');
    if (stZhEl) stZhEl.textContent = stPair.zh;
    updateSearchTermsCounter(stPair.target);

    // FAQ
    const qaContainer = document.getElementById('resListingQA');
    if (qaContainer) {
        qaContainer.textContent = '';
        const qaItems = (data?.qa || []).map(item => ({
            q: listingTextPair(item?.q || item?.question || item?.Q),
            a: listingTextPair(item?.a || item?.answer || item?.A)
        })).filter(item => item.q.target || item.q.zh || item.a.target || item.a.zh);

        if (!qaItems.length) {
            appendTextBlock(qaContainer, 'text-sm text-gray-400 bg-gray-50/80 p-4 rounded-xl border border-gray-100', '暂无 FAQ 内容，请重新生成或补充更多产品信息。');
        }

        qaItems.forEach(item => {
            const q = item.q;
            const a = item.a;
            const card = document.createElement('div');
            card.className = 'bg-indigo-50/50 p-4 rounded-xl border border-indigo-50 shadow-sm';

            const qBlock = document.createElement('div');
            qBlock.className = 'mb-2';
            const qLabel = document.createElement('span');
            qLabel.className = 'font-bold text-indigo-700 mr-2';
            qLabel.textContent = 'Q:';
            const qText = document.createElement('span');
            qText.className = 'text-gray-800 font-medium target-text text-sm';
            qText.textContent = q.target;
            qBlock.append(qLabel, qText);
            appendTextBlock(qBlock, 'text-xs text-gray-400 mt-1 ml-6 zh-text', q.zh);

            const aBlock = document.createElement('div');
            const aLabel = document.createElement('span');
            aLabel.className = 'font-bold text-emerald-600 mr-2';
            aLabel.textContent = 'A:';
            const aText = document.createElement('span');
            aText.className = 'text-gray-600 target-text text-sm';
            aText.textContent = a.target;
            aBlock.append(aLabel, aText);
            appendTextBlock(aBlock, 'text-xs text-gray-400 mt-1 ml-6 zh-text', a.zh);

            card.append(qBlock, aBlock);
            qaContainer.appendChild(card);
        });
    }

    // Social Media
    renderListingPair(
        'resListingSocial',
        data?.socialMedia || data?.social_script || data?.social,
        'target-text text-gray-700 whitespace-pre-wrap',
        'zh-text text-sm text-gray-400 mt-4 pt-4 border-t border-gray-200 whitespace-pre-wrap'
    );

    renderListingRuleWarnings(data, getSelectedListingPlatform());
    setListingViewMode(currentListingViewMode);
}

async function generateListing() {
    const name = document.getElementById('listingName')?.value.trim() || '';
    const points = document.getElementById('listingPoints')?.value.trim() || '';
    const keywords = document.getElementById('listingKeywords')?.value.trim() || '';

    const styleOpt = document.getElementById('listingStyleSelect');
    const style = styleOpt?.options[styleOpt.selectedIndex]?.value || styleOpt?.value || '';

    const regionOpt = document.getElementById('listingRegionSelect');
    const region = regionOpt?.options[regionOpt.selectedIndex]?.value || regionOpt?.value || '';

    const languageOpt = document.getElementById('listingLanguageSelect');
    const targetLanguage = languageOpt?.options[languageOpt.selectedIndex]?.value || languageOpt?.value || '';

    const themeOpt = document.getElementById('listingMarketingThemeSelect');
    const themeVal = themeOpt?.value || '';
    const themeLabel = themeOpt?.options[themeOpt.selectedIndex]?.text || '';

    if (!name || !points) {
        if (typeof showToast === 'function') showToast('请填写必填项：产品名称与核心卖点', 'error');
        return;
    }

    const btn = document.getElementById('btnGenerateListing');
    const origBtnHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.innerHTML = '<span class="loader w-4 h-4 mr-2 border-2 border-white border-t-transparent"></span> 语境适配演算中...';
        btn.disabled = true;
    }

    const includeEmoji = !!document.getElementById('listingIncludeEmojiToggle')?.checked;

    try {
        const data = await postListingApi('/api/listing/generate', {
            name,
            points,
            keywords,
            platform: style,
            region,
            target_language: targetLanguage,
            marketing_theme: themeVal,
            marketing_theme_label: themeLabel,
            include_emoji: includeEmoji
        });
        renderListingData(data);

        const inputSnapshot = {
            name,
            points,
            keywords,
            platform: style,
            platformLabel: styleOpt?.options[styleOpt.selectedIndex]?.text || style,
            region,
            target_language: targetLanguage,
            marketing_theme: themeVal,
            marketing_theme_label: themeLabel,
            include_emoji: includeEmoji,
            image_preview: currentListingUploadedBase64 || ''
        };

        if (typeof saveToHistory === 'function') {
            saveToHistory('listing', {
                name,
                platform: inputSnapshot.platformLabel,
                target_lang: targetLanguage,
                inputs: inputSnapshot,
                result: {
                    ...data,
                    _inputs: inputSnapshot
                }
            });
        }
    } catch (err) {
        console.error(err);
        if (typeof showToast === 'function') showToast('Listing 生成失败: ' + err.message, 'error');
    } finally {
        if (btn) {
            btn.innerHTML = origBtnHtml;
            btn.disabled = false;
        }
    }
}

function restoreListingFullState(dataObj) {
    if (!dataObj) return;
    const inputs = dataObj.result?._inputs || dataObj._inputs || dataObj.inputs || {};

    const nameVal = inputs.name || dataObj.product_name || '';
    const nameInput = document.getElementById('listingName');
    if (nameInput && nameVal) nameInput.value = nameVal;

    const pointsInput = document.getElementById('listingPoints');
    if (pointsInput && inputs.points) pointsInput.value = inputs.points;

    const keywordsInput = document.getElementById('listingKeywords');
    if (keywordsInput && inputs.keywords) keywordsInput.value = inputs.keywords;

    const styleSelect = document.getElementById('listingStyleSelect');
    if (styleSelect) {
        if (inputs.platform) {
            styleSelect.value = inputs.platform;
        } else if (dataObj.platform) {
            const opt = Array.from(styleSelect.options).find(o => o.text.includes(dataObj.platform) || o.value.includes(dataObj.platform));
            if (opt) styleSelect.value = opt.value;
        }
    }

    const regionSelect = document.getElementById('listingRegionSelect');
    if (regionSelect && inputs.region) regionSelect.value = inputs.region;

    const langSelect = document.getElementById('listingLanguageSelect');
    if (langSelect && (inputs.target_language || dataObj.target_lang)) {
        langSelect.value = inputs.target_language || dataObj.target_lang;
    }

    const themeSelect = document.getElementById('listingMarketingThemeSelect');
    if (themeSelect && inputs.marketing_theme) themeSelect.value = inputs.marketing_theme;

    if (inputs.image_preview) {
        currentListingUploadedBase64 = inputs.image_preview;
        const preview = document.getElementById('listingUploadedImagePreview');
        if (preview) preview.src = inputs.image_preview;
        const container = document.getElementById('listingImagePreviewContainer');
        if (container) container.classList.remove('hidden');
        const promptBtn = document.getElementById('aiListingExtractPromptBtn');
        if (promptBtn) promptBtn.classList.remove('hidden');
    }

    if (typeof inputs.include_emoji !== 'undefined') {
        onListingEmojiToggleChange(Boolean(inputs.include_emoji));
    }

    const resData = dataObj.result || dataObj.data || dataObj;
    renderListingData(resData);
}

function renderComplianceReport(data) {
    const container = document.getElementById('riskCheckContent');
    container.textContent = '';
    currentComplianceSuggestions = data?.rewrite_suggestions || [];

    appendTextBlock(container, 'font-black text-gray-900 mb-2', `综合风险：${data?.overall_level || 'unknown'}`);
    appendTextBlock(container, 'mb-4', data?.summary || '未发现明确风险。');

    if (data?.risks?.length) {
        appendTextBlock(container, 'font-bold text-red-700 mb-2', '风险明细');
        data.risks.forEach(item => {
            const block = document.createElement('div');
            block.className = 'mb-3 rounded-lg border border-red-100 bg-red-50/50 p-3';
            appendTextBlock(block, 'font-bold text-red-700', `${item.level || 'unknown'} · ${item.type || '风险'}`);
            appendTextBlock(block, 'text-xs text-gray-500 mt-1', item.evidence ? `命中内容：${item.evidence}` : '');
            appendTextBlock(block, 'text-sm text-gray-700 mt-1', item.reason || '');
            container.appendChild(block);
        });
    }

    if (data?.rewrite_suggestions?.length) {
        const headerRow = document.createElement('div');
        headerRow.className = 'flex items-center justify-between mt-4 mb-2';

        const title = document.createElement('div');
        title.className = 'font-bold text-emerald-700';
        title.textContent = `修改建议 (${data.rewrite_suggestions.length})`;
        headerRow.appendChild(title);

        const applyAllBtn = document.createElement('button');
        applyAllBtn.id = 'btnApplyAllCompliance';
        applyAllBtn.className = 'px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition-colors flex items-center gap-1 shadow-sm cursor-pointer';
        applyAllBtn.innerHTML = '<i class="ph ph-check-circle"></i> 一键采纳全部建议';
        applyAllBtn.addEventListener('click', () => applyAllComplianceSuggestions());
        headerRow.appendChild(applyAllBtn);

        container.appendChild(headerRow);

        const list = document.createElement('div');
        list.className = 'space-y-2';
        data.rewrite_suggestions.forEach((suggestion, index) => {
            const block = document.createElement('div');
            block.className = 'rounded-lg border border-emerald-100 bg-emerald-50/50 p-3';
            appendTextBlock(block, 'text-sm text-gray-700', suggestion.reason || '建议优化该处文案。');
            if (suggestion.current_text) {
                appendTextBlock(block, 'text-xs text-gray-500 mt-1', `原文：${suggestion.current_text}`);
            }
            if (suggestion.suggested_text) {
                appendTextBlock(block, 'text-xs text-emerald-700 mt-1', `建议：${suggestion.suggested_text}`);
                const btn = document.createElement('button');
                btn.id = `compliance-apply-btn-${index}`;
                btn.className = 'mt-2 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition-colors flex items-center gap-1 cursor-pointer';
                btn.innerHTML = '<i class="ph ph-check"></i> 应用建议';
                btn.addEventListener('click', () => applyComplianceSuggestion(index));
                block.appendChild(btn);
            }
            list.appendChild(block);
        });
        container.appendChild(list);
    }
}

function cleanSearchText(text) {
    if (!text || typeof text !== 'string') return '';
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim();
    return cleaned;
}

function replaceFirstStringValue(value, findText, replaceText) {
    const targetFind = cleanSearchText(findText);
    if (!targetFind) return { value, replaced: false };

    if (typeof value === 'string') {
        if (value.includes(targetFind)) {
            return { value: value.replace(targetFind, replaceText), replaced: true };
        }
        const normValue = value.replace(/\s+/g, ' ');
        const normFind = targetFind.replace(/\s+/g, ' ');
        if (normValue.toLowerCase().includes(normFind.toLowerCase())) {
            try {
                const escaped = targetFind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
                const regex = new RegExp(escaped, 'i');
                if (regex.test(value)) {
                    return { value: value.replace(regex, replaceText), replaced: true };
                }
            } catch {
                // fallback
            }
        }
        return { value, replaced: false };
    }

    if (Array.isArray(value)) {
        let replaced = false;
        const next = value.map(item => {
            if (replaced) return item;
            const result = replaceFirstStringValue(item, findText, replaceText);
            replaced = result.replaced;
            return result.value;
        });
        return { value: next, replaced };
    }

    if (value && typeof value === 'object') {
        let replaced = false;
        const next = { ...value };
        for (const key of Object.keys(next)) {
            if (replaced) break;
            const result = replaceFirstStringValue(next[key], findText, replaceText);
            replaced = result.replaced;
            next[key] = result.value;
        }
        return { value: next, replaced };
    }

    return { value, replaced: false };
}

function applySuggestionByField(data, field, suggestedText, currentText = '') {
    const next = structuredClone(data);
    const normalizedField = String(field || '').toLowerCase().trim();
    const cleanFind = cleanSearchText(currentText);

    if (normalizedField === 'title') {
        next.title = { ...listingTextPair(next.title), target: suggestedText };
        return { value: next, replaced: true };
    }
    if (normalizedField === 'description') {
        next.description = { ...listingTextPair(next.description), target: suggestedText };
        return { value: next, replaced: true };
    }
    if (normalizedField === 'socialmedia' || normalizedField === 'social') {
        next.socialMedia = { ...listingTextPair(next.socialMedia), target: suggestedText };
        return { value: next, replaced: true };
    }
    if (normalizedField === 'searchterms' || normalizedField === 'search_terms' || normalizedField === 'st') {
        next.searchTerms = { ...listingTextPair(next.searchTerms || next.search_terms), target: suggestedText };
        return { value: next, replaced: true };
    }

    if (normalizedField === 'bullets' || normalizedField === 'bullet') {
        if (Array.isArray(next.bullets) && next.bullets.length > 0) {
            let matchedIdx = -1;
            if (cleanFind) {
                matchedIdx = next.bullets.findIndex(item => {
                    const target = listingTextPair(item).target || '';
                    return target.includes(cleanFind) || target.toLowerCase().includes(cleanFind.toLowerCase());
                });
                if (matchedIdx === -1) {
                    const words = cleanFind.toLowerCase().split(/\s+/).filter(w => w.length > 3);
                    if (words.length > 0) {
                        matchedIdx = next.bullets.findIndex(item => {
                            const target = (listingTextPair(item).target || '').toLowerCase();
                            return words.some(word => target.includes(word));
                        });
                    }
                }
            }
            if (matchedIdx === -1 && next.bullets.length === 1) {
                matchedIdx = 0;
            }
            if (matchedIdx !== -1) {
                const existing = listingTextPair(next.bullets[matchedIdx]);
                next.bullets[matchedIdx] = { ...existing, target: suggestedText };
                return { value: next, replaced: true };
            }
        }
    }

    if (normalizedField === 'keywords' || normalizedField === 'keyword') {
        const categories = ['core', 'longTail', 'ads'];
        for (const cat of categories) {
            const list = next.keywords?.[cat];
            if (Array.isArray(list)) {
                const idx = list.findIndex(item => {
                    const target = listingTextPair(item).target || '';
                    return cleanFind ? target.includes(cleanFind) || target.toLowerCase().includes(cleanFind.toLowerCase()) : false;
                });
                if (idx !== -1) {
                    const existing = listingTextPair(list[idx]);
                    list[idx] = { ...existing, target: suggestedText };
                    return { value: next, replaced: true };
                }
            }
        }
    }

    if (normalizedField === 'qa') {
        if (Array.isArray(next.qa)) {
            for (let i = 0; i < next.qa.length; i++) {
                const item = next.qa[i];
                const qText = listingTextPair(item.q).target || '';
                const aText = listingTextPair(item.a).target || '';
                if (cleanFind && (qText.includes(cleanFind) || qText.toLowerCase().includes(cleanFind.toLowerCase()))) {
                    item.q = { ...listingTextPair(item.q), target: suggestedText };
                    return { value: next, replaced: true };
                }
                if (cleanFind && (aText.includes(cleanFind) || aText.toLowerCase().includes(cleanFind.toLowerCase()))) {
                    item.a = { ...listingTextPair(item.a), target: suggestedText };
                    return { value: next, replaced: true };
                }
            }
        }
    }

    return { value: data, replaced: false };
}

function markSuggestionApplied(index) {
    const btn = document.getElementById(`compliance-apply-btn-${index}`);
    if (btn) {
        btn.disabled = true;
        btn.className = 'mt-2 px-3 py-1.5 rounded-lg bg-gray-100 text-gray-400 text-xs font-bold cursor-not-allowed flex items-center gap-1 border border-gray-200';
        btn.innerHTML = '<i class="ph ph-check text-emerald-600"></i> 已应用';
    }
    if (currentComplianceSuggestions && currentComplianceSuggestions[index]) {
        currentComplianceSuggestions[index].applied = true;
    }
}

function applyComplianceSuggestion(index) {
    const suggestion = currentComplianceSuggestions[index];
    if (suggestion?.applied) {
        showToast('该建议已应用', 'info');
        return;
    }
    if (!suggestion?.suggested_text || !currentListingDataText) {
        showToast('这条建议没有可直接替换的文案', 'warning');
        return;
    }

    let result = { value: currentListingDataText, replaced: false };
    if (suggestion.current_text) {
        result = replaceFirstStringValue(currentListingDataText, suggestion.current_text, suggestion.suggested_text);
    }
    if (!result.replaced && suggestion.field) {
        result = applySuggestionByField(currentListingDataText, suggestion.field, suggestion.suggested_text, suggestion.current_text);
    }

    if (!result.replaced) {
        showToast('未找到可替换的原文，请手动参考建议调整', 'warning');
        return;
    }

    currentListingDataText = result.value;
    renderListingData(result.value);
    markSuggestionApplied(index);

    const allApplied = currentComplianceSuggestions.every(s => s.applied || !s.suggested_text);
    if (allApplied) {
        const applyAllBtn = document.getElementById('btnApplyAllCompliance');
        if (applyAllBtn) {
            applyAllBtn.disabled = true;
            applyAllBtn.className = 'px-3 py-1.5 rounded-lg bg-gray-100 text-gray-400 text-xs font-bold cursor-not-allowed border border-gray-200 flex items-center gap-1';
            applyAllBtn.innerHTML = '<i class="ph ph-check-circle text-emerald-600"></i> 全部建议已应用';
        }
    }

    showToast('已应用合规建议', 'success');
}

function applyAllComplianceSuggestions() {
    if (!currentComplianceSuggestions?.length || !currentListingDataText) {
        showToast('暂无可应用的合规建议', 'info');
        return;
    }

    let appliedCount = 0;
    currentComplianceSuggestions.forEach((suggestion, index) => {
        if (suggestion.applied || !suggestion.suggested_text) return;

        let result = { value: currentListingDataText, replaced: false };
        if (suggestion.current_text) {
            result = replaceFirstStringValue(currentListingDataText, suggestion.current_text, suggestion.suggested_text);
        }
        if (!result.replaced && suggestion.field) {
            result = applySuggestionByField(currentListingDataText, suggestion.field, suggestion.suggested_text, suggestion.current_text);
        }

        if (result.replaced) {
            currentListingDataText = result.value;
            markSuggestionApplied(index);
            appliedCount++;
        }
    });

    if (appliedCount > 0) {
        renderListingData(currentListingDataText);
        showToast(`已成功采纳 ${appliedCount} 条合规建议`, 'success');
        const allApplied = currentComplianceSuggestions.every(s => s.applied || !s.suggested_text);
        if (allApplied) {
            const applyAllBtn = document.getElementById('btnApplyAllCompliance');
            if (applyAllBtn) {
                applyAllBtn.disabled = true;
                applyAllBtn.className = 'px-3 py-1.5 rounded-lg bg-gray-100 text-gray-400 text-xs font-bold cursor-not-allowed border border-gray-200 flex items-center gap-1';
                applyAllBtn.innerHTML = '<i class="ph ph-check-circle text-emerald-600"></i> 全部建议已应用';
            }
        }
    } else {
        showToast('未找到可自动替换的原文内容', 'warning');
    }
}

async function checkListingCompliance() {
    if (!currentListingDataText) return;
    const btn = document.getElementById('btnRiskCheck');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="loader w-3 h-3 border-2 border-red-500 border-t-transparent mr-1"></span> 审查中...';
    btn.disabled = true;

    try {
        const styleOpt = document.getElementById('listingStyleSelect');
        const regionOpt = document.getElementById('listingRegionSelect');
        const data = await postListingApi('/api/listing/compliance', {
            listing: currentListingDataText,
            platform: styleOpt?.options[styleOpt.selectedIndex]?.value || '',
            region: regionOpt?.options[regionOpt.selectedIndex]?.value || ''
        });
        renderComplianceReport(data);
        document.getElementById('riskCheckModal').classList.remove('hidden');
    } catch (e) {
        showToast('审查失败: ' + e.message, 'error');
    } finally {
        btn.innerHTML = origHtml;
        btn.disabled = false;
    }
}

function closeRiskCheckModal() {
    document.getElementById('riskCheckModal').classList.add('hidden');
}

function ingestListingImageFile(file) {
    if (!file) return false;
    if (!file.type || !file.type.startsWith('image/')) {
        showToast('请选择图片文件', 'error');
        return false;
    }
    if (file.size > 6 * 1024 * 1024) {
        showToast('图片过大，请选择 6MB 以内的图片', 'error');
        return false;
    }
    const reader = new FileReader();
    reader.onload = e => {
        currentListingUploadedBase64 = e.target.result;
        const preview = document.getElementById('listingUploadedImagePreview');
        if (preview) preview.src = currentListingUploadedBase64;
        const container = document.getElementById('listingImagePreviewContainer');
        if (container) container.classList.remove('hidden');
        const promptBtn = document.getElementById('aiListingExtractPromptBtn');
        if (promptBtn) promptBtn.classList.remove('hidden');
        showToast('参考产品图已添加', 'success');
    };
    reader.readAsDataURL(file);
    return true;
}

function handleListingImageUpload(event) {
    try {
        const file = event?.target?.files?.[0];
        if (file) ingestListingImageFile(file);
    } finally {
        if (event?.target) event.target.value = '';
    }
}

function handleListingImagePaste(files) {
    const file = Array.isArray(files) ? files[0] : files;
    if (file) return ingestListingImageFile(file);
    return false;
}

function handleListingImageDrop(event) {
    if (event?.preventDefault) event.preventDefault();
    const dtFiles = Array.from(event?.dataTransfer?.files || []).filter(f => f.type && f.type.startsWith('image/'));
    if (dtFiles.length) {
        ingestListingImageFile(dtFiles[0]);
    }
}

function removeListingImage() {
    currentListingUploadedBase64 = null;
    const input = document.getElementById('listingImageUpload');
    if (input) input.value = '';
    const container = document.getElementById('listingImagePreviewContainer');
    if (container) container.classList.add('hidden');
    const promptBtn = document.getElementById('aiListingExtractPromptBtn');
    if (promptBtn) promptBtn.classList.add('hidden');
}

function insertListingFactSlot(slotType) {
    const pointsInput = document.getElementById('listingPoints');
    if (!pointsInput) return;
    const slots = {
        material: '【材质工艺】: ',
        specs: '【规格参数】: ',
        audience: '【适用受众与场景】: ',
        pain_point: '【解决核心痛点】: ',
        package: '【包装与配件清单】: '
    };
    const prefix = slots[slotType] || `【${slotType}】: `;
    const currentVal = pointsInput.value || '';
    if (currentVal.includes(prefix)) {
        if (typeof showToast === 'function') showToast(`已包含${prefix}，请在已有内容后补充`, 'info');
        pointsInput.focus();
        return;
    }
    const separator = currentVal && !currentVal.endsWith('\n') ? '\n' : '';
    pointsInput.value = currentVal + separator + prefix;
    pointsInput.focus();
    const newLen = pointsInput.value.length;
    pointsInput.setSelectionRange(newLen, newLen);
    if (typeof saveListingDraft === 'function') saveListingDraft();
}

function toggleListingAdvancedConfig() {
    const container = document.getElementById('listingAdvancedConfigContainer');
    const text = document.getElementById('listingAdvancedConfigToggleText');
    const icon = document.getElementById('listingAdvancedConfigToggleIcon');
    if (!container) return;
    const isHidden = container.classList.contains('hidden');
    if (isHidden) {
        container.classList.remove('hidden');
        if (text) text.textContent = '收起';
        if (icon) icon.className = 'ph ph-caret-up text-xs transition-transform';
    } else {
        container.classList.add('hidden');
        if (text) text.textContent = '展开';
        if (icon) icon.className = 'ph ph-caret-down text-xs transition-transform';
    }
}

function toggleListingTitleRegenMenu(event) {
    if (event && event.stopPropagation) event.stopPropagation();
    const menu = document.getElementById('listingTitleRegenMenu');
    if (!menu) return;
    menu.classList.toggle('hidden');
}

function hideAllSectionRegenMenus() {
    const menu = document.getElementById('listingTitleRegenMenu');
    if (menu) menu.classList.add('hidden');
}

let pendingListingRegenerations = {};

function getPendingRegenerationKey(section, bulletIndex) {
    return `${section}_${typeof bulletIndex === 'number' ? bulletIndex : 'main'}`;
}

function getPendingRegeneratedSection(section, bulletIndex) {
    const key = getPendingRegenerationKey(section, bulletIndex);
    return pendingListingRegenerations[key] || null;
}

function stageRegeneratedSection(section, bulletIndex, sectionData) {
    if (!currentListingDataText) return;
    const key = getPendingRegenerationKey(section, bulletIndex);

    let original = null;
    if (section === 'title') {
        original = currentListingDataText.title;
    } else if (section === 'bullet' && typeof bulletIndex === 'number') {
        original = currentListingDataText.bullets?.[bulletIndex] || null;
    } else if (section === 'description') {
        original = currentListingDataText.description;
    } else if (section === 'search_terms') {
        original = currentListingDataText.searchTerms;
    }

    pendingListingRegenerations[key] = {
        section,
        bulletIndex,
        original: original ? JSON.parse(JSON.stringify(original)) : null,
        proposed: sectionData,
        timestamp: Date.now()
    };

    if (typeof renderListingData === 'function') {
        renderListingData(currentListingDataText);
    }
}

function acceptRegeneratedSection(section, bulletIndex) {
    const key = getPendingRegenerationKey(section, bulletIndex);
    const pending = pendingListingRegenerations[key];
    if (!pending) return;

    const proposed = pending.proposed;
    delete pendingListingRegenerations[key];
    applyRegeneratedSection(section, bulletIndex, proposed);
    if (typeof showToast === 'function') {
        showToast('已采纳 AI 精修版本！', 'success');
    }
}

function dismissRegeneratedSection(section, bulletIndex) {
    const key = getPendingRegenerationKey(section, bulletIndex);
    if (pendingListingRegenerations[key]) {
        delete pendingListingRegenerations[key];
        if (typeof renderListingData === 'function') {
            renderListingData(currentListingDataText);
        }
        if (typeof showToast === 'function') {
            showToast('已保留原版内容', 'info');
        }
    }
}

function renderListingTitleComparison() {
    if (typeof document === 'undefined') return;
    const titleContainer = document.getElementById('resListingTitle');
    if (!titleContainer) return;
    const existingComp = document.getElementById('listingTitleComparisonBox');
    if (existingComp && existingComp.remove) existingComp.remove();

    const pending = typeof getPendingRegeneratedSection === 'function' ? getPendingRegeneratedSection('title') : null;
    if (!pending || !pending.proposed) return;

    const propTitle = pending.proposed.title;
    if (!propTitle) return;

    const origPair = listingTextPair(pending.original);
    const propPair = listingTextPair(propTitle);

    const compBox = document.createElement('div');
    compBox.id = 'listingTitleComparisonBox';
    compBox.className = 'mt-3 p-3.5 bg-indigo-50/70 border border-indigo-200 rounded-xl shadow-2xs';
    compBox.innerHTML = `
        <div class="flex items-center justify-between mb-2.5 pb-2 border-b border-indigo-100 flex-wrap gap-2">
            <div class="flex items-center gap-1.5 text-xs font-bold text-indigo-900">
                <i class="ph-bold ph-sparkle text-indigo-600"></i>
                <span>AI 标题精修候选对比</span>
            </div>
            <div class="flex items-center gap-1.5">
                <button type="button" onclick="acceptRegeneratedSection('title')"
                    class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold text-[11px] shadow-2xs flex items-center gap-1 transition-all cursor-pointer">
                    <i class="ph-bold ph-check"></i> 采纳新标题
                </button>
                <button type="button" onclick="dismissRegeneratedSection('title')"
                    class="px-2 py-1 bg-white hover:bg-slate-100 text-slate-600 border border-slate-200 rounded-lg font-bold text-[11px] shadow-2xs flex items-center gap-1 transition-all cursor-pointer">
                    <i class="ph-bold ph-x"></i> 保留原标题
                </button>
            </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-2.5 text-xs">
            <div class="p-2.5 bg-white/90 rounded-lg border border-slate-200/80">
                <div class="text-[10px] font-bold text-slate-400 mb-1 flex items-center gap-1">
                    <span class="w-1.5 h-1.5 rounded-full bg-slate-300"></span> 原版本
                </div>
                <div class="text-slate-600 leading-relaxed font-medium">${escapeListingHtml(origPair.target)}</div>
                ${origPair.zh ? `<div class="text-[11px] text-slate-400 mt-1.5 pt-1.5 border-t border-slate-100">${escapeListingHtml(origPair.zh)}</div>` : ''}
            </div>
            <div class="p-2.5 bg-emerald-50/60 rounded-lg border border-emerald-200">
                <div class="text-[10px] font-bold text-emerald-700 mb-1 flex items-center justify-between">
                    <span class="flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> ✨ 精修新版</span>
                    <span class="text-[9px] bg-emerald-100 text-emerald-800 font-bold px-1 rounded">新推荐</span>
                </div>
                <div class="text-slate-800 font-bold leading-relaxed">${escapeListingHtml(propPair.target)}</div>
                ${propPair.zh ? `<div class="text-[11px] text-emerald-700/80 mt-1.5 pt-1.5 border-t border-emerald-100">${escapeListingHtml(propPair.zh)}</div>` : ''}
            </div>
        </div>
    `;
    if (titleContainer.parentNode && titleContainer.parentNode.insertBefore) {
        titleContainer.parentNode.insertBefore(compBox, titleContainer.nextSibling);
    }
}

function triggerSectionRegeneration(section, bulletIndex, instruction) {
    regenerateListingSection(section, bulletIndex, instruction);
}

function triggerBulletRegeneration(bulletIndex) {
    regenerateListingSection('bullet', bulletIndex, 'benefit_heavy');
}

async function regenerateListingSection(section, bulletIndex, instruction) {
    if (!currentListingDataText) {
        if (typeof showToast === 'function') showToast('请先生成 Listing 结果，再进行局部精修', 'error');
        return;
    }
    const name = document.getElementById('listingName')?.value.trim() || currentListingDataText.title?.target || '';
    const points = document.getElementById('listingPoints')?.value.trim() || '';
    const keywords = document.getElementById('listingKeywords')?.value.trim() || '';
    const styleOpt = document.getElementById('listingStyleSelect');
    const platform = styleOpt?.options[styleOpt.selectedIndex]?.value || styleOpt?.value || '';
    const regionOpt = document.getElementById('listingRegionSelect');
    const region = regionOpt?.options[regionOpt.selectedIndex]?.value || regionOpt?.value || '';
    const languageOpt = document.getElementById('listingLanguageSelect');
    const targetLanguage = languageOpt?.options[languageOpt.selectedIndex]?.value || languageOpt?.value || '';

    let currentContent = null;
    if (section === 'title') {
        currentContent = currentListingDataText.title;
    } else if (section === 'bullet' && typeof bulletIndex === 'number' && currentListingDataText.bullets?.[bulletIndex]) {
        currentContent = currentListingDataText.bullets[bulletIndex];
    } else if (section === 'description') {
        currentContent = currentListingDataText.description;
    } else if (section === 'search_terms') {
        currentContent = currentListingDataText.searchTerms;
    }

    if (typeof showToast === 'function') showToast('AI 正在定向精修，请稍候...', 'info');

    const includeEmoji = !!document.getElementById('listingIncludeEmojiToggle')?.checked;

    try {
        const res = await postListingApi('/api/listing/regenerate-section', {
            section,
            current_content: currentContent,
            instruction: instruction || 'more_concise',
            product_name: name,
            core_selling_points: points || name,
            keywords,
            platform,
            region,
            target_language: targetLanguage,
            bullet_index: bulletIndex,
            include_emoji: includeEmoji
        });

        if (res && res.data) {
            stageRegeneratedSection(section, bulletIndex, res.data);
            if (typeof showToast === 'function') showToast('局部润色完成，请在下方对比并确认！', 'success');
        }
    } catch (err) {
        console.error(err);
        if (typeof showToast === 'function') showToast('局部优化失败: ' + err.message, 'error');
    }
}

function applyRegeneratedSection(section, bulletIndex, sectionData) {
    if (!currentListingDataText) return;
    const key = getPendingRegenerationKey(section, bulletIndex);
    if (pendingListingRegenerations[key]) {
        delete pendingListingRegenerations[key];
    }
    if (section === 'title') {
        if (sectionData.title) {
            currentListingDataText.title = sectionData.title;
        }
        if (sectionData.titleAlternatives && sectionData.titleAlternatives.length) {
            currentListingDataText.titleAlternatives = sectionData.titleAlternatives;
        }
    } else if (section === 'bullet' && typeof bulletIndex === 'number') {
        if (!Array.isArray(currentListingDataText.bullets)) {
            currentListingDataText.bullets = [];
        }
        if (sectionData.bullet) {
            currentListingDataText.bullets[bulletIndex] = sectionData.bullet;
        }
    } else if (section === 'description') {
        if (sectionData.description) {
            currentListingDataText.description = sectionData.description;
        }
    } else if (section === 'search_terms') {
        if (sectionData.searchTerms) {
            currentListingDataText.searchTerms = sectionData.searchTerms;
        }
    }

    renderListingData(currentListingDataText);
    saveCurrentListingToHistory();
}

function saveCurrentListingToHistory() {
    if (!currentListingDataText) return;
    if (typeof document === 'undefined') return;
    const name = document.getElementById('listingName')?.value.trim() || currentListingDataText.title?.target || '';
    const points = document.getElementById('listingPoints')?.value.trim() || '';
    const keywords = document.getElementById('listingKeywords')?.value.trim() || '';
    const styleOpt = document.getElementById('listingStyleSelect');
    const style = styleOpt?.options?.[styleOpt?.selectedIndex]?.value || styleOpt?.value || '';
    const regionOpt = document.getElementById('listingRegionSelect');
    const region = regionOpt?.options?.[regionOpt?.selectedIndex]?.value || regionOpt?.value || '';
    const languageOpt = document.getElementById('listingLanguageSelect');
    const targetLanguage = languageOpt?.options?.[languageOpt?.selectedIndex]?.value || languageOpt?.value || '';
    const themeOpt = document.getElementById('listingMarketingThemeSelect');

    const inputSnapshot = {
        name,
        points,
        keywords,
        platform: style,
        platformLabel: styleOpt?.options?.[styleOpt?.selectedIndex]?.text || style,
        region,
        target_language: targetLanguage,
        marketing_theme: themeOpt?.value || '',
        marketing_theme_label: themeOpt?.options?.[themeOpt?.selectedIndex]?.text || '',
        image_preview: (typeof currentListingUploadedBase64 !== 'undefined' ? currentListingUploadedBase64 : '') || ''
    };

    if (typeof saveToHistory === 'function') {
        saveToHistory('listing', {
            name,
            platform: inputSnapshot.platformLabel,
            target_lang: targetLanguage,
            inputs: inputSnapshot,
            result: {
                ...currentListingDataText,
                _inputs: inputSnapshot
            }
        });
        updateListingHistoryBadge();
    }
}

async function updateListingHistoryBadge() {
    if (typeof fetch === 'undefined') return;
    try {
        const apiBase = (typeof API_BASE !== 'undefined' ? API_BASE : '') || (typeof window !== 'undefined' && window.API_BASE ? window.API_BASE : '');
        const res = await fetch(`${apiBase}/api/history/listing?_t=${Date.now()}`);
        if (!res.ok) return;
        const items = await res.json();
        const count = Array.isArray(items) ? items.length : 0;
        const badge = document.getElementById('listingHistoryCountBadge');
        if (badge) {
            badge.textContent = count;
            if (count > 0) {
                badge.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
            }
        }
    } catch (e) {}
}

function onListingEmojiToggleChange(checked) {
    if (typeof document === 'undefined') return;
    const isChecked = Boolean(checked);
    const hint = document.getElementById('listingEmojiStatusHint');
    if (hint) {
        if (isChecked) {
            hint.textContent = '✨ 开启 (生动吸睛)';
            hint.className = 'text-[10px] text-indigo-600 font-semibold';
        } else {
            hint.textContent = '关闭 (纯文本)';
            hint.className = 'text-[10px] text-slate-400 font-normal';
        }
    }
    const toggle = document.getElementById('listingIncludeEmojiToggle');
    if (toggle && toggle.checked !== isChecked) {
        toggle.checked = isChecked;
    }
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('listing_include_emoji', isChecked ? 'true' : 'false');
        }
    } catch (e) {}
}

async function loadListingHistoryDrawerList() {
    const listEl = document.getElementById('listingHistoryList');
    if (!listEl) return;
    listEl.innerHTML = '<div class="flex items-center justify-center py-8 text-indigo-600 text-xs gap-2"><span class="loader w-3.5 h-3.5 border-2 border-indigo-500 border-t-transparent"></span> 加载快照中...</div>';

    try {
        const apiBase = (typeof API_BASE !== 'undefined' ? API_BASE : '') || (typeof window !== 'undefined' && window.API_BASE ? window.API_BASE : '');
        const res = await fetch(`${apiBase}/api/history/listing?_t=${Date.now()}`);
        if (!res.ok) throw new Error('网络请求失败');
        const items = await res.json();
        const badge = document.getElementById('listingHistoryCountBadge');
        if (badge) {
            badge.textContent = items.length;
            if (items.length > 0) badge.classList.remove('hidden');
        }

        if (!Array.isArray(items) || items.length === 0) {
            listEl.innerHTML = '<div class="text-xs text-gray-400 text-center py-10">暂无历史快照</div>';
            return;
        }

        listEl.innerHTML = '';
        items.forEach((item) => {
            if (!item) return;
            let dataObj = item;
            if (item.data) {
                try {
                    dataObj = typeof item.data === 'string' ? JSON.parse(item.data) : item.data;
                } catch (e) {
                    dataObj = item;
                }
            }
            if (!dataObj || typeof dataObj !== 'object') {
                dataObj = item || {};
            }

            if (typeof dataObj.result === 'string') {
                try {
                    dataObj.result = JSON.parse(dataObj.result);
                } catch (e) {}
            }

            const card = document.createElement('div');
            card.className = 'bg-slate-50/80 hover:bg-indigo-50/40 p-3 rounded-xl border border-slate-200/80 transition-all flex flex-col gap-2 group shadow-2xs';

            const topRow = document.createElement('div');
            topRow.className = 'flex items-center justify-between';

            const tag = document.createElement('span');
            tag.className = 'text-[10px] font-mono font-bold text-indigo-600 bg-white border border-indigo-100 px-1.5 py-0.5 rounded';
            tag.textContent = dataObj.platform || dataObj.result?._inputs?.platformLabel || dataObj.inputs?.platformLabel || item.platform || 'Listing';

            const rawTime = item.timestamp || item.created_at || dataObj.timestamp;
            const timeStr = rawTime ? new Date(rawTime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
            const timeEl = document.createElement('span');
            timeEl.className = 'text-[10px] text-gray-400';
            timeEl.textContent = timeStr;

            topRow.append(tag, timeEl);

            const titleEl = document.createElement('div');
            titleEl.className = 'text-xs font-bold text-gray-800 line-clamp-2 leading-snug';
            const resTitle = dataObj.result?.title?.target || dataObj.product_name || dataObj.name || '未命名产品';
            titleEl.textContent = resTitle;

            const btmRow = document.createElement('div');
            btmRow.className = 'flex items-center justify-between pt-1 border-t border-slate-200/60 mt-0.5';

            const restoreBtn = document.createElement('button');
            restoreBtn.className = 'text-[11px] font-bold text-indigo-600 hover:text-indigo-800 hover:underline flex items-center gap-1 cursor-pointer';
            restoreBtn.innerHTML = '<i class="ph ph-arrow-counter-clockwise"></i> 恢复此快照';
            restoreBtn.onclick = () => {
                restoreListingFullState(dataObj);
                toggleListingHistoryDrawer(false);
                if (typeof showToast === 'function') showToast('已恢复所选 Listing 快照', 'success');
            };

            const delBtn = document.createElement('button');
            delBtn.className = 'text-[11px] text-slate-400 hover:text-rose-600 transition-colors p-1 cursor-pointer';
            delBtn.title = '删除此记录';
            delBtn.innerHTML = '<i class="ph ph-trash"></i>';
            delBtn.onclick = async (e) => {
                e.stopPropagation();
                if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm('确定删除该条快照记录吗？')) {
                    return;
                }
                try {
                    const apiBase = (typeof API_BASE !== 'undefined' ? API_BASE : '') || (typeof window !== 'undefined' && window.API_BASE ? window.API_BASE : '');
                    const delRes = await fetch(`${apiBase}/api/history/listing/${item.id}`, { method: 'DELETE' });
                    if (delRes.ok) {
                        card.remove();
                        updateListingHistoryBadge();
                        if (typeof showToast === 'function') showToast('已删除快照记录', 'info');
                    }
                } catch (delErr) {
                    console.error('Delete failed', delErr);
                }
            };

            btmRow.append(restoreBtn, delBtn);

            card.append(topRow, titleEl, btmRow);
            listEl.appendChild(card);
        });
    } catch (err) {
        listEl.innerHTML = `<div class="text-xs text-rose-500 text-center py-6">加载失败: ${err.message}</div>`;
    }
}

function toggleListingHistoryDrawer(forceState) {
    const drawer = document.getElementById('listingHistoryDrawer');
    if (!drawer) return;
    const shouldOpen = typeof forceState === 'boolean' ? forceState : drawer.classList.contains('hidden');
    if (shouldOpen) {
        drawer.classList.remove('hidden');
        loadListingHistoryDrawerList();
    } else {
        drawer.classList.add('hidden');
    }
}

let currentDtcHtmlLangMode = 'target';
let currentDtcHtmlViewport = 'desktop';
let currentDtcHtmlTab = 'preview';

function escapeListingHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function buildListingDtcHtml(data, langMode = 'target') {
    if (!data) return '';
    const titlePair = listingTextPair(data.title);
    const descPair = listingTextPair(data.description);
    const bullets = Array.isArray(data.bullets) ? data.bullets.map(b => listingTextPair(b)) : [];
    const faqs = Array.isArray(data.faq) ? data.faq : [];

    const effectiveMode = langMode === 'zh' ? 'zh' : (langMode === 'bilingual' ? 'bilingual' : 'target');

    const titleText = effectiveMode === 'zh' ? (titlePair.zh || titlePair.target) : titlePair.target;
    const zhTitleText = (effectiveMode === 'bilingual' && titlePair.zh && titlePair.zh !== titlePair.target) ? titlePair.zh : '';

    const bulletsHtml = bullets.map((b) => {
        let text = effectiveMode === 'zh' ? (b.zh || b.target) : b.target;
        let tag = '';
        let prefixEmoji = '';
        const match = text.match(/^(\s*[^\[]*?\[([^\]]+)\])(.*)$/s);
        if (match) {
            prefixEmoji = match[1].replace(/\[[^\]]+\]/, '').trim();
            tag = match[2].trim();
            const rest = match[3].trim();
            text = (prefixEmoji ? `<span class="dtc-feature-emoji">${escapeListingHtml(prefixEmoji)}</span> ` : '') +
                   `<span class="dtc-feature-tag">${escapeListingHtml(tag)}</span>` +
                   `<span class="dtc-feature-body">${escapeListingHtml(rest)}</span>`;
        } else {
            text = `<span class="dtc-feature-body">${escapeListingHtml(text)}</span>`;
        }

        let zhSub = '';
        if (effectiveMode === 'bilingual' && b.zh && b.zh !== b.target) {
            zhSub = `<div class="dtc-feature-zh">${escapeListingHtml(b.zh)}</div>`;
        }

        return `<div class="dtc-feature-card">
  <div class="dtc-feature-content">
    ${text}
  </div>
  ${zhSub}
</div>`;
    }).join('\n');

    const descText = effectiveMode === 'zh' ? (descPair.zh || descPair.target) : descPair.target;
    const paragraphs = (descText || '').split(/\n+/).filter(p => p.trim());
    const descParagraphsHtml = paragraphs.map(p => `<p>${escapeListingHtml(p.trim())}</p>`).join('\n');
    let descZhHtml = '';
    if (effectiveMode === 'bilingual' && descPair.zh && descPair.zh !== descPair.target) {
        const zhParas = descPair.zh.split(/\n+/).filter(p => p.trim());
        descZhHtml = `<div class="dtc-desc-zh-box">
  <div class="dtc-desc-zh-title">🇨🇳 中文对照参考</div>
  ${zhParas.map(p => `<p>${escapeListingHtml(p.trim())}</p>`).join('\n')}
</div>`;
    }

    const heroImgSrc = (typeof currentListingUploadedBase64 !== 'undefined' && currentListingUploadedBase64) || data._inputs?.image_preview || '';
    const heroImgHtml = heroImgSrc ? `<div class="dtc-hero-image-wrap"><img src="${heroImgSrc}" alt="${escapeListingHtml(titleText)}" class="dtc-hero-image" loading="lazy" /></div>` : '';

    let faqSectionHtml = '';
    if (faqs.length > 0) {
        const faqCardsHtml = faqs.map((f) => {
            const qPair = listingTextPair(f.q || f.question);
            const aPair = listingTextPair(f.a || f.answer);
            const q = effectiveMode === 'zh' ? (qPair.zh || qPair.target) : qPair.target;
            const a = effectiveMode === 'zh' ? (aPair.zh || aPair.target) : aPair.target;
            const zhQ = (effectiveMode === 'bilingual' && qPair.zh && qPair.zh !== qPair.target) ? `<div class="dtc-faq-zh-sub">${escapeListingHtml(qPair.zh)}</div>` : '';
            const zhA = (effectiveMode === 'bilingual' && aPair.zh && aPair.zh !== aPair.target) ? `<div class="dtc-faq-zh-sub">${escapeListingHtml(aPair.zh)}</div>` : '';
            return `<div class="dtc-faq-item">
  <details>
    <summary><span class="dtc-faq-q-text">${escapeListingHtml(q)}</span>${zhQ}</summary>
    <div class="dtc-faq-answer"><p>${escapeListingHtml(a)}</p>${zhA}</div>
  </details>
</div>`;
        }).join('\n');

        faqSectionHtml = `<section class="dtc-section dtc-faq-section">
  <h3 class="dtc-section-heading"><span class="dtc-heading-icon">❓</span> Frequently Asked Questions</h3>
  <div class="dtc-faq-list">
${faqCardsHtml}
  </div>
</section>`;
    }

    const jsonLd = `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": ${JSON.stringify(titleText || 'Product')},
  "description": ${JSON.stringify((descText || '').substring(0, 300))}
}
<\/script>`;

    const scopedCss = `<style>
.dtc-listing-wrapper {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif !important;
  color: #1e293b !important;
  line-height: 1.65 !important;
  max-width: 880px !important;
  margin: 0 auto !important;
  padding: 24px 16px !important;
  box-sizing: border-box !important;
}
.dtc-listing-wrapper * {
  box-sizing: border-box !important;
}
.dtc-pill-badge {
  display: inline-flex !important;
  align-items: center !important;
  gap: 6px !important;
  padding: 4px 12px !important;
  background: #eef2ff !important;
  color: #4f46e5 !important;
  border-radius: 9999px !important;
  font-size: 11px !important;
  font-weight: 700 !important;
  letter-spacing: 0.05em !important;
  text-transform: uppercase !important;
  margin-bottom: 12px !important;
  border: 1px solid #c7d2fe !important;
}
.dtc-title {
  font-size: 24px !important;
  font-weight: 800 !important;
  color: #0f172a !important;
  line-height: 1.35 !important;
  margin: 0 0 10px 0 !important;
  letter-spacing: -0.02em !important;
}
.dtc-zh-title {
  font-size: 14px !important;
  color: #64748b !important;
  margin: 0 0 16px 0 !important;
  font-weight: 500 !important;
}
.dtc-hero-image-wrap {
  width: 100% !important;
  border-radius: 16px !important;
  overflow: hidden !important;
  margin: 16px 0 24px 0 !important;
  border: 1px solid #e2e8f0 !important;
  box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05) !important;
  background: #f8fafc !important;
}
.dtc-hero-image {
  width: 100% !important;
  height: auto !important;
  max-height: 460px !important;
  object-fit: cover !important;
  display: block !important;
}
.dtc-trust-bar {
  display: grid !important;
  grid-template-columns: repeat(3, 1fr) !important;
  gap: 12px !important;
  background: #f8fafc !important;
  border: 1px solid #e2e8f0 !important;
  border-radius: 14px !important;
  padding: 16px !important;
  margin: 20px 0 28px 0 !important;
}
.dtc-trust-item {
  display: flex !important;
  align-items: center !important;
  gap: 10px !important;
}
.dtc-trust-icon {
  font-size: 22px !important;
  line-height: 1 !important;
  flex-shrink: 0 !important;
}
.dtc-trust-title {
  font-size: 12px !important;
  font-weight: 700 !important;
  color: #1e293b !important;
  line-height: 1.2 !important;
}
.dtc-trust-desc {
  font-size: 10px !important;
  color: #64748b !important;
  line-height: 1.2 !important;
  margin-top: 2px !important;
}
.dtc-section {
  margin-bottom: 28px !important;
}
.dtc-section-heading {
  font-size: 17px !important;
  font-weight: 800 !important;
  color: #0f172a !important;
  margin: 0 0 16px 0 !important;
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  border-bottom: 2px solid #f1f5f9 !important;
  padding-bottom: 8px !important;
}
.dtc-heading-icon {
  font-size: 18px !important;
  line-height: 1 !important;
}
.dtc-features-list {
  display: flex !important;
  flex-direction: column !important;
  gap: 10px !important;
}
.dtc-feature-card {
  background: #ffffff !important;
  border: 1px solid #e2e8f0 !important;
  border-radius: 12px !important;
  padding: 14px 16px !important;
  box-shadow: 0 1px 3px rgba(0,0,0,0.02) !important;
}
.dtc-feature-content {
  line-height: 1.6 !important;
}
.dtc-feature-tag {
  display: inline-block !important;
  background: #eef2ff !important;
  color: #4f46e5 !important;
  font-size: 11px !important;
  font-weight: 800 !important;
  letter-spacing: 0.04em !important;
  padding: 3px 8px !important;
  border-radius: 6px !important;
  margin-right: 8px !important;
  border: 1px solid #c7d2fe !important;
  text-transform: uppercase !important;
}
.dtc-feature-body {
  font-size: 13.5px !important;
  color: #334155 !important;
  line-height: 1.6 !important;
}
.dtc-feature-zh {
  font-size: 12px !important;
  color: #64748b !important;
  margin-top: 6px !important;
  padding-left: 8px !important;
  border-left: 2px solid #cbd5e1 !important;
}
.dtc-desc-card {
  background: #f8fafc !important;
  border: 1px solid #e2e8f0 !important;
  border-radius: 14px !important;
  padding: 20px 22px !important;
}
.dtc-desc-body {
  font-size: 14px !important;
  color: #334155 !important;
  line-height: 1.75 !important;
}
.dtc-desc-body p {
  margin: 0 0 12px 0 !important;
}
.dtc-desc-body p:last-child {
  margin-bottom: 0 !important;
}
.dtc-desc-zh-box {
  margin-top: 16px !important;
  padding-top: 14px !important;
  border-top: 1px dashed #cbd5e1 !important;
  font-size: 12px !important;
  color: #64748b !important;
}
.dtc-desc-zh-title {
  font-weight: 700 !important;
  color: #475569 !important;
  margin-bottom: 6px !important;
}
.dtc-faq-list {
  display: flex !important;
  flex-direction: column !important;
  gap: 8px !important;
}
.dtc-faq-item {
  border: 1px solid #e2e8f0 !important;
  border-radius: 10px !important;
  background: #ffffff !important;
  overflow: hidden !important;
}
.dtc-faq-item details summary {
  padding: 14px 16px !important;
  font-size: 14px !important;
  font-weight: 700 !important;
  color: #1e293b !important;
  cursor: pointer !important;
  list-style: none !important;
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  user-select: none !important;
}
.dtc-faq-item details summary::-webkit-details-marker {
  display: none !important;
}
.dtc-faq-item details summary::after {
  content: "▾" !important;
  font-size: 15px !important;
  color: #64748b !important;
  transition: transform 0.2s !important;
}
.dtc-faq-item details[open] summary::after {
  transform: rotate(180deg) !important;
}
.dtc-faq-answer {
  padding: 0 16px 14px 16px !important;
  font-size: 13px !important;
  color: #475569 !important;
  line-height: 1.6 !important;
}
.dtc-faq-zh-sub {
  font-size: 12px !important;
  color: #94a3b8 !important;
  font-weight: 400 !important;
  margin-top: 2px !important;
}
@media (max-width: 640px) {
  .dtc-title { font-size: 19px !important; }
  .dtc-trust-bar { grid-template-columns: 1fr !important; gap: 8px !important; }
}
</style>`;

    const bodyHtml = `<div class="dtc-listing-wrapper">
  <div class="dtc-listing-header">
    <div class="dtc-pill-badge">✨ Official Product Spotlight</div>
    <h2 class="dtc-title">${escapeListingHtml(titleText)}</h2>
    ${zhTitleText ? `<div class="dtc-zh-title">${escapeListingHtml(zhTitleText)}</div>` : ''}
  </div>

  ${heroImgHtml}

  <div class="dtc-trust-bar">
    <div class="dtc-trust-item">
      <span class="dtc-trust-icon">🚚</span>
      <div>
        <div class="dtc-trust-title">Fast Global Shipping</div>
        <div class="dtc-trust-desc">Tracked door-to-door delivery</div>
      </div>
    </div>
    <div class="dtc-trust-item">
      <span class="dtc-trust-icon">🛡️</span>
      <div>
        <div class="dtc-trust-title">30-Day Guarantee</div>
        <div class="dtc-trust-desc">Hassle-free returns & refunds</div>
      </div>
    </div>
    <div class="dtc-trust-item">
      <span class="dtc-trust-icon">🎧</span>
      <div>
        <div class="dtc-trust-title">24/7 Dedicated Support</div>
        <div class="dtc-trust-desc">Always here to help you</div>
      </div>
    </div>
  </div>

  ${bulletsHtml ? `<section class="dtc-section">
    <h3 class="dtc-section-heading"><span class="dtc-heading-icon">✨</span> Key Features & Benefits</h3>
    <div class="dtc-features-list">
${bulletsHtml}
    </div>
  </section>` : ''}

  ${descParagraphsHtml ? `<section class="dtc-section">
    <h3 class="dtc-section-heading"><span class="dtc-heading-icon">📖</span> Product Story & Overview</h3>
    <div class="dtc-desc-card">
      <div class="dtc-desc-body">
${descParagraphsHtml}
      </div>
      ${descZhHtml}
    </div>
  </section>` : ''}

  ${faqSectionHtml}
</div>
${jsonLd}`;

    let fullHtml = `${scopedCss.trim()}\n${bodyHtml.trim()}`;
    fullHtml = fullHtml.replace(/>\s*[\r\n]+\s*</g, '>\n<').trim();
    return fullHtml;
}

function openListingDtcHtmlModal() {
    if (typeof document === 'undefined') return;
    if (typeof window !== 'undefined') window.activeDtcHtmlModalSource = 'listing';
    if (typeof globalThis !== 'undefined') globalThis.activeDtcHtmlModalSource = 'listing';
    const d = currentListingDataText || collectCurrentListingDataFromDom();
    if (!d || !d.title) {
        if (typeof showToast === 'function') showToast('请先生成 Listing 结果，再预览独立站 HTML', 'warning');
        return;
    }
    const modal = document.getElementById('listingDtcHtmlModal');
    if (modal) {
        modal.classList.remove('hidden');
        updateListingDtcHtmlModalContent();
    }
}

function closeListingDtcHtmlModal() {
    if (typeof document === 'undefined') return;
    const modal = document.getElementById('listingDtcHtmlModal');
    if (modal) modal.classList.add('hidden');
    if (typeof window !== 'undefined') window.activeDtcHtmlModalSource = null;
    if (typeof globalThis !== 'undefined') globalThis.activeDtcHtmlModalSource = null;
}

function setListingDtcHtmlViewport(mode) {
    if (typeof document === 'undefined') return;
    currentDtcHtmlViewport = mode;
    const btnDesktop = document.getElementById('btnDtcHtmlViewportDesktop');
    const btnMobile = document.getElementById('btnDtcHtmlViewportMobile');
    const wrapper = document.getElementById('listingDtcHtmlPreviewWrapper');

    if (mode === 'mobile') {
        if (wrapper) {
            wrapper.style.maxWidth = '375px';
            wrapper.style.margin = '0 auto';
        }
        if (btnMobile) {
            btnMobile.className = 'px-2 py-1 rounded-md text-[11px] font-bold bg-white text-indigo-600 shadow-2xs cursor-pointer flex items-center gap-1';
        }
        if (btnDesktop) {
            btnDesktop.className = 'px-2 py-1 rounded-md text-[11px] font-medium text-slate-600 hover:text-slate-900 cursor-pointer flex items-center gap-1';
        }
    } else {
        if (wrapper) {
            wrapper.style.maxWidth = '100%';
            wrapper.style.margin = '0';
        }
        if (btnDesktop) {
            btnDesktop.className = 'px-2 py-1 rounded-md text-[11px] font-bold bg-white text-indigo-600 shadow-2xs cursor-pointer flex items-center gap-1';
        }
        if (btnMobile) {
            btnMobile.className = 'px-2 py-1 rounded-md text-[11px] font-medium text-slate-600 hover:text-slate-900 cursor-pointer flex items-center gap-1';
        }
    }
}

function setListingDtcHtmlTab(tab) {
    if (typeof document === 'undefined') return;
    currentDtcHtmlTab = tab;
    const previewWrap = document.getElementById('listingDtcHtmlPreviewWrapper');
    const codeWrap = document.getElementById('listingDtcHtmlCodeWrapper');
    const btnPreview = document.getElementById('btnDtcHtmlTabPreview');
    const btnCode = document.getElementById('btnDtcHtmlTabCode');

    if (tab === 'code') {
        if (previewWrap?.classList) previewWrap.classList.add('hidden');
        if (codeWrap?.classList) codeWrap.classList.remove('hidden');
        if (btnCode) {
            btnCode.className = 'px-2.5 py-1 rounded-md text-[11px] font-bold bg-white text-indigo-600 shadow-2xs cursor-pointer flex items-center gap-1';
        }
        if (btnPreview) {
            btnPreview.className = 'px-2.5 py-1 rounded-md text-[11px] font-medium text-slate-600 hover:text-slate-900 cursor-pointer flex items-center gap-1';
        }
    } else {
        if (codeWrap?.classList) codeWrap.classList.add('hidden');
        if (previewWrap?.classList) previewWrap.classList.remove('hidden');
        if (btnPreview) {
            btnPreview.className = 'px-2.5 py-1 rounded-md text-[11px] font-bold bg-white text-indigo-600 shadow-2xs cursor-pointer flex items-center gap-1';
        }
        if (btnCode) {
            btnCode.className = 'px-2.5 py-1 rounded-md text-[11px] font-medium text-slate-600 hover:text-slate-900 cursor-pointer flex items-center gap-1';
        }
    }
}

function setListingDtcHtmlLangMode(mode) {
    currentDtcHtmlLangMode = mode;
    if (typeof window !== 'undefined') window.currentDtcHtmlLangMode = mode;
    if (typeof globalThis !== 'undefined') globalThis.currentDtcHtmlLangMode = mode;
    updateListingDtcHtmlModalContent();
}

function updateListingDtcHtmlModalContent() {
    if (typeof document === 'undefined') return;
    let d = null;
    const isDetailsSource = (typeof window !== 'undefined' && window.activeDtcHtmlModalSource === 'details') ||
        (typeof globalThis !== 'undefined' && globalThis.activeDtcHtmlModalSource === 'details');

    if (isDetailsSource) {
        if (typeof window !== 'undefined' && typeof window.getDetailDtcHtmlData === 'function') {
            d = window.getDetailDtcHtmlData();
        } else if (typeof globalThis !== 'undefined' && typeof globalThis.getDetailDtcHtmlData === 'function') {
            d = globalThis.getDetailDtcHtmlData();
        }
    } else {
        d = currentListingDataText || collectCurrentListingDataFromDom();
        if (!d) {
            if (typeof window !== 'undefined' && typeof window.getDetailDtcHtmlData === 'function') {
                d = window.getDetailDtcHtmlData();
            } else if (typeof globalThis !== 'undefined' && typeof globalThis.getDetailDtcHtmlData === 'function') {
                d = globalThis.getDetailDtcHtmlData();
            }
        }
    }
    if (!d) return;

    const html = buildListingDtcHtml(d, currentDtcHtmlLangMode);

    const codeArea = document.getElementById('listingDtcHtmlCodeArea');
    if (codeArea) codeArea.value = html;

    const iframe = document.getElementById('listingDtcHtmlPreviewFrame');
    if (iframe) {
        iframe.srcdoc = html;
    }
}

async function copyListingDtcHtml() {
    let d = null;
    const isDetailsSource = (typeof window !== 'undefined' && window.activeDtcHtmlModalSource === 'details') ||
        (typeof globalThis !== 'undefined' && globalThis.activeDtcHtmlModalSource === 'details');

    if (isDetailsSource) {
        if (typeof window !== 'undefined' && typeof window.getDetailDtcHtmlData === 'function') {
            d = window.getDetailDtcHtmlData();
        } else if (typeof globalThis !== 'undefined' && typeof globalThis.getDetailDtcHtmlData === 'function') {
            d = globalThis.getDetailDtcHtmlData();
        }
    } else {
        d = currentListingDataText || collectCurrentListingDataFromDom();
        if (!d) {
            if (typeof window !== 'undefined' && typeof window.getDetailDtcHtmlData === 'function') {
                d = window.getDetailDtcHtmlData();
            } else if (typeof globalThis !== 'undefined' && typeof globalThis.getDetailDtcHtmlData === 'function') {
                d = globalThis.getDetailDtcHtmlData();
            }
        }
    }
    if (!d) {
        if (typeof showToast === 'function') showToast('暂无内容可复制', 'error');
        return;
    }
    const html = buildListingDtcHtml(d, currentDtcHtmlLangMode);
    await copyTextToClipboard(html, '已复制独立站 HTML 代码！可直接粘贴至 Shopify / WordPress HTML 块');
}

async function copyListingDtcHtmlQuick() {
    const d = currentListingDataText || collectCurrentListingDataFromDom();
    if (!d) {
        if (typeof showToast === 'function') showToast('请先生成 Listing 结果再复制独立站 HTML', 'warning');
        return;
    }
    const html = buildListingDtcHtml(d, 'target');
    await copyTextToClipboard(html, '已复制独立站 HTML 代码 (纯外文)！可直接粘贴至独立站 HTML 块');
}

function exportListingDtcHtmlFile() {
    let d = null;
    const isDetailsSource = (typeof window !== 'undefined' && window.activeDtcHtmlModalSource === 'details') ||
        (typeof globalThis !== 'undefined' && globalThis.activeDtcHtmlModalSource === 'details');

    if (isDetailsSource) {
        if (typeof window !== 'undefined' && typeof window.getDetailDtcHtmlData === 'function') {
            d = window.getDetailDtcHtmlData();
        } else if (typeof globalThis !== 'undefined' && typeof globalThis.getDetailDtcHtmlData === 'function') {
            d = globalThis.getDetailDtcHtmlData();
        }
    } else {
        d = currentListingDataText || collectCurrentListingDataFromDom();
        if (!d) {
            if (typeof window !== 'undefined' && typeof window.getDetailDtcHtmlData === 'function') {
                d = window.getDetailDtcHtmlData();
            } else if (typeof globalThis !== 'undefined' && typeof globalThis.getDetailDtcHtmlData === 'function') {
                d = globalThis.getDetailDtcHtmlData();
            }
        }
    }

    if (!d) {
        if (typeof showToast === 'function') showToast('暂无内容可导出', 'warning');
        return;
    }

    const titlePair = listingTextPair(d.title);
    const rawProdName = (titlePair.zh || titlePair.target || 'dtc_product').replace(/[/\\?%*:|"<>]/g, '_').trim().slice(0, 50);
    const timestamp = new Date().toISOString().slice(0, 10);
    const filename = `${rawProdName}_dtc_description_${timestamp}.html`;
    const html = buildListingDtcHtml(d, currentDtcHtmlLangMode);
    downloadTextFile(filename, html, 'text/html;charset=utf-8');
    if (typeof showToast === 'function') showToast(`已导出 ${filename}`, 'success');
}

if (typeof window !== 'undefined') {
    window.ingestListingImageFile = ingestListingImageFile;
    window.handleListingImagePaste = handleListingImagePaste;
    window.handleListingImageDrop = handleListingImageDrop;
    window.setListingViewMode = setListingViewMode;
    window.getCurrentListingViewMode = getCurrentListingViewMode;
    window.getUtf8ByteLength = getUtf8ByteLength;
    window.cleanAndDeduplicateSearchTerms = cleanAndDeduplicateSearchTerms;
    window.copyAllListingText = copyAllListingText;
    window.exportListingToFile = exportListingToFile;
    window.toggleTitleAlternatives = toggleTitleAlternatives;
    window.adoptTitleAlternative = adoptTitleAlternative;
    window.toggleEditListingTitle = toggleEditListingTitle;
    window.cancelEditListingTitle = cancelEditListingTitle;
    window.saveEditListingTitle = saveEditListingTitle;
    window.onTitleEditInput = onTitleEditInput;
    window.toggleEditListingBullets = toggleEditListingBullets;
    window.cancelEditListingBullets = cancelEditListingBullets;
    window.saveEditListingBullets = saveEditListingBullets;
    window.copySingleBullet = copySingleBullet;
    window.toggleEditListingDesc = toggleEditListingDesc;
    window.cancelEditListingDesc = cancelEditListingDesc;
    window.saveEditListingDesc = saveEditListingDesc;
    window.onDescEditInput = onDescEditInput;
    window.optimizeListingSearchTerms = optimizeListingSearchTerms;
    window.toggleEditListingSearchTerms = toggleEditListingSearchTerms;
    window.cancelEditListingSearchTerms = cancelEditListingSearchTerms;
    window.saveEditListingSearchTerms = saveEditListingSearchTerms;
    window.copyListingSearchTerms = copyListingSearchTerms;
    window.onSearchTermsInputChanged = onSearchTermsInputChanged;
    window.restoreListingFullState = restoreListingFullState;
    window.toggleListingCopyDropdown = toggleListingCopyDropdown;
    window.toggleListingExportDropdown = toggleListingExportDropdown;
    window.hideListingDropdowns = hideListingDropdowns;
    window.transferListingToDetails = transferListingToDetails;
    window.transferListingToAds = transferListingToAds;
    window.insertListingFactSlot = insertListingFactSlot;
    window.toggleListingAdvancedConfig = toggleListingAdvancedConfig;
    window.toggleListingTitleRegenMenu = toggleListingTitleRegenMenu;
    window.hideAllSectionRegenMenus = hideAllSectionRegenMenus;
    window.triggerSectionRegeneration = triggerSectionRegeneration;
    window.triggerBulletRegeneration = triggerBulletRegeneration;
    window.regenerateListingSection = regenerateListingSection;
    window.applyRegeneratedSection = applyRegeneratedSection;
    window.stageRegeneratedSection = stageRegeneratedSection;
    window.acceptRegeneratedSection = acceptRegeneratedSection;
    window.dismissRegeneratedSection = dismissRegeneratedSection;
    window.getPendingRegeneratedSection = getPendingRegeneratedSection;
    window.renderListingTitleComparison = renderListingTitleComparison;
    window.pendingListingRegenerations = pendingListingRegenerations;
    window.getCurrentListingData = getCurrentListingData;
    window.setCurrentListingData = setCurrentListingData;
    window.saveCurrentListingToHistory = saveCurrentListingToHistory;
    window.updateListingHistoryBadge = updateListingHistoryBadge;
    window.loadListingHistoryDrawerList = loadListingHistoryDrawerList;
    window.toggleListingHistoryDrawer = toggleListingHistoryDrawer;
}
if (typeof globalThis !== 'undefined') {
    globalThis.ingestListingImageFile = ingestListingImageFile;
    globalThis.handleListingImagePaste = handleListingImagePaste;
    globalThis.handleListingImageDrop = handleListingImageDrop;
    globalThis.restoreListingFullState = restoreListingFullState;
    globalThis.getUtf8ByteLength = getUtf8ByteLength;
    globalThis.cleanAndDeduplicateSearchTerms = cleanAndDeduplicateSearchTerms;
    globalThis.setListingViewMode = setListingViewMode;
    globalThis.getCurrentListingViewMode = getCurrentListingViewMode;
    globalThis.getListingUploadedBase64 = getListingUploadedBase64;
    globalThis.setListingUploadedBase64 = setListingUploadedBase64;
    globalThis.toggleListingCopyDropdown = toggleListingCopyDropdown;
    globalThis.toggleListingExportDropdown = toggleListingExportDropdown;
    globalThis.hideListingDropdowns = hideListingDropdowns;
    globalThis.saveListingDraft = saveListingDraft;
    globalThis.restoreListingDraft = restoreListingDraft;
    globalThis.transferListingToDetails = transferListingToDetails;
    globalThis.transferListingToAds = transferListingToAds;
    globalThis.insertListingFactSlot = insertListingFactSlot;
    globalThis.toggleListingAdvancedConfig = toggleListingAdvancedConfig;
    globalThis.toggleListingTitleRegenMenu = toggleListingTitleRegenMenu;
    globalThis.hideAllSectionRegenMenus = hideAllSectionRegenMenus;
    globalThis.triggerSectionRegeneration = triggerSectionRegeneration;
    globalThis.triggerBulletRegeneration = triggerBulletRegeneration;
    globalThis.regenerateListingSection = regenerateListingSection;
    globalThis.applyRegeneratedSection = applyRegeneratedSection;
    globalThis.stageRegeneratedSection = stageRegeneratedSection;
    globalThis.acceptRegeneratedSection = acceptRegeneratedSection;
    globalThis.dismissRegeneratedSection = dismissRegeneratedSection;
    globalThis.getPendingRegeneratedSection = getPendingRegeneratedSection;
    globalThis.renderListingTitleComparison = renderListingTitleComparison;
    globalThis.pendingListingRegenerations = pendingListingRegenerations;
    globalThis.getCurrentListingData = getCurrentListingData;
    globalThis.setCurrentListingData = setCurrentListingData;
    globalThis.saveCurrentListingToHistory = saveCurrentListingToHistory;
    globalThis.updateListingHistoryBadge = updateListingHistoryBadge;
    globalThis.loadListingHistoryDrawerList = loadListingHistoryDrawerList;
    globalThis.toggleListingHistoryDrawer = toggleListingHistoryDrawer;
}

const LISTING_DRAFT_KEY = 'ai_ecommerce_listing_draft_v1';

function saveListingDraft() {
    if (typeof localStorage === 'undefined' || typeof document === 'undefined') return;
    const draft = {
        name: document.getElementById('listingName')?.value || '',
        points: document.getElementById('listingPoints')?.value || '',
        keywords: document.getElementById('listingKeywords')?.value || '',
        region: document.getElementById('listingRegionSelect')?.value || '',
        language: document.getElementById('listingLanguageSelect')?.value || '',
        style: document.getElementById('listingStyleSelect')?.value || ''
    };
    try {
        localStorage.setItem(LISTING_DRAFT_KEY, JSON.stringify(draft));
    } catch (e) {}
}

function restoreListingDraft() {
    if (typeof localStorage === 'undefined' || typeof document === 'undefined') return;
    try {
        const raw = localStorage.getItem(LISTING_DRAFT_KEY);
        if (!raw) return;
        const draft = JSON.parse(raw);
        const nameEl = document.getElementById('listingName');
        const pointsEl = document.getElementById('listingPoints');
        const kwEl = document.getElementById('listingKeywords');
        const regionEl = document.getElementById('listingRegionSelect');
        const langEl = document.getElementById('listingLanguageSelect');
        const styleEl = document.getElementById('listingStyleSelect');

        if (nameEl && draft.name && !nameEl.value) nameEl.value = draft.name;
        if (pointsEl && draft.points && !pointsEl.value) pointsEl.value = draft.points;
        if (kwEl && draft.keywords && !kwEl.value) kwEl.value = draft.keywords;
        if (regionEl && draft.region && !regionEl.value) regionEl.value = draft.region;
        if (langEl && draft.language && !langEl.value) langEl.value = draft.language;
        if (styleEl && draft.style && !styleEl.value) styleEl.value = draft.style;
    } catch (e) {}
}

function clearListingDraft() {
    if (typeof localStorage === 'undefined' || typeof document === 'undefined') return;
    try {
        localStorage.removeItem(LISTING_DRAFT_KEY);
    } catch (e) {}
    const nameEl = document.getElementById('listingName');
    const pointsEl = document.getElementById('listingPoints');
    const kwEl = document.getElementById('listingKeywords');
    if (nameEl) nameEl.value = '';
    if (pointsEl) pointsEl.value = '';
    if (kwEl) kwEl.value = '';
    if (typeof showToast === 'function') showToast('已清空 Listing 输入草稿', 'info');
}

function initListingDraftSync() {
    if (typeof document === 'undefined') return;
    ['listingName', 'listingPoints', 'listingKeywords'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', saveListingDraft);
    });
    ['listingRegionSelect', 'listingLanguageSelect', 'listingStyleSelect'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', saveListingDraft);
    });
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    const initListingFeatures = () => {
        restoreListingDraft();
        initListingDraftSync();
        updateListingHistoryBadge();
        const savedEmoji = typeof localStorage !== 'undefined' && localStorage.getItem('listing_include_emoji') === 'true';
        onListingEmojiToggleChange(savedEmoji);
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initListingFeatures);
    } else {
        initListingFeatures();
    }
    document.addEventListener('click', (e) => {
        const container = document.getElementById('listingTitleRegenMenuContainer');
        if (container && typeof container.contains === 'function' && !container.contains(e.target)) {
            hideAllSectionRegenMenus();
        }
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        cleanSearchText,
        replaceFirstStringValue,
        applySuggestionByField,
        applyComplianceSuggestion,
        applyAllComplianceSuggestions,
        markSuggestionApplied,
        getCurrentComplianceSuggestions,
        getCurrentListingData,
        setCurrentListingData,
        getCurrentListingViewMode,
        setListingViewMode,
        getListingUploadedBase64,
        setListingUploadedBase64,
        getUtf8ByteLength,
        cleanAndDeduplicateSearchTerms,
        adoptTitleAlternative,
        copySingleBullet,
        copyAllListingText,
        exportListingToFile,
        restoreListingFullState,
        optimizeListingSearchTerms,
        copyListingSearchTerms,
        ingestListingImageFile,
        handleListingImagePaste,
        handleListingImageDrop,
        aiFillListingInputs,
        toggleListingCopyDropdown,
        toggleListingExportDropdown,
        hideListingDropdowns,
        removeListingSearchTermsRiskWords,
        detectSearchTermsRiskWords,
        updateSearchTermsCounter,
        LISTING_AMAZON_RISK_TERMS,
        clearListingDraft,
        transferListingToDetails,
        transferListingToAds,
        insertListingFactSlot,
        toggleListingAdvancedConfig,
        toggleListingTitleRegenMenu,
        hideAllSectionRegenMenus,
        triggerSectionRegeneration,
        triggerBulletRegeneration,
        regenerateListingSection,
        applyRegeneratedSection,
        stageRegeneratedSection,
        acceptRegeneratedSection,
        dismissRegeneratedSection,
        getPendingRegeneratedSection,
        renderListingTitleComparison,
        pendingListingRegenerations,
        saveCurrentListingToHistory,
        updateListingHistoryBadge,
        loadListingHistoryDrawerList,
        toggleListingHistoryDrawer,
        onListingEmojiToggleChange,
        buildListingDtcHtml,
        openListingDtcHtmlModal,
        closeListingDtcHtmlModal,
        setListingDtcHtmlViewport,
        setListingDtcHtmlTab,
        setListingDtcHtmlLangMode,
        copyListingDtcHtml,
        copyListingDtcHtmlQuick,
        exportListingDtcHtmlFile,
        escapeListingHtml
    };
}
if (typeof window !== 'undefined') {
    window.removeListingSearchTermsRiskWords = removeListingSearchTermsRiskWords;
    window.detectSearchTermsRiskWords = detectSearchTermsRiskWords;
    window.updateSearchTermsCounter = updateSearchTermsCounter;
    window.clearListingDraft = clearListingDraft;
    window.transferListingToDetails = transferListingToDetails;
    window.transferListingToAds = transferListingToAds;
    window.onListingEmojiToggleChange = onListingEmojiToggleChange;
    window.buildListingDtcHtml = buildListingDtcHtml;
    window.openListingDtcHtmlModal = openListingDtcHtmlModal;
    window.closeListingDtcHtmlModal = closeListingDtcHtmlModal;
    window.setListingDtcHtmlViewport = setListingDtcHtmlViewport;
    window.setListingDtcHtmlTab = setListingDtcHtmlTab;
    window.setListingDtcHtmlLangMode = setListingDtcHtmlLangMode;
    window.copyListingDtcHtml = copyListingDtcHtml;
    window.copyListingDtcHtmlQuick = copyListingDtcHtmlQuick;
    window.exportListingDtcHtmlFile = exportListingDtcHtmlFile;
}
