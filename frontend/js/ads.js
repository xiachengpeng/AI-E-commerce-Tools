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
let currentAdsPlatformFilter = 'all';
let currentAdsStyleFilter = 'all';

const ADS_PLATFORM_FILTERS = [
    { value: 'facebook', label: 'Facebook' },
    { value: 'google', label: 'Google' },
    { value: 'pinterest', label: 'Pinterest PIN' },
];

const ADS_RESULT_LABELS = Object.freeze({
    product: '产品 / Product',
    productName: '产品名称 / Name',
    productSummary: '产品概述 / Summary',
    facebook: 'Facebook 广告 / Facebook Ads',
    facebookPrimaryText: '主文案 / Primary Text',
    facebookHeadline: '标题 / Headline',
    facebookDescription: '描述 / Description',
    facebookCta: '行动按钮 / CTA',
    facebookCreativeDirection: '创意方向 / Creative Direction',
    google: 'Google 广告 / Google Ads',
    googleHeadlines: '标题 / Headlines',
    googleDescriptions: '描述 / Descriptions',
    googleKeywords: '关键词 / Keywords',
    googleSitelinks: '附加链接 / Sitelinks',
    pinterest: 'Pinterest PIN',
    pinterestTitle: '标题 / Title',
    pinterestDescription: '描述 / Description',
    pinterestAltText: '替代文本 / Alt Text',
});

function adsStyles(data) {
    const styles = Array.isArray(data?.styles) ? data.styles : [];
    return styles.filter(style => style && typeof style === 'object' && !Array.isArray(style));
}

function adsStyleKey(style, index) {
    return String(style?.id || style?.styleId || `style-index-${index}`);
}

function availableAdsPlatforms(data) {
    const styles = adsStyles(data);
    return ADS_PLATFORM_FILTERS
        .map(item => item.value)
        .filter(platform => styles.some(style => Boolean(style?.[platform])));
}

function adsTextPair(value) {
    if (typeof value === 'string') return { target: value, zh: '' };
    return {
        target: value?.target || value?.English || value?.english || value?.text || value?.copy || value?.keyword || '',
        zh: value?.zh || value?.Chinese || value?.chinese || value?.cn || value?.translation || value?.translation_zh || ''
    };
}

function pinterestDescriptionWithTags(pinterest) {
    const description = adsTextPair(pinterest?.description);
    const tags = Array.isArray(pinterest?.tags) ? pinterest.tags : [];
    const targetTags = tags.map(item => adsTextPair(item).target).filter(Boolean).join('');
    const zhTags = tags.map(item => adsTextPair(item).zh).filter(Boolean).join('');
    return {
        target: `${description.target}${targetTags}`,
        zh: `${description.zh}${zhTags}`,
    };
}

