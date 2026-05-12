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
    'European Market': 'English',
    'UK Market': 'English',
    'Japan Market': 'Japanese',
    'Southeast Asia Market': 'English',
    'Middle East Market': 'English',
    'Australian Market': 'English',
    'Global Market': 'English'
};

let currentComplianceSuggestions = [];

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
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, ai_provider: AI_PROVIDER })
    });
    const data = await res.json();
    if (data.status !== 'success') {
        throw new Error(data.message || '请求失败');
    }
    return data.data;
}

function getSelectedListingPlatform() {
    const styleOpt = document.getElementById('listingStyleSelect');
    return styleOpt?.options[styleOpt.selectedIndex]?.value || '';
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
        showToast('请先上传产品参考图，AI 才能进行视觉解析', 'error');
        return;
    }

    const btn = document.getElementById('aiListingExtractBtn');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="loader w-3 h-3 border-2 border-indigo-500 border-t-transparent mr-1"></span> 提取中...';
    btn.disabled = true;

    try {
        const data = await postListingApi('/api/listing/extract', {
            image_data: currentListingUploadedBase64
        });
        document.getElementById('listingName').value = data.name || '';
        document.getElementById('listingPoints').value = data.points || '';
        const keywordsInput = document.getElementById('listingKeywords');
        if (keywordsInput && !keywordsInput.value.trim() && data.keywords) {
            keywordsInput.value = data.keywords;
        }
        showToast('产品特征视觉提取成功', 'success');
    } catch (err) {
        showToast('智能提取失败: ' + err.message, 'error');
    } finally {
        btn.innerHTML = origHtml;
        btn.disabled = false;
    }
}

function renderListingData(data) {
    currentListingDataText = data || null;
    document.getElementById('listingEmpty').classList.add('hidden');
    const resArea = document.getElementById('listingResults');
    resArea.classList.remove('hidden');
    resArea.classList.add('flex');
    document.getElementById('btnRiskCheck').classList.remove('hidden');

    renderListingPair(
        'resListingTitle',
        data?.title,
        'target-text text-gray-800 text-lg mb-2',
        'zh-text text-sm text-gray-400 pt-2 border-t border-gray-100 font-normal'
    );

    renderListingPair(
        'resListingDesc',
        data?.description,
        'target-text text-gray-700 whitespace-pre-wrap',
        'zh-text text-sm text-gray-400 mt-4 pt-4 border-t border-gray-100 whitespace-pre-wrap'
    );

    const bullets = document.getElementById('resListingBullets');
    bullets.textContent = '';
    (data?.bullets || []).forEach(item => {
        const pair = listingTextPair(item);
        const li = document.createElement('li');
        li.className = 'mb-4 bg-gray-50/80 p-3.5 rounded-xl border border-gray-100';
        appendTextBlock(li, 'target-text font-bold text-gray-700 text-sm', pair.target);
        appendTextBlock(li, 'zh-text text-xs text-gray-400 mt-2 border-t border-gray-200/60 pt-2', pair.zh);
        bullets.appendChild(li);
    });

    const renderKeywords = (containerId, items) => {
        const container = document.getElementById(containerId);
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

    const qaContainer = document.getElementById('resListingQA');
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

    renderListingPair(
        'resListingSocial',
        data?.socialMedia || data?.social_script || data?.social,
        'target-text text-gray-700 whitespace-pre-wrap',
        'zh-text text-sm text-gray-400 mt-4 pt-4 border-t border-gray-200 whitespace-pre-wrap'
    );

    renderListingRuleWarnings(data, getSelectedListingPlatform());
}

async function generateListing() {
    const name = document.getElementById('listingName').value.trim();
    const points = document.getElementById('listingPoints').value.trim();
    const keywords = document.getElementById('listingKeywords').value.trim();

    const styleOpt = document.getElementById('listingStyleSelect');
    const style = styleOpt.options[styleOpt.selectedIndex].value;

    const regionOpt = document.getElementById('listingRegionSelect');
    const region = regionOpt.options[regionOpt.selectedIndex].value;

    const languageOpt = document.getElementById('listingLanguageSelect');
    const targetLanguage = languageOpt.options[languageOpt.selectedIndex].value;

    const themeOpt = document.getElementById('listingMarketingThemeSelect');
    const themeVal = themeOpt.value;
    const themeLabel = themeOpt.options[themeOpt.selectedIndex].text;

    if (!name || !points) {
        showToast('请填写必填项：产品名称与核心卖点', 'error');
        return;
    }

    const btn = document.getElementById('btnGenerateListing');
    const origBtnHtml = btn.innerHTML;
    btn.innerHTML = '<span class="loader w-4 h-4 mr-2 border-2 border-white border-t-transparent"></span> 语境适配演算中...';
    btn.disabled = true;

    try {
        const data = await postListingApi('/api/listing/generate', {
            name,
            points,
            keywords,
            platform: style,
            region,
            target_language: targetLanguage,
            marketing_theme: themeVal,
            marketing_theme_label: themeLabel
        });
        renderListingData(data);

        saveToHistory('listing', {
            name,
            platform: styleOpt.options[styleOpt.selectedIndex].text,
            target_lang: targetLanguage,
            result: data
        });
    } catch (err) {
        console.error(err);
        showToast('Listing 生成失败: ' + err.message, 'error');
    } finally {
        btn.innerHTML = origBtnHtml;
        btn.disabled = false;
    }
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
        appendTextBlock(container, 'font-bold text-emerald-700 mt-4 mb-2', '修改建议');
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
                btn.className = 'mt-2 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition-colors';
                btn.textContent = '应用建议';
                btn.addEventListener('click', () => applyComplianceSuggestion(index));
                block.appendChild(btn);
            }
            list.appendChild(block);
        });
        container.appendChild(list);
    }
}

