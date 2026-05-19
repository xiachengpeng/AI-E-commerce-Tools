const ADS_REGION_LANGUAGE_MAP = {
    'US Market': 'English',
    'European Market': 'English',
    'UK Market': 'English',
    'Japan Market': 'Japanese',
    'Southeast Asia Market': 'English',
    'Middle East Market': 'English',
    'Australian Market': 'English',
    'Global Market': 'English'
};

let currentAdsUploadedBase64 = null;
let currentAdsData = null;

function adsTextPair(value) {
    if (typeof value === 'string') return { target: value, zh: '' };
    return {
        target: value?.target || value?.English || value?.english || value?.text || value?.copy || value?.keyword || '',
        zh: value?.zh || value?.Chinese || value?.chinese || value?.cn || value?.translation || value?.translation_zh || ''
    };
}

function initAdsControls() {
    const regionSelect = document.getElementById('adsRegionSelect');
    const languageSelect = document.getElementById('adsLanguageSelect');
    if (!regionSelect || !languageSelect) return;
    regionSelect.addEventListener('change', syncAdsLanguageToRegion);
    syncAdsLanguageToRegion();
}

function syncAdsLanguageToRegion() {
    const regionSelect = document.getElementById('adsRegionSelect');
    const languageSelect = document.getElementById('adsLanguageSelect');
    if (!regionSelect || !languageSelect) return;
    const recommendedLanguage = ADS_REGION_LANGUAGE_MAP[regionSelect.value];
    const option = Array.from(languageSelect.options).find(item => item.value === recommendedLanguage);
    if (option) languageSelect.value = recommendedLanguage;
}