function initAdsControls() {
    const regionSelect = document.getElementById('adsRegionSelect');
    const languageSelect = document.getElementById('adsLanguageSelect');
    const styleFilter = document.getElementById('adsStyleFilter');
    if (styleFilter && !styleFilter.dataset.adsFilterListenerBound) {
        styleFilter.addEventListener('change', event => setAdsStyleFilter(event.target.value));
        styleFilter.dataset.adsFilterListenerBound = 'true';
    }
    if (regionSelect && languageSelect) {
        regionSelect.addEventListener('change', syncAdsLanguageToRegion);
        syncAdsLanguageToRegion();
    }
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
        body: JSON.stringify(payload)
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

function copyAdsStyleText(style, platformFilter = 'all') {
    const lines = [];
    const pushPair = (label, value) => {
        const pair = adsTextPair(value);
        if (pair.target || pair.zh) lines.push(`${label}: ${pair.target}${pair.zh ? `\n中文: ${pair.zh}` : ''}`);
    };
    const name = adsTextPair(style.name);
    lines.push(`${name.target}${name.zh ? ` / ${name.zh}` : ''}`);
    pushPair('Logic', style.logic);
    if (style.facebook && ['all', 'facebook'].includes(platformFilter)) {
        lines.push('\n[Facebook]');
        pushPair('Primary Text', style.facebook.primaryText);
        pushPair('Headline', style.facebook.headline);
        pushPair('Description', style.facebook.description);
        pushPair('CTA', style.facebook.cta);
        pushPair('Creative Direction', style.facebook.creativeDirection);
    }
    if (style.google && ['all', 'google'].includes(platformFilter)) {
        lines.push('\n[Google]');
        ['headlines', 'descriptions', 'keywords', 'sitelinks'].forEach(key => {
            (style.google[key] || []).forEach((item, index) => pushPair(`${key} ${index + 1}`, item));
        });
    }
    if (style.pinterest && ['all', 'pinterest'].includes(platformFilter)) {
        const pin = style.pinterest;
        const description = pinterestDescriptionWithTags(pin);
        lines.push('\n[Pinterest PIN]');
        lines.push(`Title: ${pin.title?.target || ''}`);
        lines.push(`标题: ${pin.title?.zh || ''}`);
        lines.push(`Description: ${description.target}`);
        lines.push(`描述: ${description.zh}`);
        lines.push(`Alt Text: ${pin.altText?.target || ''}`);
        lines.push(`替代文本: ${pin.altText?.zh || ''}`);
    }
    navigator.clipboard.writeText(lines.join('\n')).then(
        () => showToast('已复制该风格文案', 'success'),
        () => showToast('复制失败', 'error')
    );
}

function resetAdsFilters(data) {
    const available = availableAdsPlatforms(data);
    currentAdsPlatformFilter = available[0] || 'all';
    currentAdsStyleFilter = 'all';
}

function resetAdsResultFilters() {
    resetAdsFilters(currentAdsData);
    renderAdsFilterControls();
    renderFilteredAdsResults();
}

function renderAdsFilterControls({ restorePlatformFocus = false } = {}) {
    const filters = document.getElementById('adsFilters');
    const platformFilters = document.getElementById('adsPlatformFilters');
    const styleFilter = document.getElementById('adsStyleFilter');
    const styles = adsStyles(currentAdsData);

    filters?.classList.remove('hidden');

    if (platformFilters) {
        const shouldRestorePlatformFocus = restorePlatformFocus
            && Array.from(platformFilters.children).includes(document.activeElement);
        platformFilters.replaceChildren();
        const platformButtons = [
            { value: 'all', label: '全部平台' },
            ...ADS_PLATFORM_FILTERS.filter(platform => availableAdsPlatforms(currentAdsData).includes(platform.value)),
        ];
        const activeClasses = {
            all: 'bg-orange-600 border-orange-600 text-white',
            facebook: 'bg-blue-600 border-blue-600 text-white',
            google: 'bg-emerald-600 border-emerald-600 text-white',
            pinterest: 'bg-red-600 border-red-600 text-white',
        };
        const baseClasses = 'border px-3 py-1.5 rounded-full text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2';
        const inactiveClasses = 'border-gray-200 bg-white text-gray-600 hover:border-gray-300';
        let activeButton = null;
        platformButtons.forEach(platform => {
            const button = document.createElement('button');
            const isActive = currentAdsPlatformFilter === platform.value;
            button.type = 'button';
            button.textContent = platform.label;
            button.setAttribute('aria-pressed', String(isActive));
            button.className = `${baseClasses} ${isActive ? activeClasses[platform.value] : inactiveClasses}`;
            button.addEventListener('click', () => {
                setAdsPlatformFilter(platform.value, { restoreFocus: true });
            });
            if (isActive) activeButton = button;
            platformFilters.appendChild(button);
        });
        if (shouldRestorePlatformFocus) activeButton?.focus();
    }

    if (styleFilter) {
        styleFilter.replaceChildren();
        const allOption = document.createElement('option');
        allOption.value = 'all';
        allOption.textContent = '全部创意角度';
        styleFilter.appendChild(allOption);
        styles.forEach((style, index) => {
            const option = document.createElement('option');
            const key = adsStyleKey(style, index);
            const name = adsTextPair(style?.name);
            option.value = key;
            option.textContent = name.zh || name.target || key;
            styleFilter.appendChild(option);
        });
        styleFilter.value = currentAdsStyleFilter;
    }
}

function setAdsPlatformFilter(value, { restoreFocus = false } = {}) {
    const allowed = new Set(['all', ...availableAdsPlatforms(currentAdsData)]);
    currentAdsPlatformFilter = allowed.has(value) ? value : 'all';
    renderAdsFilterControls({ restorePlatformFocus: restoreFocus });
    renderFilteredAdsResults();
}

function setAdsStyleFilter(value) {
    const styles = adsStyles(currentAdsData);
    const allowed = new Set(['all', ...styles.map((style, index) => adsStyleKey(style, index))]);
    currentAdsStyleFilter = allowed.has(value) ? value : 'all';
    renderAdsFilterControls();
    renderFilteredAdsResults();
}

function renderAdsData(data) {
    currentAdsData = data || null;
    resetAdsFilters(currentAdsData);
    renderAdsFilterControls();
    renderFilteredAdsResults();
}

function renderFilteredAdsResults() {
    const scrollPane = document.getElementById('adsResultsScroll');
    const previousScrollTop = scrollPane?.scrollTop || 0;
    const data = currentAdsData || {};
    const styles = adsStyles(data);
    document.getElementById('adsEmpty').classList.add('hidden');
    const container = document.getElementById('adsResults');
    container.textContent = '';
    container.classList.remove('hidden');
    container.classList.add('flex');

    const product = data.product || {};
    const productBlock = document.createElement('div');
    productBlock.className = 'bg-white rounded-2xl shadow-sm border border-gray-200 p-5';
    appendAdsText(productBlock, 'text-xs font-black text-orange-600 uppercase mb-2', ADS_RESULT_LABELS.product);
    appendAdsPair(productBlock, ADS_RESULT_LABELS.productName, product.name);
    appendAdsPair(productBlock, ADS_RESULT_LABELS.productSummary, product.summary);
    container.appendChild(productBlock);

    const filteredStyles = styles.filter((style, index) => {
        const styleMatches = currentAdsStyleFilter === 'all'
            || adsStyleKey(style, index) === currentAdsStyleFilter;
        const platformMatches = currentAdsPlatformFilter === 'all'
            || Boolean(style?.[currentAdsPlatformFilter]);
        return styleMatches && platformMatches;
    });

    filteredStyles.forEach(style => {
        const card = document.createElement('div');
        card.className = 'bg-white rounded-2xl shadow-sm border border-gray-200 p-5';
        const header = document.createElement('div');
        header.className = 'flex items-start justify-between gap-3 mb-4';
        const titleWrap = document.createElement('div');
        const name = adsTextPair(style.name);
        const title = document.createElement('div');
        title.className = 'text-base font-black text-gray-900';
        if (name.zh) {
            const zhName = document.createElement('span');
            zhName.textContent = name.zh;
            title.appendChild(zhName);
            if (name.target) {
                const opening = document.createElement('span');
                opening.textContent = ' (';
                const targetName = document.createElement('span');
                targetName.textContent = name.target;
                const closing = document.createElement('span');
                closing.textContent = ')';
                title.append(opening, targetName, closing);
            }
        } else {
            title.textContent = name.target;
        }
        titleWrap.appendChild(title);
        const logic = adsTextPair(style.logic);
        appendAdsText(titleWrap, 'text-xs text-gray-500 mt-1', logic.zh || logic.target);
        const copyBtn = document.createElement('button');
        copyBtn.className = 'text-xs bg-gray-100 hover:bg-orange-100 text-gray-500 hover:text-orange-600 px-2 py-1 rounded font-bold transition-colors flex items-center gap-1';
        copyBtn.textContent = '复制';
        const platformForCopy = currentAdsPlatformFilter;
        copyBtn.addEventListener('click', () => copyAdsStyleText(style, platformForCopy));
        header.append(titleWrap, copyBtn);
        card.appendChild(header);

        const showFacebook = style.facebook && ['all', 'facebook'].includes(currentAdsPlatformFilter);
        const showGoogle = style.google && ['all', 'google'].includes(currentAdsPlatformFilter);
        const showPinterest = style.pinterest && ['all', 'pinterest'].includes(currentAdsPlatformFilter);

        if (showFacebook) {
            appendAdsText(card, 'text-sm font-black text-blue-700 mt-2 mb-3', ADS_RESULT_LABELS.facebook);
            const grid = document.createElement('div');
            grid.className = 'grid grid-cols-1 md:grid-cols-2 gap-3';
            appendAdsPair(grid, ADS_RESULT_LABELS.facebookPrimaryText, style.facebook.primaryText);
            appendAdsPair(grid, ADS_RESULT_LABELS.facebookHeadline, style.facebook.headline);
            appendAdsPair(grid, ADS_RESULT_LABELS.facebookDescription, style.facebook.description);
            appendAdsPair(grid, ADS_RESULT_LABELS.facebookCta, style.facebook.cta);
            appendAdsPair(grid, ADS_RESULT_LABELS.facebookCreativeDirection, style.facebook.creativeDirection);
            card.appendChild(grid);
        }

        if (showGoogle) {
            appendAdsText(card, 'text-sm font-black text-emerald-700 mt-5 mb-3', ADS_RESULT_LABELS.google);
            const grid = document.createElement('div');
            grid.className = 'grid grid-cols-1 md:grid-cols-2 gap-3';
            appendAdsPairList(grid, ADS_RESULT_LABELS.googleHeadlines, style.google.headlines);
            appendAdsPairList(grid, ADS_RESULT_LABELS.googleDescriptions, style.google.descriptions);
            appendAdsPairList(grid, ADS_RESULT_LABELS.googleKeywords, style.google.keywords);
            appendAdsPairList(grid, ADS_RESULT_LABELS.googleSitelinks, style.google.sitelinks);
            card.appendChild(grid);
        }

        if (showPinterest) {
            const pinterest = style.pinterest;
            const heading = document.createElement('h5');
            heading.className = 'text-sm font-black text-red-700 mt-5 mb-3';
            heading.textContent = ADS_RESULT_LABELS.pinterest;
            card.appendChild(heading);
            const grid = document.createElement('div');
            grid.className = 'grid grid-cols-1 md:grid-cols-2 gap-3';
            appendAdsPair(grid, ADS_RESULT_LABELS.pinterestTitle, pinterest.title);
            appendAdsPair(grid, ADS_RESULT_LABELS.pinterestDescription, pinterestDescriptionWithTags(pinterest));
            appendAdsPair(grid, ADS_RESULT_LABELS.pinterestAltText, pinterest.altText);
            card.appendChild(grid);
        }

        container.appendChild(card);
    });

    if (filteredStyles.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'bg-white rounded-2xl border border-dashed border-gray-300 p-10 text-center';
        appendAdsText(empty, 'text-sm font-bold text-gray-500', '当前筛选条件下没有结果');
        const resetButton = document.createElement('button');
        resetButton.type = 'button';
        resetButton.className = 'mt-4 px-4 py-2 rounded-lg bg-orange-50 text-orange-600 text-xs font-bold hover:bg-orange-100 focus-visible:ring-2 focus-visible:ring-orange-400';
        resetButton.textContent = '重置筛选';
        resetButton.addEventListener('click', resetAdsResultFilters);
        empty.appendChild(resetButton);
        container.appendChild(empty);
    }

    if (scrollPane) scrollPane.scrollTop = previousScrollTop;
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
    const productName = document.getElementById('adsProductNameInput')?.value.trim() || '';
    const btn = document.getElementById('btnGenerateAds');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="loader w-4 h-4 mr-2 border-2 border-white border-t-transparent"></span> 生成中...';
    btn.disabled = true;

    try {
        const payload = {
            image_data: currentAdsUploadedBase64,
            platforms,
            region: regionOpt.options[regionOpt.selectedIndex].value,
            target_language: languageOpt.options[languageOpt.selectedIndex].value,
            marketing_theme: themeOpt.value,
            marketing_theme_label: themeOpt.options[themeOpt.selectedIndex].text
        };
        if (productName) payload.product_name = productName;
        const data = await postAdsApi(payload);
        renderAdsData(data);
        showToast('广告文案已生成', 'success');
    } catch (err) {
        showToast('广告文案生成失败: ' + err.message, 'error');
    } finally {
        btn.innerHTML = origHtml;
        btn.disabled = false;
    }
}