function replaceFirstStringValue(value, findText, replaceText) {
    if (typeof value === 'string') {
        if (findText && value.includes(findText)) {
            return { value: value.replace(findText, replaceText), replaced: true };
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

function applySuggestionByField(data, field, suggestedText) {
    const next = structuredClone(data);
    if (field === 'title') {
        next.title = { ...listingTextPair(next.title), target: suggestedText };
        return { value: next, replaced: true };
    }
    if (field === 'description') {
        next.description = { ...listingTextPair(next.description), target: suggestedText };
        return { value: next, replaced: true };
    }
    if (field === 'socialMedia') {
        next.socialMedia = { ...listingTextPair(next.socialMedia), target: suggestedText };
        return { value: next, replaced: true };
    }
    return { value: data, replaced: false };
}

function applyComplianceSuggestion(index) {
    const suggestion = currentComplianceSuggestions[index];
    if (!suggestion?.suggested_text || !currentListingDataText) {
        showToast('这条建议没有可直接替换的文案', 'warning');
        return;
    }

    let result = { value: currentListingDataText, replaced: false };
    if (suggestion.current_text) {
        result = replaceFirstStringValue(currentListingDataText, suggestion.current_text, suggestion.suggested_text);
    }
    if (!result.replaced && suggestion.field) {
        result = applySuggestionByField(currentListingDataText, suggestion.field, suggestion.suggested_text);
    }

    if (!result.replaced) {
        showToast('未找到可替换的原文，请手动参考建议调整', 'warning');
        return;
    }

    renderListingData(result.value);
    showToast('已应用合规建议', 'success');
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

function handleListingImageUpload(event) {
    const file = event.target.files[0];
    if (file) {
        if (file.size > 6 * 1024 * 1024) {
            showToast('图片过大，请选择 6MB 以内的图片', 'error');
            event.target.value = '';
            return;
        }
        const reader = new FileReader();
        reader.onload = e => {
            currentListingUploadedBase64 = e.target.result;
            document.getElementById('listingUploadedImagePreview').src = currentListingUploadedBase64;
            document.getElementById('listingImagePreviewContainer').classList.remove('hidden');
        };
        reader.readAsDataURL(file);
    }
}

function removeListingImage() {
    currentListingUploadedBase64 = null;
    document.getElementById('listingImageUpload').value = '';
    document.getElementById('listingImagePreviewContainer').classList.add('hidden');
}