async function postAdsApi(payload) {
    const res = await fetch(`${API_BASE}/api/ads/generate`, {
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

function selectedAdsPlatforms() {
    return Array.from(document.querySelectorAll('.ads-platform-checkbox:checked')).map(item => item.value);
}

function handleAdsImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) {
        showToast('图片过大，请选择 6MB 以内的图片', 'error');
        event.target.value = '';
        return;
    }
    const reader = new FileReader();
    reader.onload = e => {
        currentAdsUploadedBase64 = e.target.result;
        document.getElementById('adsUploadedImagePreview').src = currentAdsUploadedBase64;
        document.getElementById('adsImagePreviewContainer').classList.remove('hidden');
    };
    reader.readAsDataURL(file);
}

function removeAdsImage() {
    currentAdsUploadedBase64 = null;
    document.getElementById('adsImageUpload').value = '';
    document.getElementById('adsImagePreviewContainer').classList.add('hidden');
}

function appendAdsText(parent, className, text) {
    const el = document.createElement('div');
    el.className = className;
    el.textContent = text || '';
    parent.appendChild(el);
    return el;
}

function appendAdsPair(parent, label, value) {
    const pair = adsTextPair(value);
    const block = document.createElement('div');
    block.className = 'rounded-lg border border-gray-100 bg-gray-50/80 p-3';
    appendAdsText(block, 'text-[10px] font-black text-gray-400 uppercase mb-1', label);
    appendAdsText(block, 'target-text text-sm text-gray-800 whitespace-pre-wrap', pair.target);
    appendAdsText(block, 'zh-text text-xs text-gray-400 mt-2 border-t border-gray-200/70 pt-2 whitespace-pre-wrap', pair.zh);
    parent.appendChild(block);
}

function appendAdsPairList(parent, label, values) {
    const block = document.createElement('div');
    block.className = 'rounded-lg border border-gray-100 bg-gray-50/80 p-3';
    appendAdsText(block, 'text-[10px] font-black text-gray-400 uppercase mb-2', label);
    const list = document.createElement('div');
    list.className = 'space-y-2';
    (values || []).forEach(value => {
        const pair = adsTextPair(value);
        const item = document.createElement('div');
        appendAdsText(item, 'target-text text-sm text-gray-800', pair.target);
        appendAdsText(item, 'zh-text text-xs text-gray-400', pair.zh);
        list.appendChild(item);
    });
    if (!list.children.length) appendAdsText(list, 'text-xs text-gray-400', '-');
    block.appendChild(list);
    parent.appendChild(block);
}

function copyAdsStyleText(style) {
    const lines = [];
    const pushPair = (label, value) => {
        const pair = adsTextPair(value);
        if (pair.target || pair.zh) lines.push(`${label}: ${pair.target}${pair.zh ? `\n中文: ${pair.zh}` : ''}`);
    };
    const name = adsTextPair(style.name);
    lines.push(`${name.target}${name.zh ? ` / ${name.zh}` : ''}`);
    pushPair('Logic', style.logic);
    if (style.facebook) {
        lines.push('\n[Facebook]');
        pushPair('Primary Text', style.facebook.primaryText);
        pushPair('Headline', style.facebook.headline);
        pushPair('Description', style.facebook.description);
        pushPair('CTA', style.facebook.cta);
        pushPair('Creative Direction', style.facebook.creativeDirection);
    }
    if (style.google) {
        lines.push('\n[Google]');
        ['headlines', 'descriptions', 'keywords', 'sitelinks'].forEach(key => {
            (style.google[key] || []).forEach((item, index) => pushPair(`${key} ${index + 1}`, item));
        });
    }
    navigator.clipboard.writeText(lines.join('\n')).then(
        () => showToast('已复制该风格文案', 'success'),
        () => showToast('复制失败', 'error')
    );
}

function renderAdsData(data) {
    currentAdsData = data || null;
    document.getElementById('adsEmpty').classList.add('hidden');
    const container = document.getElementById('adsResults');
    container.textContent = '';
    container.classList.remove('hidden');
    container.classList.add('flex');

    const product = data?.product || {};
    const productBlock = document.createElement('div');
    productBlock.className = 'bg-white rounded-2xl shadow-sm border border-gray-200 p-5';
    appendAdsText(productBlock, 'text-xs font-black text-orange-600 uppercase mb-2', 'Product');
    appendAdsPair(productBlock, 'Name', product.name);
    appendAdsPair(productBlock, 'Summary', product.summary);
    container.appendChild(productBlock);

    (data?.styles || []).forEach(style => {
        const card = document.createElement('div');
        card.className = 'bg-white rounded-2xl shadow-sm border border-gray-200 p-5';
        const header = document.createElement('div');
        header.className = 'flex items-start justify-between gap-3 mb-4';
        const titleWrap = document.createElement('div');
        const name = adsTextPair(style.name);
        appendAdsText(titleWrap, 'text-base font-black text-gray-900', `${name.zh || ''} ${name.target ? `(${name.target})` : ''}`.trim());
        const logic = adsTextPair(style.logic);
        appendAdsText(titleWrap, 'text-xs text-gray-500 mt-1', logic.zh || logic.target);
        const copyBtn = document.createElement('button');
        copyBtn.className = 'text-xs bg-gray-100 hover:bg-orange-100 text-gray-500 hover:text-orange-600 px-2 py-1 rounded font-bold transition-colors flex items-center gap-1';
        copyBtn.innerHTML = '<i class="ph ph-copy"></i> 复制';
        copyBtn.addEventListener('click', () => copyAdsStyleText(style));
        header.append(titleWrap, copyBtn);
        card.appendChild(header);

        if (style.facebook) {
            appendAdsText(card, 'text-sm font-black text-blue-700 mt-2 mb-3', 'Facebook Ads');
            const grid = document.createElement('div');
            grid.className = 'grid grid-cols-1 md:grid-cols-2 gap-3';
            appendAdsPair(grid, 'Primary Text', style.facebook.primaryText);
            appendAdsPair(grid, 'Headline', style.facebook.headline);
            appendAdsPair(grid, 'Description', style.facebook.description);
            appendAdsPair(grid, 'CTA', style.facebook.cta);
            appendAdsPair(grid, 'Creative Direction', style.facebook.creativeDirection);
            card.appendChild(grid);
        }

        if (style.google) {
            appendAdsText(card, 'text-sm font-black text-emerald-700 mt-5 mb-3', 'Google Ads');
            const grid = document.createElement('div');
            grid.className = 'grid grid-cols-1 md:grid-cols-2 gap-3';
            appendAdsPairList(grid, 'Headlines', style.google.headlines);
            appendAdsPairList(grid, 'Descriptions', style.google.descriptions);
            appendAdsPairList(grid, 'Keywords', style.google.keywords);
            appendAdsPairList(grid, 'Sitelinks', style.google.sitelinks);
            card.appendChild(grid);
        }

        container.appendChild(card);
    });
}

async function generateAdsCopy() {
    if (!currentAdsUploadedBase64) {
        showToast('请先上传商品图片', 'error');
        return;
    }
    const platforms = selectedAdsPlatforms();
    if (!platforms.length) {
        showToast('请至少选择一个广告类型', 'error');
        return;
    }

    const regionOpt = document.getElementById('adsRegionSelect');
    const languageOpt = document.getElementById('adsLanguageSelect');
    const themeOpt = document.getElementById('adsMarketingThemeSelect');
    const btn = document.getElementById('btnGenerateAds');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="loader w-4 h-4 mr-2 border-2 border-white border-t-transparent"></span> 生成中...';
    btn.disabled = true;

    try {
        const data = await postAdsApi({
            image_data: currentAdsUploadedBase64,
            platforms,
            region: regionOpt.options[regionOpt.selectedIndex].value,
            target_language: languageOpt.options[languageOpt.selectedIndex].value,
            marketing_theme: themeOpt.value,
            marketing_theme_label: themeOpt.options[themeOpt.selectedIndex].text
        });
        renderAdsData(data);
    } catch (err) {
        showToast('广告文案生成失败: ' + err.message, 'error');
    } finally {
        btn.innerHTML = origHtml;
        btn.disabled = false;
    }
}
