
// ====== 详情页模块配置逻辑 ======
const DETAIL_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const DETAIL_MAX_TASKS = 24;
const DETAIL_MAX_UPLOAD_IMAGES = 6;
let currentStrategyPreviewContext = null;
var globalGenContext = (typeof globalThis !== 'undefined' && globalThis.globalGenContext) ? globalThis.globalGenContext : null;

// 详情页制作模式：'hybrid' (DTC 独立站图文穿插) | 'images' (经典电商图集/长图)
let currentDetailPresentationMode = 'hybrid';
let currentDtcViewport = 'desktop'; // 'desktop' | 'mobile'
let currentDetailResultView = 'hybrid'; // 'hybrid' | 'gallery'
let currentDtcLayoutStyle = 'editorial'; // 'editorial' | 'minimalist' | 'bento' | 'lookbook' | 'technical'
let currentDtcBrandColor = 'indigo'; // 'indigo' | 'orange' | 'emerald' | 'rose' | 'cyan' | 'slate' | 'amber' | 'custom'
let currentDtcCustomColorHex = '#4f46e5';
let currentDtcTrustBarEnabled = true;

// DTC 字体与排版状态配置
let currentDtcTypography = {
    templateId: 'modern',
    fontFamily: 'inter',
    titleFont: 'inherit',
    titleSize: '28px',
    titleWeight: '700',
    titleSpacing: '-0.02em',
    subtitleSize: '18px',
    subtitleWeight: '600',
    bodySize: '14px',
    bodyWeight: '400',
    bodyLineHeight: '1.6'
};

// 长图排版高级定制参数
let currentLongImageGap = 0;
let currentLongImageRadius = 0;
let currentLongImageBgColor = '#ffffff';

// 动态计算自定义品牌主色的色阶系统 (Light 背景、Border 边框、深色 Text)
function computeCustomBrandColor(hexColor) {
    if (!hexColor || typeof hexColor !== 'string') hexColor = '#4f46e5';
    hexColor = hexColor.trim();
    if (!hexColor.startsWith('#')) hexColor = '#' + hexColor;
    if (!/^#[0-9a-fA-F]{6}$/i.test(hexColor)) {
        if (/^#[0-9a-fA-F]{3}$/i.test(hexColor)) {
            hexColor = '#' + hexColor[1] + hexColor[1] + hexColor[2] + hexColor[2] + hexColor[3] + hexColor[3];
        } else {
            hexColor = '#4f46e5';
        }
    }
    hexColor = hexColor.toLowerCase();

    const r = parseInt(hexColor.slice(1, 3), 16);
    const g = parseInt(hexColor.slice(3, 5), 16);
    const b = parseInt(hexColor.slice(5, 7), 16);

    // Light 背景色：混合 93% 白色，产生柔和纯净的微背景
    const rLight = Math.round(r + (255 - r) * 0.93);
    const gLight = Math.round(g + (255 - g) * 0.93);
    const bLight = Math.round(b + (255 - b) * 0.93);
    const light = `rgb(${rLight}, ${gLight}, ${bLight})`;

    // Border 边框色：混合 75% 白色，保证细腻分割线可见性
    const rBorder = Math.round(r + (255 - r) * 0.75);
    const gBorder = Math.round(g + (255 - g) * 0.75);
    const bBorder = Math.round(b + (255 - b) * 0.75);
    const border = `rgb(${rBorder}, ${gBorder}, ${bBorder})`;

    // Text 高对比文本色：乘以 0.75 提高对比度
    const rText = Math.max(0, Math.round(r * 0.75));
    const gText = Math.max(0, Math.round(g * 0.75));
    const bText = Math.max(0, Math.round(b * 0.75));
    const text = `rgb(${rText}, ${gText}, ${bText})`;

    return {
        id: 'custom',
        name: `自定义 (${hexColor.toUpperCase()})`,
        primary: hexColor,
        light,
        border,
        text,
        desc: `自定义品牌主色 (${hexColor.toUpperCase()})`
    };
}

function getDtcBrandColorMap() {
    let baseMap = null;
    if (typeof DTC_BRAND_COLORS !== 'undefined') baseMap = DTC_BRAND_COLORS;
    else if (typeof window !== 'undefined' && window.DTC_BRAND_COLORS) baseMap = window.DTC_BRAND_COLORS;
    else if (typeof globalThis !== 'undefined' && globalThis.DTC_BRAND_COLORS) baseMap = globalThis.DTC_BRAND_COLORS;

    const map = baseMap ? { ...baseMap } : {};
    map.custom = computeCustomBrandColor(currentDtcCustomColorHex);
    return map;
}

function getDtcBrandColor() {
    return currentDtcBrandColor;
}

function setDtcBrandColor(colorKey, triggerRerender = true) {
    if (colorKey && typeof colorKey === 'string' && colorKey.startsWith('#')) {
        currentDtcCustomColorHex = colorKey;
        colorKey = 'custom';
    }

    const colorMap = getDtcBrandColorMap();
    if (colorMap && !colorMap[colorKey]) {
        colorKey = 'indigo';
    }
    currentDtcBrandColor = colorKey || 'indigo';
    if (typeof window !== 'undefined') {
        window.currentDtcBrandColor = currentDtcBrandColor;
        window.currentDtcCustomColorHex = currentDtcCustomColorHex;
    }

    const brandSelect = document.getElementById('dtcBrandColorSelect');
    if (brandSelect && brandSelect.value !== colorKey) {
        brandSelect.value = colorKey;
    }
    const resultSelect = document.getElementById('resultColorSelect');
    if (resultSelect && resultSelect.value !== colorKey) {
        resultSelect.value = colorKey;
    }

    const customPanel = document.getElementById('dtcCustomColorPanel');
    if (customPanel) {
        if (colorKey === 'custom') {
            customPanel.classList.remove('hidden');
        } else {
            customPanel.classList.add('hidden');
        }
    }
    const customInput = document.getElementById('dtcCustomColorInput');
    if (customInput && customInput.value !== currentDtcCustomColorHex) {
        customInput.value = currentDtcCustomColorHex;
    }
    const customHexInput = document.getElementById('dtcCustomColorHex');
    if (customHexInput && customHexInput.value.toUpperCase() !== currentDtcCustomColorHex.toUpperCase()) {
        customHexInput.value = currentDtcCustomColorHex.toUpperCase();
    }
    const toolbarColorPicker = document.getElementById('dtcToolbarCustomColorPicker');
    if (toolbarColorPicker && toolbarColorPicker.value !== currentDtcCustomColorHex) {
        toolbarColorPicker.value = currentDtcCustomColorHex;
    }

    const badge = document.getElementById('dtcCurrentColorBadge');
    if (badge && colorMap && colorMap[colorKey]) {
        badge.textContent = colorKey === 'custom' ? currentDtcCustomColorHex.toUpperCase() : colorMap[colorKey].name;
    }
    const indicator = document.getElementById('dtcColorIndicator');
    if (indicator && colorMap && colorMap[colorKey]) {
        indicator.style.backgroundColor = colorMap[colorKey].primary;
    }

    applyDtcBrandColorStyles();

    if (triggerRerender && currentDetailResultView === 'hybrid' && typeof renderDtcHybridPreview === 'function') {
        renderDtcHybridPreview();
    }
}

function setDtcCustomBrandColor(hex, triggerRerender = true) {
    if (!hex) return;
    const computed = computeCustomBrandColor(hex);
    currentDtcCustomColorHex = computed.primary;
    setDtcBrandColor('custom', triggerRerender);
}

function triggerDtcCustomColorPicker() {
    const picker = document.getElementById('dtcToolbarCustomColorPicker');
    if (picker && typeof picker.click === 'function') {
        picker.click();
    }
}

function applyDtcBrandColorStyles() {
    const colorMap = getDtcBrandColorMap();
    const color = (colorMap && colorMap[currentDtcBrandColor])
        ? colorMap[currentDtcBrandColor]
        : { primary: '#4f46e5', light: '#eef2ff', border: '#c7d2fe', text: '#4338ca' };

    const wrapper = document.querySelector ? document.querySelector('.dtc-pdp-wrapper') : null;
    if (wrapper && wrapper.style && typeof wrapper.style.setProperty === 'function') {
        wrapper.style.setProperty('--dtc-accent', color.primary);
        wrapper.style.setProperty('--dtc-accent-light', color.light);
        wrapper.style.setProperty('--dtc-accent-border', color.border);
        wrapper.style.setProperty('--dtc-accent-text', color.text);
    }

    const container = document.getElementById ? document.getElementById('dtcHybridContainer') : null;
    if (container && container.style && typeof container.style.setProperty === 'function') {
        container.style.setProperty('--dtc-accent', color.primary);
        container.style.setProperty('--dtc-accent-light', color.light);
        container.style.setProperty('--dtc-accent-border', color.border);
        container.style.setProperty('--dtc-accent-text', color.text);
    }

    if (typeof document !== 'undefined' && document.head && typeof document.createElement === 'function') {
        let styleEl = document.getElementById('dtc-dynamic-brand-color-style');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'dtc-dynamic-brand-color-style';
            document.head.appendChild(styleEl);
        }
        styleEl.textContent = `
            .dtc-pdp-wrapper, #dtcHybridContainer, .dtc-modular-section {
                --dtc-accent: ${color.primary} !important;
                --dtc-accent-light: ${color.light} !important;
                --dtc-accent-border: ${color.border} !important;
                --dtc-accent-text: ${color.text} !important;
            }
        `;
    }
}

// ====== DTC 字体与排版子系统 ======

function getDtcFontFamiliesMap() {
    if (typeof DTC_FONT_FAMILIES !== 'undefined') return DTC_FONT_FAMILIES;
    if (typeof window !== 'undefined' && window.DTC_FONT_FAMILIES) return window.DTC_FONT_FAMILIES;
    if (typeof globalThis !== 'undefined' && globalThis.DTC_FONT_FAMILIES) return globalThis.DTC_FONT_FAMILIES;
    return {};
}

function getDtcTypographyPresetsMap() {
    if (typeof DTC_TYPOGRAPHY_PRESETS !== 'undefined') return DTC_TYPOGRAPHY_PRESETS;
    if (typeof window !== 'undefined' && window.DTC_TYPOGRAPHY_PRESETS) return window.DTC_TYPOGRAPHY_PRESETS;
    if (typeof globalThis !== 'undefined' && globalThis.DTC_TYPOGRAPHY_PRESETS) return globalThis.DTC_TYPOGRAPHY_PRESETS;
    return {};
}

function getSavedCustomTypographyTemplates() {
    if (typeof localStorage === 'undefined') return {};
    try {
        const raw = localStorage.getItem('dtc_saved_typography_templates');
        return raw ? JSON.parse(raw) : {};
    } catch (e) {
        console.warn('Failed to parse saved typography templates:', e);
        return {};
    }
}

function saveSavedCustomTypographyTemplates(templates) {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem('dtc_saved_typography_templates', JSON.stringify(templates));
    } catch (e) {
        console.warn('Failed to save typography templates:', e);
    }
}

function resolveFontFamilyCss(fontId) {
    const fonts = getDtcFontFamiliesMap();
    if (fontId && fonts[fontId]) {
        return fonts[fontId].fontFamily;
    }
    return '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
}

function ensureGoogleFontLoaded(fontId) {
    if (typeof document === 'undefined' || !document.head) return;
    const fonts = getDtcFontFamiliesMap();
    const item = fonts[fontId];
    if (!item || !item.googleFont) return;
    const linkId = `google-font-${item.id}`;
    if (document.getElementById(linkId)) return;
    const link = document.createElement('link');
    link.id = linkId;
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${item.googleFont}&display=swap`;
    document.head.appendChild(link);
}

function initDtcTypographyDropdowns() {
    const presetSelect = document.getElementById('dtcTypographyPresetSelect');
    const fontSelect = document.getElementById('dtcFontFamilySelect');
    const titleFontSelect = document.getElementById('dtcTitleFontSelect');
    if (!presetSelect || !fontSelect) return;

    const fonts = getDtcFontFamiliesMap();
    fontSelect.innerHTML = Object.values(fonts).map(f => `
        <option value="${f.id}">${f.name}</option>
    `).join('');

    if (titleFontSelect) {
        titleFontSelect.innerHTML = `
            <option value="inherit">跟随全局主要字体</option>
            ${Object.values(fonts).map(f => `<option value="${f.id}">${f.name}</option>`).join('')}
        `;
    }

    refreshTypographyPresetDropdown();
}

function refreshTypographyPresetDropdown(selectedId = null) {
    const presetSelect = document.getElementById('dtcTypographyPresetSelect');
    if (!presetSelect) return;

    const presets = getDtcTypographyPresetsMap();
    const custom = getSavedCustomTypographyTemplates();
    const currentId = selectedId || currentDtcTypography?.templateId || 'modern';

    let html = '<optgroup label="🌟 内置精选模板">';
    Object.values(presets).forEach(p => {
        html += `<option value="${p.id}" ${p.id === currentId ? 'selected' : ''}>${p.name}</option>`;
    });
    html += '</optgroup>';

    const customKeys = Object.keys(custom);
    if (customKeys.length) {
        html += '<optgroup label="👤 我的自定义模板">';
        customKeys.forEach(k => {
            const c = custom[k];
            const escName = typeof detailEscapeHtml === 'function' ? detailEscapeHtml(c.name || k) : (c.name || k);
            html += `<option value="custom_${k}" ${`custom_${k}` === currentId ? 'selected' : ''}>📌 ${escName}</option>`;
        });
        html += '</optgroup>';
    }

    presetSelect.innerHTML = html;

    const deleteBtn = document.getElementById('btnDeleteTypographyTemplate');
    if (deleteBtn) {
        if (currentId.startsWith('custom_')) {
            deleteBtn.classList.remove('hidden');
        } else {
            deleteBtn.classList.add('hidden');
        }
    }
}

function handleTypographyPresetChange(templateId) {
    const presets = getDtcTypographyPresetsMap();
    const custom = getSavedCustomTypographyTemplates();
    let targetConfig = null;

    if (templateId.startsWith('custom_')) {
        const customKey = templateId.replace(/^custom_/, '');
        targetConfig = custom[customKey];
    } else if (presets[templateId]) {
        targetConfig = presets[templateId];
    }

    if (targetConfig) {
        syncTypographyControls(targetConfig, templateId);
        updateDtcTypographyPreview();
    }

    const deleteBtn = document.getElementById('btnDeleteTypographyTemplate');
    if (deleteBtn) {
        if (templateId.startsWith('custom_')) {
            deleteBtn.classList.remove('hidden');
        } else {
            deleteBtn.classList.add('hidden');
        }
    }
}

function syncTypographyControls(config, templateId) {
    const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el && val !== undefined) el.value = val;
    };

    setVal('dtcFontFamilySelect', config.fontFamily || 'inter');
    setVal('dtcTitleFontSelect', config.titleFont || 'inherit');
    setVal('dtcTitleSizeSelect', config.titleSize || '28px');
    setVal('dtcTitleWeightSelect', config.titleWeight || '700');
    setVal('dtcTitleSpacingSelect', config.titleSpacing || '-0.02em');
    setVal('dtcSubtitleSizeSelect', config.subtitleSize || '18px');
    setVal('dtcSubtitleWeightSelect', config.subtitleWeight || '600');
    setVal('dtcBodySizeSelect', config.bodySize || '14px');
    setVal('dtcBodyWeightSelect', config.bodyWeight || '400');
    setVal('dtcBodyLineHeightSelect', config.bodyLineHeight || '1.6');
}

function readTypographyControls() {
    const getVal = (id, fallback) => {
        const el = document.getElementById(id);
        return el ? el.value : fallback;
    };

    const presetSelect = document.getElementById('dtcTypographyPresetSelect');
    const templateId = presetSelect ? presetSelect.value : (currentDtcTypography?.templateId || 'modern');

    return {
        templateId,
        fontFamily: getVal('dtcFontFamilySelect', 'inter'),
        titleFont: getVal('dtcTitleFontSelect', 'inherit'),
        titleSize: getVal('dtcTitleSizeSelect', '28px'),
        titleWeight: getVal('dtcTitleWeightSelect', '700'),
        titleSpacing: getVal('dtcTitleSpacingSelect', '-0.02em'),
        subtitleSize: getVal('dtcSubtitleSizeSelect', '18px'),
        subtitleWeight: getVal('dtcSubtitleWeightSelect', '600'),
        bodySize: getVal('dtcBodySizeSelect', '14px'),
        bodyWeight: getVal('dtcBodyWeightSelect', '400'),
        bodyLineHeight: getVal('dtcBodyLineHeightSelect', '1.6')
    };
}

function updateDtcTypographyPreview() {
    const config = readTypographyControls();
    const liveCard = document.getElementById('dtcTypographyLiveCard');
    if (!liveCard) return;

    const mainFontFamily = resolveFontFamilyCss(config.fontFamily);
    const titleFontFamily = config.titleFont === 'inherit'
        ? mainFontFamily
        : resolveFontFamilyCss(config.titleFont);

    ensureGoogleFontLoaded(config.fontFamily);
    if (config.titleFont !== 'inherit') {
        ensureGoogleFontLoaded(config.titleFont);
    }

    liveCard.style.setProperty('--preview-font-family', mainFontFamily);
    liveCard.style.setProperty('--preview-title-font', titleFontFamily);
    liveCard.style.setProperty('--preview-title-size', config.titleSize);
    liveCard.style.setProperty('--preview-title-weight', config.titleWeight);
    liveCard.style.setProperty('--preview-title-spacing', config.titleSpacing);
    liveCard.style.setProperty('--preview-subtitle-size', config.subtitleSize);
    liveCard.style.setProperty('--preview-subtitle-weight', config.subtitleWeight);
    liveCard.style.setProperty('--preview-body-size', config.bodySize);
    liveCard.style.setProperty('--preview-body-weight', config.bodyWeight);
    liveCard.style.setProperty('--preview-body-line-height', config.bodyLineHeight);
}

function getDtcTypography() {
    return currentDtcTypography;
}

function applyDtcTypography(config, triggerRerender = true) {
    if (!config) return;
    currentDtcTypography = { ...config };
    if (typeof window !== 'undefined') window.currentDtcTypography = currentDtcTypography;

    const mainFontFamily = resolveFontFamilyCss(currentDtcTypography.fontFamily);
    const titleFontFamily = currentDtcTypography.titleFont === 'inherit'
        ? mainFontFamily
        : resolveFontFamilyCss(currentDtcTypography.titleFont);

    ensureGoogleFontLoaded(currentDtcTypography.fontFamily);
    if (currentDtcTypography.titleFont !== 'inherit') {
        ensureGoogleFontLoaded(currentDtcTypography.titleFont);
    }

    if (typeof document !== 'undefined' && document.head && typeof document.createElement === 'function') {
        let styleEl = document.getElementById('dtc-dynamic-typography-style');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'dtc-dynamic-typography-style';
            document.head.appendChild(styleEl);
        }
        styleEl.textContent = `
            .dtc-pdp-wrapper, #dtcHybridContainer, .dtc-modular-section {
                --dtc-font-family: ${mainFontFamily} !important;
                --dtc-title-font: ${titleFontFamily} !important;
                --dtc-title-size: ${currentDtcTypography.titleSize} !important;
                --dtc-title-weight: ${currentDtcTypography.titleWeight} !important;
                --dtc-title-spacing: ${currentDtcTypography.titleSpacing} !important;
                --dtc-subtitle-size: ${currentDtcTypography.subtitleSize} !important;
                --dtc-subtitle-weight: ${currentDtcTypography.subtitleWeight} !important;
                --dtc-body-size: ${currentDtcTypography.bodySize} !important;
                --dtc-body-weight: ${currentDtcTypography.bodyWeight} !important;
                --dtc-body-line-height: ${currentDtcTypography.bodyLineHeight} !important;
                font-family: ${mainFontFamily} !important;
            }
        `;
    }

    if (triggerRerender && currentDetailResultView === 'hybrid' && typeof renderDtcHybridPreview === 'function') {
        renderDtcHybridPreview();
    }
}

function openDtcTypographyModal() {
    const modal = document.getElementById('dtcTypographyModal');
    if (!modal) return;
    initDtcTypographyDropdowns();
    syncTypographyControls(currentDtcTypography, currentDtcTypography.templateId || 'modern');
    refreshTypographyPresetDropdown(currentDtcTypography.templateId || 'modern');
    updateDtcTypographyPreview();
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeDtcTypographyModal() {
    const modal = document.getElementById('dtcTypographyModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

function confirmDtcTypographyApplication() {
    const newConfig = readTypographyControls();
    applyDtcTypography(newConfig, true);
    closeDtcTypographyModal();
    if (typeof showToast === 'function') {
        showToast('已成功应用新的排版与字体设置！', 'success');
    }
}

function resetDtcTypographyToDefault() {
    const defaultTypo = (typeof DTC_DEFAULT_TYPOGRAPHY !== 'undefined') ? DTC_DEFAULT_TYPOGRAPHY : {
        templateId: 'modern',
        fontFamily: 'inter',
        titleFont: 'inherit',
        titleSize: '28px',
        titleWeight: '700',
        titleSpacing: '-0.02em',
        subtitleSize: '18px',
        subtitleWeight: '600',
        bodySize: '14px',
        bodyWeight: '400',
        bodyLineHeight: '1.6'
    };
    syncTypographyControls(defaultTypo, 'modern');
    refreshTypographyPresetDropdown('modern');
    updateDtcTypographyPreview();
}

function saveCustomTypographyTemplate() {
    const config = readTypographyControls();
    const name = window.prompt ? window.prompt('请输入自定义排版模板名称：', '我的品牌模板') : '我的品牌模板';
    if (!name || !name.trim()) return;

    const trimmedName = name.trim();
    const templateKey = 'tmpl_' + Date.now();
    const customTemplates = getSavedCustomTypographyTemplates();

    customTemplates[templateKey] = {
        ...config,
        name: trimmedName,
        id: `custom_${templateKey}`
    };

    saveSavedCustomTypographyTemplates(customTemplates);
    refreshTypographyPresetDropdown(`custom_${templateKey}`);
    handleTypographyPresetChange(`custom_${templateKey}`);

    if (typeof showToast === 'function') {
        showToast(`排版模板“${trimmedName}”已成功保存！`, 'success');
    }
}

function deleteCustomTypographyTemplate() {
    const presetSelect = document.getElementById('dtcTypographyPresetSelect');
    if (!presetSelect) return;
    const currentId = presetSelect.value;
    if (!currentId.startsWith('custom_')) return;

    const customKey = currentId.replace(/^custom_/, '');
    const customTemplates = getSavedCustomTypographyTemplates();
    const templateName = customTemplates[customKey]?.name || '此模板';

    if (window.confirm && !window.confirm(`确定要删除自定义模板“${templateName}”吗？`)) {
        return;
    }

    delete customTemplates[customKey];
    saveSavedCustomTypographyTemplates(customTemplates);
    refreshTypographyPresetDropdown('modern');
    handleTypographyPresetChange('modern');

    if (typeof showToast === 'function') {
        showToast(`已删除模板“${templateName}”`, 'info');
    }
}

function getDtcTrustBarEnabled() {
    return currentDtcTrustBarEnabled;
}

function setDtcTrustBarEnabled(enabled, triggerRerender = true) {
    currentDtcTrustBarEnabled = !!enabled;
    if (typeof window !== 'undefined') window.currentDtcTrustBarEnabled = currentDtcTrustBarEnabled;
    const toggle = document.getElementById('dtcTrustBarToggle');
    if (toggle && toggle.checked !== currentDtcTrustBarEnabled) {
        toggle.checked = currentDtcTrustBarEnabled;
    }
    if (triggerRerender && currentDetailResultView === 'hybrid' && typeof renderDtcHybridPreview === 'function') {
        renderDtcHybridPreview();
    }
}

function toggleDtcTrustBar(checked) {
    setDtcTrustBarEnabled(checked, true);
}

function getLongImageGap() {
    return currentLongImageGap;
}

function setLongImageGap(gap) {
    currentLongImageGap = parseInt(gap, 10) || 0;
    if (typeof window !== 'undefined') window.currentLongImageGap = currentLongImageGap;
    applyLongImageCanvasStyles();
}

function getLongImageRadius() {
    return currentLongImageRadius;
}

function setLongImageRadius(radius) {
    currentLongImageRadius = parseInt(radius, 10) || 0;
    if (typeof window !== 'undefined') window.currentLongImageRadius = currentLongImageRadius;
    applyLongImageCanvasStyles();
}

function getLongImageBgColor() {
    return currentLongImageBgColor;
}

function setLongImageBgColor(color) {
    currentLongImageBgColor = color || '#ffffff';
    if (typeof window !== 'undefined') window.currentLongImageBgColor = currentLongImageBgColor;
    applyLongImageCanvasStyles();
}

function applyLongImageCanvasStyles() {
    const canvas = document.getElementById('longImageCanvas');
    if (!canvas) return;
    if (canvas.style) {
        canvas.style.backgroundColor = currentLongImageBgColor;
        canvas.style.padding = currentLongImageGap > 0 ? `${currentLongImageGap}px` : '0px';
        canvas.style.gap = `${currentLongImageGap}px`;
    }
    const images = (canvas.querySelectorAll ? canvas.querySelectorAll('img') : []) || [];
    images.forEach(img => {
        if (img && img.style) {
            img.style.borderRadius = `${currentLongImageRadius}px`;
        }
    });
}

function safeFormatImgSrc(src) {
    if (typeof formatImgSrc === 'function') return formatImgSrc(src);
    if (!src) return '';
    if (src.startsWith('data:') || src.startsWith('blob:') || src.startsWith('http://') || src.startsWith('https://')) return src;
    const cleanPath = src.startsWith('/') ? src : '/' + src;
    return `http://127.0.0.1:9503${cleanPath}`;
}

function getDtcLayoutStyle() {
    return currentDtcLayoutStyle;
}

function setDtcLayoutStyle(style, triggerRerender = true) {
    const validStyles = ['editorial', 'minimalist', 'bento', 'lookbook', 'technical'];
    if (!validStyles.includes(style)) {
        style = 'editorial';
    }
    currentDtcLayoutStyle = style;
    if (typeof window !== 'undefined') window.currentDtcLayoutStyle = currentDtcLayoutStyle;

    // 同步左侧配置区与右侧结果工具栏中的风格下拉框
    const configSelect = document.getElementById('dtcLayoutStyleSelect');
    if (configSelect && configSelect.value !== style) {
        configSelect.value = style;
    }
    const resultSelect = document.getElementById('resultStyleSelect');
    if (resultSelect && resultSelect.value !== style) {
        resultSelect.value = style;
    }

    const styleMeta = (typeof DTC_LAYOUT_STYLES !== 'undefined' && DTC_LAYOUT_STYLES[style]) ? DTC_LAYOUT_STYLES[style] : null;
    const badge = document.getElementById('dtcCurrentStyleBadge');
    if (badge && styleMeta) {
        badge.textContent = styleMeta.badge || styleMeta.name;
    }
    const hint = document.getElementById('dtcStyleDescriptionHint');
    if (hint && styleMeta) {
        hint.textContent = styleMeta.desc || '';
    }

    if (triggerRerender && currentDetailResultView === 'hybrid' && typeof renderDtcHybridPreview === 'function') {
        renderDtcHybridPreview();
    }
}

function setDetailPresentationMode(mode) {
    currentDetailPresentationMode = mode === 'images' ? 'images' : 'hybrid';
    const isHybrid = currentDetailPresentationMode === 'hybrid';
    const btnHybrid = document.getElementById('modeBtnHybrid');
    const btnImages = document.getElementById('modeBtnImages');
    const badge = document.getElementById('dtcModeBadge');
    const hint = document.getElementById('modeDescriptionHint');
    const styleConfig = document.getElementById('dtcStyleConfigContainer');

    if (btnHybrid && btnImages) {
        if (isHybrid) {
            btnHybrid.className = 'text-xs py-1.5 px-2 rounded-md font-bold transition-all flex items-center justify-center gap-1 bg-indigo-600 text-white shadow-xs';
            btnImages.className = 'text-xs py-1.5 px-2 rounded-md font-bold transition-all flex items-center justify-center gap-1 bg-white text-gray-600 border border-gray-200 hover:bg-gray-100';
        } else {
            btnImages.className = 'text-xs py-1.5 px-2 rounded-md font-bold transition-all flex items-center justify-center gap-1 bg-indigo-600 text-white shadow-xs';
            btnHybrid.className = 'text-xs py-1.5 px-2 rounded-md font-bold transition-all flex items-center justify-center gap-1 bg-white text-gray-600 border border-gray-200 hover:bg-gray-100';
        }
    }
    if (badge) {
        badge.textContent = isHybrid ? '图文穿插' : '长图海报';
        badge.className = isHybrid ? 'text-[9px] bg-indigo-100 text-indigo-700 font-bold px-1.5 py-0.5 rounded' : 'text-[9px] bg-amber-100 text-amber-700 font-bold px-1.5 py-0.5 rounded';
    }
    if (hint) {
        hint.textContent = isHybrid
            ? '遵循 DTC 规范：无文字纯净 AI 视觉图 + 语义化 HTML 标题文案 + 多样化响应式排版 + 常见疑虑 FAQ。'
            : '经典电商模式：适合 Amazon A+ 或平台图集，支持带字模块图及整张长图排版导出。';
    }
    if (styleConfig) {
        styleConfig.classList.toggle('hidden', !isHybrid);
    }
    const brandConfig = document.getElementById('dtcBrandConfigContainer');
    if (brandConfig && brandConfig.parentElement !== styleConfig) {
        brandConfig.classList.toggle('hidden', !isHybrid);
    }
}

function getDetailPresentationMode() {
    return currentDetailPresentationMode;
}

function getDetailResultView() {
    return currentDetailResultView;
}

function switchDetailResultView(view) {
    currentDetailResultView = view === 'gallery' ? 'gallery' : 'hybrid';
    if (typeof window !== 'undefined') window.currentDetailResultView = currentDetailResultView;
    const isHybrid = currentDetailResultView === 'hybrid';
    const tabHybrid = document.getElementById('viewTabHybrid');
    const tabGallery = document.getElementById('viewTabGallery');
    const containerGallery = document.getElementById('modulesResultContainer');
    const containerHybrid = document.getElementById('dtcHybridContainer');
    const viewportControls = document.getElementById('pdpViewportControls');
    const styleSwitcher = document.getElementById('pdpStyleSwitcher');
    const colorSwitcher = document.getElementById('pdpColorSwitcher');
    const typoBtn = document.getElementById('dtcTypographyBtn');
    const dtcExportActions = document.getElementById('dtcExportActions');

    if (tabHybrid && tabGallery) {
        tabHybrid.className = isHybrid
            ? 'h-7 flex items-center gap-1.5 px-3 text-xs font-bold rounded-md transition-all bg-white text-indigo-600 shadow-xs cursor-pointer'
            : 'h-7 flex items-center gap-1.5 px-3 text-xs font-medium rounded-md transition-all text-slate-500 hover:text-slate-800 cursor-pointer';
        tabGallery.className = !isHybrid
            ? 'h-7 flex items-center gap-1.5 px-3 text-xs font-bold rounded-md transition-all bg-white text-indigo-600 shadow-xs cursor-pointer'
            : 'h-7 flex items-center gap-1.5 px-3 text-xs font-medium rounded-md transition-all text-slate-500 hover:text-slate-800 cursor-pointer';
    }

    if (containerGallery && containerHybrid) {
        containerGallery.classList?.toggle?.('hidden', isHybrid);
        containerHybrid.classList?.toggle?.('hidden', !isHybrid);
    }
    if (viewportControls?.classList) viewportControls.classList.toggle('hidden', !isHybrid);
    if (styleSwitcher?.classList) styleSwitcher.classList.toggle('hidden', !isHybrid);
    if (colorSwitcher?.classList) colorSwitcher.classList.toggle('hidden', !isHybrid);
    if (typoBtn?.classList) typoBtn.classList.toggle('hidden', !isHybrid);
    const codeExportDropdown = document.getElementById('codeExportDropdownContainer');
    if (codeExportDropdown?.classList) codeExportDropdown.classList.toggle('hidden', !isHybrid);

    if (isHybrid && typeof renderDtcHybridPreview === 'function') {
        renderDtcHybridPreview();
    }
}

function setDtcViewport(viewport) {
    currentDtcViewport = viewport === 'mobile' ? 'mobile' : 'desktop';
    const isDesktop = currentDtcViewport === 'desktop';
    const btnDesktop = document.getElementById('viewportBtnDesktop');
    const btnMobile = document.getElementById('viewportBtnMobile');

    if (btnDesktop && btnMobile) {
        btnDesktop.className = isDesktop
            ? 'h-7 flex items-center gap-1 px-2.5 text-xs font-bold rounded-md transition-all bg-white text-slate-800 shadow-xs cursor-pointer'
            : 'h-7 flex items-center gap-1 px-2.5 text-xs font-medium rounded-md transition-all text-slate-500 hover:text-slate-800 cursor-pointer';
        btnMobile.className = !isDesktop
            ? 'h-7 flex items-center gap-1 px-2.5 text-xs font-bold rounded-md transition-all bg-white text-slate-800 shadow-xs cursor-pointer'
            : 'h-7 flex items-center gap-1 px-2.5 text-xs font-medium rounded-md transition-all text-slate-500 hover:text-slate-800 cursor-pointer';
    }
    const wrapper = document.querySelector('.dtc-pdp-wrapper');
    if (wrapper) {
        if (wrapper.classList && typeof wrapper.classList.toggle === 'function') {
            wrapper.classList.toggle('dtc-viewport-desktop', isDesktop);
            wrapper.classList.toggle('dtc-viewport-mobile', !isDesktop);
        } else {
            const current = (wrapper.className || '').replace(/\bdtc-viewport-(?:desktop|mobile)\b/g, '').trim();
            wrapper.className = `${current} ${isDesktop ? 'dtc-viewport-desktop' : 'dtc-viewport-mobile'}`.trim();
        }
    }
}

const MODULE_PLATFORM_TAGS = {
    m1: { label: '通用', class: 'bg-slate-100 text-slate-600 border-slate-200' },
    m2: { label: '通用', class: 'bg-slate-100 text-slate-600 border-slate-200' },
    m3: { label: '通用', class: 'bg-slate-100 text-slate-600 border-slate-200' },
    m4: { label: 'Amazon 7图', class: 'bg-amber-50 text-amber-800 border-amber-300 font-bold' },
    m5: { label: '独立站 DTC', class: 'bg-indigo-50 text-indigo-700 border-indigo-200 font-bold' },
    m6: { label: 'Amazon 7图', class: 'bg-amber-50 text-amber-800 border-amber-300 font-bold' },
    m7: { label: '独立站 DTC', class: 'bg-indigo-50 text-indigo-700 border-indigo-200 font-bold' },
    m8: { label: 'Amazon 7图', class: 'bg-amber-50 text-amber-800 border-amber-300 font-bold' },
    m9: { label: 'TikTok 爆款', class: 'bg-rose-50 text-rose-700 border-rose-200 font-bold' },
    m10: { label: '独立站 DTC', class: 'bg-indigo-50 text-indigo-700 border-indigo-200 font-bold' },
    m11: { label: 'Amazon / TikTok', class: 'bg-amber-50/80 text-amber-800 border-amber-200' },
    m12: { label: '独立站 DTC', class: 'bg-indigo-50 text-indigo-700 border-indigo-200 font-bold' },
    m13: { label: '套装/礼包', class: 'bg-emerald-50 text-emerald-800 border-emerald-300 font-bold' },
    m14: { label: '套装/礼包', class: 'bg-emerald-50 text-emerald-800 border-emerald-300 font-bold' },
    m15: { label: '套装/礼包', class: 'bg-emerald-50 text-emerald-800 border-emerald-300 font-bold' },
    m16: { label: '套装/礼包', class: 'bg-emerald-50 text-emerald-800 border-emerald-300 font-bold' },
    m17: { label: '3C/工业', class: 'bg-cyan-50 text-cyan-800 border-cyan-300 font-bold' },
    m18: { label: '社交/UGC', class: 'bg-pink-50 text-pink-800 border-pink-300 font-bold' }
};

const MODULE_CATEGORIES = {
    all: { label: '全部', ids: [] },
    selected: { label: '已选', ids: [] },
    core: { label: '货架核心', ids: ['m1', 'm2', 'm3', 'm4', 'm6', 'm8'] },
    brand: { label: '场景品牌', ids: ['m5', 'm7', 'm9', 'm18'] },
    specs: { label: '规格工艺', ids: ['m10', 'm11', 'm12', 'm17'] },
    bundle: { label: '套装专区', ids: ['m13', 'm14', 'm15', 'm16'] }
};
let currentModuleCategory = 'all';

function setModuleCategoryFilter(catKey) {
    if (!MODULE_CATEGORIES[catKey]) catKey = 'all';
    currentModuleCategory = catKey;
    if (typeof initModules === 'function') initModules();
}

function invertModuleSelection() {
    const targetModules = (typeof modules !== 'undefined' && Array.isArray(modules))
        ? modules
        : ((typeof globalThis !== 'undefined' && globalThis.modules) || []);
    targetModules.forEach(mod => {
        mod.active = !mod.active;
        if (mod.active && typeof mod.includeText === 'undefined') {
            mod.includeText = true;
        }
    });
    if (typeof initModules === 'function') initModules();
    if (typeof showToast === 'function') showToast('已反向选择模块', 'info');
}

function batchSetAllModuleText(includeText = true) {
    const targetModules = (typeof modules !== 'undefined' && Array.isArray(modules))
        ? modules
        : ((typeof globalThis !== 'undefined' && globalThis.modules) || []);
    let count = 0;
    targetModules.forEach(mod => {
        if (mod.active) {
            mod.includeText = Boolean(includeText);
            count += 1;
        }
    });
    if (typeof initModules === 'function') initModules();
    if (typeof showToast === 'function') {
        showToast(includeText ? `已将 ${count} 个已选模块切换为【含字】模式` : `已将 ${count} 个已选模块切换为【纯图】模式`, 'success');
    }
}

let currentProductType = 'single'; // 'single' | 'bundle'

function setProductTypeMode(mode) {
    currentProductType = mode === 'bundle' ? 'bundle' : 'single';
    const isBundle = currentProductType === 'bundle';
    const btnSingle = document.getElementById('productTypeBtnSingle');
    const btnBundle = document.getElementById('productTypeBtnBundle');
    const banner = document.getElementById('bundleModeBanner');
    if (btnSingle && btnBundle) {
        if (isBundle) {
            btnBundle.className = 'px-2 py-0.5 rounded-md font-bold transition-all bg-emerald-600 text-white shadow-2xs flex items-center gap-1';
            btnSingle.className = 'px-2 py-0.5 rounded-md font-bold transition-all text-gray-500 hover:text-gray-800';
        } else {
            btnSingle.className = 'px-2 py-0.5 rounded-md font-bold transition-all bg-white text-gray-800 shadow-2xs';
            btnBundle.className = 'px-2 py-0.5 rounded-md font-bold transition-all text-gray-500 hover:text-gray-800 flex items-center gap-1';
        }
    }
    if (banner) {
        banner.classList.toggle('hidden', !isBundle);
    }
    const hint = document.getElementById('uploadImageHint');
    if (hint) {
        hint.textContent = isBundle
            ? '最多 6 张。套装模式：建议第 1 张为全套合影或主机，后续图片为各个配件/耗材白底图，悬停可设为主图。'
            : '最多 6 张。第一张作为主图，后续图片优先供“多角度图”使用；悬停缩略图可设为主图。';
    }
}

function getProductTypeMode() {
    return currentProductType;
}

let currentModulePreset = null;

function detectCurrentModulePreset() {
    const targetModules = (typeof modules !== 'undefined' && Array.isArray(modules))
        ? modules
        : ((typeof globalThis !== 'undefined' && globalThis.modules) || []);
    if (!targetModules.length) return null;
    const activeIds = targetModules.filter(m => m.active).map(m => m.id).sort().join(',');
    if (typeof MODULE_PRESETS !== 'undefined') {
        for (const [key, preset] of Object.entries(MODULE_PRESETS)) {
            const presetIds = [...preset.ids].sort().join(',');
            if (activeIds === presetIds) return key;
        }
    }
    return null;
}

function updatePresetButtonsUI() {
    currentModulePreset = detectCurrentModulePreset();
    const configs = {
        amazon_seven: {
            btnId: 'presetBtn_amazon_seven',
            activeClass: 'bg-amber-500 text-white border-amber-600 shadow-xs ring-2 ring-amber-200 font-bold',
            inactiveClass: 'bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100 font-medium',
            activeIcon: 'ph-check-circle',
            inactiveIcon: 'ph-package',
            name: 'Amazon 7图'
        },
        shopify_dtc: {
            btnId: 'presetBtn_shopify_dtc',
            activeClass: 'bg-indigo-600 text-white border-indigo-700 shadow-xs ring-2 ring-indigo-200 font-bold',
            inactiveClass: 'bg-indigo-50 text-indigo-800 border-indigo-200 hover:bg-indigo-100 font-medium',
            activeIcon: 'ph-check-circle',
            inactiveIcon: 'ph-shopping-bag',
            name: '独立站视觉流'
        },
        tiktok_viral: {
            btnId: 'presetBtn_tiktok_viral',
            activeClass: 'bg-rose-600 text-white border-rose-700 shadow-xs ring-2 ring-rose-200 font-bold',
            inactiveClass: 'bg-rose-50 text-rose-800 border-rose-200 hover:bg-rose-100 font-medium',
            activeIcon: 'ph-check-circle',
            inactiveIcon: 'ph-lightning',
            name: 'TikTok爆款'
        },
        bundle_suite: {
            btnId: 'presetBtn_bundle_suite',
            activeClass: 'bg-emerald-600 text-white border-emerald-700 shadow-xs ring-2 ring-emerald-200 font-bold',
            inactiveClass: 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100 font-medium',
            activeIcon: 'ph-check-circle',
            inactiveIcon: 'ph-gift',
            name: '套装大礼包'
        },
        tech_hardware: {
            btnId: 'presetBtn_tech_hardware',
            activeClass: 'bg-cyan-600 text-white border-cyan-700 shadow-xs ring-2 ring-cyan-200 font-bold',
            inactiveClass: 'bg-cyan-50 text-cyan-800 border-cyan-200 hover:bg-cyan-100 font-medium',
            activeIcon: 'ph-check-circle',
            inactiveIcon: 'ph-cpu',
            name: '3C硬核工匠'
        },
        social_ugc: {
            btnId: 'presetBtn_social_ugc',
            activeClass: 'bg-pink-600 text-white border-pink-700 shadow-xs ring-2 ring-pink-200 font-bold',
            inactiveClass: 'bg-pink-50 text-pink-800 border-pink-200 hover:bg-pink-100 font-medium',
            activeIcon: 'ph-check-circle',
            inactiveIcon: 'ph-thumbs-up',
            name: '社交种草流'
        }
    };

    Object.entries(configs).forEach(([key, cfg]) => {
        const btn = document.getElementById(cfg.btnId);
        if (!btn) return;
        const isActive = currentModulePreset === key;
        btn.className = `text-[10px] py-1.5 px-1.5 rounded-lg transition-all flex items-center justify-center gap-1 border shadow-2xs truncate cursor-pointer ${isActive ? cfg.activeClass : cfg.inactiveClass}`;
        btn.innerHTML = `<i class="ph-bold ${isActive ? cfg.activeIcon : cfg.inactiveIcon} shrink-0"></i> <span class="truncate">${cfg.name}${isActive ? ' (已选)' : ''}</span>`;
    });

    const hint = document.getElementById('presetActiveHint');
    if (hint) {
        if (currentModulePreset === 'amazon_seven') {
            hint.className = 'text-[10px] font-medium text-amber-800 bg-amber-50 border border-amber-200/90 px-2 py-1.5 rounded mb-2 flex items-center justify-between shadow-2xs';
            hint.innerHTML = `<span><i class="ph-bold ph-package text-amber-600 mr-1"></i>已激活 <strong>Amazon 7图套餐</strong>（匹配 7 个 Amazon 货架转化核心模块）</span><span class="text-[9px] bg-amber-200/70 font-bold text-amber-900 px-1.5 py-0.5 rounded">货架长图推荐</span>`;
        } else if (currentModulePreset === 'shopify_dtc') {
            hint.className = 'text-[10px] font-medium text-indigo-800 bg-indigo-50 border border-indigo-200/90 px-2 py-1.5 rounded mb-2 flex items-center justify-between shadow-2xs';
            hint.innerHTML = `<span><i class="ph-bold ph-shopping-bag text-indigo-600 mr-1"></i>已激活 <strong>独立站视觉流</strong> 模式（匹配 7 个 DTC 纯净出图与语义文案模块）</span><span class="text-[9px] bg-indigo-200/70 font-bold text-indigo-900 px-1.5 py-0.5 rounded">DTC图文推荐</span>`;
        } else if (currentModulePreset === 'tiktok_viral') {
            hint.className = 'text-[10px] font-medium text-rose-800 bg-rose-50 border border-rose-200/90 px-2 py-1.5 rounded mb-2 flex items-center justify-between shadow-2xs';
            hint.innerHTML = `<span><i class="ph-bold ph-lightning text-rose-600 mr-1"></i>已激活 <strong>TikTok爆款流</strong> 模式（匹配 5 个痛点刺激与强转化模块）</span><span class="text-[9px] bg-rose-200/70 font-bold text-rose-900 px-1.5 py-0.5 rounded">爆款流推荐</span>`;
        } else if (currentModulePreset === 'bundle_suite') {
            hint.className = 'text-[10px] font-medium text-emerald-800 bg-emerald-50 border border-emerald-200/90 px-2 py-1.5 rounded mb-2 flex items-center justify-between shadow-2xs';
            hint.innerHTML = `<span><i class="ph-bold ph-gift text-emerald-600 mr-1"></i>已激活 <strong>套装大礼包流</strong> 模式（全家福开箱拆解 + 关键配件特写 + 协同动线 + 超值对比）</span><span class="text-[9px] bg-emerald-200/70 font-bold text-emerald-900 px-1.5 py-0.5 rounded">多件套装推荐</span>`;
        } else if (currentModulePreset === 'tech_hardware') {
            hint.className = 'text-[10px] font-medium text-cyan-800 bg-cyan-50 border border-cyan-200/90 px-2 py-1.5 rounded mb-2 flex items-center justify-between shadow-2xs';
            hint.innerHTML = `<span><i class="ph-bold ph-cpu text-cyan-600 mr-1"></i>已激活 <strong>3C硬核工匠流</strong> 模式（核心功能 + 内部爆炸拆解 + 细节材质 + 精工规格）</span><span class="text-[9px] bg-cyan-200/70 font-bold text-cyan-900 px-1.5 py-0.5 rounded">硬核科技推荐</span>`;
        } else if (currentModulePreset === 'social_ugc') {
            hint.className = 'text-[10px] font-medium text-pink-800 bg-pink-50 border border-pink-200/90 px-2 py-1.5 rounded mb-2 flex items-center justify-between shadow-2xs';
            hint.innerHTML = `<span><i class="ph-bold ph-thumbs-up text-pink-600 mr-1"></i>已激活 <strong>社交种草爆款流</strong> 模式（痛点唤醒 + UGC买家秀开箱 + 核心功能 + 差异对比）</span><span class="text-[9px] bg-pink-200/70 font-bold text-pink-900 px-1.5 py-0.5 rounded">兴趣社交推荐</span>`;
        } else {
            hint.className = 'hidden';
            hint.innerHTML = '';
        }
    }
}

function applyModulePreset(presetKey) {
    const preset = (typeof MODULE_PRESETS !== 'undefined' && MODULE_PRESETS[presetKey]) ? MODULE_PRESETS[presetKey] : null;
    const targetModules = (typeof modules !== 'undefined' && Array.isArray(modules))
        ? modules
        : ((typeof globalThis !== 'undefined' && globalThis.modules) || []);
    if (!preset || !Array.isArray(preset.ids)) return;
    targetModules.forEach(mod => {
        mod.active = preset.ids.includes(mod.id);
        if (mod.active && currentDetailPresentationMode === 'hybrid') {
            mod.includeText = false;
        }
    });
    if (typeof initModules === 'function') initModules();
    if (typeof showToast === 'function') showToast(`已应用【${preset.label}】`, 'success');
}

function selectAllModules(selectAll = true) {
    const targetModules = (typeof modules !== 'undefined' && Array.isArray(modules))
        ? modules
        : ((typeof globalThis !== 'undefined' && globalThis.modules) || []);
    targetModules.forEach(mod => {
        mod.active = Boolean(selectAll);
        if (mod.active && currentDetailPresentationMode === 'hybrid') {
            mod.includeText = false;
        }
    });
    if (typeof initModules === 'function') initModules();
    if (typeof showToast === 'function') showToast(selectAll ? '已全选所有模块' : '已清空模块选择', 'info');
}

// 转义 HTML 特殊字符，避免用户输入或 AI 文案插入页面时破坏 DOM。
function detailEscapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]));
}

// 获取 select 当前选中项的展示文案，用于保存配置和拼接提示词。
function getSelectedOptionLabel(selectId) {
    const select = document.getElementById(selectId);
    return select?.options?.[select.selectedIndex]?.text || select?.value || '';
}

// 解析详情页视觉风格，兼容固定选项和用户手动输入的自定义风格。
function resolveDetailImageStyle({ selectedValue = '', selectedLabel = '', customValue = '' } = {}) {
    const value = String(selectedValue || '').trim();
    const label = String(selectedLabel || '').trim();
    const custom = String(customValue || '').replace(/\s+/g, ' ').trim();
    if (value !== 'custom') {
        return { value, label: label || value, isCustom: false, error: '' };
    }
    if (!custom) {
        return { value: '', label: label || '自定义风格', isCustom: true, error: '请输入自定义风格' };
    }
    return {
        value: custom,
        label: `自定义风格：${custom}`,
        isCustom: true,
        error: ''
    };
}

// ====== 工具栏下拉折叠菜单交互管理 ======
function hideAllToolbarDropdowns() {
    const mediaMenu = document.getElementById('mediaExportDropdownMenu');
    const codeMenu = document.getElementById('codeExportDropdownMenu');
    if (mediaMenu) mediaMenu.classList.add('hidden');
    if (codeMenu) codeMenu.classList.add('hidden');
}

function toggleMediaDropdown(event) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    const mediaMenu = document.getElementById('mediaExportDropdownMenu');
    const codeMenu = document.getElementById('codeExportDropdownMenu');
    if (codeMenu) codeMenu.classList.add('hidden');
    if (mediaMenu) mediaMenu.classList.toggle('hidden');
}

function toggleCodeDropdown(event) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    const mediaMenu = document.getElementById('mediaExportDropdownMenu');
    const codeMenu = document.getElementById('codeExportDropdownMenu');
    if (mediaMenu) mediaMenu.classList.add('hidden');
    if (codeMenu) codeMenu.classList.toggle('hidden');
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('click', (e) => {
        const mediaContainer = document.getElementById('mediaExportDropdownContainer');
        const codeContainer = document.getElementById('codeExportDropdownContainer');
        if (mediaContainer && !mediaContainer.contains(e.target) &&
            codeContainer && !codeContainer.contains(e.target)) {
            hideAllToolbarDropdowns();
        }
    });
}

// 根据产品标题、事实或卖点文本，智能推断最适合的视觉出图风格与独立站排版模板
function matchImageStyleForProduct(text = '') {
    const raw = String(text || '').toLowerCase();
    if (!raw.trim()) {
        return {
            value: "Shopify premium lifestyle style, editorial product photography, elegant spacing",
            label: "Shopify高级生活方式风",
            matchedCategory: "general",
            layoutStyle: "editorial"
        };
    }

    // 1. 3C数码 / 智能硬件 / 无人机 / 消费电子 / 耳机音箱
    if (/(?:drone|无人机|earphone|headphone|耳机|tws|earbuds|charger|power\s*bank|充电宝|充电器|smart\s*watch|智能手表|smart|bluetooth|蓝牙|camera|相机|云台|gimbal|mouse|keyboard|键盘|鼠标|gaming|vr|speaker|音箱|数码|3c|electronic|phone\s*case|手机壳|apple|iphone|ipad|laptop|笔记本)/i.test(raw)) {
        return {
            value: "Apple Keynote minimalist presentation style, pure white to subtle light gray gradient background, ultra-clean, elegant generous spacing, crisp modern lighting",
            label: "Apple Keynote 极简发布会风",
            matchedCategory: "3c_electronics",
            layoutStyle: "minimalist"
        };
    }

    // 2. 奢华精工机械 / 腕表 / 陀飞轮 / 仪器仪表
    if (/(?:watch|腕表|机械表|陀飞轮|horlogerie|titanium|chronograph|precision\s*instrument|deconstruction|精密仪器|机芯)/i.test(raw)) {
        return {
            value: "Haute horlogerie technical deconstruction style, luxury brushed titanium and sapphire crystal, technical brochure aesthetics, crisp daylight reflections",
            label: "奢华精工机械透视风",
            matchedCategory: "mechanical_luxury",
            layoutStyle: "technical"
        };
    }

    // 3. 美妆 / 护肤 / 口红 / 香水 / 个护
    if (/(?:serum|精华|cream|面霜|乳液|lotion|lipstick|口红|唇膏|makeup|彩妆|skincare|护肤|perfume|香水|beauty|cosmetic|美妆|shampoo|洗发|cleanser|洁面|mask|面膜|toner|爽肤水|foundation|粉底)/i.test(raw)) {
        return {
            value: "Beauty and personal care premium style, soft lighting, refined editorial layout",
            label: "美妆个护高级风",
            matchedCategory: "beauty_skincare",
            layoutStyle: "lookbook"
        };
    }

    // 4. 健康护理 / 医疗个护 / 按摩仪 / 筋膜枪 / 口腔护理
    if (/(?:massage|massager|按摩|筋膜枪|theragun|toothbrush|电动牙刷|oral|口腔|health|wellness|supplement|保健品|vitamin|维生素|理疗|care|护膝|braces)/i.test(raw)) {
        return {
            value: "Health and wellness trust style, calm colors, compliant supportive messaging",
            label: "健康护理克制风",
            matchedCategory: "health_wellness",
            layoutStyle: "editorial"
        };
    }

    // 5. 运动健身 / 力量训练 / 瑜伽 / 跑步 / 走步机
    if (/(?:fitness|健身|gym|workout|yoga|瑜伽|dumbbell|哑铃|跑步|treadmill|走步机|walking\s*pad|resistance\s*band|弹力带|athletic|crossfit|sport|运动)/i.test(raw)) {
        return {
            value: "Professional fitness equipment style, clean studio, restrained performance cues",
            label: "运动健身专业风",
            matchedCategory: "fitness_sports",
            layoutStyle: "editorial"
        };
    }

    // 6. 户外装备 / 露营 / 徒步 / 战术
    if (/(?:outdoor|户外|camping|露营|hiking|徒步|tent|帐篷|backpack|背包|登山包|flashlight|手电|knife|战术|tactical|survival|cooler|保温箱|sleeping\s*bag|睡袋)/i.test(raw)) {
        return {
            value: "Outdoor rugged gear style, durable materials, practical adventure context",
            label: "户外硬核装备风",
            matchedCategory: "outdoor_adventure",
            layoutStyle: "editorial"
        };
    }

    // 7. 自然原木 / 竹木 / 有机生态 / 茶道
    if (/(?:wood|wooden|原木|实木|bamboo|竹|organic|有机|natural|自然|eco|环保|tea|茶具|茶道|linen|棉麻)/i.test(raw)) {
        return {
            value: "Natural, organic, warm, cozy, lifestyle photography",
            label: "自然原木",
            matchedCategory: "natural_organic",
            layoutStyle: "editorial"
        };
    }

    // 8. 家居日用 / 厨房家电 / 家具 / 室内生活
    if (/(?:home|家居|furniture|家具|sofa|沙发|chair|椅子|table|桌|lamp|台灯|bedding|床品|pillow|枕头|kitchen|厨房|cookware|锅|blender|破壁机|榨汁机|coffee\s*maker|咖啡机|air\s*fryer|空气炸锅|vacuum|扫地|吸尘器|appliance|家电)/i.test(raw)) {
        return {
            value: "Realistic home interior scene, natural daylight, credible product scale",
            label: "家居场景实拍风",
            matchedCategory: "home_living",
            layoutStyle: "bento"
        };
    }

    // 9. 母婴玩具 / 婴儿用品 / 儿童
    if (/(?:baby|婴儿|infant|toddler|kid|儿童|toy|玩具|stroller|婴儿车|推车|diaper|纸尿裤|pacifier|奶嘴|bottle|奶瓶|maternity|母婴)/i.test(raw)) {
        return {
            value: "Mother and baby soft trust style, warm gentle palette, safety-focused layout",
            label: "母婴柔和信任风",
            matchedCategory: "mother_baby",
            layoutStyle: "bento"
        };
    }

    // 10. 办公效率 / 升降桌 / 显示器支架 / 人体工学
    if (/(?:office|办公|desk|书桌|stationery|文具|pen|钢笔|notebook|笔记本本子|planner|ergonomic|人体工学|monitor\s*arm|显示器支架|standing\s*desk|升降桌)/i.test(raw)) {
        return {
            value: "Office productivity style, organized workspace, efficient professional atmosphere",
            label: "办公效率风",
            matchedCategory: "office_productivity",
            layoutStyle: "minimalist"
        };
    }

    // 11. 工业五金 / 仪器工具 / 激光测距 / 电钻
    if (/(?:industrial|工业|hardware|五金|tool|工具|drill|电钻|laser\s*measure|测距仪|multimeter|万用表|wrench|扳手|machinery|机械设备)/i.test(raw)) {
        return {
            value: "Industrial technical specification style, precise diagrams, clean measurement layout",
            label: "工业参数说明风",
            matchedCategory: "industrial_technical",
            layoutStyle: "technical"
        };
    }

    // 12. 潮流玩具 / 潮玩手办 / 微缩模型 / 盲盒
    if (/(?:figure|手办|miniature|微缩|diorama|lego|积木|blind\s*box|盲盒|collectible|潮玩|model\s*kit)/i.test(raw)) {
        return {
            value: "Miniature creative diorama style, macro tilt-shift photography, playful environment scale, realistic warm daylight, rich environmental details",
            label: "微缩景观创意风",
            matchedCategory: "creative_miniature",
            layoutStyle: "bento"
        };
    }

    // 13. 服装服饰 / 鞋靴箱包 / 珠宝首饰
    if (/(?:clothing|apparel|服装|dress|连衣裙|jacket|外套|shirt|衬衫|shoes|鞋|sneakers|运动鞋|bag|包|handbag|手提包|jewelry|珠宝|necklace|项链|ring|戒指|earrings|耳环|fashion|时尚)/i.test(raw)) {
        return {
            value: "Vintage editorial lookbook style, high-fashion catalog shoot, warm daylight studio, dynamic layout collage, sophisticated shopping website aesthetic",
            label: "复古编辑杂志画册风",
            matchedCategory: "fashion_apparel",
            layoutStyle: "lookbook"
        };
    }

    // 默认回退：Shopify高级生活方式风
    return {
        value: "Shopify premium lifestyle style, editorial product photography, elegant spacing",
        label: "Shopify高级生活方式风",
        matchedCategory: "general",
        layoutStyle: "editorial"
    };
}

// 将推荐的画面风格与排版风格应用到界面，并点亮 AI 匹配徽章
function applyRecommendedStyle(styleHint = '', contextText = '') {
    const styleSelect = document.getElementById('imageStyleSelect');
    const badge = document.getElementById('aiMatchedStyleBadge');

    const options = (typeof IMAGE_STYLE_OPTIONS !== 'undefined' && Array.isArray(IMAGE_STYLE_OPTIONS))
        ? IMAGE_STYLE_OPTIONS
        : [];

    let matchedOption = null;
    let targetLayoutStyle = null;

    // 1. 优先尝试从 AI 返回的 styleHint 中匹配
    if (styleHint && typeof styleHint === 'string') {
        const hint = styleHint.trim().toLowerCase();
        matchedOption = options.find(opt => {
            const l = opt.label.toLowerCase();
            const v = opt.value.toLowerCase();
            return l === hint || l.includes(hint) || hint.includes(l) || v.includes(hint);
        });
    }

    // 2. 若未匹配，使用基于产品文本的启发式规则推断
    const heuristic = matchImageStyleForProduct(contextText || styleHint || '');
    if (!matchedOption && heuristic) {
        matchedOption = options.find(opt => opt.label === heuristic.label || opt.value === heuristic.value);
    }
    if (heuristic && heuristic.layoutStyle) {
        targetLayoutStyle = heuristic.layoutStyle;
    }

    if (matchedOption && styleSelect) {
        styleSelect.value = matchedOption.value;
        if (typeof toggleCustomImageStyle === 'function') {
            toggleCustomImageStyle();
        }
        if (badge) {
            badge.classList.remove('hidden');
            badge.title = `AI 智能根据产品特征匹配：${matchedOption.label}`;
            badge.textContent = `✨ AI 已匹配: ${matchedOption.label}`;
        }
    }

    // 联动同步 DTC 独立站排版风格模版
    const resultStyleSelect = document.getElementById('resultStyleSelect');
    if (resultStyleSelect && targetLayoutStyle) {
        resultStyleSelect.value = targetLayoutStyle;
        if (typeof setDtcLayoutStyle === 'function') {
            setDtcLayoutStyle(targetLayoutStyle);
        }
    }

    return matchedOption;
}

// 根据风格下拉状态显示或隐藏自定义风格输入框，并联动更新 AI 匹配徽标。
function toggleCustomImageStyle() {
    const styleSelect = document.getElementById('imageStyleSelect');
    const badge = document.getElementById('aiMatchedStyleBadge');
    const style = resolveDetailImageStyle({
        selectedValue: styleSelect?.value || '',
        selectedLabel: getSelectedOptionLabel('imageStyleSelect'),
        customValue: document.getElementById('customImageStyleInput')?.value || ''
    });
    const container = document.getElementById('customImageStyleContainer');
    if (container) {
        container.classList.toggle('hidden', !style.isCustom);
        if (style.isCustom) {
            document.getElementById('customImageStyleInput')?.focus();
        }
    }
    // 当用户手动更换风格且与当前 AI 匹配徽标不一致时，隐藏徽标以避免误导
    if (badge && !badge.classList.contains('hidden')) {
        const currentLabel = getSelectedOptionLabel('imageStyleSelect');
        if (currentLabel && !badge.textContent.includes(currentLabel)) {
            badge.classList.add('hidden');
        }
    }
}

// 校验并标准化宽高比字符串，返回模型可识别的 "宽:高" 格式。
function normalizeAspectRatio(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    if (width > 50 || height > 50) return null;
    return `${width}:${height}`;
}

// 汇总详情页生成所需的全局配置，包括风格、平台、市场、语言、比例和营销主题。
function getDetailConfig() {
    let ratioVal = document.getElementById('aspectRatioSelect')?.value || '1:1';
    if (ratioVal === 'custom') {
        ratioVal = `${document.getElementById('customRatioW')?.value || ''}:${document.getElementById('customRatioH')?.value || ''}`;
    }
    const aspectRatio = normalizeAspectRatio(ratioVal);
    if (!aspectRatio) {
        showToast('请填写有效的宽高比，例如 3:4', 'error');
        return null;
    }

    const region = document.getElementById('regionSelect')?.value || 'Global Market';
    const imageStyle = resolveDetailImageStyle({
        selectedValue: document.getElementById('imageStyleSelect')?.value || '',
        selectedLabel: getSelectedOptionLabel('imageStyleSelect'),
        customValue: document.getElementById('customImageStyleInput')?.value || ''
    });
    if (imageStyle.error) {
        showToast(imageStyle.error, 'error');
        document.getElementById('customImageStyleInput')?.focus();
        return null;
    }
    return {
        imageStyle: imageStyle.value,
        imageStyleLabel: imageStyle.label,
        imageStyleIsCustom: imageStyle.isCustom,
        platform: document.getElementById('platformSelect')?.value || '',
        platformLabel: getSelectedOptionLabel('platformSelect'),
        region,
        regionLabel: getSelectedOptionLabel('regionSelect'),
        marketTone: MARKET_TONE_MAP?.[region] || MARKET_TONE_MAP?.["Global Market"] || '',
        language: document.getElementById('languageSelect')?.value || 'English',
        languageLabel: getSelectedOptionLabel('languageSelect'),
        aspectRatio,
        marketingTheme: document.getElementById('marketingThemeSelect')?.value || 'none',
        marketingThemeLabel: getSelectedOptionLabel('marketingThemeSelect'),
        productType: currentProductType || 'single',
        productName: document.getElementById('productNameInput')?.value.trim() || '',
        productFacts: document.getElementById('productFactsText')?.value.trim() || '',
        forbiddenClaims: document.getElementById('forbiddenClaimsText')?.value.trim() || '',
        strictProductLock: document.getElementById('strictProductLockToggle') ? document.getElementById('strictProductLockToggle').checked : true
    };
}

// 压缩长文本中的空白并截断到指定长度，避免提示词过长。
function compactDetailText(value, maxLength = 900) {
    const normalized = String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
    if (normalized.length <= maxLength) return normalized;
    const clipped = normalized.slice(0, maxLength);
    const lastSpace = clipped.lastIndexOf(' ');
    const safeCut = lastSpace > maxLength * 0.75 ? clipped.slice(0, lastSpace) : clipped;
    return safeCut.replace(/[,:;.-]*$/, '').trim();
}

// 按需生成产品事实和禁用词上下文，供各类提示词复用。
function buildProductGuardrails(config = {}) {
    const productName = compactDetailText(config.productName || '', 160);
    const facts = compactDetailText(config.productFacts || '', 900);
    const forbidden = compactDetailText(config.forbiddenClaims || '', 700);
    const sections = [];
    if (productName) {
        sections.push(`Product name: ${productName}`);
    }
    if (facts) {
        sections.push(`Confirmed product facts:\n${facts}`);
    }
    if (forbidden) {
        sections.push(`User-forbidden claims and wording:\n${forbidden}`);
    }
    return sections.join('\n\n');
}

// 获取给模型使用的英文模块名称，避免 UI 中文标题进入完整 Prompt。
function getPromptModuleTitle(task = {}) {
    return compactDetailText(task.promptTitle || task.promptName || task.id || 'Detail Page Section', 120);
}

// 构建产品锁定规则，强约束模型不要改造参考图中的产品结构。
function buildProductLockPrompt(config = {}) {
    const isBundle = config.productType === 'bundle' || config.isBundle;
    const hasFacts = Boolean(compactDetailText(config.productFacts || '', 200));
    if (isBundle) {
        return `KIT COHESION LOCK (BUNDLE / MULTI-ITEM SET - PROMPT-AS-CODE)
- The product is a multi-item bundle/kit. Treat all visible items across the reference images as the authenticated set.
- STRICT KIT ZERO-DRIFT POLICY: Under no circumstance may any item in the kit be altered, redesigned, morphed, or substituted with generic alternatives.
- Maintain authentic relative physical proportions between the hero item and secondary accessories (e.g. smaller parts like bits, cables, or bottles must not appear disproportionately oversized).
- Strictly preserve authentic industrial design, silhouettes, materials, textures, colors, and logos across all items in the kit.
- Do not invent extra non-existent electronics, unrelated tools, or phantom accessories not mentioned in the product brief.
- Every visible item from the reference images must retain its exact 1:1 physical appearance, form factor, and branded details in every generated scene.
- Physical Lighting Protocol: Unify lighting direction, softbox fill, color temperature, crisp rim lighting, and ground contact shadows across all components in the scene (strictly avoid fake floating cutouts).
- Material Fidelity: Render realistic tactile surfaces (brushed titanium, matte polymers, optical glass, textured silicone) without plastic melting.
${hasFacts ? '- Strictly respect the confirmed bundle package facts and piece counts; do not contradict them.' : '- Preserve all visible items in the kit faithfully without inventing new attachments.'}`;
    }
    return `PRODUCT LOCK & PHYSICAL RENDERING SPEC (PROMPT-AS-CODE)
- Use the uploaded reference product as the source of truth.
- Treat the uploaded reference product as the only source of truth for every visible product detail.
- STRICT ZERO-DRIFT MANDATE (PHYSICAL INVARIANT): The product shown in this image MUST be 100% IDENTICAL in form, silhouette, industrial design, colorway, texture, finish, logos, buttons, ports, vents, and hardware details to the uploaded reference product.
- Do not redesign the product or change its category, silhouette, structure, material, color, proportions, or visible details.
- Do not add any extra product elements, accessories, markings, parts, functions, or attachments.
- Do not alter or invent the product category, silhouette, structure, parts, accessories, color, material, finish, proportions, logo, controls, buttons, ports, labels, texture, and component placement.
- ABSOLUTE PROHIBITION ON PRODUCT MORPHING: Do NOT generate a generic, alternative, conceptual, or modernized variation of the product. Do NOT change curvature, edge chamfers, panel seams, screen displays, or hardware interfaces.
- FEATURE VISUALIZATION BOUNDARY: Express the requested feature or selling point ONLY through environmental staging, realistic usage context, lighting, camera framing, or text callouts. NEVER modify or distort the physical product itself to illustrate a feature.
- Preserve original packaging, markings, color accents, surface finish, and every recognizable product detail exactly as shown in the reference image.
- Physical Lighting Protocol: Commercial softbox key light with directional fill, crisp rim lighting on silhouette edges for subject separation, and physically plausible contact shadows anchoring the product to its ground plane.
- Material Micro-Texture Fidelity: High-fidelity surface textures (e.g. micro-matte grain, polished metal reflections, optical transparency, tactile seams) without cheap plastic sheen or blurry artifacts.
- Background, lighting, and non-product decoration may change, but they must not obscure, reshape, replace, or redesign the product.
- If a product detail is unclear, keep it simple or omit it instead of inventing.
${hasFacts ? '- Respect the confirmed product facts listed in PRODUCT CONTEXT; do not contradict them.' : '- No extra confirmed facts were supplied. Use the module goal only for background and composition; never infer or invent missing product details.'}`;
}

// 根据模块文案模式构建统一的可见文字策略，无文案模式优先覆盖模块原始要求。
function buildModuleTextPolicy(task = {}, config = {}) {
    if (task.includeText === false) {
        return `NO ADDED TEXT
- No headlines, subheadlines, callouts, captions, specifications, dimensions, labels, badges, watermarks, letters, numbers, or typographic elements may be added.
- This rule overrides any module request for text, tables, comparison rows, measurement labels, step labels, badges, or written callouts. Communicate the module goal through composition, objects, lighting, and scene only.
- Original product markings visible in the uploaded reference may remain only when reproduced exactly. Do not rewrite, translate, replace, or redesign them.`;
    }

    const visibleTextById = {
        m1: 'Use one short headline, one short support line, and up to three fact-based callouts from confirmed product information.',
        m2: 'Use one short benefit headline and up to three large fact-based callouts. Each callout must map to one confirmed feature or visible product detail.',
        m3: 'Use little or no overlay text. If text is needed, use one short scenario phrase.',
        m4: 'Use short angle labels only when helpful. Avoid long paragraphs.',
        m5: 'Use one short lifestyle phrase at most.',
        m6: 'Use short labels for visible details only.',
        m7: 'Use restrained editorial copy, one headline and one support line at most.',
        m8: 'Use measurement labels from confirmed facts when available; if missing, infer plausible visual scale details.',
        m9: 'Use concise comparison row labels and factual feature names.',
        m10: 'Use specification labels and values from confirmed facts when available; if missing, infer plausible e-commerce specification details.',
        m11: 'Use trust labels only for supplied support, warranty, shipping, return, maintenance, or package-list facts.',
        m12: 'Use short step labels with minimal instruction text.',
        m13: "Use clear numbered callouts ('01', '02', '03') with short item names and exact piece counts (e.g. 'x 1', 'x 4').",
        m14: "Use clear comparison headers: single item total vs bundle special price, with a concise savings callout (e.g. 'Save 35%').",
        m15: "Use short step badges ('STEP 01', 'STEP 02', 'STEP 03') with concise 2-word phase names.",
        m16: "Use focused accessory labels highlighting precision materials, fit, or durable finish.",
        m17: 'Use short technical component callouts based strictly on verified product internal structure and materials, with minimal lines.',
        m18: "Use an authentic customer quote (1-2 lines), 5-star rating graphic, and a verified buyer badge."
    };
    const focalRule = task.focalFeature
        ? `\n- Focal copy requirement: Any visible headline, callout, or annotation in this image MUST directly communicate this module's focal feature: "${task.focalFeature}". Do NOT use generic or unrelated copy.`
        : '';
    return `VISIBLE TEXT
- All visible text must be ${config.language || 'English'}.
- ${visibleTextById[task.id] || 'Use concise, factual visible copy only. One headline, one support line, and up to three short callouts maximum.'}${focalRule}
- Prefer Product information and Confirmed product facts. When information is missing, infer plausible e-commerce details from the reference image, product category, and module goal.
- Text density: max 1 headline, max 1 subheadline, maximum 3 bullets/callouts, no dense fine print, repeated badges, or dense poster text.`;
}

// 解析卖点文本为离散条目和结构化小节，为各模块精准分配聚焦点。
function parseSellingPointsList(sellingPointsText = '') {
    const raw = String(sellingPointsText || '').trim();
    if (!raw) {
        return { items: [], coreBenefits: [], facts: [], scenarios: [], rawText: '' };
    }

    const lines = raw.split(/\r?\n/);
    const items = [];
    const coreBenefits = [];
    const facts = [];
    const scenarios = [];

    let currentSection = ''; // 'name' | 'type' | 'benefits' | 'facts' | 'scenarios' | 'users' | 'risks'

    const sectionRegexMap = [
        { type: 'name', regex: /^(?:product name|产品名称)[\s:：]/i },
        { type: 'type', regex: /^(?:product type(?: and core use)?|产品类型)[\s:：]/i },
        { type: 'benefits', regex: /^(?:core selling points?|核心卖点|主要卖点|卖点|key features?|benefits?)[\s:：]/i },
        { type: 'facts', regex: /^(?:known facts?|product facts?|confirmed visible physical facts?|已知事实|产品事实|规格参数|材料材质|材质工艺)[\s:：]/i },
        { type: 'scenarios', regex: /^(?:use scenarios?|usage scenarios?|使用场景|适用场景|场景)[\s:：]/i },
        { type: 'users', regex: /^(?:target users?|target audience|目标用户|适用人群|适合人群)[\s:：]/i },
        { type: 'risks', regex: /^(?:unknown or risky claims|forbidden claims|风险项|禁用词|注意事项)[\s:：]/i }
    ];

    function processItemContent(text, section) {
        const bulletMatch = text.match(/^(?:(?:\d+[\.、\)]|[-*•·●]|\([0-9]+\)|【\d+】)\s*)+(.*)$/);
        const content = (bulletMatch ? bulletMatch[1] : text)
            .replace(/^[\s*:：-]+/, '')
            .replace(/[*_~`]/g, '')
            .trim();

        if (!content || content.length < 2) return;

        // Skip metadata headers and non-benefit sections
        if (/^(?:product name|产品名称|product type|产品类型|known facts|核心卖点|使用场景)[\s:：]?$/i.test(content)) {
            return;
        }
        if (section === 'name' || section === 'type' || section === 'users' || section === 'risks') {
            return;
        }

        if (section === 'benefits') {
            coreBenefits.push(content);
            items.push(content);
        } else if (section === 'facts') {
            facts.push(content);
            items.push(content);
        } else if (section === 'scenarios') {
            scenarios.push(content);
            items.push(content);
        } else {
            if (/^(?:product name|产品名称|product type|产品类型)[\s:：]/i.test(content)) {
                return;
            }
            items.push(content);
        }
    }

    lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;

        const strippedHeader = trimmed.replace(/^(?:(?:\d+[\.、\)]|[-*•·●]|\([0-9]+\)|【\d+】)\s*)+/, '').trim();

        for (const sec of sectionRegexMap) {
            if (sec.regex.test(strippedHeader)) {
                currentSection = sec.type;
                const afterColon = strippedHeader.replace(sec.regex, '').trim();
                if (afterColon) {
                    processItemContent(afterColon, currentSection);
                }
                return;
            }
        }

        processItemContent(trimmed, currentSection);
    });

    if (!items.length && raw.length > 5) {
        const sentences = raw
            .split(/[。！？!?；;\n]+/)
            .map(s => s.trim().replace(/^[-*•·\d\.\s]+/, ''))
            .filter(s => s.length >= 4 && !/^(?:product name|产品名称|product type|产品类型)[\s:：]/i.test(s));
        items.push(...sentences);
    }

    if (!coreBenefits.length && items.length) {
        coreBenefits.push(...items);
        items.forEach(it => {
            if (/(?:材质|不锈钢|材料|尺寸|重量|容量|规格|结构|工艺|material|steel|dimension|capacity|weight)/i.test(it)) {
                facts.push(it);
            }
            if (/(?:场景|居家|办公|户外|旅行|卧室|厨房|客厅|scenario|home|office|outdoor|travel|desk)/i.test(it)) {
                scenarios.push(it);
            }
        });
    }

    return {
        items,
        coreBenefits: coreBenefits.length ? coreBenefits : items.slice(0, 5),
        facts,
        scenarios,
        rawText: raw
    };
}

// 根据模块类型与序号，从卖点和配置中解析针对该模块的聚焦卖点与视觉转化指令。
function resolveModuleFocalFeature(task = {}, sellingPoints = '', config = {}) {
    const parsed = parseSellingPointsList(sellingPoints);
    const variant = Number(task.variant || 0);
    const totalVariants = Number(task.totalVariants || 1);
    const id = task.id || 'm1';

    let focalFeature = '';
    let visualDirective = '';
    let visualOnlyDirective = '';

    if (id === 'm1') {
        focalFeature = parsed.coreBenefits[0] || parsed.items[0] || (config.productName ? `${config.productName} flagship showcase` : 'Core flagship benefit');
        visualDirective = `Flagship Hero Showcase: Position the reference product from Reference Image 1 large and commanding in the frame with generous breathing space. Highlight its defining flagship advantage. Commercial studio lighting with softbox key light and crisp rim light separating the silhouette from the clean background.`;
        visualOnlyDirective = `Flagship Hero Showcase: Keep the unchanged reference product large and recognizable as the central visual anchor in pristine commercial lighting without added text.`;
    } else if (id === 'm2') {
        const benefitIndex = Math.min(variant, Math.max(0, parsed.coreBenefits.length - 1));
        focalFeature = parsed.coreBenefits[benefitIndex] || parsed.items[variant] || `Core Benefit ${variant + 1}`;
        visualDirective = `Primary Benefit In Action: Visually demonstrate the specific functional payoff of this core advantage. Frame the reference product clearly, focusing directly on the physical feature, component, or interaction delivering this benefit with dynamic lighting and crisp visual hierarchy.`;
        visualOnlyDirective = `Demonstrate one core benefit through product placement, scene, props, and believable use only. Do not use callouts or infographic elements.`;
    } else if (id === 'm3') {
        focalFeature = parsed.scenarios[0] || parsed.items.find(it => /场景|居家|办公|户外|旅行|scenario|home|office|outdoor|travel/i.test(it)) || 'Authentic everyday usage context';
        visualDirective = `Believable Lifestyle Context: Place the reference product naturally in an authentic real-world environment. Natural daylight, authentic human posture and interaction if hands/models are featured, realistic scale, demonstrating how the product seamlessly solves the user's daily need.`;
        visualOnlyDirective = `Show one believable usage context with realistic product scale, natural posture, and credible lighting.`;
    } else if (id === 'm4') {
        focalFeature = 'Multi-angle physical geometry and silhouette integrity';
        visualDirective = `Multi-Angle Structural Layout: Showcase a clean, coordinated multi-angle presentation (front, 3/4 perspective, side profile) of the reference product on a minimalist studio backdrop. Strictly maintain identical proportions, finishes, and design details across all angles.`;
        visualOnlyDirective = `Show faithful product angles or a clean angle-view collage with no angle labels.`;
    } else if (id === 'm5') {
        focalFeature = 'Premium lifestyle ambiance and aspirational mood';
        visualDirective = `Atmospheric Lifestyle Shot: Elegant environmental shot matching the product's premium aesthetic. Warm natural ambient lighting, refined spatial context, soft depth of field, with the unchanged reference product firmly anchored as the centerpiece.`;
        visualOnlyDirective = `Build a restrained lifestyle mood around the unchanged product. The product remains the anchor.`;
    } else if (id === 'm6') {
        focalFeature = parsed.facts.find(f => /材质|不锈钢|材料|表面|涂层|接缝|防水|做工|material|steel|titanium|leather|silicone|finish|texture|seam|waterproof/i.test(f))
            || parsed.items.find(it => /材质|做工|工艺|涂层|接缝|texture|material|craft/i.test(it))
            || 'Premium materials, tactile surface micro-texture, and precision craftsmanship';
        visualDirective = `Extreme Macro Detail: Macro close-up photography highlighting visible surface micro-texture, tactile finish, precision chamfers/seams, and natural metallic or polymer reflections without cheap plastic sheen.`;
        visualOnlyDirective = `Use close-up framing for visible material, surface, controls, texture, seams, ports, or construction details that already exist in the reference product.`;
    } else if (id === 'm7') {
        focalFeature = 'Brand positioning, design ethos, and refined craftsmanship';
        visualDirective = `Editorial Brand Story: Sophisticated magazine editorial aesthetic with ample negative space, elegant lighting contrast, and refined styling reflecting craftsmanship and premium positioning.`;
        visualOnlyDirective = `Use editorial composition, lighting, and negative space to express positioning without written copy.`;
    } else if (id === 'm8') {
        focalFeature = parsed.facts.find(f => /尺寸|重量|折叠|收纳|便携|容量|cm|mm|inch|lbs|kg|dimension|capacity|compact|storage/i.test(f))
            || parsed.items.find(it => /尺寸|折叠|收纳|便携|容量|size|dimension|storage|compact/i.test(it))
            || 'Compact spatial scale, dimensions, and storage footprint';
        visualDirective = `Dimensions & Spatial Footprint: Clear visual scale indication with realistic proportions alongside familiar everyday reference objects or clean, elegant measurement line overlays demonstrating compact footprint.`;
        visualOnlyDirective = `Show scale or storage footprint through familiar objects and spatial context, without measurement lines, numbers, or labels.`;
    } else if (id === 'm9') {
        focalFeature = parsed.items.find(it => /对比|传统|优势|差异|更|vs|compare|superior|differentiator/i.test(it))
            || 'Superior efficiency, durability, and convenience over conventional alternatives';
        visualDirective = `Objective Visual Comparison: Side-by-side or split visual comparison clearly highlighting this product's practical advantage vs conventional alternatives, using factual visual proof rather than exaggerated claims.`;
        visualOnlyDirective = `Use a simple side-by-side visual comparison communicated only through composition and visible objects, without tables, rows, labels, or symbols.`;
    } else if (id === 'm10') {
        focalFeature = (parsed.facts.length ? parsed.facts.join('; ') : '') || config.productFacts || 'Confirmed physical specifications and hardware parameters';
        visualDirective = `Technical Specification Card: Clean, well-structured parameter card or clean callout layout presenting confirmed physical specifications and factual performance data.`;
        visualOnlyDirective = `Use an organized visual arrangement of the unchanged product and only its visible supplied parts, without specification cards, values, or labels.`;
    } else if (id === 'm11') {
        focalFeature = 'Package completeness, durable build quality, and customer support confidence';
        visualDirective = `Buyer Trust & Package Reassurance: Pristine display of packaged components, organized accessories, and high-trust service reassurance cues confirming product authenticity and durability.`;
        visualOnlyDirective = `Use supplied package contents or a believable support and delivery scene without trust badges, policy text, labels, or symbols.`;
    } else if (id === 'm12') {
        focalFeature = 'Simple step-by-step operation, intuitive controls, and easy maintenance';
        visualDirective = `Intuitive Step-by-Step Guide: Clear 3-4 step visual flow illustrating simple operation, quick-start setup, or easy maintenance with intuitive visual cues.`;
        visualOnlyDirective = `Show a visual sequence of believable use or maintenance scenes without step numbers, labels, icons, arrows, or instruction text.`;
    } else if (id === 'm13') {
        focalFeature = "Complete kit knolling breakdown showing what's in the box";
        visualDirective = `Knolling / Flat-Lay Kit Breakdown: Orderly overhead knolling layout neatly displaying the primary product alongside all included accessories, attachments, cables, and packaging in a clean geometric grid.`;
        visualOnlyDirective = `Organize all visible items from the set in an elegant, orderly knolling arrangement with balanced spacing and no added labels or text.`;
    } else if (id === 'm14') {
        focalFeature = 'Bundle value savings and one-stop kit convenience';
        visualDirective = `Bundle Value Comparison: Structured visual contrasting individual items vs the all-in-one complete bundle, highlighting value savings and one-stop convenience.`;
        visualOnlyDirective = `Contrast the assembled complete bundle against separate packaged units through clean spatial composition without numerical price tags.`;
    } else if (id === 'm15') {
        focalFeature = 'Multi-step sequential routine and synergy between kit items';
        visualDirective = `Sequential Synergy Workflow: Harmonious 3-step sequence showing how the different items in this set work together sequentially to solve the user's complete routine.`;
        visualOnlyDirective = `Present a seamless multi-step visual sequence of the items in action across three harmonious scenes without typography.`;
    } else if (id === 'm16') {
        focalFeature = 'Precision craft, durable materials, and exact fit of core accessories';
        visualDirective = `Macro Accessory Craftsmanship: Macro close-up focusing on key accessories and connectors, highlighting durable materials, precise fit, and premium surface finish.`;
        visualOnlyDirective = `Capture a pristine macro close-up of accessory craft, metallic texture, and seams without text labels.`;
    } else if (id === 'm17') {
        focalFeature = 'Internal engineering, core precision motor/components, and deconstructed exploded view';
        visualDirective = `Exploded Engineering View: Precision deconstructed layout showing core internal components floating in orderly alignment along an exploded axis alongside the reference product, with brushed metal reflections and subtle technical annotations.`;
        visualOnlyDirective = `Render an exploded view showing the internal core engineering and components floating in immaculate alignment alongside the product, without text labels or callouts.`;
    } else if (id === 'm18') {
        focalFeature = 'Authentic everyday consumer unboxing and 5-star customer endorsement';
        visualDirective = `Authentic UGC Lifestyle & Unboxing: Natural everyday setting with realistic consumer unboxing or hands-on usage moment, paired with a modern high-trust 5-star review quote card overlay.`;
        visualOnlyDirective = `Capture an authentic everyday consumer unboxing or hands-on lifestyle moment in natural lighting, without any text badges or overlays.`;
    } else {
        focalFeature = parsed.items[0] || 'Specific product value';
        visualDirective = `Focused Section: Communicate specific value with clear hierarchy and the unchanged reference product as the main subject.`;
        visualOnlyDirective = `Communicate specific value through composition, objects, lighting, and scene only, without added text.`;
    }

    const role = getModuleContentRole({ ...task, variant, totalVariants, focalFeature }, sellingPoints, config);
    const strategyCn = getModuleStrategyCn({ ...task, variant, totalVariants, focalFeature }, sellingPoints, config);

    return {
        focalFeature,
        visualDirective,
        visualOnlyDirective,
        role,
        strategyCn,
        summary: compactDetailText(`${role} ${focalFeature}`, 260),
        specializedPrompt: `Visual focus on ${focalFeature}: ${visualDirective}`
    };
}

// 构建单个模块的执行 brief，明确这张图的目标、构图和可见文字。
function buildModuleExecutionBrief(task = {}, sellingPoints = '', config = {}) {
    const moduleTitle = getPromptModuleTitle(task);
    const role = task.role || getModuleContentRole(task, sellingPoints, config);
    const compositionById = {
        m1: 'Use a clean studio or premium lifestyle setting with clear empty space for text. The product must be instantly recognizable.',
        m2: 'Use one focused benefit layout. Keep the product prominent, then add up to three large proof callouts around it. Do not repeat the hero layout.',
        m3: 'Show one believable usage context with realistic product scale, natural posture, and credible lighting. Keep text minimal.',
        m4: 'Show faithful product angles or a clean angle-view collage. Keep each view consistent with the same source product.',
        m5: 'Build a restrained lifestyle mood around the product. The product remains the anchor, not a small decorative prop.',
        m6: 'Use close-up framing for visible material, surface, controls, texture, seams, ports, or construction details from the reference product.',
        m7: 'Use editorial spacing and restrained copy. Focus on positioning and product fit, not invented brand history.',
        m8: 'Use measurement lines, scale references, or storage layout. Prefer confirmed dimensions, and when missing infer plausible scale cues from the reference image.',
        m9: 'Use a simple objective comparison layout with few rows. Compare practical features, not exaggerated superiority.',
        m10: 'Use a clean specification card or chart. Prefer confirmed facts, and when missing infer plausible specification details from the reference image and product category.',
        m11: 'Use trust cues such as support, maintenance, package list, shipping, returns, or warranty only when supplied.',
        m12: 'Use a simple 3-4 step instructional layout with icons or small visual cues and minimal copy.',
        m13: "Use a clean, organized knolling or flat-lay composition. Neatly arrange the hero product and all accompanying accessories in an orderly grid with clear space around each item.",
        m14: "Use a structured side-by-side comparison layout showing the complete bundle vs standalone items, with clear price-value badges.",
        m15: "Use a sequential 3-step or 4-step workflow layout showing the transition from item 1 to item 2 to item 3.",
        m16: "Use a macro detail view focusing on the premium build quality, precise connector/fit, and surface finish of the primary accessories.",
        m17: "Use an exploded view / precision deconstructed layout. The core mechanical or internal components float in clean, orderly alignment along a central exploded axis alongside the hero product, with subtle leader lines or technical annotations.",
        m18: "Use an authentic lifestyle unboxing or everyday usage composition. Frame the product naturally in real consumer hands or on a tabletop, paired with a modern, high-trust 5-star customer review quote card overlay."
    };
    const visualOnlyCompositionById = {
        m1: 'Use a clean studio or premium lifestyle setting. Keep the unchanged source product large, clear, and instantly recognizable.',
        m2: 'Demonstrate one benefit through product placement, scene, props, and believable use only. Do not use callouts or infographic elements.',
        m3: 'Show one believable usage context with realistic product scale, natural posture, and credible lighting.',
        m4: 'Show faithful product angles or a clean angle-view collage with no angle labels.',
        m5: 'Build a restrained lifestyle mood around the unchanged product. The product remains the anchor.',
        m6: 'Use close-up framing for visible material, surface, controls, texture, seams, ports, or construction details that already exist in the reference product.',
        m7: 'Use editorial composition, lighting, and negative space to express positioning without written copy.',
        m8: 'Show scale or storage footprint through familiar objects and spatial context, without measurement lines, numbers, or labels.',
        m9: 'Use a simple side-by-side visual comparison communicated only through composition and visible objects, without tables, rows, labels, or symbols.',
        m10: 'Use an organized visual arrangement of the unchanged product and only its visible supplied parts, without specification cards, values, or labels.',
        m11: 'Use supplied package contents or a believable support and delivery scene without trust badges, policy text, labels, or symbols.',
        m12: 'Show a visual sequence of believable use or maintenance scenes without step numbers, labels, icons, arrows, or instruction text.',
        m13: 'Organize all visible items from the set in an elegant, orderly knolling arrangement with balanced spacing and no added labels or text.',
        m14: 'Contrast the assembled complete bundle against separate packaged units through clean spatial composition without numerical price tags.',
        m15: 'Present a seamless multi-step visual sequence of the items in action across three harmonious scenes without typography.',
        m16: 'Capture a pristine macro close-up of accessory craft, metallic texture, and seams without text labels.',
        m17: 'Render an exploded view showing the internal core engineering and components floating in immaculate alignment alongside the product, without text labels or callouts.',
        m18: 'Capture an authentic everyday consumer unboxing or hands-on lifestyle moment in natural lighting, without any text badges or overlays.'
    };
    const composition = task.includeText === false
        ? visualOnlyCompositionById[task.id]
        : compositionById[task.id];
    const focalAngle = task.focalFeature
        ? `\n- Focal Feature / Angle: ${task.focalFeature}`
        : '';
    const visualDirective = task.visualDirective
        ? `\n- Visual Directive: ${task.visualDirective}`
        : '';
    return `SECTION GOAL
${role}${focalAngle}${visualDirective}

COMPOSITION
- Place the product large and clear as the main subject unless this module is a pure close-up detail section.
- PRODUCT PRESERVATION MANDATE: Render the EXACT physical product from the reference image. Do not modify its structure, buttons, colorway, ports, or silhouette.
${composition || `Create one focused visual idea for "${moduleTitle}" with clear hierarchy and the unchanged product as the main subject.`}`;
}

// 构建整套详情页的全局策略 brief，约束模块分工、合规、文案密度和视觉真实性。
function buildDetailPageBrief(sellingPoints, config = {}) {
    const productInfo = compactDetailText(sellingPoints, 1600);
    const platform = config.platform || 'cross-border e-commerce';
    const market = config.region || 'Global Market';
    const style = config.imageStyle || 'clean e-commerce';
    const guardrails = buildProductGuardrails(config);
    return `DETAIL PAGE BRIEF
Product information: ${productInfo}
Target platform: ${platform}
Target market: ${market}
Visual style: ${style}
${guardrails ? `\n${guardrails}` : ''}

Global strategy:
- Each section has one clear conversion job. Do not make every image repeat the full product story.
- Build a compact page flow: hero, focused benefits, believable usage, objective comparison, factual specs, and trust.
- Text density rule: one short headline, one short supporting line, maximum 3 bullets or callouts, large readable type, no tiny paragraph blocks.
- Evidence rule: prioritize supplied facts; when information is missing, infer plausible e-commerce specifications and commercial details from the reference image, product category, and module goal.
- Compliance rule: Avoid medical outcomes, body-transformation promises, fat-loss promises, guaranteed results, absolute superlatives, and unverifiable performance claims.
- Visual realism rule: keep source product identity, proportions, material, color, and scale stable. Avoid fake perspective, unrealistic human posture, and mismatched shadows.
- Mobile readability rule: avoid crowded layouts, long tables with tiny text, repeated badges, and dense poster-style stacking.`;
}

// 构建 AI 帮写卖点时使用的图片理解提示词，要求输出事实、卖点、场景和风险项。
function buildSellingPointsExtractionPrompt(imageCount = 1, productFacts = '', forbiddenClaims = '', productName = '', outputLanguage = 'English') {
    const multiImageNote = imageCount > 1
        ? `I provided ${imageCount} product images. The first image is the primary product image and the rest are angle/detail references. Treat them as the same product unless clearly impossible.`
        : 'I provided one primary product image.';
    const normalizedProductName = compactDetailText(productName, 160);
    const normalizedOutputLanguage = compactDetailText(outputLanguage, 80) || 'English';
    const productNameNote = normalizedProductName
        ? `User-provided product name: ${normalizedProductName}. Use the uploaded image evidence as the visual source of truth, and combine the uploaded image evidence with this product name to correct the product category, naming, and selling-point direction.`
        : 'No user-provided product name. Identify the product from the uploaded image evidence.';
    const guardrails = buildProductGuardrails({ productName: normalizedProductName, productFacts, forbiddenClaims });
    return `You are a senior cross-border e-commerce product strategist and visual merchandising copywriter.

Analyze the supplied product image(s) and extract a factual, conversion-ready product brief for detail-page generation.
${multiImageNote}
${productNameNote}
${guardrails ? `\n${guardrails}` : ''}

Return only one valid JSON object with exactly these string fields:
{
  "product_name": "A concise, e-commerce-friendly product name written in ${normalizedOutputLanguage}",
  "selling_points": "The complete product brief written in ${normalizedOutputLanguage}",
  "product_facts": "Confirmed visible physical facts, specifications, dimensions, materials, and package contents written in ${normalizedOutputLanguage}",
  "forbidden_claims": "Claims, certifications, medical effects, or exaggerations that must NOT be made",
  "recommended_image_style": "One recommended photography/visual style name from: [Apple Keynote 极简发布会风, 科技风, C4D 3D 商用超写实, 奢华精工机械透视风, 美妆个护高级风, 家居场景实拍风, 运动健身专业风, 户外硬核装备风, 自然原木, 母婴柔和信任风, 办公效率风, 复古编辑杂志画册风, 高端极简, Shopify高级生活方式风, 工业参数说明风]"
}

The selling_points string must contain these clearly labeled sections:
1. Product name: concise and e-commerce friendly.
2. Product type and core use: explain what it is in one sentence.
3. Known facts: list visible or supplied facts only, including material, structure, controls, accessories, app/remote support, dimensions, capacity, speed, warranty, certifications, or specifications only when visible or provided.
4. Core selling points: 3-4 bullets. Each bullet must use "feature + user value" and avoid vague quality words.
5. Target users: specific user groups.
6. Use scenarios: specific everyday contexts.
7. Unknown or risky claims to avoid: list claims that should not be invented for this product.

Rules:
- Do not invent specifications, certifications, warranty terms, medical effects, measured performance, or app features.
- Use cautious wording for inferred benefits.
- For wellness, fitness, beauty, recovery, or health products, avoid weight-loss, medical, body-transformation, pain-treatment, or guaranteed-result claims.
- Prefer practical, verifiable benefits over hype words such as ultimate, revolutionary, transform, miracle, best, or guaranteed.
- Do not use markdown tables.`;
}

// 解析结构化 AI 返回，并兼容 Markdown JSON 代码块和旧版普通文本。
function parseSellingPointsResponse(rawText = '') {
    const raw = String(rawText || '').trim();
    if (!raw) return { productName: '', sellingPoints: '' };

    const unfenced = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();

    try {
        const parsed = JSON.parse(unfenced);
        const res = {
            productName: compactDetailText(parsed.product_name || parsed.productName || '', 160),
            sellingPoints: String(parsed.selling_points || parsed.sellingPoints || '').trim()
        };
        if (parsed.product_facts || parsed.productFacts) {
            res.productFacts = String(parsed.product_facts || parsed.productFacts || '').trim();
        }
        if (parsed.forbidden_claims || parsed.forbiddenClaims) {
            res.forbiddenClaims = String(parsed.forbidden_claims || parsed.forbiddenClaims || '').trim();
        }
        if (parsed.recommended_image_style || parsed.recommendedImageStyle) {
            res.recommendedImageStyle = compactDetailText(parsed.recommended_image_style || parsed.recommendedImageStyle || '', 100);
        }
        return res;
    } catch (_) {
        const nameMatch = raw.match(/^(?:product\s*name|产品名称)\s*[:：]\s*(.+)$/im);
        return {
            productName: compactDetailText(nameMatch?.[1] || '', 160),
            sellingPoints: raw
        };
    }
}

// 根据点击前的表单状态决定是否回填 AI 识别的产品名称及事实/禁用词。
function resolveSellingPointsFormState(currentProductName = '', currentSellingPoints = '', parsedResult = {}) {
    const existingName = String(currentProductName || '').trim();
    const nextSellingPoints = String(parsedResult.sellingPoints || '').trim();
    if (!nextSellingPoints) {
        const state = {
            productName: existingName,
            sellingPoints: String(currentSellingPoints || ''),
            didFillProductName: false
        };
        if (parsedResult.productFacts !== undefined) state.productFacts = String(parsedResult.productFacts || '').trim();
        if (parsedResult.forbiddenClaims !== undefined) state.forbiddenClaims = String(parsedResult.forbiddenClaims || '').trim();
        if (parsedResult.recommendedImageStyle !== undefined) state.recommendedImageStyle = String(parsedResult.recommendedImageStyle || '').trim();
        return state;
    }

    const generatedName = compactDetailText(parsedResult.productName || '', 160);
    const state = {
        productName: existingName || generatedName,
        sellingPoints: nextSellingPoints,
        didFillProductName: !existingName && Boolean(generatedName)
    };
    if (parsedResult.productFacts !== undefined) state.productFacts = String(parsedResult.productFacts || '').trim();
    if (parsedResult.forbiddenClaims !== undefined) state.forbiddenClaims = String(parsedResult.forbiddenClaims || '').trim();
    if (parsedResult.recommendedImageStyle !== undefined) state.recommendedImageStyle = String(parsedResult.recommendedImageStyle || '').trim();
    return state;
}

// 根据模块 ID 和序号返回当前模块的转化职责，避免不同图片重复讲同一件事。
function getModuleContentRole(task = {}, sellingPoints = '', config = {}) {
    const variant = Number(task.variant || 0);
    const roles = {
        m1: 'Hero: immediately state what the product is, the primary user benefit, and 2-3 proof points. Avoid vague revolution/ultimate language.',
        m3: 'Lifestyle scene: show one believable use case with realistic scale, natural lighting, and minimal overlay text.',
        m4: 'Multi-angle proof: show real product angles or faithful inferred views. Focus on appearance and construction, not marketing promises.',
        m5: 'Lifestyle mood: communicate fit with the user environment using quiet visual cues and very little text.',
        m6: 'Detail close-up: highlight material, texture, controls, surface, seams, ports, or build details visible in the reference.',
        m7: 'Brand story: express product positioning with restrained editorial copy and no unsupported origin or mission claims.',
        m8: 'Size and dimensions: show scale, measurements, or storage footprint. Prefer supplied values, and infer plausible scale cues when missing.',
        m9: 'Comparison: use an objective feature table. Compare functions and convenience, not inflated superiority claims.',
        m10: 'Specifications: Prefer supplied facts or visible reference cues. If values are missing, infer plausible specification details for the product category.',
        m11: 'Trust: show after-sales, support, maintenance, shipping, returns, or package-list reassurance only if supported by supplied information.',
        m12: 'Usage guide: show a clear step-by-step use or maintenance flow with simple icons and minimal text.',
        m13: "What's in the Box: show the complete bundle breakdown in an organized flat lay or knolling layout. Clearly label every accessory, part, and piece count.",
        m14: "Bundle value comparison: contrast buying individual items separately vs purchasing this complete bundle. Highlight one-stop convenience and cost savings.",
        m15: "Multi-step synergy: illustrate how the different items in the kit work together sequentially in a streamlined 3-step routine.",
        m16: "Key accessory spotlight: macro close-up highlighting durable materials, precision fit, and OEM-grade build quality of essential accessories.",
        m17: "Exploded View: render an exploded view showing the internal core engineering and components floating in immaculate alignment alongside the product.",
        m18: "UGC Social Proof: show authentic lifestyle unboxing or everyday usage composition with high-trust customer review card."
    };
    if (task.id === 'm2') {
        const benefitRoles = [
            'Benefit 1: core daily-use angle. Visually demonstrate the primary practical use case and immediate functional payoff.',
            'Benefit 2: secondary function angle. Visually demonstrate the secondary capability, comfort mode, or control convenience.',
            'Benefit 3: ownership angle. Visually demonstrate easy storage, quiet operation, durable construction, or space-saving setup.',
            'Benefit 4: design/detail angle. Visually demonstrate controls, non-slip surface, build quality, or multi-mode convenience.',
            'Benefit 5: audience angle. Visually demonstrate target user fit, everyday practicality, and specific application.'
        ];
        return benefitRoles[Math.min(variant, benefitRoles.length - 1)];
    }
    return roles[task.id] || 'Focused section: communicate one specific buying reason with clear proof and restrained copy.';
}

// 根据模块 ID 和序号返回中文策略说明，供生成前预览阅读和修改方向。
function getModuleStrategyCn(task = {}, sellingPoints = '', config = {}) {
    const variant = Number(task.variant || 0);
    const focalFeature = task.focalFeature || '';
    const featureNote = focalFeature ? `【${focalFeature}】` : '';

    const strategies = {
        m1: {
            goal: `首屏让用户立刻看懂这是什么产品、适合谁、核心好处是什么${featureNote ? `：${featureNote}` : ''}。`,
            visual: '产品主体占据视觉重心，商业棚拍质感，高光与轮廓光清晰，预留大标题与2-3个核心标签空间。',
            avoid: '避免空泛口号、过度震撼词、看不清产品主体。'
        },
        m3: {
            goal: `用真实场景唤醒需求，让用户想象自己怎么用${featureNote ? `：${featureNote}` : ''}。`,
            visual: '场景要可信，产品比例真实，人物姿态自然，文字少。',
            avoid: '避免夸张健身效果、AI 感人物、产品尺寸失真。'
        },
        m4: {
            goal: '展示外观和角度，降低用户看不清结构的疑虑。',
            visual: '用主图和角度素材做清晰拼图，突出正面、侧面、细节。',
            avoid: '避免生成不同型号、不同颜色或不一致外观。'
        },
        m5: {
            goal: '强化生活方式和空间氛围，提高代入感。',
            visual: '画面干净、有真实空间感，少量文案辅助即可。',
            avoid: '避免只有氛围没有产品，也避免过度装饰。'
        },
        m6: {
            goal: `证明材质、做工或关键细节，让用户觉得产品可信${featureNote ? `：${featureNote}` : ''}。`,
            visual: '放大控制区、表面材质纹理、结构接缝或精密接口等可见细节。',
            avoid: '避免编造看不到的工艺、认证或材质。'
        },
        m7: {
            goal: '表达产品定位和调性，适合独立站品牌感页面。',
            visual: '更像编辑排版，克制文字，强调品牌气质和使用价值。',
            avoid: '避免虚构品牌历史、使命或奖项。'
        },
        m8: {
            goal: `说明尺寸、收纳或空间占用，消除放不下的顾虑${featureNote ? `：${featureNote}` : ''}。`,
            visual: '用测量线、比例参照、收纳示意表达明确尺寸。',
            avoid: '没有确定尺寸时不要编具体数字。'
        },
        m9: {
            goal: `客观说明为什么选它，而不是单纯贬低普通产品${featureNote ? `：${featureNote}` : ''}。`,
            visual: '用简洁对比表呈现功能、便利性、收纳、控制方式等差异。',
            avoid: '避免绝对化胜出、夸张优越性表达、无依据对比。'
        },
        m10: {
            goal: '集中展示确定参数，用事实消除下单前顾虑。',
            visual: '规格表要清楚、大字、少行，只展示已知事实。',
            avoid: '避免编造承重、速度、功率、认证、保修等参数。'
        },
        m11: {
            goal: '建立信任，降低售后、配送、维护和购买风险。',
            visual: '可展示保修、客服、包装清单、维护便利等已知内容。',
            avoid: '避免虚构认证、保修年限、退换政策。'
        },
        m12: {
            goal: '降低使用门槛，让用户知道买回去怎么开始用。',
            visual: '用 3-4 步流程图说明开机、模式、收纳、维护。',
            avoid: '避免复杂说明书式小字。'
        },
        m13: {
            goal: '工整呈现套装内所有物品、配件与规格数量，消除货不对板争议。',
            visual: 'Knolling 俯视工整平铺或微立体悬浮陈列，每个单品配序号引线与数量标。',
            avoid: '避免漏掉清单核心配件，避免凭空生成未包含的虚构电子配件。'
        },
        m14: {
            goal: '突出整套购买比单买更划算，量化一站式配齐的价值与省钱金额。',
            visual: '清晰的单买划线价 vs 套装专享价对比，配合“立省 XX%”与原装配件加赠徽章。',
            avoid: '避免无根据夸大优惠幅度，保持价格数字合理合规。'
        },
        m15: {
            goal: '展示套装内各单品按步骤（Step 1/2/3）协同解决完整痛点的闭环体验。',
            visual: '清晰的横向流程或阶段卡片，展示各单品分工配合的使用场景。',
            avoid: '避免杂乱无序堆砌，确保步骤逻辑清晰顺畅。'
        },
        m16: {
            goal: '特写展示高频核心配件的做工、材质与精确匹配度，打消配件廉价劣质疑虑。',
            visual: '微距特写展示配件接合处、金属/医用级材质纹理与细腻光泽。',
            avoid: '避免虚假微距工艺，配件造型必须与参考图一致。'
        },
        m17: {
            goal: '展示产品内部精密结构与高品质核心元器件，建立工业级硬核信任。',
            visual: '核心部件工整悬浮展开，材质细腻，拉丝金属/工程塑料真实反光，工整对齐。',
            avoid: '避免凭空胡乱捏造虚假电子芯片或破坏产品外部原貌。'
        },
        m18: {
            goal: '通过真实买家开箱与生活场景使用，打消下单疑虑，强化社交好评背书。',
            visual: '自然日光/生活实景，真实比例，5星好评与简明真实评语卡片。',
            avoid: '避免虚假医美/虚假过度承诺与过度摆拍假感。'
        }
    };
    if (task.id === 'm2') {
        const goals = [
            ['主卖点证明', `讲最核心的日常使用价值${featureNote ? `：聚焦${featureNote}` : '，突出主打功能与即时反馈'}`],
            ['第二功能证明', `讲辅助功能与进阶体验${featureNote ? `：聚焦${featureNote}` : '，突出多模式便利或操控感受'}`],
            ['拥有成本证明', `讲购买后长期价值${featureNote ? `：聚焦${featureNote}` : '，突出耐用、收纳或静音维护'}`],
            ['细节信任证明', `讲结构细节与交互做工${featureNote ? `：聚焦${featureNote}` : '，突出控制区、防滑表面或多模式便利性'}`],
            ['人群匹配证明', `讲特定人群与场景适配${featureNote ? `：聚焦${featureNote}` : '，突出精准解决日常痛点'}`]
        ];
        const selected = goals[Math.min(variant, goals.length - 1)];
        return {
            goal: `${selected[0]}：${selected[1]}`,
            visual: '只讲一个购买理由，围绕该卖点展开具体视觉证据，标题短，最多三个大号信息点。',
            avoid: '避免每张核心卖点图都重复同一套视觉构图或话术。'
        };
    }
    return strategies[task.id] || {
        goal: `围绕明确购买理由组织这一张图${featureNote ? `：${featureNote}` : ''}。`,
        visual: '产品清晰、文案克制、层级明确。',
        avoid: '避免重复、堆字和无依据承诺。'
    };
}

// 构建模块 SEO 标题和 Alt 文案的提示词，并限制编造参数或高风险功效表述。
function buildSEOMetadataPrompt(task = {}, sellingPoints = '', config = {}) {
    const guardrails = buildProductGuardrails(config);
    const moduleTitle = getPromptModuleTitle(task);
    const productName = config.productName || (typeof document !== 'undefined' ? document.getElementById('productNameInput')?.value.trim() : '') || '';
    const focalFeature = task.focalFeature || '';
    return `You are an e-commerce SEO specialist. I am generating one product detail-page image module named "${moduleTitle}".
${productName ? `Product name: ${productName}\n` : ''}${focalFeature ? `Module focal feature: ${focalFeature}\n` : ''}Product information: ${compactDetailText(sellingPoints, 500)}
Target platform: ${config.platform || 'cross-border e-commerce'}
Target market: ${config.region || 'Global Market'}
${guardrails ? `\n${guardrails}` : ''}

Create SEO metadata in English with Chinese reference text:
1. seoTitle: short image title containing the core product keyword${focalFeature ? ' and module focus' : ''}.
2. altText: accessible, descriptive image alt text accurately describing the image subject.

Rules:
- seoTitle must accurately represent the verified product name and feature (${focalFeature || moduleTitle}).
- altText must clearly describe the visible subject of this module (${focalFeature || moduleTitle}) for this product without generic filler or hallucinated accessories.
- Do not add unsupported claims, fake specifications, certifications, warranty terms, awards, or exact performance data.
- For wellness, fitness, beauty, recovery, or health products, avoid medical, body transformation, fat loss, treatment, cure, or guaranteed-result wording.
- Keep the title natural and under 70 characters.
- Keep alt text descriptive and under 160 characters.

Return strict JSON only:
{
  "seoTitle": {"target": "English Title", "zh": "中文对照标题"},
  "altText": {"target": "English Alt Text", "zh": "中文对照alt描述"}
} `;
}

// 拼接最终发给图片模型的模块级提示词，融合模块职责、卖点、配置、合规和重绘要求。
function buildModuleGenerationPrompt(task, sellingPoints, config = {}, promptAdjustment = '') {
    const moduleTitle = getPromptModuleTitle(task);
    const moduleRequest = task.includeText === false
        ? `Create a visual-only interpretation of "${moduleTitle}" and follow the NO ADDED TEXT policy.`
        : task.prompt;
    const productInfo = compactDetailText(sellingPoints, 1800);
    const guardrails = buildProductGuardrails(config);
    const productLock = buildProductLockPrompt(config);
    const executionBrief = buildModuleExecutionBrief(task, sellingPoints, config);
    const textPolicy = buildModuleTextPolicy(task, config);
    const themeContext = config.marketingTheme && config.marketingTheme !== 'none'
        ? `Marketing theme: ${config.marketingTheme}. Integrate it lightly without overwhelming the product.`
        : 'Marketing theme: none. Keep the layout evergreen and product-led.';
    const variationRule = task.totalVariants > 1
        ? task.includeText === false
            ? `Variant rule: this is version ${Number(task.variant || 0) + 1}/${task.totalVariants}. Do NOT repeat the same angle, scene, product placement, or visual composition used by sibling variants.`
            : `Variant rule: this is version ${Number(task.variant || 0) + 1}/${task.totalVariants}. Do NOT repeat the same angle, headline, visual composition, or callout set used by sibling variants.`
        : 'Variant rule: one focused version only.';
    const repaintRule = promptAdjustment
        ? `User repaint instruction: ${promptAdjustment}. CRITICAL: Apply this instruction ONLY to background scene, props, lighting, angle, or text layout while strictly preserving product identity, structure, details, section role, compliance, and readability. NEVER alter or redesign the physical product itself.`
        : '';
    const brandDirectives = (typeof window !== 'undefined' && window.brandContextHub && typeof window.brandContextHub.getVisualBrandDirectives === 'function')
        ? window.brandContextHub.getVisualBrandDirectives()
        : '';
    const focalLead = task.focalFeature
        ? `\nPRIMARY VISUAL FOCUS (CRITICAL): Feature and visualize "${task.focalFeature}". The composition, scene props, and lighting must directly express this core selling point without altering the product.`
        : '';

    return `IMAGE TASK
Create one professional e-commerce detail-page image section for "${moduleTitle}".${focalLead}
Module request: ${moduleRequest}
Consistency Mandate: The product in this image MUST be 100% IDENTICAL in form, silhouette, color, texture, and details to the uploaded reference image. Do NOT alter, redesign, or replace the product.

PRODUCT CONTEXT
Product information: ${productInfo || 'No written product information supplied.'}
${guardrails ? `\n${guardrails}` : ''}

MARKET AND STYLE
- Target platform: ${config.platform || 'cross-border e-commerce'}
- Target market: ${config.region || 'Global Market'}
- Local tone: ${config.marketTone || 'clear, practical, trust-building'}
- Aspect ratio: ${config.aspectRatio || '1:1'}
- Aesthetic visual style: ${config.imageStyle || 'clean premium e-commerce'}. Apply this photographic lighting, environment, color grading, and composition aesthetic to the background, scene props, and lighting atmosphere while strictly preserving the authentic product structure.
- ${themeContext}
- ${variationRule}
${brandDirectives ? `\nBRAND VISUAL GUIDELINES\n${brandDirectives}` : ''}

${productLock}

${executionBrief}

${textPolicy}

HARD RULES
- STRICT PRODUCT FIDELITY (IMMUTABLE): The physical product shown in the generated image must strictly match the uploaded reference image in every visible dimension, material, color, logo, and detail. Any modification, re-imagining, or model drift of the product is strictly forbidden.
- Generate one finished image only, not a wireframe or instruction sheet.
- Keep one primary visual idea, clear hierarchy, and no overstuffed collage.
- Forbidden claims: no clinical outcomes, no body-shape guarantees, no guaranteed measurable results, and no forbidden wording supplied by the user.
${task.includeText === false ? '- Do not add commercial specifications, dimensions, values, warranty terms, app functions, or other written details.' : '- If specs, dimensions, capacity, warranty, app functions, or similar commercial details are not supplied, generate cautious, plausible e-commerce copy without altering the product itself.'}
- Avoid medical outcomes, body-transformation promises, fat-loss promises, absolute superlatives, and unverifiable performance claims.
- Keep shadows, perspective, scale, and human posture realistic.
${repaintRule}`.trim();
}

// 构建策略预览里展示的短模块请求和完整最终提示词，避免把两者混为一谈。
function buildStrategyPromptPreview(task, sellingPoints, config = {}) {
    const moduleRequest = String(task?.prompt || '').trim();
    return {
        moduleRequest,
        fullPrompt: buildModuleGenerationPrompt({ ...task, prompt: moduleRequest }, sellingPoints, config)
    };
}

// 根据已启用模块生成出图前策略任务列表，每个任务对应最终要生成的一张图。
function buildStrategyTasks(activeModules = [], sellingPoints = '', config = {}) {
    const tasks = [];
    activeModules.forEach(mod => {
        for (let i = 0; i < (mod.count || 1); i++) {
            const tempTask = { ...mod, variant: i, totalVariants: mod.count || 1 };
            const focal = resolveModuleFocalFeature(tempTask, sellingPoints, config);
            const task = {
                ...mod,
                includeText: mod.includeText !== false,
                uniqueId: `${mod.id}_${i}`,
                displayTitle: mod.count > 1 ? `${mod.title} 0${i + 1}` : mod.title,
                variant: i,
                totalVariants: mod.count || 1,
                focalFeature: focal.focalFeature,
                visualDirective: focal.visualDirective,
                role: getModuleContentRole(tempTask, sellingPoints, config),
                strategyCn: getModuleStrategyCn({ ...tempTask, focalFeature: focal.focalFeature }, sellingPoints, config),
                status: 'pending'
            };
            task.strategySummary = compactDetailText(`${task.role} ${sellingPoints}`, 260);
            tasks.push(task);
        }
    });
    return tasks;
}

// 把策略预览里手动编辑的 prompt 覆盖到任务列表，保持原任务对象不被直接修改。
function applyStrategyOverrides(tasks = [], overrides = {}) {
    return tasks.map(task => {
        const override = String(overrides?.[task.uniqueId] || '').trim();
        return override ? { ...task, prompt: override, promptOverride: override } : { ...task };
    });
}

// 根据模块状态、SEO 文案、prompt 和禁用词做本地质检，给出轻量问题标签。
function assessModuleQuality(task = {}, config = {}) {
    const issues = [];
    const text = [
        task.title,
        task.displayTitle,
        task.prompt,
        task.repaintPrompt,
        task.seo?.titleTarget,
        task.seo?.altTarget,
        task.seo?.titleZh,
        task.seo?.altZh
    ].filter(Boolean).join(' ').toLowerCase();
    const forbidden = compactDetailText(config.forbiddenClaims || '', 700).toLowerCase();
    const forbiddenTerms = forbidden
        .split(/[,，\n;/]+/)
        .map(item => item.replace(/do not mention|不要写|禁止|do not|不要/gi, '').trim())
        .filter(item => item.length >= 3);

    forbiddenTerms.forEach(term => {
        if (term && text.includes(term.toLowerCase())) {
            issues.push({ code: 'forbidden-claim', level: 'danger', label: '禁用词风险', text: `出现禁用表达：${term}` });
        }
    });
    if (/burn fat|medical recovery|fda|cure|pain relief|guaranteed result/i.test(text)) {
        issues.push({ code: 'forbidden-claim', level: 'danger', label: '高风险功效', text: '可能包含疗效、认证或保证类高风险表达' });
    }
    if (/tiny text|dense|fine print|paragraph|many labels|信息密集|小字/i.test(text)) {
        issues.push({ code: 'dense-text', level: 'warning', label: '小字/拥挤', text: '可能出现文字过密或小字不可读' });
    }
    if (task.status === 'fallback' || task.isFallback) {
        issues.push({ code: 'fallback', level: 'warning', label: '降级图', text: '图片模型失败后使用了本地降级图' });
    }
    if (!task.imageSrc) {
        issues.push({ code: 'missing-image', level: 'danger', label: '缺图', text: '该模块还没有可导出的图片' });
    }
    if ((task.title || '').includes('规格') && !compactDetailText(config.productFacts || '', 900)) {
        issues.push({ code: 'missing-facts', level: 'warning', label: '缺少事实', text: '规格模块缺少明确产品事实，容易空泛或编造' });
    }
    if (!issues.length) {
        issues.push({ code: 'usable', level: 'success', label: '可用', text: '未发现明显本地规则风险' });
    }
    return { issues };
}

// 按质检问题生成可直接放进重绘输入框的英文重绘建议。
function buildPromptRewriteSuggestion(task = {}, issues = [], config = {}) {
    const actions = [
        `Regenerate "${task.title || task.displayTitle || 'this module'}" with the same product identity.`
    ];
    if (issues.some(issue => issue.code === 'dense-text')) {
        actions.push('Reduce text density: use one short headline, one short subheadline, and no more than three large readable callouts.');
    }
    if (issues.some(issue => issue.code === 'forbidden-claim')) {
        actions.push('Remove all forbidden or unsupported claims.');
    }
    if (issues.some(issue => issue.code === 'missing-facts')) {
        actions.push('Use only confirmed facts; omit unknown specification rows instead of inventing values.');
    }
    const guardrails = buildProductGuardrails(config);
    if (guardrails) actions.push(guardrails);
    actions.push('Keep the layout clean, mobile-readable, and conversion-focused.');
    return actions.join('\n');
}

// 导出长图前检查模块完整性、降级图、缺图、重复模块和事实/禁用词风险。
function buildExportChecklist(tasks = [], config = {}) {
    const checklist = [];
    if (!tasks.length) {
        return [{ level: 'danger', text: '没有可导出的模块' }];
    }
    const titles = new Map();
    tasks.forEach(task => {
        const title = task.title || task.displayTitle || task.id;
        titles.set(title, (titles.get(title) || 0) + 1);
        if (!task.imageSrc) checklist.push({ level: 'danger', text: `${title} 缺少图片` });
        if (task.status === 'fallback' || task.isFallback) checklist.push({ level: 'warning', text: `${title} 是 fallback 降级图` });
        const quality = assessModuleQuality(task, config);
        quality.issues
            .filter(issue => issue.level !== 'success')
            .forEach(issue => checklist.push({ level: issue.level, text: `${title}: ${issue.text}` }));
    });
    titles.forEach((count, title) => {
        if (count > 1) checklist.push({ level: 'info', text: `${title} 有 ${count} 张，导出前确认是否重复` });
    });
    if (!compactDetailText(config.productFacts || '', 900)) {
        checklist.push({ level: 'info', text: '未填写产品事实/参数，规格和对比信息可能偏泛' });
    }
    return checklist.length ? checklist : [{ level: 'success', text: '导出检查未发现明显问题' }];
}

// 更新单个模块卡片的状态徽标，例如生成中、已完成、降级图或失败。
function setModuleStatus(uniqueId, status, message = '') {
    const badge = document.getElementById(`status-badge-${uniqueId}`);
    if (!badge) return;
    const styles = {
        pending: 'bg-slate-100 text-slate-500 border-slate-200',
        loading: 'bg-blue-50 text-blue-600 border-blue-100',
        success: 'bg-emerald-50 text-emerald-600 border-emerald-100',
        fallback: 'bg-amber-50 text-amber-700 border-amber-100',
        error: 'bg-red-50 text-red-600 border-red-100',
        cancelled: 'bg-rose-50 text-rose-600 border-rose-200'
    };
    const labels = {
        pending: '等待中',
        loading: '生成中',
        success: '已完成',
        fallback: '降级图',
        error: '失败',
        cancelled: '已终止'
    };
    badge.className = `text-[10px] font-black px-2 py-0.5 rounded-full border ${styles[status] || styles.pending}`;
    badge.textContent = message || labels[status] || labels.pending;
}

// 从页面表单读取某个模块当前的 SEO 标题和 Alt 文案。
function getModuleSeo(uniqueId) {
    return {
        titleTarget: document.getElementById(`seo-title-target-${uniqueId}`)?.value || '',
        titleZh: document.getElementById(`seo-title-zh-${uniqueId}`)?.value || '',
        altTarget: document.getElementById(`alt-text-target-${uniqueId}`)?.value || '',
        altZh: document.getElementById(`alt-text-zh-${uniqueId}`)?.value || ''
    };
}

// 把生成或恢复的 SEO 标题和 Alt 文案写回模块表单。
function setModuleSeo(uniqueId, seo = {}) {
    const fields = {
        [`seo-title-target-${uniqueId}`]: seo.titleTarget || seo.seoTitle?.target || '',
        [`seo-title-zh-${uniqueId}`]: seo.titleZh || seo.seoTitle?.zh || '',
        [`alt-text-target-${uniqueId}`]: seo.altTarget || seo.altText?.target || '',
        [`alt-text-zh-${uniqueId}`]: seo.altZh || seo.altText?.zh || ''
    };
    Object.entries(fields).forEach(([id, value]) => {
        const el = document.getElementById(id);
        if (el) el.value = value;
    });
}

// 获取指定模块当前显示图片的 src，用于下载、长图排版和历史保存。
function getModuleImageSrc(uniqueId) {
    return document.getElementById(`content-mod-${uniqueId}`)?.querySelector('img')?.src || '';
}

// 获取指定模块重绘输入框中的附加提示词。
function getModulePromptAdjustment(uniqueId) {
    return document.getElementById(`regen-prompt-${uniqueId}`)?.value.trim() || '';
}

// 设置模块重绘控件的忙碌状态，防止重复提交并同步按钮文案。
function setPromptControlsBusy(uniqueId, busy) {
    const promptInput = document.getElementById(`regen-prompt-${uniqueId}`);
    const submitBtn = document.getElementById(`regen-submit-${uniqueId}`);
    if (promptInput) promptInput.disabled = busy;
    if (submitBtn) {
        submitBtn.disabled = busy;
        submitBtn.innerHTML = busy
            ? '<span class="loader border-white border-t-transparent w-3 h-3"></span><span>重绘中</span>'
            : '<i class="ph ph-magic-wand text-sm"></i><span>按提示重绘</span>';
    }
}

// 渲染单个模块下方的 Prompt Repaint 输入区和提交按钮。
function renderPromptRegenerationControls(uniqueId) {
    const safeId = detailEscapeHtml(uniqueId);
    return `
        <div class="border-t border-gray-100 bg-white px-4 py-3 flex flex-col gap-2">
            <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-1.5 min-w-0">
                    <i class="ph ph-magic-wand text-blue-500"></i>
                    <span class="text-xs font-black text-gray-700 uppercase tracking-widest">Prompt Repaint</span>
                </div>
                <button id="regen-submit-${safeId}" onclick="regenerateModuleWithPrompt('${safeId}')" class="flex items-center justify-center gap-1.5 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 px-3 py-1.5 rounded shadow-sm transition-all active:scale-95 whitespace-nowrap">
                    <i class="ph ph-magic-wand text-sm"></i><span>按提示重绘</span>
                </button>
            </div>
            <textarea id="regen-prompt-${safeId}" class="w-full text-xs leading-relaxed px-3 py-2 border border-gray-200 rounded bg-slate-50 outline-none focus:border-blue-400 focus:bg-white resize-none" rows="2" placeholder="输入想调整的画面要求，例如：背景换成厨房使用场景，产品主体更大，光线更自然"></textarea>
        </div>`;
}

// 渲染模块本地质检结果和重绘建议入口。
function renderModuleQualityPanel(uniqueId) {
    const task = globalGenContext?.tasks?.[uniqueId];
    const container = document.getElementById(`quality-panel-${uniqueId}`);
    if (!task || !container) return;
    const quality = assessModuleQuality(task, globalGenContext?.config || {});
    container.innerHTML = `
        <div class="flex items-center justify-between gap-2">
            <div class="flex flex-wrap gap-1.5">
                ${quality.issues.map(issue => {
                    const cls = issue.level === 'danger'
                        ? 'bg-red-50 text-red-600 border-red-100'
                        : issue.level === 'warning'
                            ? 'bg-amber-50 text-amber-700 border-amber-100'
                            : issue.level === 'success'
                                ? 'bg-emerald-50 text-emerald-600 border-emerald-100'
                                : 'bg-slate-50 text-slate-500 border-slate-100';
                    return `<span title="${detailEscapeHtml(issue.text)}" class="text-[10px] font-bold px-2 py-1 rounded border ${cls}">${detailEscapeHtml(issue.label)}</span>`;
                }).join('')}
            </div>
            <button onclick="fillRewriteSuggestion('${detailEscapeHtml(uniqueId)}')" class="text-[10px] font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 border border-blue-100 px-2 py-1 rounded">重绘建议</button>
        </div>`;
}

// 根据本地质检结果生成重绘提示词，并填入当前模块的重绘输入框。
function fillRewriteSuggestion(uniqueId) {
    const task = globalGenContext?.tasks?.[uniqueId];
    if (!task) return;
    const quality = assessModuleQuality(task, globalGenContext?.config || {});
    const suggestion = buildPromptRewriteSuggestion(task, quality.issues, globalGenContext?.config || {});
    const input = document.getElementById(`regen-prompt-${uniqueId}`);
    if (input) {
        input.value = suggestion;
        input.focus();
    }
    showToast('已生成重绘建议', 'success');
}

// 按用户输入的重绘提示词重新生成单个模块图片和 SEO。
async function regenerateModuleWithPrompt(uniqueId) {
    const promptAdjustment = getModulePromptAdjustment(uniqueId);
    if (!promptAdjustment) {
        showToast('请输入重绘提示词', 'warning');
        document.getElementById(`regen-prompt-${uniqueId}`)?.focus();
        return;
    }

    setPromptControlsBusy(uniqueId, true);
    try {
        await generateSingleWrap(uniqueId, false, promptAdjustment);
        showToast('已按提示重绘', 'success');
    } catch (error) {
        console.error(error);
        showToast('重绘失败', 'error');
    } finally {
        setPromptControlsBusy(uniqueId, false);
    }
}

// 校验 AI 返回的长图排序 ID，去重、过滤非法 ID，并自动补齐遗漏模块。
function validateSortedIds(sortedIds, expectedIds) {
    if (!Array.isArray(sortedIds)) return null;
    const expected = new Set(expectedIds);
    const clean = [];
    sortedIds.forEach(id => {
        if (expected.has(id) && !clean.includes(id)) clean.push(id);
    });
    expectedIds.forEach(id => {
        if (!clean.includes(id)) clean.push(id);
    });
    return clean.length === expectedIds.length ? clean : null;
}

// 解析 data URL 图片，拆出 MIME 类型和 base64 数据。
function parseImageDataUrl(dataUrl) {
    if (!dataUrl || !dataUrl.includes(',')) return null;
    return {
        mimeType: dataUrl.split(';')[0].split(':')[1],
        data: dataUrl.split(',')[1]
    };
}

// 把远程或本地图片 URL 转成 data URL，方便作为模型内联图片输入。
async function imageUrlToDataUrl(src) {
    if (!src || src.startsWith('data:image')) return src;
    const response = await fetch(safeFormatImgSrc(src));
    if (!response.ok) throw new Error(`图片读取失败: ${response.status}`);
    const blob = await response.blob();
    return await fileToDataUrl(blob);
}

// 确保图片对象包含模型调用需要的 mimeType 和 base64 data 字段。
async function ensureInlineImageData(image) {
    if (!image) return null;
    if (image.data && image.mimeType) return image;
    const dataUrl = await imageUrlToDataUrl(image.base64 || image.imageSrc || '');
    const parsed = parseImageDataUrl(dataUrl);
    if (!parsed) return null;
    return {
        ...image,
        base64: dataUrl,
        mimeType: parsed.mimeType,
        data: parsed.data
    };
}

// 读取浏览器 File/Blob 并转换为 data URL。
function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// 获取当前主图素材，兼容新版多图数组和旧版单图字段。
function getPrimaryUploadedImage() {
    if (Array.isArray(currentUploadedImages) && currentUploadedImages.length) {
        return currentUploadedImages[0];
    }
    return currentUploadedBase64 ? {
        id: 'primary_legacy',
        name: '主图',
        base64: currentUploadedBase64,
        isPrimary: true,
        ...parseImageDataUrl(currentUploadedBase64)
    } : null;
}

// 获取除主图以外的角度或细节素材。
function getAngleUploadedImages() {
    return Array.isArray(currentUploadedImages) ? currentUploadedImages.slice(1) : [];
}

// 渲染已上传素材的缩略图、主图标记、设为主图按钮和删除按钮。
function renderUploadedImagePreviews() {
    const container = document.getElementById('imagePreviewContainer');
    if (!container) return;

    if (!currentUploadedImages.length) {
        container.innerHTML = '';
        container.classList.add('hidden');
        container.classList.remove('flex');
        return;
    }

    container.classList.remove('hidden');
    container.classList.add('flex');
    container.innerHTML = currentUploadedImages.map((img, index) => `
        <div class="w-[112px] rounded-lg border border-gray-200 bg-gray-50 overflow-hidden relative group shadow-inner p-1">
            <div class="relative w-full h-[82px] overflow-hidden rounded bg-white">
                <img src="${detailEscapeHtml(img.base64)}" alt="${detailEscapeHtml(img.name || 'Product')}" class="w-full h-full object-cover">
                <span class="absolute left-1 bottom-1 text-[9px] font-black px-1.5 py-0.5 rounded bg-black/60 text-white">${index === 0 ? '主图' : `素材${index}`}</span>
            </div>
            <select onchange="updateImageRole(${index}, this.value)" class="mt-1 w-full text-[10px] border border-gray-200 rounded bg-white px-1 py-0.5 outline-none">
                ${[
                    ['primary', '主图'],
                    ['angle', '角度/外观'],
                    ['detail', '细节/材质'],
                    ['scene', '场景参考'],
                    ['spec', '尺寸/参数'],
                    ['package', '包装/配件']
                ].map(([value, label]) => `<option value="${value}" ${(img.role || (index === 0 ? 'primary' : 'angle')) === value ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
            ${index > 0 ? `<button onclick="setPrimaryImage(${index})" title="设为主图"
                class="absolute left-1 top-1 bg-white/90 text-blue-600 rounded px-1.5 py-0.5 text-[9px] font-black opacity-0 group-hover:opacity-100 transition-opacity">主图</button>` : ''}
            <button onclick="removeImage(${index})"
                class="absolute top-1 right-1 bg-black/60 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"><i
                    class="ph ph-x text-xs"></i></button>
        </div>
    `).join('');
}

// 更新某张上传素材的角色，用于后续按模块优先选择参考图。
function updateImageRole(index, role) {
    if (!Array.isArray(currentUploadedImages) || !currentUploadedImages[index]) return;
    currentUploadedImages[index] = { ...currentUploadedImages[index], role };
    if (index === 0 && role !== 'primary') {
        currentUploadedImages[index].role = 'primary';
        showToast('第一张固定为主图角色', 'info');
    }
    renderUploadedImagePreviews();
}

// 将某张角度素材移动为主图，并重新渲染上传预览。
function setPrimaryImage(index) {
    if (!Array.isArray(currentUploadedImages) || index <= 0 || index >= currentUploadedImages.length) return;
    const [selected] = currentUploadedImages.splice(index, 1);
    currentUploadedImages.unshift(selected);
    currentUploadedImages = currentUploadedImages.map((img, idx) => ({ ...img, isPrimary: idx === 0, role: idx === 0 ? 'primary' : (img.role === 'primary' ? 'angle' : img.role || 'angle') }));
    currentUploadedBase64 = currentUploadedImages[0]?.base64 || null;
    renderUploadedImagePreviews();
    showToast('已设为主图', 'success');
}

function setDetailProductImage(imageDataUrl, filename = 'Imported Image', asPrimary = true) {
    if (!imageDataUrl) return;
    const parsed = parseImageDataUrl(imageDataUrl);
    const newImg = {
        id: `img_${Date.now()}`,
        name: filename,
        base64: imageDataUrl,
        isPrimary: asPrimary,
        role: asPrimary ? 'primary' : 'angle',
        mimeType: parsed.mimeType || 'image/png',
        data: parsed.data || ''
    };
    if (!Array.isArray(currentUploadedImages)) {
        currentUploadedImages = [];
    }
    if (asPrimary) {
        currentUploadedImages.forEach(img => {
            img.isPrimary = false;
            if (img.role === 'primary') img.role = 'angle';
        });
        currentUploadedImages.unshift(newImg);
        currentUploadedBase64 = imageDataUrl;
    } else {
        currentUploadedImages.push(newImg);
    }
    renderUploadedImagePreviews();
    const promptSection = document.getElementById('sellingPointsSection');
    if (promptSection) promptSection.classList.remove('hidden');
    if (typeof showToast === 'function') {
        showToast(`已成功将图片设为详情页${asPrimary ? '主图' : '参考图'}！`, 'success');
    }
}

function clearDetailInputs() {
    const nameInput = document.getElementById('productNameInput');
    const pointsText = document.getElementById('sellingPointsText');
    const factsText = document.getElementById('productFactsText');
    const claimsText = document.getElementById('forbiddenClaimsText');
    if (nameInput) nameInput.value = '';
    if (pointsText) pointsText.value = '';
    if (factsText) factsText.value = '';
    if (claimsText) claimsText.value = '';
    if (typeof showToast === 'function') showToast('已清空详情页输入内容', 'info');
}

// 根据模块类型选择传给模型的图片素材，多角度模块会带上更多角度参考图。
function getImagesForTask(task) {
    const primaryImage = globalGenContext.primaryImage;
    const angleImages = globalGenContext.angleImages || [];
    const byRole = role => angleImages.filter(img => img.role === role);
    let preferred = [];
    if (task.id === 'm3' || task.id === 'm5') preferred = byRole('scene');
    else if (task.id === 'm6' || task.id === 'm16') preferred = byRole('detail');
    else if (task.id === 'm8' || task.id === 'm10') preferred = byRole('spec');
    else if (task.id === 'm11' || task.id === 'm13' || task.id === 'm14') preferred = byRole('package');
    else if (task.id === 'm4' || task.id === 'm15') preferred = byRole('angle');
    const fallback = (task.id === 'm4' || task.id === 'm13') ? angleImages : [];
    return primaryImage ? [primaryImage, ...preferred, ...fallback].slice(0, 6) : [];
}

// 初始化模块选择网格，显示模块卡片、分类筛选、实时统计与紧凑控制底栏。
function initModules() {
    const grid = document.getElementById('moduleGrid');
    if (!grid) return;
    grid.innerHTML = '';

    if (typeof updatePresetButtonsUI === 'function') {
        updatePresetButtonsUI();
    }

    const targetModules = (typeof modules !== 'undefined' && Array.isArray(modules))
        ? modules
        : ((typeof globalThis !== 'undefined' && globalThis.modules) || []);

    const activeModules = targetModules.filter(m => m.active);
    const activeCount = activeModules.length;
    const totalImageCount = targetModules.reduce((sum, m) => sum + (m.active ? (Number(m.count) || 1) : 0), 0);

    // 1. 更新顶部已选模块统计徽标
    const statsBadge = document.getElementById('moduleSelectionStatsBadge');
    if (statsBadge) {
        if (activeCount > 0) {
            statsBadge.className = 'text-[10px] font-bold text-blue-700 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-full truncate';
            statsBadge.textContent = `已选 ${activeCount} 模块 · 共 ${totalImageCount} 张图`;
        } else {
            statsBadge.className = 'text-[10px] font-medium text-slate-400 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded-full truncate';
            statsBadge.textContent = '未选择模块';
        }
    }

    // 2. 渲染模块分类筛选 Tabs
    const tabsContainer = document.getElementById('moduleCategoryTabs');
    if (tabsContainer) {
        const catKeys = ['all', 'selected', 'core', 'brand', 'specs', 'bundle'];
        tabsContainer.innerHTML = catKeys.map(catKey => {
            const cat = MODULE_CATEGORIES[catKey];
            if (!cat) return '';
            const isCurrent = currentModuleCategory === catKey;
            let countBadge = '';
            if (catKey === 'all') {
                countBadge = `<span class="opacity-70 text-[9px] ml-0.5 font-normal">(${targetModules.length})</span>`;
            } else if (catKey === 'selected') {
                countBadge = `<span class="${activeCount > 0 ? (isCurrent ? 'bg-white text-blue-600' : 'bg-blue-100 text-blue-700') : 'bg-slate-200/60 text-slate-400'} text-[9px] px-1 py-0.2 rounded-full ml-0.5 font-black">${activeCount}</span>`;
            } else {
                const catActive = cat.ids.filter(id => targetModules.find(m => m.id === id)?.active).length;
                countBadge = catActive > 0
                    ? `<span class="${isCurrent ? 'bg-white text-blue-600' : 'bg-blue-100 text-blue-700'} text-[9px] px-1 py-0.2 rounded-full ml-0.5 font-black">${catActive}/${cat.ids.length}</span>`
                    : `<span class="opacity-60 text-[9px] ml-0.5 font-normal">(${cat.ids.length})</span>`;
            }
            const activeTabClass = 'bg-blue-600 text-white shadow-2xs cursor-default font-black';
            const inactiveTabClass = 'bg-slate-100 text-slate-600 hover:bg-slate-200/80 hover:text-slate-900 cursor-pointer font-medium';
            return `<button type="button" onclick="setModuleCategoryFilter('${catKey}')" class="px-2 py-0.5 rounded-md transition-all whitespace-nowrap flex items-center shrink-0 ${isCurrent ? activeTabClass : inactiveTabClass}">
                <span>${cat.label}</span>${countBadge}
            </button>`;
        }).join('');
    }

    // 3. 根据当前分类筛选展示模块
    let displayModules = targetModules;
    if (currentModuleCategory === 'selected') {
        displayModules = targetModules.filter(m => m.active);
    } else if (currentModuleCategory !== 'all' && MODULE_CATEGORIES[currentModuleCategory]?.ids) {
        const catIds = MODULE_CATEGORIES[currentModuleCategory].ids;
        displayModules = targetModules.filter(m => catIds.includes(m.id));
    }

    // 4. 空状态处理
    if (!displayModules.length) {
        grid.innerHTML = `
            <div class="col-span-2 py-8 px-4 text-center rounded-xl bg-slate-50 border border-dashed border-slate-200 text-slate-400 text-xs flex flex-col items-center justify-center gap-2">
                <i class="ph-bold ph-squares-four text-2xl text-slate-300"></i>
                <span>${currentModuleCategory === 'selected' ? '暂无已选模块，请点击分类标签挑选模块' : '当前分类下暂无模块'}</span>
                <button type="button" onclick="setModuleCategoryFilter('all')" class="text-[11px] font-bold text-blue-600 hover:underline cursor-pointer">查看全部 18 个模块</button>
            </div>`;
        return;
    }

    // 5. 渲染模块卡片
    displayModules.forEach(mod => {
        const isAct = Boolean(mod.active);
        const activeClasses = isAct
            ? 'border-blue-500 bg-blue-50/70 shadow-xs ring-1 ring-blue-400/40'
            : 'border-slate-200/90 bg-white hover:border-blue-200 hover:shadow-2xs';
        const titleClasses = isAct ? 'text-blue-700' : 'text-slate-800';

        let orderBadgeHTML = '';
        if (isAct) {
            const activeIdx = activeModules.findIndex(m => m.id === mod.id);
            orderBadgeHTML = `<span class="absolute top-2 right-2 w-5 h-5 rounded-full bg-blue-600 text-white text-[10px] font-black flex items-center justify-center shadow-2xs ring-2 ring-white" title="全案生成顺序第 ${activeIdx + 1} 位">#${activeIdx + 1}</span>`;
        }

        const platformTag = (typeof MODULE_PLATFORM_TAGS !== 'undefined' && MODULE_PLATFORM_TAGS[mod.id])
            ? MODULE_PLATFORM_TAGS[mod.id]
            : { label: '通用', class: 'bg-slate-100 text-slate-600 border-slate-200' };
        const tagHTML = `<span class="text-[9px] px-1.5 py-0.5 rounded border font-bold ${platformTag.class}">${platformTag.label}</span>`;

        let footerControlHTML = '';
        if (isAct) {
            const includeText = mod.includeText !== false;
            const selectedCopyClass = 'bg-blue-600 text-white';
            const unselectedCopyClass = 'bg-white text-slate-500 hover:text-blue-600';
            footerControlHTML = `
                <div class="mt-2.5 pt-2 border-t border-blue-100 flex items-center justify-between gap-1 select-none" onclick="event.stopPropagation()">
                    <div class="flex items-center gap-1">
                        <span class="text-[9px] text-slate-400 font-bold">张数</span>
                        <div class="flex items-center bg-white rounded border border-slate-200 shadow-2xs">
                            <button type="button" onclick="updateModuleCount('${mod.id}', -1)" class="w-5 h-4 flex items-center justify-center text-slate-400 hover:text-blue-600 disabled:opacity-25 cursor-pointer" ${mod.count <= 1 ? 'disabled' : ''} title="减少张数"><i class="ph-bold ph-minus text-[8px]"></i></button>
                            <span class="text-[10px] font-black w-3.5 text-center text-blue-700">${mod.count}</span>
                            <button type="button" onclick="updateModuleCount('${mod.id}', 1)" class="w-5 h-4 flex items-center justify-center text-slate-400 hover:text-blue-600 disabled:opacity-25 cursor-pointer" ${mod.count >= 5 ? 'disabled' : ''} title="增加张数"><i class="ph-bold ph-plus text-[8px]"></i></button>
                        </div>
                    </div>
                    <div class="flex items-center">
                        <div class="flex rounded border border-slate-200 overflow-hidden bg-white shadow-2xs text-[9px] font-bold" title="${includeText ? '当前画面将生成排版文字与视觉卖点' : '当前为纯净出图，不添加任何额外文案/标线'}">
                            <button type="button" onclick="updateModuleIncludeText('${mod.id}', true)" class="px-1.5 h-4 transition-colors cursor-pointer ${includeText ? selectedCopyClass : unselectedCopyClass}">含字</button>
                            <button type="button" onclick="updateModuleIncludeText('${mod.id}', false)" class="px-1.5 h-4 transition-colors cursor-pointer ${!includeText ? selectedCopyClass : unselectedCopyClass}">纯图</button>
                        </div>
                    </div>
                </div>`;
        } else {
            footerControlHTML = `
                <div class="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-between text-[9px] text-slate-400 font-medium select-none">
                    <span>点击选择</span>
                    <i class="ph ph-plus-circle text-xs text-slate-400"></i>
                </div>`;
        }

        grid.insertAdjacentHTML('beforeend', `
            <div onclick="toggleModule('${mod.id}')" class="relative cursor-pointer border rounded-xl p-2.5 transition-all flex flex-col justify-between min-h-[106px] ${activeClasses}">
                ${orderBadgeHTML}
                <div>
                    <div class="text-xs font-bold ${titleClasses} mb-1 pr-6 leading-tight">${detailEscapeHtml(mod.title)}</div>
                    <div class="mb-1">${tagHTML}</div>
                    <div class="text-[10px] text-slate-400 line-clamp-2 leading-snug" title="${detailEscapeHtml(mod.subtitle)}">${detailEscapeHtml(mod.subtitle)}</div>
                </div>
                ${footerControlHTML}
            </div>`);
    });
}

// 获取当前已启用模块对应的策略任务，并合并手动 prompt 覆盖。
function getCurrentStrategyTasks() {
    const config = getDetailConfig();
    if (!config) return null;
    const sellingPoints = document.getElementById('sellingPointsText')?.value || '';
    const activeModules = modules.filter(m => m.active);
    return applyStrategyOverrides(
        buildStrategyTasks(activeModules, sellingPoints, config),
        typeof detailStrategyOverrides === 'object' ? detailStrategyOverrides : {}
    );
}

// 打开生成前策略预览弹窗，允许编辑每个模块本次使用的 prompt。
function openStrategyPreview() {
    const modal = document.getElementById('detailStrategyModal');
    if (modal && modal.parentElement !== document.body) {
        document.body.appendChild(modal);
    }
    const tasks = getCurrentStrategyTasks();
    if (!tasks || !tasks.length) {
        showToast('请至少选择一个模块', 'error');
        return;
    }
    const container = document.getElementById('detailStrategyContent');
    if (!container) return;
    const config = getDetailConfig();
    const sellingPoints = document.getElementById('sellingPointsText')?.value.trim() || '';
    currentStrategyPreviewContext = { tasks, sellingPoints, config };
    container.innerHTML = tasks.map(task => {
        const promptPreview = buildStrategyPromptPreview(task, sellingPoints, config || {});
        return `
        <div class="border border-gray-200 rounded-xl p-4 bg-white shadow-sm">
            <div class="flex items-start justify-between gap-3 mb-3">
                <div>
                    <div class="text-sm font-black text-gray-800">${detailEscapeHtml(task.displayTitle)}</div>
                    <div class="text-[11px] text-gray-600 mt-1 leading-relaxed">${detailEscapeHtml(task.strategyCn?.goal || '')}</div>
                </div>
                <span class="text-[10px] font-bold text-blue-600 bg-blue-50 border border-blue-100 px-2 py-1 rounded">${detailEscapeHtml(task.subtitle || '')}</span>
            </div>
            ${task.focalFeature ? `
            <div class="mb-3 px-3 py-1.5 bg-blue-50/80 border border-blue-100 rounded-lg flex items-center gap-2 text-xs text-blue-900">
                <span class="font-bold text-[10px] uppercase tracking-wider bg-blue-200 text-blue-900 px-1.5 py-0.5 rounded shrink-0">卖点焦点</span>
                <span class="truncate font-medium">${detailEscapeHtml(task.focalFeature)}</span>
            </div>` : ''}
            <div class="grid grid-cols-2 gap-3 mb-3">
                <div class="bg-slate-50 border border-slate-100 rounded-lg p-3">
                    <div class="text-[10px] font-black text-slate-400 mb-1">画面方向</div>
                    <div class="text-xs text-slate-700 leading-relaxed">${detailEscapeHtml(task.strategyCn?.visual || '')}</div>
                </div>
                <div class="bg-red-50/50 border border-red-100 rounded-lg p-3">
                    <div class="text-[10px] font-black text-red-400 mb-1">避免事项</div>
                    <div class="text-xs text-red-700 leading-relaxed">${detailEscapeHtml(task.strategyCn?.avoid || '')}</div>
                </div>
            </div>
            <details class="group">
                <summary class="cursor-pointer text-[11px] font-bold text-blue-600 hover:text-blue-700 select-none">编辑模块请求</summary>
                <div class="mt-2 text-[10px] font-bold text-gray-400">这段是模块方向，会被拼进下面的完整最终 Prompt。</div>
                <textarea data-strategy-id="${detailEscapeHtml(task.uniqueId)}" rows="3"
                    oninput="updateStrategyFullPrompt('${detailEscapeHtml(task.uniqueId)}')"
                    class="mt-1 w-full text-xs leading-relaxed border border-gray-200 rounded-lg p-3 outline-none focus:border-blue-500 resize-none bg-slate-50">${detailEscapeHtml(promptPreview.moduleRequest)}</textarea>
            </details>
            <details class="group mt-3">
                <summary class="cursor-pointer text-[11px] font-bold text-slate-600 hover:text-slate-800 select-none">查看完整最终 Prompt</summary>
                <div class="mt-2 text-[10px] font-bold text-gray-400">这是实际发送给图片模型的完整提示词预览，包含商品信息、平台、风格、禁用词和生成约束。</div>
                <textarea data-full-prompt-id="${detailEscapeHtml(task.uniqueId)}" rows="10" readonly
                    class="mt-1 w-full text-xs leading-relaxed border border-gray-200 rounded-lg p-3 outline-none bg-gray-50 text-gray-600 resize-y">${detailEscapeHtml(promptPreview.fullPrompt)}</textarea>
            </details>
        </div>
    `;
    }).join('');
    modal?.classList.remove('hidden');
}

// 根据当前编辑的模块请求实时刷新完整最终 Prompt 预览。
function updateStrategyFullPrompt(uniqueId) {
    const context = currentStrategyPreviewContext;
    if (!context) return;
    const task = context.tasks.find(item => item.uniqueId === uniqueId);
    const moduleField = document.querySelector(`[data-strategy-id="${CSS.escape(uniqueId)}"]`);
    const fullField = document.querySelector(`[data-full-prompt-id="${CSS.escape(uniqueId)}"]`);
    if (!task || !moduleField || !fullField) return;
    const promptPreview = buildStrategyPromptPreview(
        { ...task, prompt: moduleField.value },
        context.sellingPoints,
        context.config || {}
    );
    fullField.value = promptPreview.fullPrompt;
}

// 关闭生成前策略预览弹窗。
function closeStrategyPreview() {
    document.getElementById('detailStrategyModal')?.classList.add('hidden');
}

// 应用策略预览里编辑过的模块 prompt 覆盖。
function applyStrategyPreview() {
    const fields = document.querySelectorAll('[data-strategy-id]');
    fields.forEach(field => {
        const id = field.dataset.strategyId;
        const value = field.value.trim();
        if (id && value) detailStrategyOverrides[id] = value;
    });
    closeStrategyPreview();
    showToast('已应用本次生成策略', 'success');
}

// 切换某个详情页模块的启用状态。
function toggleModule(id) {
    const targetModules = (typeof modules !== 'undefined' && Array.isArray(modules))
        ? modules
        : ((typeof globalThis !== 'undefined' && globalThis.modules) || []);
    const mod = targetModules.find(m => m.id === id);
    if (mod) {
        mod.active = !mod.active;
        if (mod.active && typeof mod.includeText === 'undefined') {
            mod.includeText = true;
        }
        if (typeof initModules === 'function') initModules();
    }
}

// 调整模块生成张数，并限制在允许范围内。
function updateModuleCount(id, delta) {
    const targetModules = (typeof modules !== 'undefined' && Array.isArray(modules))
        ? modules
        : ((typeof globalThis !== 'undefined' && globalThis.modules) || []);
    const mod = targetModules.find(m => m.id === id);
    if (mod) {
        let newCount = (Number(mod.count) || 1) + delta;
        if (newCount >= 1 && newCount <= 5) {
            mod.count = newCount;
            if (typeof initModules === 'function') initModules();
        }
    }
}

// 只更新目标模块的文案模式，不影响模块启用状态或张数。
function setModuleIncludeText(moduleList = [], moduleId = '', includeText = true) {
    const mod = Array.isArray(moduleList) ? moduleList.find(item => item.id === moduleId) : null;
    if (!mod) return false;
    mod.includeText = includeText !== false;
    return true;
}

// 切换模块生成图是否允许新增可见文案。
function updateModuleIncludeText(moduleId, includeText) {
    if (setModuleIncludeText(modules, moduleId, includeText)) initModules();
}

// 根据比例下拉状态显示或隐藏自定义宽高比输入区。
function toggleCustomRatio() {
    const select = document.getElementById('aspectRatioSelect');
    const container = document.getElementById('customRatioContainer');
    if (select.value === 'custom') {
        container.classList.remove('hidden'); container.classList.add('grid');
    } else {
        container.classList.add('hidden'); container.classList.remove('grid');
    }
}

// ====== 图像上传与粘贴处理 ======
// 处理用户上传或粘贴的主图和角度素材，完成类型/大小校验、base64 转换和预览刷新。
async function ingestDetailImageFiles(files) {
    const rawFiles = Array.from(files || []);
    if (!rawFiles.length) return false;
    const remainingSlots = DETAIL_MAX_UPLOAD_IMAGES - currentUploadedImages.length;
    if (remainingSlots <= 0) {
        showToast(`最多上传 ${DETAIL_MAX_UPLOAD_IMAGES} 张素材`, 'warning');
        return false;
    }
    const selectedFiles = rawFiles.slice(0, remainingSlots);
    if (rawFiles.length > remainingSlots) {
        showToast(`最多保留 ${DETAIL_MAX_UPLOAD_IMAGES} 张素材，已自动忽略多余图片`, 'warning');
    }

    const validFiles = [];
    for (const file of selectedFiles) {
        if (!file.type || !file.type.startsWith('image/')) {
            showToast('请上传图片文件', 'error');
            return false;
        }
        if (file.size > DETAIL_IMAGE_MAX_BYTES) {
            showToast('图片过大，请压缩到 8MB 以内', 'error');
            return false;
        }
        validFiles.push(file);
    }

    try {
        const uploaded = await Promise.all(validFiles.map(async (file, idx) => {
            const base64 = await fileToDataUrl(file);
            return {
                id: `detail_img_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 8)}`,
                name: file.name || `detail_pasted_${Date.now()}_${idx + 1}.png`,
                base64,
                isPrimary: false,
                ...parseImageDataUrl(base64)
            };
        }));
        currentUploadedImages = [...currentUploadedImages, ...uploaded]
            .slice(0, DETAIL_MAX_UPLOAD_IMAGES)
            .map((img, index) => ({ ...img, isPrimary: index === 0, role: index === 0 ? 'primary' : img.role || 'angle' }));
        currentUploadedBase64 = currentUploadedImages[0]?.base64 || null;
        renderUploadedImagePreviews();
        const angleCount = Math.max(0, currentUploadedImages.length - 1);
        showToast(angleCount ? `已添加 ${currentUploadedImages.length} 张素材，多角度图将优先使用角度素材` : '主图素材添加成功', 'success');
        return true;
    } catch (e) {
        console.error(e);
        showToast('图片读取失败', 'error');
        return false;
    }
}

async function handleImageUpload(event) {
    try {
        await ingestDetailImageFiles(event?.target?.files);
    } finally {
        if (event?.target) event.target.value = '';
    }
}

async function handleDetailImagePaste(files) {
    const fileList = Array.isArray(files) ? files : [files].filter(Boolean);
    return await ingestDetailImageFiles(fileList);
}

function handleDetailImageDrop(event) {
    if (event?.preventDefault) event.preventDefault();
    const dtFiles = Array.from(event?.dataTransfer?.files || []).filter(f => f.type && f.type.startsWith('image/'));
    if (dtFiles.length) {
        ingestDetailImageFiles(dtFiles);
    }
}


// 删除单张或全部上传素材，并同步主图状态和预览。
function removeImage(index = null) {
    if (index === null || index === undefined) {
        currentUploadedImages = [];
    } else {
        currentUploadedImages.splice(index, 1);
        currentUploadedImages = currentUploadedImages.map((img, idx) => ({ ...img, isPrimary: idx === 0, role: idx === 0 ? 'primary' : (img.role === 'primary' ? 'angle' : img.role || 'angle') }));
    }
    currentUploadedBase64 = currentUploadedImages[0]?.base64 || null;
    document.getElementById('imageUpload').value = '';
    renderUploadedImagePreviews();
}

// ====== 生成逻辑 ======
// 调用文本模型从上传图片中提取产品事实、核心卖点、适用人群、场景和风险提示。
async function generateSellingPoints() {
    const logMsg = "开始提取核心卖点...";
    console.log(`%c[详情页] ${logMsg}`, "color: #6366f1; font-weight: bold;");
    remoteLog(logMsg);
    const btn = document.getElementById('aiWriteBtn');
    const textArea = document.getElementById('sellingPointsText');
    const productNameInput = document.getElementById('productNameInput');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="loader w-3 h-3 border-2 border-blue-500 border-t-transparent mr-1"></span> 生成中...';
    btn.disabled = true;

    const sellingPointImages = [getPrimaryUploadedImage(), ...getAngleUploadedImages().slice(0, 2)].filter(Boolean);
    const currentProductName = productNameInput?.value.trim() || '';
    const currentSellingPoints = textArea?.value || '';
    const outputLanguage = getDetailConfig().language || 'English';
    const productFacts = document.getElementById('productFactsText')?.value.trim() || '';
    const forbiddenClaims = document.getElementById('forbiddenClaimsText')?.value.trim() || '';
    let parts = [{
        text: buildSellingPointsExtractionPrompt(
            sellingPointImages.length || 1,
            productFacts,
            forbiddenClaims,
            currentProductName,
            outputLanguage
        )
    }];
    if (sellingPointImages.length) {
        if (sellingPointImages.length > 1) {
            parts[0].text += `\n\n我同时提供了 ${sellingPointImages.length} 张商品素材。第一张是主图，后续为角度/细节参考。请综合判断，但不要把不同角度误认为不同产品。`;
        }
        sellingPointImages.forEach(img => {
            parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
        });
    } else { showToast('未上传图片，将仅使用预设文案测试', 'info'); }

    try {
        const payload = { contents: [{ role: "user", parts: parts }] };
        remoteLog(`正在提取产品卖点 (视觉解析模式)...`);
        const res = await callAI("text", payload);
        const rawText = res.candidates?.[0]?.content?.parts?.[0]?.text;
        const parsed = parseSellingPointsResponse(rawText);
        if (!parsed.sellingPoints) {
            throw new Error('AI 返回内容缺少核心卖点');
        }
        const nextState = resolveSellingPointsFormState(
            currentProductName,
            currentSellingPoints,
            parsed
        );
        if (productNameInput && nextState.didFillProductName) {
            productNameInput.value = nextState.productName;
        }
        textArea.value = nextState.sellingPoints;
        const factsInput = document.getElementById('productFactsText');
        if (factsInput && !factsInput.value.trim() && nextState.productFacts) {
            factsInput.value = nextState.productFacts;
        }
        const forbiddenInput = document.getElementById('forbiddenClaimsText');
        if (forbiddenInput && !forbiddenInput.value.trim() && nextState.forbiddenClaims) {
            forbiddenInput.value = nextState.forbiddenClaims;
        }
        showToast('卖点提取成功', 'success');

        // AI 自动匹配画面风格与独立站排版风格
        const matchedStyle = applyRecommendedStyle(
            parsed.recommendedImageStyle || '',
            [nextState.productName, nextState.sellingPoints, nextState.productFacts].filter(Boolean).join(' ')
        );
        if (matchedStyle) {
            showToast(`已智能匹配视觉风格: 【${matchedStyle.label}】`, 'info');
        }

        remoteLog(
            nextState.didFillProductName
                ? `卖点提取成功，已自动识别产品名称: ${nextState.productName}`
                : '卖点提取成功，已保留现有产品名称'
        );
    } catch (err) {
        console.error(err); showToast('生成失败', 'error');
        remoteLog(`卖点提取失败: ${err.message}`);
    } finally {
        btn.innerHTML = origHtml; btn.disabled = false;
    }
}

// 调用文本模型为单个详情页模块生成 SEO 标题和 Alt 文案。
async function generateSEOMetadata(task, sellingPoints, options = {}) {
    const prompt = buildSEOMetadataPrompt(task, sellingPoints, globalGenContext?.config || {});

    try {
        remoteLog(`正在为模块 [${task.title}] 生成 SEO 元数据...`);
        const res = await callAI("text", {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        }, options);
        const text = res.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
            const data = JSON.parse(text);
            const getVal = (obj) => typeof obj === 'string' ? { target: obj, zh: '' } : { target: obj?.target || '', zh: obj?.zh || '' };

            const titleData = getVal(data.seoTitle);
            const altData = getVal(data.altText);
            const seo = {
                titleTarget: titleData.target,
                titleZh: titleData.zh,
                altTarget: altData.target,
                altZh: altData.zh
            };
            setModuleSeo(task.uniqueId, seo);
            task.seo = seo;
            remoteLog(`模块 [${task.title}] SEO 元数据生成成功`);
            return seo;
        }
    } catch (e) {
        if (e.name === 'AbortError' || options?.signal?.aborted) return null;
        console.warn("SEO Gen Fail:", e);
        remoteLog(`模块 [${task.title}] SEO 生成失败: ${e.message}`);
    }
    return null;
}

// 默认英文语义文案预设字典，杜绝非中文模式下泄露中文模块标题或默认值
const MODULE_DEFAULT_EN = {
    m1: {
        tagline: 'CORE ADVANTAGE',
        headline: 'Engineered for Exceptional Daily Performance',
        subheadline: 'Crafted to elevate your daily routine with seamless comfort, precision, and durability.',
        fbr: [
            { feature: 'Thoughtful Design', benefit: 'Engineered with user-first ergonomics for immediate everyday ease.' },
            { feature: 'Verified Reliability', benefit: 'Rigorous manufacturing standards ensure lasting peace of mind.' }
        ]
    },
    m2: {
        tagline: 'TARGETED BENEFIT',
        headline: 'Engineered for Effortless Daily Use',
        subheadline: 'Intelligently resolves common hassles with targeted precision and intuitive design.',
        fbr: [
            { feature: 'Targeted Solution', benefit: 'Directly addresses daily needs for a noticeably better experience.' },
            { feature: 'Instant Ease', benefit: 'Enjoy effortless everyday operation straight out of the box.' }
        ]
    },
    m3: {
        tagline: 'VERSATILE FIT',
        headline: 'Fits Naturally into Any Routine',
        subheadline: 'Adapts seamlessly whether you are at home, in the office, or on the go.',
        fbr: [
            { feature: 'Multi-Scene Adaptability', benefit: 'Performs reliably across diverse daily scenarios.' },
            { feature: 'Modern Aesthetics', benefit: 'Clean minimalist profile complements any setting.' }
        ]
    },
    m4: {
        tagline: 'AUTHENTIC DETAILS',
        headline: 'Excellence Across Every Angle',
        subheadline: 'Inspect every refined contour, seamless seam, and balanced proportion with complete confidence.',
        fbr: [
            { feature: 'Refined Proportions', benefit: 'Engineered with balanced geometry and tactile comfort.' },
            { feature: 'Premium Touch', benefit: 'Carefully refined tactile surface feels natural to the touch.' }
        ]
    },
    m5: {
        tagline: 'LIFESTYLE ESSENTIAL',
        headline: 'Elevate Your Personal Space',
        subheadline: 'Designed to bring calm focus and effortless organization to your daily environment.',
        fbr: [
            { feature: 'Harmonious Design', benefit: 'Naturally blends with your existing home or workspace decor.' },
            { feature: 'Ambient Comfort', benefit: 'Creates an inviting, clutter-free atmosphere.' }
        ]
    },
    m6: {
        tagline: 'PREMIUM CRAFTSMANSHIP',
        headline: 'Built with Heavy-Duty Materials',
        subheadline: 'Constructed from top-tier, resilient components built to withstand heavy everyday use.',
        fbr: [
            { feature: 'Premium Construction', benefit: 'Selected high-quality materials resist everyday wear and tear.' },
            { feature: 'Refined Detailing', benefit: 'Meticulous attention to every joint, seam, and finished surface.' }
        ]
    },
    m7: {
        tagline: 'BRAND INTEGRITY',
        headline: 'Dedicated to Timeless Quality',
        subheadline: 'Every design choice reflects our commitment to practical elegance and lasting value.',
        fbr: [
            { feature: 'Verified Standards', benefit: 'Certified for consumer safety and strict environmental standards.' },
            { feature: 'Customer-First Care', benefit: 'Backed by dedicated specialist support whenever you need help.' }
        ]
    },
    m8: {
        tagline: 'COMPACT FIT',
        headline: 'Space-Saving Precision Dimensions',
        subheadline: 'Maximized functional capacity with a minimized physical footprint.',
        fbr: [
            { feature: 'Smart Ergonomics', benefit: 'Compact enough for tight spaces without sacrificing utility.' },
            { feature: 'Effortless Storage', benefit: 'Folds or stores away cleanly in seconds.' }
        ]
    },
    m9: {
        tagline: 'UPGRADED ADVANTAGE',
        headline: 'Why It Outperforms the Competition',
        subheadline: 'Key engineering upgrades solve the shortcomings of conventional alternatives.',
        fbr: [
            { feature: 'Upgraded Core Efficiency', benefit: 'Delivers superior performance with noticeably less effort.' },
            { feature: 'Longer Working Lifespan', benefit: 'Reinforced stress points prevent premature wear and breakdowns.' }
        ]
    },
    m10: {
        tagline: 'TRANSPARENT DETAILS',
        headline: 'What’s In The Box & Specifications',
        subheadline: 'Verified technical specifications and full package inclusions with zero surprises.'
    },
    m11: {
        tagline: 'FREQUENTLY ASKED QUESTIONS',
        headline: 'Got Questions? We’ve Got Answers',
        subheadline: 'Everything you need to know before making your purchase decision.'
    },
    m12: {
        tagline: 'EASY 3-STEP GUIDE',
        headline: 'How Simple It Is To Use',
        subheadline: 'Zero technical knowledge required. Ready out of the box in seconds.'
    },
    m13: {
        tagline: 'ALL-IN-ONE KIT',
        headline: "What's In The Box",
        subheadline: 'Every essential tool and accessory, organized and ready out of the box.'
    },
    m14: {
        tagline: 'BUNDLE & SAVE',
        headline: 'Complete System Advantage',
        subheadline: 'Get the full setup together and save significantly compared to single items.'
    },
    m15: {
        tagline: 'STEP GUIDE',
        headline: 'Simple Operational Flow',
        subheadline: 'Intuitive steps designed for effortless daily execution.'
    },
    m16: {
        tagline: 'PRECISION ACCESSORIES',
        headline: 'High-Spec Attachments Included',
        subheadline: 'Every included accessory is built with the same uncompromising standards as the main unit.'
    },
    m17: {
        tagline: 'PRECISION CRAFTSMANSHIP',
        headline: 'Engineered from the Inside Out',
        subheadline: 'Every core internal component is meticulously designed for high performance and durability.',
        fbr: [
            { feature: 'Precision Architecture', benefit: 'Engineered with premium internal components for long-term durability.' },
            { feature: 'Seamless Assembly', benefit: 'Tight tolerances guarantee lasting performance and smooth daily operation.' }
        ]
    },
    m18: {
        tagline: 'COMMUNITY PRAISE',
        headline: 'Loved by Real Customers',
        subheadline: 'Real reviews and everyday experiences from our verified community.',
        fbr: [
            { feature: '5-Star Satisfaction', benefit: 'Consistently praised for ease of use, durability, and premium tactile feel.' },
            { feature: 'Everyday Reliable', benefit: 'Over 98% of users recommend this to friends and family.' }
        ]
    }
};

function hasChineseText(str) {
    return typeof str === 'string' && /[\u4e00-\u9fa5]/.test(str);
}

// 为单个详情页模块调用文本模型生成符合《独立站商品详情页规范》的语义化 HTML 文案
async function generateDtcSectionCopy(task, sellingPoints, config = {}, options = {}) {
    const moduleTitle = getPromptModuleTitle(task);
    const lang = config.language || 'English';
    const isTargetZh = lang === 'Chinese' || lang === '中文';
    const guardrails = buildProductGuardrails(config);
    const isStep = task.id === 'm12' || task.id === 'm4' || task.id === 'm15';
    const isSpecs = task.id === 'm10' || task.id === 'm8';
    const isFaq = task.id === 'm11';
    const isBundleBox = task.id === 'm13';
    const isBundleSavings = task.id === 'm14';

    // 动态解析商品上下文与当前模块专属卖点
    const productName = config.productName || (typeof document !== 'undefined' ? document.getElementById('productNameInput')?.value.trim() : '') || '';
    const brandName = config.brandName || (typeof window !== 'undefined' && window.brandContextHub?.getActiveProfile()?.brandName) || '';
    const focal = (task.focalFeature && task.role)
        ? { focalFeature: task.focalFeature, role: task.role }
        : resolveModuleFocalFeature(task, sellingPoints, config);
    const focalFeature = task.focalFeature || focal.focalFeature || '';
    const role = task.role || focal.role || getModuleContentRole(task, sellingPoints, config);
    const variantNum = Number(task.variant || 0);
    const totalVariants = Number(task.totalVariants || 1);

    const defaultEn = MODULE_DEFAULT_EN[task.id] || {
        tagline: 'KEY ADVANTAGE',
        headline: 'Engineered for Performance',
        subheadline: 'Crafted with premium materials for effortless daily reliability.',
        fbr: [
            { feature: 'Thoughtful Design', benefit: 'Engineered with user-first ergonomics for immediate everyday ease.' },
            { feature: 'Verified Reliability', benefit: 'Rigorous manufacturing standards ensure lasting peace of mind.' }
        ]
    };

    let prompt = `You are a world-class DTC e-commerce conversion copywriter for leading modern consumer brands.
Create clean, high-converting, mobile-first PDP (Product Detail Page) section copy in ${lang} for the module "${moduleTitle}".

PRODUCT CONTEXT:
${productName ? `- Product Name: ${productName}\n` : ''}${brandName ? `- Brand Name: ${brandName}\n` : ''}- Section Module: "${moduleTitle}" (${task.displayTitle || task.title || moduleTitle})
${focalFeature ? `- Module Focal Feature / Target Angle: ${focalFeature}\n` : ''}- Section Conversion Goal: ${role}
${totalVariants > 1 ? `- Variant: version ${variantNum + 1} of ${totalVariants}. Differentiate this copy to focus specifically on "${focalFeature || moduleTitle}" rather than repeating generic claims.\n` : ''}Product information: ${compactDetailText(sellingPoints, 1200)}
${guardrails ? `\n${guardrails}` : ''}

CRITICAL RULES FOR FACTUAL GROUNDING & COMPLIANCE (STRICT):
1. FACTUAL GROUNDING: Base all copy strictly on the verified product name, category, and selling points provided above.
2. NO INVENTED MATERIALS: Never invent materials that do not belong to the product. (For example, if the product is glass, ceramic, wood, fabric, or organic, NEVER invent alloy, titanium, or composite claims).
3. NO INVENTED ACCESSORIES OR ELECTRONICS: Never invent chargers, USB cables, batteries, apps, bluetooth, or storage cases unless explicitly listed in the confirmed product facts.
4. NO HIGH-RISK OR MEDICAL CLAIMS: Never make medical, therapeutic, pain-relief, curative, or body-transformation claims unless the product is explicitly verified for such use.
5. FOCUSED HEADLINES: The headline, subheadline, and highlights MUST focus specifically on this module's assigned Focal Feature ("${focalFeature || moduleTitle}"). Avoid generic one-size-fits-all slogans.

CRITICAL RULES FOR BREVITY & SCANNABILITY (CONCISE, CLEAR, ZERO FLUFF):
- Real shoppers scan on mobile in 3 seconds. DO NOT write long paragraphs or dense compound sentences.
- Never use hype words or empty fluff ("revolutionary", "miracle", "perfection", "ultimate", "game changer").
- Headlines: Punchy and bold (3 to 6 words maximum).
- Subheadlines / Intros: Exactly 1 short crisp sentence (10 to 16 words maximum).
- Bullet Highlights: Exactly 2 to 3 points maximum. Format each as a 2-4 word bold anchor keyword ("feature") + a crisp 8-12 word practical takeaway sentence ("benefit").
- Tagline: 2-3 words uppercase category/benefit kicker tightly aligned with the focal feature (e.g. DAILY COMFORT, PRECISION CRAFT, PURE TASTE).

CRITICAL LANGUAGE REQUIREMENT (STRICT & MANDATORY):
- Target language: ${lang}.
- Every single text string in the returned JSON (tagline, headline, subheadline, features, benefits, steps, faqs, specifications, etc.) MUST be written 100% in ${lang}.
- Even if the input product information, facts, or instructions are in Chinese, you MUST translate and adapt all copy entirely into ${lang}.
${!isTargetZh ? '- STRICT PROHIBITION: DO NOT output any Chinese characters (汉字) anywhere in the response. All text MUST be strictly in ' + lang + '.' : ''}
`;

    if (isBundleBox) {
        prompt += `
Return a JSON object following this schema. List ONLY items actually confirmed in the product facts. Do NOT invent chargers, cables, or cases:
{
  "tagline": "EVERYTHING INCLUDED",
  "headline": "What's In The Box",
  "subheadline": "Every essential item, organized and ready out of the box.",
  "items": [
    {"name": "<Primary Product Name>", "count": "1×", "desc": "<Factual concise role>"}
  ]
}`;
    } else if (isBundleSavings) {
        prompt += `
Return a JSON object. STRICT PRICING RULE: If exact prices are not confirmed in product facts, omit singleItemsTotal/bundlePrice or use empty string, and express savings qualitatively (e.g. 'Bundle & Save' or 'Complete Kit Value'). NEVER invent fake dollar numbers:
{
  "tagline": "All-in-One Value",
  "headline": "Bundle & Save",
  "subheadline": "Get the complete setup together and save compared to buying separately.",
  "bundleComparison": {
    "singleItemsTotal": "",
    "bundlePrice": "",
    "savingsText": "Special Bundle Value",
    "perks": ["All official package items included", "Zero compatibility hassle", "Dedicated customer care"]
  }
}`;
    } else if (isStep) {
        prompt += `
Return a JSON object with practical steps specific to this product:
{
  "tagline": "How It Works",
  "headline": "Simple 3-6 word step headline",
  "steps": [
    {"step": 1, "title": "Short 2-3 word title", "instruction": "One concise instruction sentence (max 10 words)."},
    {"step": 2, "title": "Short 2-3 word title", "instruction": "One concise instruction sentence (max 10 words)."},
    {"step": 3, "title": "Short 2-3 word title", "instruction": "One concise instruction sentence (max 10 words)."}
  ]
}`;
    } else if (isSpecs) {
        prompt += `
Return a JSON object. STRICT ZERO-FACT OMISSION: Use only verified specifications from the provided product information (e.g. Material, Dimensions, Weight, Capacity, Care instructions). Do NOT invent warranty or certification terms unless supplied. If an item or spec is not confirmed in facts, do NOT invent it:
{
  "tagline": "Product Details",
  "headline": "Specifications & Verified Details",
  "packageIncludes": ["1 × Main Unit"],
  "specifications": [
    {"label": "Material", "value": "Factual material from product facts"},
    {"label": "Dimensions", "value": "Factual dimensions if known"},
    {"label": "Weight / Capacity", "value": "Factual weight or capacity if known"}
  ]
}`;
    } else if (isFaq) {
        prompt += `
Return a JSON object answering 3-4 top buyer questions specifically relevant to this product category (e.g. usage, cleaning/maintenance, materials, compatibility). Avoid inventing arbitrary shipping days or return terms unless supplied:
{
  "tagline": "Common Questions",
  "headline": "Frequently Asked Questions",
  "faqs": [
    {"q": "How do I clean and maintain it?", "a": "Concise factual maintenance tip."},
    {"q": "Is it easy to use for beginners?", "a": "Concise answer based on product facts."}
  ]
}`;
    } else {
        prompt += `
Return a JSON object:
{
  "tagline": "2-3 word uppercase benefit kicker relevant to ${focalFeature || 'this module'}",
  "headline": "Punchy 3-6 word headline directly reflecting ${focalFeature || 'the focal benefit'}",
  "subheadline": "One short crisp sentence explaining the primary benefit (max 15 words).",
  "fbr": [
    {
      "feature": "2-4 word bold anchor keyword",
      "benefit": "One crisp factual takeaway sentence (8-12 words max).",
      "result": ""
    },
    {
      "feature": "2-4 word bold anchor keyword",
      "benefit": "One crisp factual takeaway sentence (8-12 words max).",
      "result": ""
    }
  ]
}`;
    }

    try {
        remoteLog(`正在为模块 [${task.title}] 生成独立站 DTC 语义化文案...`);
        const res = await callAI("text", {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        }, options);
        const text = res.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
            const data = JSON.parse(text);
            task.dtcCopy = data;
            remoteLog(`模块 [${task.title}] DTC 语义化文案生成成功`);
            return data;
        }
    } catch (e) {
        if (e.name === 'AbortError' || options?.signal?.aborted) return null;
        console.warn(`[DTC Copy Gen] Error for ${task.title}:`, e);
        let fallbackCopy;
        if (isTargetZh) {
            fallbackCopy = {
                tagline: (hasChineseText(focalFeature) ? focalFeature : task.title) || '核心优势',
                headline: task.subtitle || task.title || '核心卖点',
                subheadline: compactDetailText(sellingPoints, 120) || '精工打造，确保日常顺畅运行与持久安心体验。',
                fbr: [{ feature: (hasChineseText(focalFeature) ? focalFeature : task.title) || '品质保证', benefit: task.subtitle || '出色操作体验', result: '' }]
            };
        } else {
            fallbackCopy = {
                tagline: defaultEn.tagline,
                headline: defaultEn.headline,
                subheadline: defaultEn.subheadline,
                fbr: defaultEn.fbr ? defaultEn.fbr.slice() : [{ feature: 'Refined Quality', benefit: 'Engineered for reliable everyday performance.', result: '' }]
            };
        }
        if (isBundleBox) {
            fallbackCopy = {
                tagline: isTargetZh ? '全套清单' : 'Complete Package',
                headline: isTargetZh ? '包装清单' : "What's in the Box",
                subheadline: isTargetZh ? '所有配件一应俱全，开箱即用。' : 'All essentials included and verified.',
                items: [
                    { name: isTargetZh ? '核心主机' : 'Main Unit', count: '1×', desc: isTargetZh ? '主功能设备' : 'Core product unit' },
                    { name: isTargetZh ? '标准配件包' : 'Standard Accessories Kit', count: '1×', desc: isTargetZh ? '全套原厂配件' : 'Full OEM accessory set' },
                    { name: isTargetZh ? '说明书与保修卡' : 'Quick Guide & Warranty', count: '1×', desc: isTargetZh ? '完整指引与品质保障' : 'Complete manual and warranty' }
                ]
            };
        } else if (isBundleSavings) {
            fallbackCopy = {
                tagline: isTargetZh ? '超值组合' : 'Bundle & Save',
                headline: isTargetZh ? '全套组合优势' : 'Complete System Value',
                subheadline: isTargetZh ? '整套购买相比单独购买立省更多。' : 'Save significantly compared to purchasing components separately.',
                bundleComparison: {
                    singleItemsTotal: '$129.99',
                    bundlePrice: '$79.99',
                    savingsText: isTargetZh ? '立省 $50 (直降 38%)' : 'Save $50 (38% OFF)',
                    perks: isTargetZh
                        ? ['官方原装配件全包含', '无任何兼容性顾虑', '享受优先急速配送']
                        : ['Official OEM accessories included', 'Zero compatibility risk', 'Fast insured delivery']
                }
            };
        }
        task.dtcCopy = fallbackCopy;
        return fallbackCopy;
    }
    return null;
}

// 全局详情页生成中止控制器与运行状态
let detailGenerationAbortController = null;
let isDetailGenerating = false;

// 检查并异步等待，支持中止信号立即中断
function abortableDelay(ms, signal) {
    return new Promise((resolve, reject) => {
        const createAbortError = () => {
            if (typeof DOMException !== 'undefined') {
                return new DOMException('Aborted', 'AbortError');
            }
            const err = new Error('Aborted');
            err.name = 'AbortError';
            return err;
        };
        if (signal?.aborted) return reject(createAbortError());
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(createAbortError());
        }, { once: true });
    });
}

// 同步生成中界面状态（侧边栏按钮、顶部状态栏及中止按钮）
function updateDetailGeneratingUI(isBusy, completedCount = 0, totalCount = 0) {
    const btn = document.getElementById('generateBtn');
    const abortBtn = document.getElementById('abortDetailGenBtn');
    const statusBar = document.getElementById('detailGenerationStatusBar');
    const progressText = document.getElementById('detailGenProgressText');
    const regenDetailsBtn = document.getElementById('btnRegenerateDetails');
    const toolbarRetryBtn = document.getElementById('btnRetryFailedToolbar');
    const alertRetryBtn = document.getElementById('btnRetryFailedImages');

    if (isBusy) {
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `<span class="loader mr-2 border-white border-t-transparent w-4 h-4"></span> 正在并行渲染 (${completedCount}/${totalCount})...`;
        }
        if (abortBtn) {
            abortBtn.classList.remove('hidden');
        }
        if (statusBar) {
            statusBar.classList.remove('hidden');
            statusBar.classList.add('flex');
        }
        if (progressText) {
            progressText.textContent = `正在并行渲染 (${completedCount}/${totalCount})...`;
        }
        if (regenDetailsBtn) {
            regenDetailsBtn.disabled = true;
            regenDetailsBtn.classList.add('opacity-50', 'pointer-events-none');
        }
        if (toolbarRetryBtn) {
            toolbarRetryBtn.disabled = true;
            toolbarRetryBtn.classList.add('opacity-50', 'pointer-events-none');
        }
        if (alertRetryBtn) {
            alertRetryBtn.disabled = true;
            alertRetryBtn.classList.add('opacity-50', 'pointer-events-none');
        }
    } else {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="ph ph-magic-wand text-lg"></i> 生成跨平台详情页';
        }
        if (abortBtn) {
            abortBtn.classList.add('hidden');
        }
        if (statusBar) {
            statusBar.classList.add('hidden');
            statusBar.classList.remove('flex');
        }
        if (regenDetailsBtn) {
            regenDetailsBtn.disabled = false;
            regenDetailsBtn.classList.remove('opacity-50', 'pointer-events-none');
        }
        if (toolbarRetryBtn) {
            toolbarRetryBtn.disabled = false;
            toolbarRetryBtn.classList.remove('opacity-50', 'pointer-events-none');
        }
        if (alertRetryBtn) {
            alertRetryBtn.disabled = false;
            alertRetryBtn.classList.remove('opacity-50', 'pointer-events-none');
        }
    }
}

// 手动终止正在进行的详情页生成
function abortDetailGeneration() {
    if (!isDetailGenerating || !detailGenerationAbortController) {
        return false;
    }
    remoteLog('用户手动终止详情页全案生成流程');
    detailGenerationAbortController.abort();
    isDetailGenerating = false;
    updateDetailGeneratingUI(false);
    updateDetailFailureUI();
    showToast('已终止生成流程，您可以修改参数后重新生成', 'info');
    return true;
}

// 获取当前所有生成失败、手动终止或缺少有效图片的模块任务
function getFailedModuleTasks() {
    if (!globalGenContext?.tasks) return [];
    return Object.values(globalGenContext.tasks).filter(task => {
        if (!task || !task.uniqueId) return false;
        const hasValidImage = Boolean(
            task.imageSrc &&
            (task.imageSrc.startsWith('data:image/') || task.imageSrc.startsWith('http'))
        );
        return task.status === 'error' || task.status === 'cancelled' || task.isFallback || !hasValidImage;
    });
}

// 刷新失败提示条及工具栏重试按钮的状态
function updateDetailFailureUI() {
    const failedTasks = getFailedModuleTasks();
    const count = failedTasks.length;

    // 1. 顶部工具栏重试按钮
    const toolbarRetryBtn = document.getElementById('btnRetryFailedToolbar');
    const toolbarRetryText = document.getElementById('btnRetryFailedToolbarText');
    if (toolbarRetryBtn) {
        if (count > 0) {
            toolbarRetryBtn.classList.remove('hidden');
            toolbarRetryBtn.classList.add('flex');
            if (toolbarRetryText) toolbarRetryText.textContent = `重试失败图片 (${count})`;
        } else {
            toolbarRetryBtn.classList.add('hidden');
            toolbarRetryBtn.classList.remove('flex');
        }
    }

    // 2. 结果区失败警示条
    const alertBar = document.getElementById('detailFailureAlertBar');
    const alertMsg = document.getElementById('detailFailureAlertMsg');
    if (alertBar) {
        if (count > 0 && !alertBar.dataset.dismissed) {
            alertBar.classList.remove('hidden');
            alertBar.classList.add('flex');
            if (alertMsg) {
                alertMsg.textContent = `检测到 ${count} 张模块图片生成失败或中断`;
            }
        } else {
            alertBar.classList.add('hidden');
            alertBar.classList.remove('flex');
        }
    }
}

// 手动关闭失败提示条
function dismissDetailFailureAlert() {
    const alertBar = document.getElementById('detailFailureAlertBar');
    if (alertBar) {
        alertBar.classList.add('hidden');
        alertBar.classList.remove('flex');
        alertBar.dataset.dismissed = 'true';
    }
}

// 一键重新生成所有失败或中断的模块图片，保留已成功的图片
async function retryFailedModuleImages() {
    if (isDetailGenerating) {
        showToast('当前已有生成任务正在进行，请先终止或等待完成', 'warning');
        return;
    }

    const failedTasks = getFailedModuleTasks();
    if (!failedTasks.length) {
        showToast('当前没有需要重试的失败图片', 'info');
        updateDetailFailureUI();
        return;
    }

    const totalFailed = failedTasks.length;
    const concurrency = (typeof CONCURRENCY_LIMIT !== 'undefined' && CONCURRENCY_LIMIT) ? CONCURRENCY_LIMIT : 2;
    const stagger = (typeof STAGGER_DELAY !== 'undefined' && STAGGER_DELAY) ? STAGGER_DELAY : 2000;
    const logMsg = `开始重试失败图片 | 共 ${totalFailed} 张 | 并发控制: ${concurrency}`;
    console.log(`%c[详情页] ${logMsg}`, "color: #e11d48; font-weight: bold;");
    remoteLog(logMsg);

    // 重置已手动关闭标记
    const alertBar = document.getElementById('detailFailureAlertBar');
    if (alertBar) delete alertBar.dataset.dismissed;

    detailGenerationAbortController = new AbortController();
    isDetailGenerating = true;
    const signal = detailGenerationAbortController.signal;
    updateDetailGeneratingUI(true, 0, totalFailed);

    const activeTasks = [];
    let completedCount = 0;
    let retrySuccessCount = 0;
    let retryErrorCount = 0;

    for (let i = 0; i < failedTasks.length; i++) {
        if (signal.aborted) break;

        if (activeTasks.length >= concurrency) {
            await Promise.race(activeTasks);
        }
        if (signal.aborted) break;

        const task = failedTasks[i];
        const submitMsg = `正在重试模块 [${task.title}] (${i + 1}/${totalFailed})`;
        console.log(`%c[详情页] ${submitMsg}`, "color: #8b5cf6;");
        remoteLog(submitMsg);

        const taskPromise = (async () => {
            try {
                const result = await generateSingleWrap(task.uniqueId, false, '', signal);
                if (result?.status === 'success') {
                    retrySuccessCount++;
                    remoteLog(`模块 [${task.title}] 重试成功`);
                } else if (result?.status === 'cancelled') {
                    // cancelled
                } else {
                    retryErrorCount++;
                    remoteLog(`模块 [${task.title}] 重试失败`);
                }
            } catch (err) {
                if (err.name === 'AbortError' || signal.aborted) {
                    task.status = 'cancelled';
                    setModuleStatus(task.uniqueId, 'cancelled');
                    return;
                }
                retryErrorCount++;
                console.error(`Retry task ${task.uniqueId} failed:`, err);
                setModuleStatus(task.uniqueId, 'error');
                remoteLog(`模块 [${task.title}] 重试异常: ${err.message}`);
            } finally {
                completedCount++;
                updateDetailGeneratingUI(isDetailGenerating, completedCount, totalFailed);
            }
        })();

        activeTasks.push(taskPromise);
        taskPromise.finally(() => {
            const idx = activeTasks.indexOf(taskPromise);
            if (idx > -1) activeTasks.splice(idx, 1);
        });

        if (i < failedTasks.length - 1) {
            try {
                await abortableDelay(stagger, signal);
            } catch (err) {
                if (err.name === 'AbortError' || signal.aborted) break;
            }
        }
    }

    await Promise.allSettled(activeTasks);

    isDetailGenerating = false;
    updateDetailGeneratingUI(false);
    updateDetailFailureUI();

    if (signal.aborted) {
        showToast(`重试已手动终止（已成功恢复 ${retrySuccessCount} 张）`, 'info');
        remoteLog(`详情页失败图片重试终止 | 已恢复 ${retrySuccessCount} 张`);
    } else {
        const remainingFailed = getFailedModuleTasks().length;
        if (remainingFailed === 0) {
            showToast(`🎉 所有失败图片已全部成功恢复生成！(共 ${retrySuccessCount} 张)`, 'success');
            remoteLog(`详情页所有失败图片重试成功 | 共 ${retrySuccessCount} 张全部恢复`);
        } else {
            showToast(`重试完成：成功恢复 ${retrySuccessCount} 张，仍有 ${remainingFailed} 张失败`, 'warning');
            remoteLog(`详情页失败图片重试结束 | 恢复 ${retrySuccessCount} 张，仍失败 ${remainingFailed} 张`);
        }
        if (retrySuccessCount > 0) {
            saveDetailProjectToHistory();
        }
    }

    if (currentDetailPresentationMode === 'hybrid' && typeof renderDtcHybridPreview === 'function') {
        renderDtcHybridPreview();
    }
}

// 启动整套详情页生成流程：校验输入、创建任务队列、并发生成模块并渲染结果区。
async function generateAIPage() {
    if (isDetailGenerating) {
        showToast('当前已有生成任务正在进行，请先终止或等待完成', 'warning');
        return;
    }

    const activeModules = modules.filter(m => m.active);
    if (!activeModules.length) { showToast('请至少选择一个模块', 'error'); return; }
    const primaryImage = getPrimaryUploadedImage();
    const angleImages = getAngleUploadedImages();
    if (!primaryImage) { showToast('请先上传一张主图素材', 'error'); return; }
    const totalTaskCount = activeModules.reduce((sum, mod) => sum + (mod.count || 1), 0);
    if (totalTaskCount > DETAIL_MAX_TASKS) {
        showToast(`当前共 ${totalTaskCount} 张，建议控制在 ${DETAIL_MAX_TASKS} 张以内`, 'error');
        return;
    }

    const sellingPoints = document.getElementById('sellingPointsText').value;
    if (!sellingPoints) { showToast('请填写核心卖点', 'error'); return; }

    const startMsg = `开始详情页全案生成流程 | 出图总数: ${totalTaskCount} | 并发控制: ${CONCURRENCY_LIMIT}`;
    console.log(`%c[详情页] ${startMsg}`, "color: #4f46e5; font-weight: bold;");
    remoteLog(startMsg);

    const config = getDetailConfig();
    if (!config) return;

    globalGenContext = {
        base64Data: primaryImage.data,
        mimeType: primaryImage.mimeType,
        primaryImage,
        angleImages,
        uploadedImages: [primaryImage, ...angleImages],
        sellingPoints,
        config,
        tasks: {},
        longImageOrder: []
    };

    let taskQueue = applyStrategyOverrides(
        buildStrategyTasks(activeModules, sellingPoints, config),
        typeof detailStrategyOverrides === 'object' ? detailStrategyOverrides : {}
    );
    taskQueue.forEach(task => {
        globalGenContext.tasks[task.uniqueId] = task;
        globalGenContext.longImageOrder.push(task.uniqueId);
    });

    document.getElementById('showcaseArea').classList.add('hidden');
    const resArea = document.getElementById('resultArea');
    resArea.classList.remove('hidden'); resArea.classList.add('flex');

    // 确保开始生成时切入画廊模式，实时向用户呈现每个模块排队、构图与生成进度卡片
    if (typeof switchDetailResultView === 'function') {
        switchDetailResultView('gallery');
    }

    const container = document.getElementById('modulesResultContainer');
    container.innerHTML = '';

    const ratioStr = config.aspectRatio.replace(':', '/');
    taskQueue.forEach(task => {
        container.innerHTML += `
            <div id="result-mod-${task.uniqueId}" class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden flex flex-col group">
                <div class="bg-gray-50/80 px-5 py-3 border-b border-gray-100 flex justify-between items-center backdrop-blur">
                    <div class="flex items-center gap-2">
                        <span class="w-1.5 h-4 bg-blue-500 rounded-full"></span>
                        <span class="font-bold text-gray-700 text-sm">${detailEscapeHtml(task.displayTitle)}</span>
                        <span id="status-badge-${task.uniqueId}" class="text-[10px] font-black px-2 py-0.5 rounded-full border bg-slate-100 text-slate-500 border-slate-200">等待中</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="text-xs text-gray-400 mr-2">${detailEscapeHtml(task.subtitle)}</span>
                        <button id="regen-btn-${task.uniqueId}" onclick="generateSingleWrap('${task.uniqueId}')" class="hidden flex items-center justify-center w-7 h-7 rounded bg-white border border-gray-200 text-gray-500 hover:text-blue-600 transition-colors shadow-sm" title="重绘图像并刷新 SEO"><i class="ph ph-arrows-clockwise text-sm"></i></button>
                    </div>
                </div>
                <div id="content-mod-${task.uniqueId}" class="p-6 flex flex-col items-center justify-center relative bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMCIgaGVpZ2h0PSIyMCI+PHJlY3Qgd2lkdGg9IjIwIiBoZWlnaHQ9IjIwIiBmaWxsPSIjZmZmIi8+PGNpcmNsZSBjeD0iMTAiIGN5PSIxMCIgcj0iMSIgZmlsbD0iI2YxZjFmMSIvPjwvc3ZnPg==')]" style="aspect-ratio: ${ratioStr}; min-height: 200px;">
                    <span class="loader border-blue-500 border-t-transparent w-8 h-8 mb-3"></span><span class="text-sm text-gray-500 font-medium tracking-wide">AI引擎构图中...</span>
                </div>
                ${renderPromptRegenerationControls(task.uniqueId)}
                <div id="quality-panel-${task.uniqueId}" class="border-t border-gray-100 bg-white px-4 py-3"></div>
                <div class="border-t border-gray-100 bg-slate-50 p-4 flex flex-col gap-3">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-1.5"><i class="ph-fill ph-link text-blue-500"></i><span class="text-xs font-black text-gray-700 uppercase tracking-widest">SEO Meta-Data</span></div>
                        <div class="flex items-center gap-1.5">
                            <button onclick="uploadDetailModuleToCloud('${task.uniqueId}')" class="text-xs flex items-center gap-1 text-blue-600 hover:text-blue-800 font-bold bg-white border border-blue-200 px-2 py-1 rounded shadow-sm transition-all active:scale-95" title="上传至云存储图床"><i class="ph ph-cloud-arrow-up"></i> 上传</button>
                            <button onclick="downloadModule('${task.uniqueId}', '${task.displayTitle}')" class="text-xs flex items-center gap-1 text-gray-500 hover:text-indigo-600 font-bold bg-white border border-gray-200 px-2 py-1 rounded shadow-sm transition-all active:scale-95"><i class="ph ph-download-simple"></i> 单存</button>
                        </div>
                    </div>
                    <div class="flex flex-col gap-2.5">
                        <div class="flex items-center gap-2">
                            <span class="text-[10px] font-bold text-gray-400 w-6">Title</span>
                            <div class="relative flex-1">
                                <input type="text" id="seo-title-target-${task.uniqueId}" class="w-full text-xs pl-2 pr-8 py-1.5 border border-gray-200 rounded outline-none focus:border-blue-400 bg-white shadow-inner" placeholder="English Title" readonly>
                                <button onclick="copyText('seo-title-target-${task.uniqueId}')" class="absolute inset-y-0 right-0 pr-2 flex items-center text-gray-400 hover:text-blue-600"><i class="ph ph-copy"></i></button>
                            </div>
                            <div class="relative flex-1">
                                <input type="text" id="seo-title-zh-${task.uniqueId}" class="w-full text-xs pl-2 pr-8 py-1.5 border border-gray-200 rounded outline-none focus:border-blue-400 bg-white shadow-inner text-gray-500" placeholder="中文标题" readonly>
                            </div>
                        </div>
                        <div class="flex items-start gap-2">
                            <span class="text-[10px] font-bold text-gray-400 w-6 mt-1">Alt</span>
                            <div class="relative flex-1">
                                <textarea id="alt-text-target-${task.uniqueId}" class="w-full text-xs pl-2 pr-8 py-1.5 border border-gray-200 rounded outline-none focus:border-blue-400 bg-white shadow-inner resize-none hide-scroll" rows="2" placeholder="English Alt" readonly></textarea>
                                <button onclick="copyText('alt-text-target-${task.uniqueId}')" class="absolute top-1 right-0 pr-2 flex items-start text-gray-400 hover:text-blue-600"><i class="ph ph-copy"></i></button>
                            </div>
                            <div class="relative flex-1">
                                <textarea id="alt-text-zh-${task.uniqueId}" class="w-full text-xs pl-2 pr-8 py-1.5 border border-gray-200 rounded outline-none focus:border-blue-400 bg-white shadow-inner resize-none hide-scroll text-gray-500" rows="2" placeholder="中文描述" readonly></textarea>
                            </div>
                        </div>
                    </div>
                </div>
            </div>`;
    });

    detailGenerationAbortController = new AbortController();
    isDetailGenerating = true;
    const signal = detailGenerationAbortController.signal;
    updateDetailGeneratingUI(true, 0, taskQueue.length);

    const activeTasks = [];
    let completedCount = 0;
    let successCount = 0;
    let fallbackCount = 0;
    let errorCount = 0;

    for (let i = 0; i < taskQueue.length; i++) {
        if (signal.aborted) break;

        if (activeTasks.length >= CONCURRENCY_LIMIT) {
            await Promise.race(activeTasks);
        }
        if (signal.aborted) break;

        const task = taskQueue[i];
        const submitMsg = `正在提交任务 [${task.title}] (${i + 1}/${taskQueue.length})`;
        console.log(`%c[详情页] ${submitMsg}`, "color: #8b5cf6;");
        remoteLog(submitMsg);

        const taskPromise = (async () => {
            try {
                const result = await generateSingleWrap(task.uniqueId, false, '', signal);
                if (result?.status === 'success') successCount++;
                else if (result?.status === 'fallback') fallbackCount++;
                else if (result?.status === 'cancelled') { /* ignored */ }
                else errorCount++;
                const finishMsg = result?.status === 'cancelled'
                    ? `模块 [${task.title}] 已终止`
                    : `模块 [${task.title}] 渲染成功`;
                console.log(`%c[详情页] ${finishMsg}`, "color: #10b981;");
                remoteLog(finishMsg);
            } catch (e) {
                if (e.name === 'AbortError' || signal.aborted) {
                    task.status = 'cancelled';
                    setModuleStatus(task.uniqueId, 'cancelled');
                    return;
                }
                errorCount++;
                console.error(`Task ${task.uniqueId} failed:`, e);
                setModuleStatus(task.uniqueId, 'error');
                remoteLog(`模块 [${task.title}] 渲染异常: ${e.message}`);
            } finally {
                completedCount++;
                updateDetailGeneratingUI(isDetailGenerating, completedCount, taskQueue.length);
            }
        })();

        activeTasks.push(taskPromise);
        taskPromise.finally(() => {
            const idx = activeTasks.indexOf(taskPromise);
            if (idx > -1) activeTasks.splice(idx, 1);
        });

        if (i < taskQueue.length - 1) {
            try {
                await abortableDelay(STAGGER_DELAY, signal);
            } catch (err) {
                if (err.name === 'AbortError' || signal.aborted) break;
            }
        }
    }

    await Promise.allSettled(activeTasks);

    if (signal.aborted) {
        taskQueue.forEach(task => {
            if (task.status === 'loading' || task.status === 'pending' || !task.status) {
                task.status = 'cancelled';
                setModuleStatus(task.uniqueId, 'cancelled');
                const contentDiv = document.getElementById(`content-mod-${task.uniqueId}`);
                if (contentDiv && (!task.imageSrc || task.status === 'cancelled')) {
                    contentDiv.innerHTML = `
                        <div class="w-full h-full flex flex-col items-center justify-center text-xs text-rose-500 p-6 text-center">
                            <i class="ph-bold ph-stop-circle text-3xl mb-2 text-rose-400"></i>
                            <span class="font-bold">生成已手动终止</span>
                            <span class="text-[10px] text-slate-400 mt-1">随时可点击右上角刷新重新生成此模块</span>
                        </div>`;
                    document.getElementById(`regen-btn-${task.uniqueId}`)?.classList.remove('hidden');
                }
            }
        });
    }

    isDetailGenerating = false;
    updateDetailGeneratingUI(false);
    updateDetailFailureUI();

    if (signal.aborted) {
        const abortedMsg = `生成已终止（已完成 ${successCount}，降级 ${fallbackCount}，终止 ${taskQueue.length - successCount - fallbackCount}）`;
        showToast(abortedMsg, 'info');
        remoteLog(`详情页生成已终止 | ${abortedMsg}`);
    } else {
        const summary = `生成完成：成功 ${successCount}，降级 ${fallbackCount}，失败 ${errorCount}`;
        showToast(summary, errorCount ? 'warning' : (fallbackCount ? 'warning' : 'success'));
        remoteLog(`详情页全案生成结束 | ${summary}`);
        if (successCount > 0 || fallbackCount > 0) {
            saveDetailProjectToHistory();
        }
    }

    if (currentDetailPresentationMode === 'hybrid') {
        renderDtcHybridPreview();
        switchDetailResultView('hybrid');
    }
}

// 生成或重绘单个详情页模块图片，失败时降级为本地 HTML/CSS 占位图。
async function generateSingleWrap(uniqueId, skipSEO = false, promptAdjustment = '', signal = null) {
    const task = globalGenContext?.tasks?.[uniqueId] || Object.values(globalGenContext?.tasks || {}).find(t => t.uniqueId === uniqueId || t.id === uniqueId);
    if (!task) return;
    const resolvedId = task.uniqueId || uniqueId;

    if (signal?.aborted) {
        task.status = 'cancelled';
        setModuleStatus(resolvedId, 'cancelled');
        return { status: 'cancelled', task };
    }

    remoteLog(`开始渲染模块: ${task.title}`);
    if (promptAdjustment) {
        task.repaintPrompt = promptAdjustment;
        remoteLog(`模块 [${task.title}] 使用自定义提示词重绘`);
    }
    const contentDiv = document.getElementById(`content-mod-${resolvedId}`);
    if (!contentDiv) return;

    setModuleStatus(resolvedId, 'loading');
    task.status = 'loading';
    task.error = '';
    contentDiv.innerHTML = `<span class="loader border-blue-500 border-t-transparent w-8 h-8 mb-3"></span><span class="text-sm text-gray-500 font-medium">AI引擎构图中...</span>`;
    document.getElementById(`regen-btn-${resolvedId}`)?.classList.add('hidden');
    contentDiv.classList.add('p-6', 'flex-col', 'items-center', 'justify-center');
    contentDiv.style.padding = '';

    const { sellingPoints, config } = globalGenContext;
    const taskImages = (await Promise.all(getImagesForTask(task).map(img => ensureInlineImageData(img)))).filter(Boolean);
    if (!taskImages.length) {
        throw new Error('缺少可用的商品图片素材');
    }
    const isAngleModule = task.id === 'm4';
    const hasAngleReferences = isAngleModule && (globalGenContext.angleImages || []).length > 0;

    const angleRule = isAngleModule
        ? (hasAngleReferences
            ? `9. Multi-angle mode: I provided real angle reference images after the first primary image. Use these references faithfully to build a multi-angle collage. Do not hallucinate different product variants.`
            : `9. Multi-angle mode: Only one primary image is provided. Generate plausible front, side, back, detail, and perspective views from the primary image while preserving the exact product identity, proportions, materials, and colors.`)
        : '';

    let prompt = buildModuleGenerationPrompt(task, sellingPoints, config, promptAdjustment);
    if (angleRule) prompt += `\n${angleRule}`;

    const referenceIntro = taskImages.length > 1
        ? `\n\nATTACHED IMAGES SPECIFICATION: Attached image 1 is the primary authentic product reference. The remaining images show confirmed angles/details of the SAME product. You must render this EXACT product with zero drift.`
        : `\n\nATTACHED IMAGE SPECIFICATION: The attached image is the authentic product reference. You must render this EXACT product with zero drift.`;
    prompt += referenceIntro;

    let parts = [{ text: prompt }, ...taskImages.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.data } }))];
    const payload = {
        contents: [{ role: "user", parts: parts }],
        generationConfig: {
            responseModalities: ['IMAGE'],
            imageConfig: { aspectRatio: config.aspectRatio }
        }
    };

    try {
        const promises = [callAI("image", payload, { signal })];
        if (!skipSEO) {
            promises.push(generateSEOMetadata(task, sellingPoints, { signal }));
        }
        if (currentDetailPresentationMode === 'hybrid') {
            promises.push(generateDtcSectionCopy(task, sellingPoints, config, { signal }));
        }

        const results = await Promise.all(promises);
        const imgRes = results[0];

        const imagePart = imgRes.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
        if (imagePart?.inlineData) {
            let generatedSrc = `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;

            // 检查是否开启自动 WebP 压缩
            const shouldCompress = typeof document !== 'undefined'
                ? (document.getElementById('detailAutoCompressWebp')?.checked ?? true)
                : true;

            if (shouldCompress && typeof compressImageToWebp === 'function') {
                try {
                    const compRes = await compressImageToWebp(generatedSrc, { quality: 0.90 });
                    if (compRes && compRes.changed && compRes.dataUrl) {
                        generatedSrc = compRes.dataUrl;
                        task.compressedStats = compRes;
                    }
                } catch (cErr) {
                    console.warn('[WebP] Module auto compression fallback to raw:', cErr);
                }
            }

            contentDiv.innerHTML = `<img src="${generatedSrc}" class="w-full h-full object-cover cursor-zoom-in" onclick="openImageLightbox('${generatedSrc}', '${detailEscapeHtml(task.displayTitle || task.title)}')" title="点击放大预览">`;
            contentDiv.classList.remove('p-6', 'flex-col', 'items-center', 'justify-center');
            contentDiv.style.padding = '0';
            task.imageSrc = generatedSrc;
            task.status = 'success';
            task.isFallback = false;
            setModuleStatus(uniqueId, 'success');
        } else throw new Error("No image data in response");

    } catch (error) {
        if (error.name === 'AbortError' || signal?.aborted) {
            remoteLog(`模块 [${task.title}] 生成被用户手动终止`);
            task.status = 'cancelled';
            task.isFallback = false;
            task.error = '生成已终止';
            setModuleStatus(uniqueId, 'cancelled');
            contentDiv.innerHTML = `
                <div class="w-full h-full flex flex-col items-center justify-center text-xs text-rose-500 p-6 text-center">
                    <i class="ph-bold ph-stop-circle text-3xl mb-2 text-rose-400"></i>
                    <span class="font-bold">生成已手动终止</span>
                    <span class="text-[10px] text-slate-400 mt-1">随时可点击右上角刷新重新生成此模块</span>
                </div>`;
            document.getElementById(`regen-btn-${uniqueId}`)?.classList.remove('hidden');
            return { status: 'cancelled', task };
        }

        console.error(`[AI Image Generation Error] Module [${task.title}]:`, error);
        remoteLog(`模块 [${task.title}] 生图失败: ${error.message || error}`);
        task.status = 'error';
        task.isFallback = false;
        task.error = error.message || String(error);
        task.imageSrc = '';
        setModuleStatus(resolvedId, 'error');

        const errMsg = detailEscapeHtml(error.message || '模型调用失败，请检查设置中的图片模型');
        contentDiv.innerHTML = `
            <div class="w-full h-full flex flex-col items-center justify-center text-xs text-red-500 p-6 text-center bg-red-50/40 rounded-xl border border-dashed border-red-200">
                <i class="ph-bold ph-warning-circle text-3xl mb-2 text-red-500 animate-pulse"></i>
                <span class="font-bold text-slate-800 text-sm mb-1">图片生成失败</span>
                <p class="text-[11px] text-red-600 max-w-xs break-words mb-3">${errMsg}</p>
                <button type="button" onclick="generateSingleWrap('${resolvedId}')" class="px-3 py-1.5 bg-white border border-red-200 hover:border-red-300 hover:bg-red-50 text-red-600 rounded-lg text-xs font-medium transition-all shadow-sm flex items-center gap-1.5 cursor-pointer">
                    <i class="ph-bold ph-arrows-clockwise"></i>
                    <span>点击重新生成此模块</span>
                </button>
            </div>`;
        if (!skipSEO) {
            try {
                await generateSEOMetadata(task, sellingPoints);
            } catch (seoErr) {
                console.warn('[SEO Gen Warning]', seoErr);
            }
        }
    }

    document.getElementById(`regen-btn-${resolvedId}`)?.classList.remove('hidden');
    task.seo = getModuleSeo(resolvedId);
    renderModuleQualityPanel(resolvedId);
    updateDetailFailureUI();
    if (task.status === 'success') {
        saveDetailProjectToHistory();
    }
    if (currentDetailPresentationMode === 'hybrid' && currentDetailResultView === 'hybrid' && typeof renderDtcHybridPreview === 'function') {
        renderDtcHybridPreview();
    }
    return { status: task.status, task };
}

// 在图片模型失败时渲染通用降级模块，保证页面仍有可下载的占位图。
function renderMockModule(container, task, points, config, imgSrc) {
    if (!container) return;
    const ratioStr = config.aspectRatio.replace(':', '/');
    const themeTag = config.marketingTheme !== 'none' ? `<div class="absolute top-4 left-4 bg-orange-500 text-white text-[9px] font-black px-2 py-1 rounded shadow-lg uppercase tracking-tighter z-10">${detailEscapeHtml(config.marketingThemeLabel || config.marketingTheme)}</div>` : '';
    const safeTitle = detailEscapeHtml(task.title);
    const safePoints = detailEscapeHtml(points.substring(0, 80));
    const safeStyle = detailEscapeHtml((config.imageStyleLabel || config.imageStyle || '').split(',')[0]);
    const safePlatform = detailEscapeHtml(config.platformLabel || config.platform);
    const safeImg = detailEscapeHtml(imgSrc || '');

    let content = `<div class="w-full h-full flex flex-col items-center justify-center p-8 text-center bg-gradient-to-br from-slate-50 to-slate-100 relative overflow-hidden">
        ${themeTag}
        <img src="${safeImg}" class="h-3/5 object-contain drop-shadow-2xl mb-6 max-w-full transform hover:scale-105 transition-transform duration-700">
        <h3 class="text-xl font-black text-slate-800 tracking-wider uppercase">${safeTitle}</h3>
        <div class="w-12 h-1 bg-blue-500 my-3 rounded-full"></div>
        <p class="text-[10px] text-slate-500 mt-1 max-w-xs leading-relaxed font-medium">${safePoints}...</p>
        <div class="mt-6 flex items-center gap-2">
            <span class="px-3 py-1 bg-white border border-slate-200 rounded-full text-[9px] font-black text-slate-400 uppercase tracking-widest">${safeStyle}</span>
            <span class="w-1 h-1 rounded-full bg-slate-300"></span>
            <span class="text-[9px] font-black text-blue-500 uppercase">${safePlatform}</span>
        </div>
    </div>`;
    container.innerHTML = `<div class="w-full h-full overflow-hidden" style="aspect-ratio: ${ratioStr};">${content}</div>`;
    container.classList.remove('p-6', 'flex-col', 'items-center', 'justify-center');
    container.style.padding = '0';
}

// 在多角度模块失败时用上传素材渲染本地多角度拼图降级图。
function renderMultiAngleFallback(container, task, points, config, images) {
    if (!container || !images.length) return;
    const ratioStr = config.aspectRatio.replace(':', '/');
    const safeTitle = detailEscapeHtml(task.title);
    const safePoints = detailEscapeHtml(points.substring(0, 70));
    const safeTheme = detailEscapeHtml(config.marketingThemeLabel || '');
    const tiles = images.slice(0, 6).map((img, index) => `
        <div class="relative bg-white rounded-lg overflow-hidden border border-slate-200 shadow-sm">
            <img src="${detailEscapeHtml(img.base64)}" class="w-full h-full object-contain p-2">
            <span class="absolute left-2 bottom-2 bg-slate-900/70 text-white text-[9px] font-black px-2 py-0.5 rounded">${index === 0 ? '主视角' : `角度 ${index}`}</span>
        </div>
    `).join('');

    container.innerHTML = `
        <div class="w-full h-full bg-slate-50 p-5 flex flex-col gap-4" style="aspect-ratio: ${ratioStr};">
            <div class="flex items-center justify-between">
                <div>
                    <div class="text-xl font-black text-slate-800 tracking-wide">${safeTitle}</div>
                    <div class="text-[10px] text-slate-500 mt-1 max-w-lg">${safePoints}...</div>
                </div>
                ${safeTheme ? `<span class="text-[9px] font-black text-orange-600 bg-orange-50 border border-orange-100 rounded px-2 py-1">${safeTheme}</span>` : ''}
            </div>
            <div class="grid grid-cols-3 gap-3 flex-1 min-h-0">${tiles}</div>
        </div>`;
    container.classList.remove('p-6', 'flex-col', 'items-center', 'justify-center');
    container.style.padding = '0';
}

// 从结果区返回详情页生成首页展示区。
function resetView() {
    dismissDetailFailureAlert();
    updateDetailFailureUI();
    document.getElementById('resultArea').classList.add('hidden');
    document.getElementById('resultArea').classList.remove('flex');
    document.getElementById('showcaseArea').classList.remove('hidden');
    setTimeout(() => { document.getElementById('showcaseArea').classList.remove('opacity-0'); }, 50);
}

// 将单个模块 DOM 打包成图片并下载。AI 原始图像直出无损，降级占位图使用 html2canvas 渲染。
async function downloadModule(modId, modTitle, isBatch = false) {
    const el = document.getElementById(`content-mod-${modId}`);
    if (!el) return;
    try {
        if (!isBatch) showToast(`正在打包...`, 'info');
        const task = globalGenContext?.tasks?.[modId];
        let baseFilename = modTitle;
        const seoInput = document.getElementById(`seo-title-target-${modId}`);
        if (seoInput && seoInput.value && seoInput.value.length > 2) {
            const parsedTitle = seoInput.value.trim().replace(/[/\\?%*:|"<>]/g, '-');
            if (parsedTitle) baseFilename = parsedTitle;
        }

        const pad = n => n.toString().padStart(2, '0');
        const d = new Date();
        const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
        const link = document.createElement('a');

        if (task && task.imageSrc && !task.isFallback) {
            const extMatch = task.imageSrc.match(/^data:image\/([a-zA-Z0-9]+);base64,/);
            const ext = extMatch ? (extMatch[1] === 'jpeg' ? 'jpg' : extMatch[1]) : (task.imageSrc.split('.').pop()?.split('?')[0] || 'png');
            link.download = `${baseFilename}_${ts}.${ext.length <= 4 ? ext : 'png'}`;
            link.href = task.imageSrc;
            link.click();
        } else {
            const canvas = await html2canvas(el, { useCORS: true, scale: 2, backgroundColor: '#ffffff' });
            link.download = `${baseFilename}_${ts}.png`;
            link.href = canvas.toDataURL('image/png');
            link.click();
        }
        if (!isBatch) showToast('下载成功', 'success');
    } catch (e) { console.error(e); if (!isBatch) showToast('下载失败', 'error'); }
}

// 依次下载当前项目里的所有已生成模块图片。
async function downloadAllModules() {
    if (!globalGenContext || !Object.keys(globalGenContext.tasks).length) return;
    showToast('开始批量打包，请耐心等待...', 'info');
    const ids = Object.keys(globalGenContext.tasks);
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        await downloadModule(id, globalGenContext.tasks[id].displayTitle, true);
        await new Promise(r => setTimeout(r, 600));
    }
    showToast('全部下载完毕！', 'success');
}

// 标准化历史任务，兼容旧记录中缺少文案模式字段的情况。
function normalizeRestoredDetailTask(task = {}) {
    return { ...task, includeText: task.includeText !== false };
}

// 详情页生成成功后自动保存全案项目快照至历史记录
function saveDetailProjectToHistory() {
    if (!globalGenContext || !globalGenContext.tasks) return;
    try {
        const ts = Date.now();
        const productName = (document.getElementById('productNameInput')?.value || '').trim() || globalGenContext.config?.productName || '';
        const order = Array.isArray(globalGenContext.longImageOrder) && globalGenContext.longImageOrder.length
            ? globalGenContext.longImageOrder
            : Object.keys(globalGenContext.tasks);
        const firstTaskId = order[0];
        const previewImage = (firstTaskId && getModuleImageSrc(firstTaskId)) || globalGenContext.primaryImage?.base64 || '';
        const project = collectCurrentRenderProject(previewImage);
        if (!project) return;

        if (typeof saveToHistory === 'function') {
            saveToHistory('render', {
                name: productName ? `${productName}_详情全案` : `AI详情页_${ts}`,
                style: globalGenContext.config?.imageStyleLabel || globalGenContext.config?.imageStyle || '默认',
                image: previewImage,
                metadata: project
            });
            if (typeof remoteLog === 'function') {
                remoteLog('已将生成的详情页项目自动保存至历史记录');
            }
        }
    } catch (e) {
        console.error('Auto save detail project to history failed:', e);
    }
}

// 收集当前详情页项目快照，用于历史保存和后续恢复。
function collectCurrentRenderProject(finalImage = '') {
    if (!globalGenContext) return null;
    const taskEntries = Object.entries(globalGenContext.tasks || {});
    const modulesSnapshot = taskEntries.map(([id, task]) => ({
        id,
        title: task.title,
        subtitle: task.subtitle,
        displayTitle: task.displayTitle,
        prompt: task.prompt,
        variant: task.variant,
        totalVariants: task.totalVariants,
        includeText: task.includeText !== false,
        status: task.status || 'pending',
        isFallback: !!task.isFallback,
        error: task.error || '',
        repaintPrompt: task.repaintPrompt || getModulePromptAdjustment(id),
        imageSrc: getModuleImageSrc(id) || task.imageSrc || '',
        remoteImageUrl: task.remoteImageUrl || '',
        remoteImageUrls: task.remoteImageUrls ? { ...task.remoteImageUrls } : {},
        activeStorageTarget: task.activeStorageTarget || '',
        originalImageSrc: task.originalImageSrc || '',
        seo: getModuleSeo(id),
        dtcCopy: task.dtcCopy || null
    }));
    return {
        version: 2,
        kind: 'detail-page-project',
        finalImage,
        presentationMode: typeof currentDetailPresentationMode !== 'undefined' ? currentDetailPresentationMode : 'modules',
        layoutStyle: typeof currentDtcLayoutStyle !== 'undefined' ? currentDtcLayoutStyle : 'editorial',
        brandColor: typeof currentDtcBrandColor !== 'undefined' ? currentDtcBrandColor : 'indigo',
        customBrandColor: typeof currentDtcCustomColorHex !== 'undefined' ? currentDtcCustomColorHex : '#4f46e5',
        typography: typeof currentDtcTypography !== 'undefined' ? { ...currentDtcTypography } : null,
        trustBarEnabled: typeof currentDtcTrustBarEnabled !== 'undefined' ? currentDtcTrustBarEnabled : true,
        uploadedImages: (globalGenContext.uploadedImages || []).map(img => ({
            id: img.id,
            name: img.name,
            base64: img.base64,
            mimeType: img.mimeType,
            isPrimary: !!img.isPrimary,
            role: img.role || ''
        })),
        sellingPoints: globalGenContext.sellingPoints || '',
        productName: globalGenContext.config?.productName || '',
        productFacts: globalGenContext.config?.productFacts || '',
        forbiddenClaims: globalGenContext.config?.forbiddenClaims || '',
        config: globalGenContext.config || {},
        longImageOrder: (globalGenContext.longImageOrder || []).slice(),
        modules: modulesSnapshot
    };
}

// 从历史记录恢复详情页项目，包括素材、模块图片、SEO、顺序和重绘提示词。
function renderRestoredDetailProject(project, fallbackImage = '') {
    if (!project || project.kind !== 'detail-page-project' || !Array.isArray(project.modules)) return false;

    const restoredImages = Array.isArray(project.uploadedImages)
        ? project.uploadedImages.map((img, index) => {
            const base64 = safeFormatImgSrc(img.base64 || img.imageSrc || '');
            const parsed = parseImageDataUrl(base64) || {};
            return {
                ...img,
                base64,
                mimeType: img.mimeType || parsed.mimeType || '',
                data: img.data || parsed.data || '',
                isPrimary: index === 0,
                role: index === 0 ? 'primary' : img.role || 'angle'
            };
        }).filter(img => img.base64).slice(0, DETAIL_MAX_UPLOAD_IMAGES)
        : [];
    currentUploadedImages = restoredImages;
    currentUploadedBase64 = restoredImages[0]?.base64 || null;
    renderUploadedImagePreviews();

    const restoredTasks = {};
    const order = Array.isArray(project.longImageOrder) && project.longImageOrder.length
        ? project.longImageOrder
        : project.modules.map(mod => mod.id);

    const restoredLanguage = project.config?.language || 'English';
    const langSelect = document.getElementById('languageSelect');
    if (langSelect && restoredLanguage) {
        langSelect.value = restoredLanguage;
    }

    globalGenContext = {
        base64Data: '',
        mimeType: '',
        primaryImage: restoredImages[0] || null,
        angleImages: restoredImages.slice(1),
        uploadedImages: restoredImages,
        sellingPoints: project.sellingPoints || '',
        config: {
            aspectRatio: '1:1',
            marketingTheme: 'none',
            ...(project.config || {}),
            language: restoredLanguage
        },
        tasks: restoredTasks,
        longImageOrder: order
    };

    const sellingInput = document.getElementById('sellingPointsText');
    if (sellingInput) sellingInput.value = project.sellingPoints || '';
    const productNameInput = document.getElementById('productNameInput');
    if (productNameInput) productNameInput.value = project.productName || project.config?.productName || '';
    const factsInput = document.getElementById('productFactsText');
    if (factsInput) factsInput.value = project.productFacts || project.config?.productFacts || '';
    const forbiddenInput = document.getElementById('forbiddenClaimsText');
    if (forbiddenInput) forbiddenInput.value = project.forbiddenClaims || project.config?.forbiddenClaims || '';

    const showcaseArea = document.getElementById('showcaseArea');
    const resultArea = document.getElementById('resultArea');
    const container = document.getElementById('modulesResultContainer');
    if (!container || !resultArea) return false;

    showcaseArea?.classList.add('hidden');
    resultArea.classList.remove('hidden');
    resultArea.classList.add('flex');
    container.innerHTML = '';

    const ratioStr = (project.config?.aspectRatio || '1:1').replace(':', '/');
    project.modules.forEach(mod => {
        const imageSrc = safeFormatImgSrc(mod.imageSrc || fallbackImage || project.finalImage || '');
        const task = {
            ...normalizeRestoredDetailTask(mod),
            uniqueId: mod.id,
            active: true,
            imageSrc: imageSrc,
            remoteImageUrl: mod.remoteImageUrl || '',
            remoteImageUrls: mod.remoteImageUrls ? { ...mod.remoteImageUrls } : {},
            activeStorageTarget: mod.activeStorageTarget || '',
            originalImageSrc: mod.originalImageSrc || '',
            dtcCopy: mod.dtcCopy || null
        };
        restoredTasks[mod.id] = task;
        container.insertAdjacentHTML('beforeend', `
            <div id="result-mod-${detailEscapeHtml(mod.id)}" class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden flex flex-col group">
                <div class="bg-gray-50/80 px-5 py-3 border-b border-gray-100 flex justify-between items-center backdrop-blur">
                    <div class="flex items-center gap-2">
                        <span class="w-1.5 h-4 bg-blue-500 rounded-full"></span>
                        <span class="font-bold text-gray-700 text-sm">${detailEscapeHtml(mod.displayTitle || mod.title || '详情模块')}</span>
                        <span id="status-badge-${detailEscapeHtml(mod.id)}" class="text-[10px] font-black px-2 py-0.5 rounded-full border bg-slate-100 text-slate-500 border-slate-200">等待中</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="text-xs text-gray-400 mr-2">${detailEscapeHtml(mod.subtitle || '')}</span>
                        <button id="regen-btn-${detailEscapeHtml(mod.id)}" onclick="generateSingleWrap('${detailEscapeHtml(mod.id)}')" class="flex items-center justify-center w-7 h-7 rounded bg-white border border-gray-200 text-gray-500 hover:text-blue-600 transition-colors shadow-sm" title="重绘图像并刷新 SEO"><i class="ph ph-arrows-clockwise text-sm"></i></button>
                    </div>
                </div>
                <div id="content-mod-${detailEscapeHtml(mod.id)}" class="relative bg-white" style="aspect-ratio: ${ratioStr}; min-height: 200px; padding: 0;">
                    ${imageSrc ? `<img src="${detailEscapeHtml(imageSrc)}" class="w-full h-full object-cover">` : '<div class="w-full h-full flex items-center justify-center text-xs text-gray-400">暂无模块图片</div>'}
                </div>
                ${renderPromptRegenerationControls(mod.id)}
                <div id="quality-panel-${detailEscapeHtml(mod.id)}" class="border-t border-gray-100 bg-white px-4 py-3"></div>
                <div class="border-t border-gray-100 bg-slate-50 p-4 flex flex-col gap-3">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-1.5"><i class="ph-fill ph-link text-blue-500"></i><span class="text-xs font-black text-gray-700 uppercase tracking-widest">SEO Meta-Data</span></div>
                        <div class="flex items-center gap-1.5">
                            <button onclick="uploadDetailModuleToCloud('${detailEscapeHtml(mod.id)}')" class="text-xs flex items-center gap-1 text-blue-600 hover:text-blue-800 font-bold bg-white border border-blue-200 px-2 py-1 rounded shadow-sm transition-all active:scale-95" title="上传至云存储图床"><i class="ph ph-cloud-arrow-up"></i> 上传</button>
                            <button onclick="downloadModule('${detailEscapeHtml(mod.id)}', '${detailEscapeHtml(mod.displayTitle || mod.title || '详情模块')}')" class="text-xs flex items-center gap-1 text-gray-500 hover:text-indigo-600 font-bold bg-white border border-gray-200 px-2 py-1 rounded shadow-sm transition-all active:scale-95"><i class="ph ph-download-simple"></i> 单存</button>
                        </div>
                    </div>
                    <div class="flex flex-col gap-2.5">
                        <div class="flex items-center gap-2">
                            <span class="text-[10px] font-bold text-gray-400 w-6">Title</span>
                            <input type="text" id="seo-title-target-${detailEscapeHtml(mod.id)}" class="flex-1 text-xs px-2 py-1.5 border border-gray-200 rounded bg-white shadow-inner" readonly>
                            <input type="text" id="seo-title-zh-${detailEscapeHtml(mod.id)}" class="flex-1 text-xs px-2 py-1.5 border border-gray-200 rounded bg-white shadow-inner text-gray-500" readonly>
                        </div>
                        <div class="flex items-start gap-2">
                            <span class="text-[10px] font-bold text-gray-400 w-6 mt-1">Alt</span>
                            <textarea id="alt-text-target-${detailEscapeHtml(mod.id)}" class="flex-1 text-xs px-2 py-1.5 border border-gray-200 rounded bg-white shadow-inner resize-none hide-scroll" rows="2" readonly></textarea>
                            <textarea id="alt-text-zh-${detailEscapeHtml(mod.id)}" class="flex-1 text-xs px-2 py-1.5 border border-gray-200 rounded bg-white shadow-inner resize-none hide-scroll text-gray-500" rows="2" readonly></textarea>
                        </div>
                    </div>
                </div>
            </div>`);
        setModuleSeo(mod.id, mod.seo || {});
        const promptInput = document.getElementById(`regen-prompt-${mod.id}`);
        if (promptInput) promptInput.value = mod.repaintPrompt || '';
        setModuleStatus(mod.id, mod.status || (mod.isFallback ? 'fallback' : 'success'));
        renderModuleQualityPanel(mod.id);
    });

    renderSortableList();
    if (typeof setDtcLayoutStyle === 'function') {
        setDtcLayoutStyle(project.layoutStyle || 'editorial', false);
    }
    if (project.customBrandColor) {
        currentDtcCustomColorHex = project.customBrandColor;
    }
    if (typeof setDtcBrandColor === 'function') {
        setDtcBrandColor(project.brandColor || 'indigo', false);
    }
    if (project.typography && typeof applyDtcTypography === 'function') {
        applyDtcTypography(project.typography, false);
    }
    if (typeof setDtcTrustBarEnabled === 'function') {
        setDtcTrustBarEnabled(typeof project.trustBarEnabled !== 'undefined' ? project.trustBarEnabled : true, false);
    }
    const hasDtcCopy = project.modules.some(mod => mod.dtcCopy && Object.keys(mod.dtcCopy).length > 0);
    const targetMode = project.presentationMode === 'images' && !hasDtcCopy ? 'images' : 'hybrid';
    if (typeof setDetailPresentationMode === 'function') {
        setDetailPresentationMode(targetMode);
    }
    if (typeof switchDetailResultView === 'function') {
        switchDetailResultView(targetMode === 'hybrid' ? 'hybrid' : 'gallery');
    } else if (targetMode === 'hybrid' && typeof renderDtcHybridPreview === 'function') {
        renderDtcHybridPreview();
    }
    updateDetailFailureUI();
    return true;
}

// ====== 长图拖拽排版台逻辑 ======
// 打开长图排版台，并在打开前刷新模块排序列表和预览画布。
function openLongImageBuilder() {
    if (!globalGenContext || !globalGenContext.longImageOrder.length) {
        showToast('尚未生成任何模块', 'error'); return;
    }
    renderSortableList();
    document.getElementById('longImageBuilderModal').classList.remove('hidden');
}

// 关闭长图排版台弹窗。
function closeLongImageBuilder() {
    document.getElementById('longImageBuilderModal').classList.add('hidden');
}

// 从长图排序中移除指定模块 ID，用于把不想要的图片排除出长图。
function removeLongImageModuleFromOrder(order = [], moduleId = '') {
    return Array.isArray(order)
        ? order.filter(id => id && id !== moduleId)
        : [];
}

// 删除长图排版台中的模块，只影响长图合成顺序，不删除结果区单张图片。
function removeLongImageModule(moduleId = '') {
    if (!globalGenContext || !moduleId) return;
    const beforeCount = (globalGenContext.longImageOrder || []).length;
    globalGenContext.longImageOrder = removeLongImageModuleFromOrder(globalGenContext.longImageOrder || [], moduleId);
    const afterCount = globalGenContext.longImageOrder.length;
    if (afterCount === beforeCount) return;
    renderSortableList();
    const panel = document.getElementById('exportChecklistPanel');
    if (panel && !panel.classList.contains('hidden')) renderExportChecklist();
    showToast('已从长图中移除，单张模块图仍保留', 'success');
}

// 渲染可拖拽模块列表和长图预览画布。
function renderSortableList() {
    const list = document.getElementById('sortableList');
    const canvas = document.getElementById('longImageCanvas');
    if (!list || !canvas) return;
    list.innerHTML = '';
    canvas.innerHTML = '';

    if (!globalGenContext.longImageOrder.length) {
        list.innerHTML = `
            <div class="text-xs text-slate-400 bg-white border border-dashed border-slate-200 rounded-lg p-4 text-center leading-relaxed">
                当前没有加入长图的图片
            </div>`;
        canvas.innerHTML = `
            <div class="min-h-[360px] flex items-center justify-center text-xs text-slate-400 bg-slate-50">
                当前没有加入长图的图片
            </div>`;
        return;
    }

    globalGenContext.longImageOrder.forEach((id) => {
        const task = globalGenContext.tasks[id];
        if (!task) return;

        const li = document.createElement('div');
        li.className = 'bg-white border border-gray-200 p-3 rounded-lg shadow-sm cursor-move flex items-center gap-3 hover:border-indigo-400 select-none transition-colors';
        li.draggable = true;
        li.dataset.id = id;
        li.innerHTML = `
            <i class="ph ph-dots-six-vertical text-gray-400 text-lg"></i>
            <div class="flex-1 min-w-0">
                <div class="text-xs font-bold text-gray-700 truncate">${detailEscapeHtml(task.displayTitle)}</div>
                <div class="text-[10px] text-gray-400 truncate">${detailEscapeHtml(task.subtitle)}</div>
            </div>
            <button type="button"
                onclick="event.stopPropagation(); removeLongImageModule('${detailEscapeHtml(id)}')"
                class="flex items-center justify-center w-7 h-7 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 border border-transparent hover:border-red-100 transition-colors cursor-pointer"
                title="不加入长图">
                <i class="ph ph-trash text-sm"></i>
            </button>
        `;

        li.addEventListener('dragstart', (e) => {
            draggedItem = li;
            setTimeout(() => li.classList.add('ghost-item'), 0);
        });

        li.addEventListener('dragend', () => {
            setTimeout(() => {
                draggedItem?.classList.remove('ghost-item');
                draggedItem = null;
                updatePreviewOrder();
            }, 0);
        });

        li.addEventListener('dragover', e => e.preventDefault());
        li.addEventListener('dragenter', function (e) {
            e.preventDefault();
            if (this !== draggedItem) this.classList.add('border-indigo-500', 'bg-indigo-50/50');
        });
        li.addEventListener('dragleave', function () {
            this.classList.remove('border-indigo-500', 'bg-indigo-50/50');
        });
        li.addEventListener('drop', function () {
            this.classList.remove('border-indigo-500', 'bg-indigo-50/50');
            if (draggedItem && this !== draggedItem) {
                const allItems = [...list.children];
                const curPos = allItems.indexOf(draggedItem);
                const dropPos = allItems.indexOf(this);
                if (curPos < dropPos) this.parentNode.insertBefore(draggedItem, this.nextSibling);
                else this.parentNode.insertBefore(draggedItem, this);
            }
        });

        list.appendChild(li);

        const contentDiv = document.getElementById(`content-mod-${id}`);
        const img = contentDiv?.querySelector('img');
        const imgSrc = img?.src || task.imageSrc;
        if (imgSrc) {
            const cloneImg = document.createElement('img');
            cloneImg.src = imgSrc;
            cloneImg.className = 'w-full h-auto block m-0 p-0 border-none';
            cloneImg.dataset.id = id;
            cloneImg.crossOrigin = 'anonymous';
            canvas.appendChild(cloneImg);
        }
    });
    applyLongImageCanvasStyles();
}

// 根据拖拽后的列表顺序更新全局长图顺序和预览图片顺序。
function updatePreviewOrder() {
    const list = document.getElementById('sortableList');
    const newOrder = [...list.children].map(li => li.dataset.id);
    globalGenContext.longImageOrder = newOrder;

    const canvas = document.getElementById('longImageCanvas');
    const images = [...canvas.children];
    newOrder.forEach(id => {
        const img = images.find(img => img.dataset.id === id);
        if (img) canvas.appendChild(img);
    });
    applyLongImageCanvasStyles();
}

// 渲染导出前检查结果，提示缺图、降级图、重复和潜在风险。
function renderExportChecklist() {
    const panel = document.getElementById('exportChecklistPanel');
    if (!panel || !globalGenContext) return;
    const tasks = (globalGenContext.longImageOrder || [])
        .map(id => globalGenContext.tasks[id])
        .filter(Boolean);
    const checklist = buildExportChecklist(tasks, globalGenContext.config || {});
    panel.classList.remove('hidden');
    panel.innerHTML = `
        <div class="font-black text-slate-700 mb-2 flex items-center gap-1.5"><i class="ph ph-shield-check"></i> 导出检查</div>
        <div class="flex flex-col gap-1.5">
            ${checklist.map(item => {
                const cls = item.level === 'danger'
                    ? 'text-red-600'
                    : item.level === 'warning'
                        ? 'text-amber-700'
                        : item.level === 'success'
                            ? 'text-emerald-600'
                            : 'text-slate-500';
                return `<div class="${cls}">• ${detailEscapeHtml(item.text)}</div>`;
            }).join('')}
        </div>`;
}

// 导出当前详情页项目 JSON，便于以后重新载入或排查生成配置。
function exportCurrentProjectJson() {
    const project = collectCurrentRenderProject('');
    if (!project) {
        showToast('没有可导出的详情页项目', 'error');
        return;
    }
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    const ts = Date.now();
    link.download = `AI详情页项目_${ts}.json`;
    link.href = URL.createObjectURL(blob);
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    showToast('项目 JSON 已导出', 'success');
}

// 调用文本模型按高转化详情页逻辑重新排序长图模块。
async function aiSortLongImage() {
    if (!globalGenContext || !globalGenContext.longImageOrder.length) return;
    const btn = document.getElementById('aiSortBtn');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<i class="ph ph-spinner animate-spin text-sm"></i> 智能计算中...';
    btn.disabled = true;

    const modulesToSort = globalGenContext.longImageOrder.map(id => {
        const task = globalGenContext.tasks[id];
        return { id: id, title: task.title, subtitle: task.subtitle };
    });
    const guardrails = buildProductGuardrails(globalGenContext.config || {});

    const prompt = `你是一个资深跨境电商运营与高转化详情页架构专家。
目前我有以下详情页模块需要组合成一张长图。请根据“高转化营销逻辑”（如 AIDA 模型）对这些模块进行最优排序。
产品卖点背景：${globalGenContext.sellingPoints.substring(0, 300)}
${guardrails ? `产品事实与禁用约束：\n${guardrails}\n` : ''}
待排序模块列表：${JSON.stringify(modulesToSort)}
任务要求：
1. 必须返回所有输入的模块 ID，不能遗漏。
2. 严格返回 JSON 数组格式，仅包含排序后的 ID 字符串列表。
直接返回纯净的 JSON 数组，不要任何解释。`;

    try {
        const res = await callAI("text", {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        });
        const text = res.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
            const sortedIds = JSON.parse(text);
            if (Array.isArray(sortedIds)) {
                const currentIds = globalGenContext.longImageOrder.slice();
                const safeOrder = validateSortedIds(sortedIds, currentIds);
                if (!safeOrder) throw new Error('AI 返回的排序结果不完整');
                const changed = safeOrder.some((id, idx) => id !== sortedIds[idx]) || safeOrder.length !== sortedIds.length;
                globalGenContext.longImageOrder = safeOrder;
                renderSortableList();
                showToast(changed ? 'AI 排序已应用，已自动补齐缺失模块' : 'AI 智能排序已应用', 'success');
            }
        }
    } catch (err) { console.error(err); showToast('AI 排序失败', 'error'); }
    finally { btn.innerHTML = origHtml; btn.disabled = false; }
}

// 将长图排版台中的预览画布导出为 PNG/JPG，并保存到历史记录。
async function executeLongImageDownload() {
    const canvasEl = document.getElementById('longImageCanvas');
    const format = document.getElementById('exportQualitySelect').value;
    const btn = document.getElementById('btnDownloadLong');
    const origHTML = btn.innerHTML;
    if (!globalGenContext?.longImageOrder?.length) {
        showToast('长图中没有可导出的图片', 'error');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="ph ph-spinner animate-spin text-lg"></i> 渲染中...';
    renderExportChecklist();

    try {
        await new Promise(r => setTimeout(r, 300));
        const finalCanvas = await html2canvas(canvasEl, { useCORS: true, scale: format === 'png' ? 2 : 1.5, backgroundColor: currentLongImageBgColor || '#ffffff', logging: false });
        const link = document.createElement('a');
        const ts = Date.now();

        if (format === 'webp') {
            link.download = `AI详情页长图_${ts}.webp`;
            link.href = finalCanvas.toDataURL('image/webp', 0.90);
        } else if (format === 'png') {
            link.download = `AI详情页长图_${ts}.png`;
            link.href = finalCanvas.toDataURL('image/png');
        } else {
            link.download = `AI详情页长图_${ts}.jpg`;
            link.href = finalCanvas.toDataURL('image/jpeg', 0.85);
        }

        link.click();
        showToast(`长图导出成功 (${format.toUpperCase()})`, 'success');

        const finalImage = finalCanvas.toDataURL('image/webp', 0.75);
        const project = collectCurrentRenderProject(finalImage);
        // 存档全案
        saveToHistory('render', {
            name: `全案详情页_${ts}`,
            style: globalGenContext?.config?.imageStyleLabel || globalGenContext?.config?.imageStyle || '默认',
            image: finalImage,
            metadata: project || { count: globalGenContext?.longImageOrder?.length || 0 }
        });
    } catch (e) { showToast('导出失败', 'error'); }
    finally { btn.innerHTML = origHTML; btn.disabled = false; }
}

/**
 * 一键将当前详情页已生成的全部模块图片无损压缩为 WebP 格式
 */
async function compressAllCurrentModuleImages() {
    if (!globalGenContext?.tasks?.length) {
        showToast('当前没有已生成的模块图片', 'info');
        return;
    }

    const eligibleTasks = globalGenContext.tasks.filter(t => t.imageSrc && (t.imageSrc.startsWith('data:image/') || t.imageSrc.startsWith('http')));
    if (!eligibleTasks.length) {
        showToast('没有可压缩的图片', 'info');
        return;
    }

    const btn = document.getElementById('btnBatchCompressWebp');
    const origHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="ph-bold ph-spinner animate-spin"></i> <span>压缩中...</span>';
    }

    let totalSavedBytes = 0;
    let compressedCount = 0;

    try {
        for (const task of eligibleTasks) {
            if (typeof compressImageToWebp === 'function') {
                const res = await compressImageToWebp(task.imageSrc, { quality: 0.90 });
                if (res && res.changed && res.dataUrl) {
                    task.imageSrc = res.dataUrl;
                    task.compressedStats = res;
                    const saved = res.savingsBytes || Math.max(0, (res.originalSize || 0) - (res.compressedSize || 0));
                    totalSavedBytes += saved;
                    compressedCount++;

                    // 更新 DOM 节点预览图
                    const uniqueId = task.uniqueId || task.id;
                    const contentDiv = document.getElementById(`content-${uniqueId}`);
                    const img = contentDiv?.querySelector('img');
                    if (img) img.src = res.dataUrl;
                }
            }
        }

        if (compressedCount > 0) {
            const savedStr = typeof formatBytes === 'function' ? formatBytes(totalSavedBytes) : `${Math.round(totalSavedBytes / 1024)} KB`;
            showToast(`已成功将 ${compressedCount} 张图片压缩为 WebP 高清格式！累计瘦身 ${savedStr}`, 'success');
            if (currentDetailPresentationMode === 'hybrid' && typeof renderDtcHybridPreview === 'function') {
                renderDtcHybridPreview();
            }
        } else {
            showToast('当前图片已处于最优 WebP 压缩状态，无需重复压缩', 'info');
        }
    } catch (err) {
        console.error('Batch compress WebP failed:', err);
        showToast('批量转 WebP 失败: ' + err.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = origHtml;
        }
    }
}


// ====== 独立站 DTC 图文穿插 (Hybrid PDP) 预览与导出逻辑 ======

// 提取并清洗模块文案，确保语言规范与结构完备
function prepareTaskDtcCopy(task, isZh) {
    const copy = task?.dtcCopy || {};
    const def = (typeof MODULE_DEFAULT_EN !== 'undefined' && MODULE_DEFAULT_EN[task?.id]) || {
        tagline: 'KEY ADVANTAGE',
        headline: 'Engineered for Performance',
        subheadline: 'Built with industry-grade precision to ensure seamless everyday operation.',
        fbr: [{ feature: 'Thoughtful Design', benefit: 'Engineered for lasting everyday satisfaction.', result: '' }]
    };

    let tagline = copy.tagline || (!isZh ? def.tagline : task?.title || 'Core Feature');
    if (!isZh && hasChineseText(tagline)) tagline = def.tagline;

    let headline = copy.headline || (!isZh ? def.headline : task?.subtitle || task?.title || 'Product Highlight');
    if (!isZh && hasChineseText(headline)) headline = def.headline;

    let subheadline = copy.subheadline || copy.valueProposition || (!isZh ? def.subheadline : task?.subtitle || 'Built with industry-grade precision to ensure seamless everyday operation.');
    if (!isZh && hasChineseText(subheadline)) subheadline = def.subheadline;

    let fbrList = Array.isArray(copy.fbr) && copy.fbr.length
        ? copy.fbr
        : (Array.isArray(copy.trustBadges) && copy.trustBadges.length
            ? copy.trustBadges.map(b => ({ feature: (typeof b === 'string' ? b : b.feature || '').replace(/^✓\s*/, ''), benefit: (typeof b === 'string' ? '' : b.benefit || ''), result: '' }))
            : (isZh
                ? [{ feature: task?.title || '核心优势', benefit: task?.subtitle || '出色操作体验', result: '' }]
                : (def.fbr ? def.fbr.slice() : [{ feature: 'Verified Quality', benefit: 'Engineered for lasting everyday peace of mind.', result: '' }])));

    if (!isZh) {
        fbrList = fbrList.map((item, itemIdx) => {
            let feat = item.feature || '';
            let ben = item.benefit || item.result || '';
            if (hasChineseText(feat)) {
                feat = def.fbr?.[itemIdx]?.feature || def.fbr?.[0]?.feature || 'Premium Quality';
            }
            if (hasChineseText(ben)) {
                ben = def.fbr?.[itemIdx]?.benefit || def.fbr?.[0]?.benefit || 'Engineered for reliable everyday performance.';
            }
            return { feature: feat, benefit: ben };
        });
    }

    const imgSrc = safeFormatImgSrc(task?.imageSrc || '');
    return { copy, def, tagline, headline, subheadline, fbrList, imgSrc };
}

// 详情页模块图片替换选择器状态与逻辑
let currentSwappingModuleId = null;

function openModuleImagePicker(moduleId) {
    currentSwappingModuleId = moduleId;
    const modal = document.getElementById('moduleImagePickerModal');
    if (!modal) return;

    const task = globalGenContext?.tasks?.[moduleId];
    const currentLang = globalGenContext?.config?.language || document.getElementById('languageSelect')?.value || 'English';
    const isZh = currentLang === 'Chinese' || currentLang === '中文';
    const titleEl = document.getElementById('modulePickerTargetTitle');
    if (titleEl) {
        const modTitle = task?.displayTitle || task?.title || moduleId;
        titleEl.textContent = isZh ? `当前模块：${modTitle}` : `Target Module: ${modTitle}`;
    }

    const grid = document.getElementById('modulePickerUploadedGrid');
    if (grid) {
        let uploaded = (globalGenContext?.uploadedImages && globalGenContext.uploadedImages.length > 0)
            ? globalGenContext.uploadedImages
            : (typeof currentUploadedImages !== 'undefined' && currentUploadedImages && currentUploadedImages.length > 0 ? currentUploadedImages : []);

        if ((!uploaded || uploaded.length === 0) && globalGenContext?.tasks) {
            const taskList = Object.values(globalGenContext.tasks);
            const validTaskImages = taskList
                .filter(t => t && t.imageSrc && t.imageSrc.trim())
                .map((t, idx) => ({
                    base64: t.imageSrc,
                    imageSrc: t.imageSrc,
                    isPrimary: idx === 0,
                    role: idx === 0 ? 'primary' : 'module'
                }));
            if (validTaskImages.length > 0) {
                uploaded = validTaskImages;
            }
        }

        if (uploaded.length > 0) {
            grid.innerHTML = uploaded.map((img, idx) => {
                const src = safeFormatImgSrc(img.base64 || img.data || img.imageSrc || '');
                const isPrimary = img.isPrimary || idx === 0;
                return `
                <div class="relative group aspect-square rounded-xl overflow-hidden border-2 border-slate-200 hover:border-indigo-500 cursor-pointer transition-all shadow-2xs hover:shadow-md bg-slate-50" onclick="selectModuleImage('${moduleId}', '${src}')" title="${isZh ? '点击选用此图片' : 'Use this image'}">
                    <img src="${src}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200">
                    <div class="absolute inset-0 bg-indigo-950/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white text-[11px] font-black backdrop-blur-2xs">
                        <span>${isZh ? '选用此图' : 'Select'}</span>
                    </div>
                    ${isPrimary ? `<span class="absolute top-1 left-1 bg-indigo-600 text-white text-[9px] px-1.5 py-0.5 rounded font-black shadow-xs">${isZh ? '主图' : 'Primary'}</span>` : ''}
                </div>`;
            }).join('');
        } else {
            grid.innerHTML = `
                <div class="col-span-4 py-4 text-center text-xs text-slate-400 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                    ${isZh ? '暂无已上传的商品图，请在下方直接上传新图片' : 'No uploaded images available. Please upload a new image below.'}
                </div>`;
        }
    }

    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeModuleImagePicker() {
    currentSwappingModuleId = null;
    const modal = document.getElementById('moduleImagePickerModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

function selectModuleImage(moduleId, newSrc) {
    if (!moduleId || !newSrc) return;
    if (globalGenContext?.tasks?.[moduleId]) {
        globalGenContext.tasks[moduleId].imageSrc = newSrc;
        globalGenContext.tasks[moduleId].status = 'success';
        globalGenContext.tasks[moduleId].error = '';
        globalGenContext.tasks[moduleId].isFallback = false;
    }

    // 同步更新单图画廊视图中的模块图片（如果已渲染）
    const contentEl = document.getElementById(`content-mod-${moduleId}`);
    if (contentEl) {
        const img = contentEl.querySelector('img');
        if (img) {
            img.src = safeFormatImgSrc(newSrc);
        } else {
            contentEl.innerHTML = `<img src="${safeFormatImgSrc(newSrc)}" class="w-full h-full object-cover">`;
        }
    }

    // 重新渲染 DTC 独立站图文混排视图
    if (currentDetailResultView === 'hybrid' && typeof renderDtcHybridPreview === 'function') {
        renderDtcHybridPreview();
    }

    closeModuleImagePicker();
    if (typeof showToast === 'function') {
        showToast('模块图片已成功替换！', 'success');
    }
}

function handleModulePickerUpload(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
        if (typeof showToast === 'function') showToast('请选择有效的图片文件', 'error');
        return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
        const dataUrl = e.target?.result;
        if (dataUrl && currentSwappingModuleId) {
            selectModuleImage(currentSwappingModuleId, dataUrl);
        }
    };
    reader.readAsDataURL(file);
    event.target.value = '';
}

// 渲染统一图片容器（支持悬浮放大、点击打开灯箱、原图下载角标、行内模块换图）
function renderDtcImagePlate(imgSrc, title, isZh, aspectClass = 'aspect-square', roundedClass = 'rounded-2xl', extraWrapClass = '', taskId = '') {
    const escTitle = detailEscapeHtml(title || (isZh ? '模块大图' : 'Product Detail'));
    return `
    <div class="relative group ${roundedClass} overflow-hidden bg-slate-100 border border-slate-200/80 shadow-xs ${aspectClass} ${extraWrapClass}">
        ${imgSrc
            ? `<img src="${imgSrc}" alt="${escTitle}" loading="lazy" class="w-full h-full object-cover cursor-zoom-in transition-transform duration-300 group-hover:scale-105" onclick="openImageLightbox('${imgSrc}', '${escTitle}')" title="${isZh ? '点击查看大图' : 'View full image'}">`
            : `<div class="w-full h-full flex flex-col items-center justify-center text-slate-400 text-xs p-6 text-center">
                <i class="ph-bold ph-warning-circle text-3xl mb-1.5 text-rose-400"></i>
                <span class="font-bold text-slate-700">${isZh ? '图片生成失败或缺失' : 'Image generation failed'}</span>
                ${taskId ? `<button type="button" onclick="event.stopPropagation(); generateSingleWrap('${taskId}')" class="mt-2 text-xs font-bold text-rose-600 hover:text-rose-700 bg-white hover:bg-rose-50 border border-rose-200 px-2.5 py-1 rounded-md transition-all flex items-center gap-1 shadow-2xs cursor-pointer"><i class="ph-bold ph-arrows-clockwise"></i><span>${isZh ? '重新生成此图片' : 'Regenerate Image'}</span></button>` : ''}
               </div>`}
        ${taskId ? `
        <button type="button" class="dtc-image-swap-btn" onclick="event.stopPropagation(); openModuleImagePicker('${taskId}')" title="${isZh ? '替换当前模块图片' : 'Swap module image'}">
            <i class="ph-bold ph-arrows-clockwise text-xs"></i><span>${isZh ? '换图' : 'Swap'}</span>
        </button>` : ''}
        ${imgSrc ? `
        <div class="dtc-lightbox-trigger-badge absolute bottom-3 right-3 bg-black/60 hover:bg-black/80 backdrop-blur-xs text-white text-[11px] px-2.5 py-1 rounded cursor-pointer opacity-85 group-hover:opacity-100 transition-all flex items-center gap-1 z-10 shadow-xs select-none" onclick="openImageLightbox('${imgSrc}', '${escTitle}')" title="${isZh ? '点击放大查看' : 'View full image'}">
            <i class="ph ph-magnifying-glass-plus mr-0.5"></i>${isZh ? '原图' : 'View Full'}
        </div>` : ''}
    </div>`;
}

// 渲染 DTC 信任保障条 (Trust & Guarantee Bar)
function renderDtcTrustBar(isZh, style = 'editorial') {
    if (!currentDtcTrustBarEnabled) return '';
    const isTech = style === 'technical';
    const isLookbook = style === 'lookbook';
    const isMinimalist = style === 'minimalist';

    return `
    <div class="dtc-section-container" data-section="trust-bar">
        <div class="dtc-section-actions">
            <button type="button" class="dtc-section-copy-btn" onclick="copyDtcSectionHtml('trust-bar', '${isZh ? '信任保障条' : 'Trust Guarantee Bar'}')" title="${isZh ? '独立复制此模块 HTML' : 'Copy section HTML'}">
                <i class="ph ph-copy"></i><span>${isZh ? '复制模块 HTML' : 'Copy HTML'}</span>
            </button>
        </div>
        <section class="dtc-trust-bar ${isTech ? 'bg-slate-900/90 border-cyan-900/50 text-slate-200' : (isLookbook ? 'bg-stone-100 border-stone-200/80 text-stone-800' : (isMinimalist ? 'bg-slate-50 border-slate-200/70 text-slate-800' : ''))}">
            <div class="dtc-trust-item flex items-center gap-2.5">
                <div class="dtc-trust-icon w-8 h-8 rounded-lg ${isTech ? 'bg-cyan-950 text-cyan-400' : (isLookbook ? 'bg-amber-50 text-amber-800' : 'shadow-2xs')} flex items-center justify-center shrink-0 text-base">
                    <i class="ph-fill ph-truck"></i>
                </div>
                <div class="min-w-0">
                    <div class="text-xs font-bold leading-snug ${isTech ? 'text-white font-mono' : 'text-slate-900'}">${isZh ? '全场免运费' : 'Free Shipping'}</div>
                    <div class="text-[10px] ${isTech ? 'text-slate-400 font-mono' : 'text-slate-500'} leading-none mt-0.5">${isZh ? '直邮极速配送' : 'On all orders today'}</div>
                </div>
            </div>
            <div class="dtc-trust-item flex items-center gap-2.5">
                <div class="dtc-trust-icon w-8 h-8 rounded-lg ${isTech ? 'bg-cyan-950 text-cyan-400' : (isLookbook ? 'bg-amber-50 text-amber-800' : 'shadow-2xs')} flex items-center justify-center shrink-0 text-base">
                    <i class="ph-fill ph-shield-check"></i>
                </div>
                <div class="min-w-0">
                    <div class="text-xs font-bold leading-snug ${isTech ? 'text-white font-mono' : 'text-slate-900'}">${isZh ? '30天无忧试用' : '30-Day Money Back'}</div>
                    <div class="text-[10px] ${isTech ? 'text-slate-400 font-mono' : 'text-slate-500'} leading-none mt-0.5">${isZh ? '不满意全额退款' : '100% risk-free trial'}</div>
                </div>
            </div>
            <div class="dtc-trust-item flex items-center gap-2.5">
                <div class="dtc-trust-icon w-8 h-8 rounded-lg ${isTech ? 'bg-cyan-950 text-cyan-400' : (isLookbook ? 'bg-amber-50 text-amber-800' : 'shadow-2xs')} flex items-center justify-center shrink-0 text-base">
                    <i class="ph-fill ph-seal-check"></i>
                </div>
                <div class="min-w-0">
                    <div class="text-xs font-bold leading-snug ${isTech ? 'text-white font-mono' : 'text-slate-900'}">${isZh ? '1年正品联保' : '1-Year Warranty'}</div>
                    <div class="text-[10px] ${isTech ? 'text-slate-400 font-mono' : 'text-slate-500'} leading-none mt-0.5">${isZh ? '官方故障免费换新' : 'Full hardware coverage'}</div>
                </div>
            </div>
            <div class="dtc-trust-item flex items-center gap-2.5">
                <div class="dtc-trust-icon w-8 h-8 rounded-lg ${isTech ? 'bg-cyan-950 text-cyan-400' : (isLookbook ? 'bg-amber-50 text-amber-800' : 'shadow-2xs')} flex items-center justify-center shrink-0 text-base">
                    <i class="ph-fill ph-headset"></i>
                </div>
                <div class="min-w-0">
                    <div class="text-xs font-bold leading-snug ${isTech ? 'text-white font-mono' : 'text-slate-900'}">${isZh ? '7×24专属客服' : '24/7 Dedicated Support'}</div>
                    <div class="text-[10px] ${isTech ? 'text-slate-400 font-mono' : 'text-slate-500'} leading-none mt-0.5">${isZh ? '随时解答任何疑问' : 'Always here to assist'}</div>
                </div>
            </div>
        </section>
    </div>`;
}

// 渲染 CRO 价值堆叠清单与专属加赠 (Offer Stacking & Bonuses)
function renderDtcOfferStackSection(isZh, style = 'editorial') {
    const isTech = style === 'technical';
    const isLookbook = style === 'lookbook';
    const isMinimalist = style === 'minimalist';
    const isBento = style === 'bento';

    return `
    <div class="dtc-section-container" data-section="offer-stack">
        <div class="dtc-section-actions">
            <button type="button" class="dtc-section-copy-btn" onclick="copyDtcSectionHtml('offer-stack', '${isZh ? '价值清单与赠品卡片' : 'Offer Stack & Bonuses'}')" title="${isZh ? '独立复制此模块 HTML' : 'Copy section HTML'}">
                <i class="ph ph-copy"></i><span>${isZh ? '复制模块 HTML' : 'Copy HTML'}</span>
            </button>
        </div>
        <section class="dtc-offer-stack p-6 md:p-10 ${isTech ? 'bg-[#080d1a] border border-cyan-950/80 text-slate-200' : (isLookbook ? 'bg-[#fcfaf7] border border-stone-200/80 text-stone-900' : (isMinimalist ? 'bg-white border border-slate-200/80 text-slate-900' : (isBento ? 'bg-white rounded-3xl border border-slate-200/80' : 'bg-gradient-to-b from-indigo-50/40 to-white border border-indigo-100 rounded-3xl')))} shadow-sm space-y-6">
            <div class="text-center max-w-xl mx-auto space-y-2">
                <span class="inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider px-3 py-1 rounded-full ${isTech ? 'bg-cyan-950 text-cyan-400 border border-cyan-800' : (isLookbook ? 'bg-stone-200 text-stone-800' : 'bg-indigo-100 text-indigo-700')}">
                    <i class="ph-fill ph-gift"></i> ${isZh ? '限时超值组合包' : 'LIMITED-TIME BUNDLE VALUE'}
                </span>
                <h3 class="text-2xl font-black ${isTech ? 'text-white font-sans' : (isLookbook ? 'font-serif text-stone-900' : 'text-slate-900')} tracking-tight">
                    ${isZh ? '全套开箱包装清单与专属加赠' : "What's In The Box & Free Bonuses"}
                </h3>
                <p class="text-xs ${isTech ? 'text-slate-400 font-mono' : 'text-slate-500'}">
                    ${isZh ? '今日下单即享完整高阶配件包与专属增值特权，无需二次加购' : 'Everything you need to get started right out of the box, zero hidden costs.'}
                </p>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl mx-auto">
                <div class="p-4 rounded-2xl ${isTech ? 'bg-slate-900/90 border border-cyan-900/60' : 'bg-white border border-slate-200/90'} shadow-2xs flex items-center justify-between gap-3">
                    <div class="flex items-center gap-3">
                        <div class="w-9 h-9 rounded-xl ${isTech ? 'bg-cyan-950 text-cyan-400' : 'bg-indigo-50 text-indigo-600'} flex items-center justify-center font-black text-sm shrink-0">
                            1
                        </div>
                        <div>
                            <div class="text-sm font-bold text-slate-900">${isZh ? '旗舰主机与标准核心组件' : 'Main Flagship Hardware Unit'}</div>
                            <div class="text-[11px] text-slate-500">${isZh ? '出厂全套标配，拆箱即用' : 'Complete with factory certified components'}</div>
                        </div>
                    </div>
                    <span class="text-xs font-bold text-slate-400 line-through">$89.00</span>
                </div>

                <div class="p-4 rounded-2xl ${isTech ? 'bg-slate-900/90 border border-cyan-900/60' : 'bg-white border border-slate-200/90'} shadow-2xs flex items-center justify-between gap-3">
                    <div class="flex items-center gap-3">
                        <div class="w-9 h-9 rounded-xl ${isTech ? 'bg-cyan-950 text-cyan-400' : 'bg-amber-50 text-amber-600'} flex items-center justify-center font-black text-sm shrink-0">
                            🎁
                        </div>
                        <div>
                            <div class="text-sm font-bold text-slate-900">${isZh ? '赠品 1: 定制保护收纳套件' : 'Bonus #1: Custom Protective Kit'}</div>
                            <div class="text-[11px] text-slate-500">${isZh ? '防摔耐磨定制保护袋' : 'Water-resistant travel carrying case'}</div>
                        </div>
                    </div>
                    <span class="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">${isZh ? '免费加赠 ($29)' : 'FREE ($29 Value)'}</span>
                </div>

                <div class="p-4 rounded-2xl ${isTech ? 'bg-slate-900/90 border border-cyan-900/60' : 'bg-white border border-slate-200/90'} shadow-2xs flex items-center justify-between gap-3">
                    <div class="flex items-center gap-3">
                        <div class="w-9 h-9 rounded-xl ${isTech ? 'bg-cyan-950 text-cyan-400' : 'bg-amber-50 text-amber-600'} flex items-center justify-center font-black text-sm shrink-0">
                            🎁
                        </div>
                        <div>
                            <div class="text-sm font-bold text-slate-900">${isZh ? '赠品 2: 极速上手安装指南' : 'Bonus #2: Quickstart Master Guide'}</div>
                            <div class="text-[11px] text-slate-500">${isZh ? '手把手视频与彩印说明书' : 'Video walkthrough & cheat sheet'}</div>
                        </div>
                    </div>
                    <span class="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">${isZh ? '免费加赠 ($19)' : 'FREE ($19 Value)'}</span>
                </div>

                <div class="p-4 rounded-2xl ${isTech ? 'bg-slate-900/90 border border-cyan-900/60' : 'bg-white border border-slate-200/90'} shadow-2xs flex items-center justify-between gap-3">
                    <div class="flex items-center gap-3">
                        <div class="w-9 h-9 rounded-xl ${isTech ? 'bg-cyan-950 text-cyan-400' : 'bg-amber-50 text-amber-600'} flex items-center justify-center font-black text-sm shrink-0">
                            🛡️
                        </div>
                        <div>
                            <div class="text-sm font-bold text-slate-900">${isZh ? '终身VIP客服与延长保修' : 'VIP Priority Support & Warranty'}</div>
                            <div class="text-[11px] text-slate-500">${isZh ? '专属一对一售后极速响应' : 'Extended 1-on-1 lifetime care'}</div>
                        </div>
                    </div>
                    <span class="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">${isZh ? '免费升级' : 'INCLUDED'}</span>
                </div>
            </div>

            <div class="p-4 rounded-2xl bg-amber-50/80 border border-amber-200/80 max-w-2xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 text-center sm:text-left">
                <div>
                    <div class="text-xs text-amber-900 font-bold">${isZh ? '总感知价值 (Total Perceived Value)：$137+' : 'Total Perceived Value: $137+'}</div>
                    <div class="text-base font-black text-amber-950">${isZh ? '今日特惠直接省下 $50+，赠品全部免费送！' : 'Save $50+ today with all bonuses included!'}</div>
                </div>
                <div class="text-xs font-bold px-3 py-1.5 rounded-xl bg-amber-500 text-white shadow-xs shrink-0">
                    ${isZh ? '⚡ 仅限本批次现货' : '⚡ While Supplies Last'}
                </div>
            </div>
        </section>
    </div>`;
}

// 渲染 CRO 零风险退换保障卡 (Risk Reversal Guarantee)
function renderDtcRiskReversalSection(isZh, style = 'editorial') {
    const isTech = style === 'technical';
    const isLookbook = style === 'lookbook';

    return `
    <div class="dtc-section-container" data-section="risk-reversal">
        <div class="dtc-section-actions">
            <button type="button" class="dtc-section-copy-btn" onclick="copyDtcSectionHtml('risk-reversal', '${isZh ? '安心保障卡' : 'Risk Reversal Guarantee'}')" title="${isZh ? '独立复制此模块 HTML' : 'Copy section HTML'}">
                <i class="ph ph-copy"></i><span>${isZh ? '复制模块 HTML' : 'Copy HTML'}</span>
            </button>
        </div>
        <section class="dtc-risk-reversal p-6 md:p-8 ${isTech ? 'bg-slate-900/90 border border-cyan-900/60 text-slate-200' : 'bg-emerald-50/50 border border-emerald-200/70 text-slate-900'} rounded-3xl shadow-xs max-w-3xl mx-auto my-4 flex flex-col sm:flex-row items-center gap-5">
            <div class="w-14 h-14 rounded-2xl ${isTech ? 'bg-cyan-950 text-cyan-400 border border-cyan-800' : 'bg-emerald-100 text-emerald-700 border border-emerald-200'} flex items-center justify-center text-3xl shrink-0 shadow-sm">
                <i class="ph-fill ph-seal-check"></i>
            </div>
            <div class="flex-1 text-center sm:text-left space-y-1.5">
                <h4 class="text-base sm:text-lg font-black ${isTech ? 'text-white font-sans' : (isLookbook ? 'font-serif text-stone-900' : 'text-emerald-950')}">
                    ${isZh ? '100% 零风险试用保障：30天不满意全额退款' : '100% Risk-Free 30-Day Money Back Guarantee'}
                </h4>
                <p class="text-xs ${isTech ? 'text-slate-400 font-mono' : 'text-slate-600'} leading-relaxed">
                    ${isZh
                        ? '我们对产品品质有绝对信心。收到商品 30 天内，若有任何不满意，无需任何繁琐理由，联系客服即可发起全额退款。所有风险由我们承担，您可以完全放心体验！'
                        : 'Try it for 30 full days. If for any reason you are not completely thrilled with the results, contact our support team for a prompt and courteous full refund. No hassles, no questions asked.'}
                </p>
            </div>
        </section>
    </div>`;
}

// 构建自包含 Google-compliant JSON-LD (Product + FAQPage) Rich Snippets 结构化数据
function buildDtcJsonLdSchema(projectData) {
    const data = projectData || globalGenContext || {};
    const title = data.productName || document.getElementById('detailProductName')?.value || 'Premium Product';
    const desc = data.productSummary || 'High quality product engineered for performance and daily comfort.';
    const brand = data.brandName || 'Brand';

    const faqEntities = [];
    const taskList = Array.isArray(data.tasks)
        ? data.tasks
        : (data.tasks && typeof data.tasks === 'object' ? Object.values(data.tasks) : []);
    const faqTasks = taskList.filter(t => t && t.type === 'faq');
    faqTasks.forEach(task => {
        const copy = task.dtcCopy || {};
        const faqs = Array.isArray(copy.faqs) ? copy.faqs : [];
        faqs.forEach(f => {
            if (f && f.q && f.a) {
                faqEntities.push({
                    "@type": "Question",
                    "name": String(f.q),
                    "acceptedAnswer": {
                        "@type": "Answer",
                        "text": String(f.a)
                    }
                });
            }
        });
    });

    const graph = [
        {
            "@type": "Product",
            "@id": "#product",
            "name": title,
            "description": desc,
            "brand": {
                "@type": "Brand",
                "name": brand
            },
            "offers": {
                "@type": "Offer",
                "priceCurrency": "USD",
                "price": "49.99",
                "availability": "https://schema.org/InStock"
            }
        }
    ];

    if (faqEntities.length > 0) {
        graph.push({
            "@type": "FAQPage",
            "@id": "#faq",
            "mainEntity": faqEntities
        });
    }

    const schemaObj = {
        "@context": "https://schema.org",
        "@graph": graph
    };

    return `<script type="application/ld+json">\n${JSON.stringify(schemaObj, null, 2)}\n</script>`;
}

// 渲染使用流程与操作步骤
function renderDtcStepsSection(stepTasks, isZh, style = 'editorial') {
    if (!stepTasks.length) return '';
    const isTech = style === 'technical';
    const isLookbook = style === 'lookbook';
    const isBento = style === 'bento';
    const isMinimalist = style === 'minimalist';

    const content = stepTasks.map(task => {
        const copy = task.dtcCopy || {};
        const steps = Array.isArray(copy.steps) && copy.steps.length
            ? copy.steps
            : [
                { step: 1, title: isZh ? '拆箱与快速就位' : 'Unpack & Prepare', instruction: isZh ? '取出主机并确认随附配件齐全。' : 'Take out the unit and inspect the included accessories.' },
                { step: 2, title: isZh ? '60秒极速上手' : 'Quick 60-Second Setup', instruction: isZh ? '按照触感指示在1分钟内完成极简安装。' : 'Follow the intuitive tactile guides to complete setup in under a minute.' },
                { step: 3, title: isZh ? '畅享卓越效果' : 'Enjoy Effortless Results', instruction: isZh ? '体验零负担的流畅日常使用体验。' : 'Experience flawless daily results with zero hassle.' }
            ];

        return `
        <section class="p-6 md:p-10 ${isTech ? 'bg-[#0B0F19] border-t border-slate-800' : (isLookbook ? 'bg-[#faf8f5] border-t border-stone-200/80' : (isMinimalist ? 'bg-white border-t border-slate-100' : 'bg-slate-50/70 border-y border-slate-100'))} space-y-8">
            <div class="text-center max-w-xl mx-auto space-y-2">
                ${isTech
                    ? `<div class="inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-[10px] font-mono font-bold tracking-widest uppercase bg-cyan-950/80 text-cyan-400 border border-cyan-800/50"><span class="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"></span> [EXECUTION PIPELINE]</div>`
                    : (isLookbook
                        ? `<span class="text-[#b45309] font-sans tracking-[0.2em] text-xs uppercase font-semibold block">${detailEscapeHtml(copy.tagline || (isZh ? '简单三步上手' : 'EASY 3-STEP GUIDE'))}</span>`
                        : (isMinimalist
                            ? `<span class="text-xs uppercase tracking-widest font-mono text-slate-400 font-bold block">${detailEscapeHtml(copy.tagline || (isZh ? '简单三步上手' : 'EASY 3-STEP GUIDE'))}</span>`
                            : `<div class="dtc-section-tag"><i class="ph-fill ph-steps"></i> ${detailEscapeHtml(copy.tagline || (isZh ? '简单三步上手' : 'EASY 3-STEP GUIDE'))}</div>`))}
                <h2 class="text-2xl font-black ${isTech ? 'text-white font-sans' : (isLookbook ? 'text-stone-900 font-serif' : 'text-slate-900')} tracking-tight">${detailEscapeHtml(copy.headline || (isZh ? '开箱即用 简单高效' : 'How Simple It Is To Use'))}</h2>
                <p class="text-xs ${isTech ? 'text-slate-400 font-mono' : (isLookbook ? 'text-stone-600 font-sans' : 'text-slate-500')}">${isZh ? '无需专业知识，几秒内即可开始体验。' : 'Zero technical knowledge required. Ready out of the box in seconds.'}</p>
            </div>
            <div class="dtc-steps-grid grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-6">
                ${steps.map((st, i) => `
                <div class="dtc-step-card ${isTech ? 'bg-slate-900/80 border border-cyan-900/40 text-slate-200' : (isLookbook ? 'bg-white border border-stone-200/80' : (isBento ? 'bg-white rounded-3xl border border-slate-200/80' : (isMinimalist ? 'bg-slate-50/60 border border-slate-200/60' : 'bg-white border border-slate-200/80')))} p-5 sm:p-6 rounded-2xl shadow-xs relative flex flex-col md:flex-col gap-3.5 sm:gap-4 transition-all">
                    <div class="dtc-step-badge w-10 h-10 ${isBento ? 'rounded-2xl' : 'rounded-xl'} ${isTech ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/40 font-mono' : (isLookbook ? 'bg-stone-800 text-stone-100 font-serif' : (isMinimalist ? 'bg-slate-900 text-white font-mono' : 'text-white'))} font-black flex items-center justify-center text-sm shadow-sm shrink-0">
                        0${st.step || i + 1}
                    </div>
                    <div class="dtc-step-content space-y-1.5 flex-1 min-w-0">
                        <h4 class="font-black ${isTech ? 'text-white' : (isLookbook ? 'text-stone-900 font-serif' : 'text-slate-900')} text-base leading-snug">${detailEscapeHtml(st.title)}</h4>
                        <p class="text-xs ${isTech ? 'text-slate-400 font-mono' : (isLookbook ? 'text-stone-600 font-sans' : 'text-slate-600')} leading-relaxed">${detailEscapeHtml(st.instruction)}</p>
                    </div>
                </div>`).join('')}
            </div>
        </section>`;
    }).join('');

    return `
    <div class="dtc-section-container" data-section="steps">
        <div class="dtc-section-actions">
            <button type="button" class="dtc-section-copy-btn" onclick="copyDtcSectionHtml('steps', '${isZh ? '操作步骤' : 'Step-by-Step Guide'}')" title="${isZh ? '独立复制此模块 HTML' : 'Copy section HTML'}">
                <i class="ph ph-copy"></i><span>${isZh ? '复制模块 HTML' : 'Copy HTML'}</span>
            </button>
        </div>
        ${content}
    </div>`;
}

// 渲染规格参数与包装清单
function renderDtcSpecsSection(specsTasks, isZh, style = 'editorial') {
    if (!specsTasks.length) return '';
    const isTech = style === 'technical';
    const isLookbook = style === 'lookbook';
    const isBento = style === 'bento';
    const isMinimalist = style === 'minimalist';

    const content = specsTasks.map(task => {
        const copy = task.dtcCopy || {};
        const packageList = Array.isArray(copy.packageIncludes) && copy.packageIncludes.length
            ? copy.packageIncludes
            : (isZh
                ? ['1 × 核心设备主机', '1 × 详尽使用说明书', '1 × 高品质保护外盒', '1 × 官方品质保修卡']
                : ['1 × Master Product Unit', '1 × Comprehensive Manual', '1 × Premium Protection Case', '1 × 1-Year Warranty Card']);
        const specList = Array.isArray(copy.specifications) && copy.specifications.length
            ? copy.specifications
            : (isZh
                ? [
                    { label: '核心材质', value: '航空级合金与环保符合材料' },
                    { label: '设备重量', value: '轻量化紧凑便携设计' },
                    { label: '通用适配', value: '多规格标准全面兼容' },
                    { label: '权威认证', value: 'CE, FCC, RoHS 国际合规认证' }
                ]
                : [
                    { label: 'Primary Material', value: 'Aerospace-Grade Alloy & Eco Composite' },
                    { label: 'Weight', value: 'Compact & Ultralight Design' },
                    { label: 'Compatibility', value: 'Universal Standard' },
                    { label: 'Certification', value: 'CE, FCC, RoHS Certified' }
                ]);

        return `
        <section class="p-6 md:p-10 space-y-8 ${isTech ? 'bg-[#0B0F19]' : ''}">
            <div class="text-center max-w-xl mx-auto space-y-2">
                ${isTech
                    ? `<div class="inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-[10px] font-mono font-bold tracking-widest uppercase bg-cyan-950/80 text-cyan-400 border border-cyan-800/50">> [SYSTEM PARAMETERS & PACKAGING]</div>`
                    : (isLookbook
                        ? `<span class="text-[#b45309] font-sans tracking-[0.2em] text-xs uppercase font-semibold block">${detailEscapeHtml(copy.tagline || (isZh ? '透明配置' : 'TRANSPARENT DETAILS'))}</span>`
                        : `<div class="dtc-section-tag"><i class="ph-fill ph-package"></i> ${detailEscapeHtml(copy.tagline || (isZh ? '透明配置' : 'TRANSPARENT DETAILS'))}</div>`)}
                <h2 class="text-2xl font-black ${isTech ? 'text-white' : (isLookbook ? 'text-stone-900 font-serif' : 'text-slate-900')} tracking-tight">${detailEscapeHtml(copy.headline || (isZh ? '包装清单与规格参数' : 'What’s In The Box & Specifications'))}</h2>
            </div>
            <div class="dtc-specs-grid grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
                <!-- Package Included -->
                <div class="${isTech ? 'bg-slate-900/80 border border-cyan-900/40 text-slate-200' : (isLookbook ? 'bg-stone-50/70 border border-stone-200/80' : (isBento ? 'bg-white rounded-3xl border border-slate-200/80' : (isMinimalist ? 'bg-slate-50/60 border border-slate-200/60' : 'bg-slate-50/80 border border-slate-200/80')))} p-5 sm:p-6 rounded-2xl shadow-xs space-y-4">
                    <div class="font-black ${isTech ? 'text-white font-mono' : (isLookbook ? 'text-stone-900 font-serif' : 'text-slate-900')} text-sm flex items-center gap-2.5">
                        <div class="dtc-specs-icon w-7 h-7 rounded-lg ${isTech ? 'bg-cyan-950 text-cyan-400' : (isLookbook ? 'bg-amber-100 text-amber-800' : '')} flex items-center justify-center text-sm">
                            <i class="ph-bold ph-gift"></i>
                        </div>
                        <span>${isZh ? '包装随附清单' : "What's Included"}</span>
                    </div>
                    <ul class="space-y-2.5 text-xs ${isTech ? 'text-slate-300 font-mono' : (isLookbook ? 'text-stone-700 font-sans' : 'text-slate-700 font-medium')}">
                        ${packageList.map(item => `
                        <li class="flex items-center gap-2.5 ${isTech ? 'bg-slate-950 border border-cyan-900/40' : 'bg-white border border-slate-200/70'} px-3.5 py-2.5 rounded-xl shadow-2xs">
                            <i class="ph-bold ph-check ${isTech ? 'text-cyan-400' : 'text-emerald-600'} shrink-0 text-sm"></i>
                            <span class="leading-tight">${detailEscapeHtml(item)}</span>
                        </li>`).join('')}
                    </ul>
                </div>

                <!-- Tech Specs Table -->
                <div class="${isTech ? 'bg-slate-900/80 border border-cyan-900/40 text-slate-200' : (isLookbook ? 'bg-stone-50/70 border border-stone-200/80' : (isBento ? 'bg-white rounded-3xl border border-slate-200/80' : (isMinimalist ? 'bg-slate-50/60 border border-slate-200/60' : 'bg-slate-50/80 border border-slate-200/80')))} p-5 sm:p-6 rounded-2xl shadow-xs space-y-4">
                    <div class="font-black ${isTech ? 'text-white font-mono' : (isLookbook ? 'text-stone-900 font-serif' : 'text-slate-900')} text-sm flex items-center gap-2.5">
                        <div class="dtc-specs-icon w-7 h-7 rounded-lg ${isTech ? 'bg-cyan-950 text-cyan-400' : (isLookbook ? 'bg-amber-100 text-amber-800' : '')} flex items-center justify-center text-sm">
                            <i class="ph-bold ph-sliders"></i>
                        </div>
                        <span>${isZh ? '详细技术参数' : 'Technical Specifications'}</span>
                    </div>
                    <div class="divide-y ${isTech ? 'divide-slate-800 bg-slate-950 border border-cyan-900/40' : 'divide-slate-200/70 bg-white border border-slate-200/70'} text-xs rounded-xl shadow-2xs overflow-hidden px-4">
                        ${specList.map(spec => `
                        <div class="py-3 flex justify-between items-center gap-3">
                            <span class="${isTech ? 'text-slate-400 font-mono' : 'text-slate-500 font-medium'} shrink-0">${detailEscapeHtml(spec.label)}</span>
                            <span class="${isTech ? 'text-cyan-300 font-mono' : 'text-slate-900 font-bold'} text-right">${detailEscapeHtml(spec.value)}</span>
                        </div>`).join('')}
                    </div>
                </div>
            </div>
        </section>`;
    }).join('');

    return `
    <div class="dtc-section-container" data-section="specs">
        <div class="dtc-section-actions">
            <button type="button" class="dtc-section-copy-btn" onclick="copyDtcSectionHtml('specs', '${isZh ? '规格参数与清单' : 'Specs & Packaging'}')" title="${isZh ? '独立复制此模块 HTML' : 'Copy section HTML'}">
                <i class="ph ph-copy"></i><span>${isZh ? '复制模块 HTML' : 'Copy HTML'}</span>
            </button>
        </div>
        ${content}
    </div>`;
}

// 渲染套装全家福开箱
function renderDtcBundleBoxSection(bundleBoxTasks, isZh, style = 'editorial') {
    if (!bundleBoxTasks.length) return '';
    const isTech = style === 'technical';
    const isLookbook = style === 'lookbook';
    const isBento = style === 'bento';

    const content = bundleBoxTasks.map(task => {
        const copy = task.dtcCopy || {};
        const items = Array.isArray(copy.items) && copy.items.length
            ? copy.items
            : [
                { name: isZh ? '核心旗舰主机' : 'Core Hero Device', count: '1×', desc: isZh ? '精密核心性能单元' : 'Primary precision performance unit' },
                { name: isZh ? '多功能配件模组' : 'Comprehensive Accessory Pack', count: '4×', desc: isZh ? '全场景适用替换组件' : 'Multi-functional attachments and heads' },
                { name: isZh ? '极速快充适配器' : 'Quick Power Adapter & Cable', count: '1×', desc: isZh ? '快速安全充电线缆' : 'Fast safe universal charging system' },
                { name: isZh ? '定制防护收纳盒' : 'Protective Travel Storage Case', count: '1×', desc: isZh ? '高强度量身贴合保护' : 'Heavy-duty custom fit protection' }
            ];
        const imgSrc = safeFormatImgSrc(task.imageSrc || '');
        return `
        <!-- Bundle What's in the Box -->
        <section class="p-6 md:p-10 ${isTech ? 'bg-slate-950 border-t border-slate-800' : (isLookbook ? 'bg-[#f4efe6] border-y border-stone-200' : 'bg-slate-50/70 border-y border-slate-100')} space-y-8">
            <div class="text-center max-w-xl mx-auto space-y-2">
                <div class="dtc-section-tag"><i class="ph-fill ph-gift"></i> ${detailEscapeHtml(copy.tagline || (isZh ? '全配套装' : 'ALL-IN-ONE KIT'))}</div>
                <h2 class="text-2xl md:text-3xl font-black ${isTech ? 'text-white' : (isLookbook ? 'text-stone-900 font-serif' : 'text-slate-900')} tracking-tight">${detailEscapeHtml(copy.headline || (isZh ? '开箱全家福' : "What's In The Box"))}</h2>
                <p class="text-xs ${isTech ? 'text-slate-400 font-mono' : (isLookbook ? 'text-stone-600 font-sans' : 'text-slate-500')}">${detailEscapeHtml(copy.subheadline || (isZh ? '一应俱全，开箱即可发挥全部实力。' : 'Everything you need, unboxed and ready to perform right away.'))}</p>
            </div>
            <div class="dtc-bundle-box-grid grid grid-cols-1 ${imgSrc ? 'md:grid-cols-2' : ''} gap-6 md:gap-8 items-center">
                ${imgSrc ? renderDtcImagePlate(imgSrc, isZh ? '全家福清单' : "What's in the Box", isZh, 'aspect-square', isBento ? 'rounded-3xl' : 'rounded-2xl', '', task.id) : ''}
                <div class="space-y-3">
                    ${items.map((it, idx) => `
                    <div class="p-4 ${isTech ? 'bg-slate-900/90 border-cyan-900/50' : 'bg-white border-slate-200/80'} rounded-xl border shadow-2xs flex items-center justify-between gap-3">
                        <div class="flex items-center gap-3 min-w-0">
                            <div class="dtc-bundle-item-badge w-8 h-8 rounded-lg ${isTech ? 'bg-cyan-950 text-cyan-300 font-mono' : ''} font-black text-xs flex items-center justify-center shrink-0">
                            0${idx + 1}
                            </div>
                            <div class="min-w-0">
                                <div class="text-sm font-bold ${isTech ? 'text-white font-mono' : 'text-slate-900'} truncate">${detailEscapeHtml(it.name)}</div>
                                <div class="text-xs ${isTech ? 'text-slate-400 font-mono' : 'text-slate-500'} truncate">${detailEscapeHtml(it.desc || '')}</div>
                            </div>
                        </div>
                        <span class="dtc-bundle-count-badge px-2.5 py-1 ${isTech ? 'bg-cyan-950 text-cyan-300 border-cyan-800/40 font-mono' : ''} text-xs font-black rounded-lg border shrink-0">${detailEscapeHtml(it.count || '1×')}</span>
                    </div>`).join('')}
                </div>
            </div>
        </section>`;
    }).join('');

    return `
    <div class="dtc-section-container" data-section="bundle-box">
        <div class="dtc-section-actions">
            <button type="button" class="dtc-section-copy-btn" onclick="copyDtcSectionHtml('bundle-box', '${isZh ? '开箱全家福' : "What's in the Box"}')" title="${isZh ? '独立复制此模块 HTML' : 'Copy section HTML'}">
                <i class="ph ph-copy"></i><span>${isZh ? '复制模块 HTML' : 'Copy HTML'}</span>
            </button>
        </div>
        ${content}
    </div>`;
}

// 渲染套装立省对比
function renderDtcBundleSavingsSection(bundleSavingsTasks, isZh, style = 'editorial') {
    if (!bundleSavingsTasks.length) return '';
    const isTech = style === 'technical';
    const isLookbook = style === 'lookbook';

    const content = bundleSavingsTasks.map(task => {
        const copy = task.dtcCopy || {};
        const comp = copy.bundleComparison || {
            singleItemsTotal: '$129.99',
            bundlePrice: '$79.99',
            savingsText: isZh ? '立省 $50 (立享 62折)' : 'Save $50 (38% OFF)',
            perks: isZh
                ? ['官方标配原厂配件', '免去多番单独购买烦恼', '优先专线快速发货']
                : ['Official OEM accessories included', 'Zero compatibility hassle', 'Free priority expedited shipping']
        };
        return `
        <section class="p-6 md:p-10 space-y-6">
            <div class="max-w-2xl mx-auto ${isTech ? 'bg-slate-950 border border-cyan-800/60' : (isLookbook ? 'bg-stone-900 border border-stone-800' : 'bg-slate-900 border border-slate-800')} text-white p-6 sm:p-8 rounded-3xl shadow-xl space-y-6 relative overflow-hidden">
                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/10 pb-6">
                    <div>
                        <span class="text-[11px] uppercase tracking-widest ${isTech ? 'text-cyan-400 font-mono' : 'dtc-accent-text'} font-bold block">${detailEscapeHtml(copy.tagline || (isZh ? '套装立省' : 'BUNDLE & SAVE'))}</span>
                        <h3 class="text-2xl font-black tracking-tight mt-1 ${isLookbook ? 'font-serif' : ''}">${detailEscapeHtml(copy.headline || (isZh ? '整套选购 尽享专属特惠' : 'Complete System Advantage'))}</h3>
                    </div>
                    <div class="dtc-bundle-savings-badge ${isTech ? 'bg-cyan-500/20 border-cyan-400/40 text-cyan-300 font-mono' : ''} border px-3.5 py-1.5 rounded-full text-xs font-black self-start sm:self-auto flex items-center gap-1.5">
                        <i class="ph-fill ph-tag"></i> ${detailEscapeHtml(comp.savingsText || (isZh ? '超值精选' : 'BEST VALUE'))}
                    </div>
                </div>
                <div class="dtc-bundle-savings-grid grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div class="p-4 rounded-2xl bg-white/5 border border-white/10">
                        <span class="text-xs text-white/60 block">${isZh ? '单件分别购买总价' : 'If Bought Separately'}</span>
                        <span class="text-2xl font-bold line-through text-white/50">${detailEscapeHtml(comp.singleItemsTotal || '$129.99')}</span>
                        <span class="text-[11px] text-white/40 block mt-1">${isZh ? '单件零售价 + 分开邮费' : 'Individual parts + shipping'}</span>
                    </div>
                    <div class="p-4 rounded-2xl ${isTech ? 'bg-cyan-500/10 border-cyan-400/30' : 'dtc-bundle-price-card bg-white/5'} border">
                        <span class="text-xs ${isTech ? 'text-cyan-300 font-mono' : 'dtc-accent-text'} font-bold block">${isZh ? '套装专属特惠价' : 'Bundle Kit Special'}</span>
                        <span class="text-3xl font-black text-white">${detailEscapeHtml(comp.bundlePrice || '$79.99')}</span>
                        <span class="text-[11px] ${isTech ? 'text-cyan-300 font-mono' : 'dtc-accent-text'} font-bold block mt-1">✓ ${isZh ? '一键购齐 全部随附' : 'Complete package all-in-one'}</span>
                    </div>
                </div>
                <div class="space-y-2 pt-2 text-xs text-white/80">
                    ${(comp.perks || []).map(pk => `
                    <div class="flex items-center gap-2">
                        <i class="ph-bold ph-check-circle ${isTech ? 'text-cyan-400' : 'text-emerald-400'} shrink-0"></i>
                        <span>${detailEscapeHtml(pk)}</span>
                    </div>`).join('')}
                </div>
            </div>
        </section>`;
    }).join('');

    return `
    <div class="dtc-section-container" data-section="bundle-savings">
        <div class="dtc-section-actions">
            <button type="button" class="dtc-section-copy-btn" onclick="copyDtcSectionHtml('bundle-savings', '${isZh ? '套装立省对比' : 'Bundle & Save'}')" title="${isZh ? '独立复制此模块 HTML' : 'Copy section HTML'}">
                <i class="ph ph-copy"></i><span>${isZh ? '复制模块 HTML' : 'Copy HTML'}</span>
            </button>
        </div>
        ${content}
    </div>`;
}

// 渲染 FAQ 常见疑问解答折叠面板
function renderDtcFaqSection(faqTasks, isZh, style = 'editorial') {
    const faqTask = faqTasks[0];
    const copy = faqTask?.dtcCopy || {};
    const faqs = Array.isArray(copy.faqs) && copy.faqs.length
        ? copy.faqs
        : [
            { q: isZh ? "一般发货需要多长时间？" : "How long will delivery take?", a: isZh ? "所有订单均在24小时内处理完毕。标准物流通常在3-5个工作日内送达，提供全程实时物流追踪。" : "All orders are processed within 24 hours. Standard domestic shipping arrives within 3-5 business days with full real-time tracking." },
            { q: isZh ? "如果我不满意可以退换吗？" : "What if I am not completely satisfied?", a: isZh ? "我们为您提供30天无风险试用体验。若您未达到满分满意，可随时联系客服团队办理全额退款。" : "We proudly stand behind our product with a 30-day no-risk trial. If you don't love it, simply contact our support team for a full refund." },
            { q: isZh ? "新手第一次使用容易上手吗？" : "Is this suitable for first-time users?", a: isZh ? "完全无需担忧！产品专为直觉化开箱体验设计，配有图文并茂指南，无需任何专业知识。" : "Absolutely! It was purposefully designed for intuitive, out-of-the-box operation without requiring technical experience or tools." },
            { q: isZh ? "产品包含品质保障或保修吗？" : "Is there a warranty included?", a: isZh ? "每份购买均自动享有一年官方正品保修，涵盖制造缺陷与非人为故障，安心无忧。" : "Yes, every purchase includes an automatic 1-Year Comprehensive Manufacturer Warranty covering all defects and operational failures." }
        ];

    const isTech = style === 'technical';
    const isLookbook = style === 'lookbook';
    const isMinimalist = style === 'minimalist';
    const isBento = style === 'bento';

    return `
    <div class="dtc-section-container" data-section="faq">
        <div class="dtc-section-actions">
            <button type="button" class="dtc-section-copy-btn" onclick="copyDtcSectionHtml('faq', '${isZh ? '常见疑问解答' : 'FAQ'}')" title="${isZh ? '独立复制此模块 HTML' : 'Copy section HTML'}">
                <i class="ph ph-copy"></i><span>${isZh ? '复制模块 HTML' : 'Copy HTML'}</span>
            </button>
        </div>
        <section class="p-6 md:p-10 ${isTech ? 'bg-[#0B0F19] border-t border-slate-800 text-white' : (isLookbook ? 'bg-[#faf8f5] border-t border-stone-200/80 font-serif' : (isMinimalist ? 'bg-white border-t border-slate-100' : 'border-t border-slate-200/80 bg-gradient-to-b from-slate-50/50 to-white'))} space-y-8">
            <div class="text-center max-w-xl mx-auto space-y-2.5">
                ${isTech
                    ? `<div class="inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-[10px] font-mono font-bold tracking-widest uppercase bg-cyan-950/80 text-cyan-400 border border-cyan-800/50">> [FREQUENTLY ASKED QUESTIONS]</div>`
                    : (isLookbook
                        ? `<span class="text-[#b45309] font-sans tracking-[0.2em] text-xs uppercase font-semibold block">${isZh ? '常见疑虑解答' : 'FREQUENTLY ASKED QUESTIONS'}</span>`
                        : `<div class="dtc-section-tag"><i class="ph-fill ph-question"></i> ${isZh ? '常见疑虑解答' : 'FREQUENTLY ASKED QUESTIONS'}</div>`)}
                <h2 class="text-2xl md:text-3xl font-black ${isTech ? 'text-white' : (isLookbook ? 'text-stone-900' : 'text-slate-900')} tracking-tight">${isZh ? '选购前的常见疑问' : 'Got Questions? We’ve Got Answers'}</h2>
                <p class="text-xs sm:text-sm ${isTech ? 'text-slate-400 font-mono' : (isLookbook ? 'text-stone-600 font-sans' : 'text-slate-500')}">${isZh ? '为您解答关于品质、物流与售后的一切疑虑。' : 'Everything you need to know before making your purchase decision.'}</p>
                <div class="flex items-center justify-center gap-3 pt-1 text-[11px] font-semibold ${isTech ? 'text-slate-400 font-mono' : 'text-slate-500'}">
                    <span class="flex items-center gap-1"><i class="ph-fill ph-shield-check ${isTech ? 'text-cyan-400' : 'text-emerald-600'}"></i> ${isZh ? '30天无忧体验' : '30-Day Risk-Free Trial'}</span>
                    <span>•</span>
                    <span class="flex items-center gap-1"><i class="ph-fill ph-headset ${isTech ? 'text-cyan-400' : 'dtc-accent-text'}"></i> ${isZh ? '24小时专属客服' : '24/7 Fast Support'}</span>
                </div>
            </div>

            <div class="max-w-2xl mx-auto space-y-3.5">
                ${faqs.map((faq, i) => `
                <details class="dtc-accordion-item ${isTech ? 'bg-slate-900/80 border border-slate-800 text-white' : (isLookbook ? 'bg-white border border-stone-200/80' : (isBento ? 'bg-white border border-slate-200 rounded-3xl' : 'bg-white border border-slate-200/90 rounded-2xl'))} overflow-hidden shadow-xs transition-all duration-200 ${i === 0 ? 'active' : ''}" ${i === 0 ? 'open' : ''}>
                    <summary class="dtc-accordion-header p-4 sm:p-5 flex items-center justify-between gap-3.5 cursor-pointer select-none group" onclick="toggleDtcAccordion(this)">
                        <div class="flex items-center gap-3 min-w-0">
                            <div class="dtc-faq-q-badge w-7 h-7 rounded-lg ${isTech ? 'bg-cyan-950 text-cyan-400 font-mono' : (isLookbook ? 'bg-amber-50 text-amber-800' : '')} font-black text-xs flex items-center justify-center shrink-0 transition-all shadow-2xs">
                                Q
                            </div>
                            <span class="font-bold ${isTech ? 'text-slate-100 font-mono' : (isLookbook ? 'text-stone-900 font-serif' : 'text-slate-800')} text-sm sm:text-base leading-snug transition-colors">${detailEscapeHtml(faq.q)}</span>
                        </div>
                        <div class="dtc-chevron-circle w-7 h-7 rounded-full ${isTech ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-500'} flex items-center justify-center shrink-0 transition-all">
                            <i class="ph-bold ph-caret-down text-sm dtc-chevron-icon transition-transform duration-300"></i>
                        </div>
                    </summary>
                    <div class="dtc-accordion-body px-4 sm:px-5 pb-5 pt-0">
                        <div class="pt-3 border-t ${isTech ? 'border-slate-800 text-slate-300 font-mono' : 'border-slate-100/90 text-slate-600'} text-xs sm:text-sm leading-relaxed sm:pl-10 flex items-start gap-2.5">
                            <div class="w-5 h-5 rounded-md ${isTech ? 'bg-cyan-950 text-cyan-400' : 'bg-emerald-50 text-emerald-600'} font-bold text-[10px] flex items-center justify-center shrink-0 mt-0.5 shadow-2xs">A</div>
                            <div class="flex-1">${detailEscapeHtml(faq.a)}</div>
                        </div>
                    </div>
                </details>`).join('')}
            </div>
        </section>
    </div>`;
}

// 渲染终极行动召唤 CTA（已根据需求移除）
function renderDtcCtaSection(isZh, style = 'editorial') {
    return '';
}

// 风格 1：经典杂志交错风 (Editorial Alternating Grid)
function renderEditorialLayout(fbrTasks, stepTasks, specsTasks, bundleBoxTasks, bundleSavingsTasks, faqTasks, isZh, isDesktop) {
    return `
    <div class="dtc-pdp-wrapper dtc-style-editorial ${isDesktop ? 'dtc-viewport-desktop' : 'dtc-viewport-mobile'} font-sans text-slate-800 bg-white">
        <!-- 1. Feature - Benefit - Result (FBR Alternating Grid) -->
        ${fbrTasks.length ? `
        <div class="dtc-section-container" data-section="fbr">
            <div class="dtc-section-actions">
                <button type="button" class="dtc-section-copy-btn" onclick="copyDtcSectionHtml('fbr', '${isZh ? '痛点破局对比' : 'Core Highlights'}')" title="${isZh ? '独立复制此模块 HTML' : 'Copy section HTML'}">
                    <i class="ph ph-copy"></i><span>${isZh ? '复制模块 HTML' : 'Copy HTML'}</span>
                </button>
            </div>
            <section class="p-6 md:p-10 space-y-12">
                <div class="text-center max-w-xl mx-auto space-y-2">
                    <div class="dtc-section-tag"><i class="ph-fill ph-lightning"></i> ${isZh ? '直击痛点 精准解决' : 'DESIGNED TO SOLVE REAL PROBLEMS'}</div>
                    <h2 class="text-2xl md:text-3xl font-black text-slate-900 tracking-tight">${isZh ? '为什么选择我们且不再更换' : 'Why Our Customers Switch & Never Look Back'}</h2>
                    <p class="text-xs text-slate-500">${isZh ? '每一处工程细节都经过深思熟虑，旨在提供更出色的日常体验。' : 'Every design decision was engineered with intent to provide maximum efficiency and durability.'}</p>
                </div>

                <div class="space-y-16">
                    ${fbrTasks.map((task, idx) => {
                        const isEven = idx % 2 === 0;
                        const { tagline, headline, subheadline, fbrList, imgSrc } = prepareTaskDtcCopy(task, isZh);

                        return `
                        <div class="dtc-alternating-grid grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-12 items-center ${!isEven ? 'md:grid-flow-dense' : ''}">
                            <!-- Visual -->
                            <div class="${!isEven ? 'md:col-start-2' : ''}">
                                ${renderDtcImagePlate(imgSrc, headline, isZh, 'aspect-square', 'rounded-2xl', '', task.id)}
                            </div>

                            <!-- Content -->
                            <div class="space-y-4 ${!isEven ? 'md:col-start-1' : ''}">
                                <div class="space-y-2">
                                    <div class="dtc-section-tag">${detailEscapeHtml(tagline)}</div>
                                    <h3 class="text-xl md:text-2xl font-black text-slate-900 tracking-tight leading-snug" contenteditable="true" onblur="updateDtcText('${task.id}', 'headline', this)" title="${isZh ? '点击可直接编辑标题' : 'Click to edit headline'}">${detailEscapeHtml(headline)}</h3>
                                    <p class="text-sm text-slate-600 leading-relaxed" contenteditable="true" onblur="updateDtcText('${task.id}', 'subheadline', this)" title="${isZh ? '点击可直接编辑副标题' : 'Click to edit subheadline'}">${detailEscapeHtml(subheadline)}</p>
                                </div>

                                <div class="space-y-2.5 pt-2">
                                    ${fbrList.map((item, itemIdx) => {
                                        const cleanFeature = (item.feature || '').replace(/[:：]\s*$/, '').trim();
                                        const benefitText = (item.benefit || item.result || '').trim();
                                        return `
                                    <div class="dtc-fbr-chip flex items-start gap-2.5 p-2.5 rounded-xl bg-slate-50/80 border border-slate-200/70 hover:bg-slate-50 transition-all">
                                        <div class="dtc-fbr-check w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 text-xs font-black">
                                            <i class="ph-bold ph-check"></i>
                                        </div>
                                        <div class="text-xs leading-relaxed text-slate-700 min-w-0" contenteditable="true" onblur="updateDtcFbrItem('${task.id}', ${itemIdx}, this)" title="${isZh ? '点击可直接编辑要点' : 'Click to edit highlight'}">
                                            <strong class="font-bold text-slate-900">${detailEscapeHtml(cleanFeature)}${benefitText ? ':' : ''}</strong>
                                            ${benefitText ? `<span class="text-slate-600 ml-1">${detailEscapeHtml(benefitText)}</span>` : ''}
                                        </div>
                                    </div>`;
                                    }).join('')}
                                </div>
                            </div>
                        </div>`;
                    }).join('')}
                </div>
            </section>
        </div>` : ''}

        ${renderDtcTrustBar(isZh, 'editorial')}
        ${renderDtcStepsSection(stepTasks, isZh, 'editorial')}
        ${renderDtcSpecsSection(specsTasks, isZh, 'editorial')}
        ${renderDtcBundleBoxSection(bundleBoxTasks, isZh, 'editorial')}
        ${renderDtcBundleSavingsSection(bundleSavingsTasks, isZh, 'editorial')}
        ${renderDtcOfferStackSection(isZh, 'editorial')}
        ${renderDtcRiskReversalSection(isZh, 'editorial')}
        ${renderDtcFaqSection(faqTasks, isZh, 'editorial')}
    </div>`;
}

// 风格 2：苹果极简大图风 (Tech Minimalist)
function renderMinimalistLayout(fbrTasks, stepTasks, specsTasks, bundleBoxTasks, bundleSavingsTasks, faqTasks, isZh, isDesktop) {
    const heroTask = fbrTasks[0];
    const remainingTasks = fbrTasks.slice(1);
    const heroData = heroTask ? prepareTaskDtcCopy(heroTask, isZh) : null;

    return `
    <div class="dtc-pdp-wrapper dtc-style-minimalist ${isDesktop ? 'dtc-viewport-desktop' : 'dtc-viewport-mobile'} font-sans text-slate-900 bg-white">
        <!-- 1. Feature - Benefit - Result (Minimalist Hero + Feature Cards) -->
        ${fbrTasks.length ? `
        <div class="dtc-section-container" data-section="fbr">
            <div class="dtc-section-actions">
                <button type="button" class="dtc-section-copy-btn" onclick="copyDtcSectionHtml('fbr', '${isZh ? '极简大图卖点' : 'Core Highlights'}')" title="${isZh ? '独立复制此模块 HTML' : 'Copy section HTML'}">
                    <i class="ph ph-copy"></i><span>${isZh ? '复制模块 HTML' : 'Copy HTML'}</span>
                </button>
            </div>
            ${heroData ? `
            <section class="p-6 md:p-10">
                <div class="dtc-minimalist-hero relative rounded-3xl overflow-hidden bg-slate-950 text-white shadow-xl min-h-[360px] md:min-h-[460px] flex flex-col justify-end p-6 md:p-12 group">
                    ${heroData.imgSrc ? `
                    <img src="${heroData.imgSrc}" class="absolute inset-0 w-full h-full object-cover opacity-80 cursor-zoom-in transition-transform duration-700 group-hover:scale-105" onclick="openImageLightbox('${heroData.imgSrc}', '${detailEscapeHtml(heroData.headline)}')" title="${isZh ? '点击查看大图' : 'View full image'}">
                    <button type="button" class="dtc-image-swap-btn" style="bottom: auto; top: 16px; left: 16px;" onclick="event.stopPropagation(); openModuleImagePicker('${heroTask.id}')" title="${isZh ? '替换图片' : 'Swap image'}">
                        <i class="ph-bold ph-arrows-clockwise text-xs"></i><span>${isZh ? '换图' : 'Swap'}</span>
                    </button>
                    <div class="dtc-lightbox-trigger-badge absolute top-4 right-4 bg-black/60 hover:bg-black/80 backdrop-blur-xs text-white text-[11px] px-2.5 py-1 rounded-full cursor-pointer opacity-85 group-hover:opacity-100 transition-all flex items-center gap-1 z-10 shadow-xs select-none" onclick="openImageLightbox('${heroData.imgSrc}', '${detailEscapeHtml(heroData.headline)}')">
                        <i class="ph ph-magnifying-glass-plus mr-0.5"></i>${isZh ? '原图' : 'View Full'}
                    </div>` : ''}
                    <div class="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/40 to-transparent pointer-events-none"></div>
                    <div class="relative z-10 space-y-3 max-w-xl">
                        <span class="inline-block px-3 py-1 rounded-full text-[10px] font-mono font-bold tracking-widest uppercase bg-white/20 backdrop-blur-md border border-white/30 text-white">${detailEscapeHtml(heroData.tagline)}</span>
                        <h2 class="text-2xl sm:text-4xl font-extrabold tracking-tight text-white leading-tight" contenteditable="true" onblur="updateDtcText('${heroTask.id}', 'headline', this)" title="${isZh ? '点击可直接编辑标题' : 'Click to edit headline'}">${detailEscapeHtml(heroData.headline)}</h2>
                        <p class="text-xs sm:text-sm text-white/80 leading-relaxed max-w-lg" contenteditable="true" onblur="updateDtcText('${heroTask.id}', 'subheadline', this)" title="${isZh ? '点击可直接编辑副标题' : 'Click to edit subheadline'}">${detailEscapeHtml(heroData.subheadline)}</p>
                        <div class="flex flex-wrap gap-2 pt-2">
                            ${heroData.fbrList.map((item, idx) => `
                            <div class="backdrop-blur-md bg-white/15 border border-white/25 rounded-full px-3 py-1 text-xs text-white flex items-center gap-1.5" contenteditable="true" onblur="updateDtcFbrItem('${heroTask.id}', ${idx}, this)" title="${isZh ? '点击可直接编辑要点' : 'Click to edit highlight'}">
                                <i class="ph-bold ph-check text-emerald-400"></i>
                                <span class="font-bold">${detailEscapeHtml(item.feature)}</span>
                            </div>`).join('')}
                        </div>
                    </div>
                </div>
            </section>` : ''}

            <!-- 2. Subsequent Minimalist Feature Blocks -->
            ${remainingTasks.length ? `
            <section class="p-6 md:p-10 space-y-16">
                ${remainingTasks.map((task, idx) => {
                    const { tagline, headline, subheadline, fbrList, imgSrc } = prepareTaskDtcCopy(task, isZh);
                    const isReverse = idx % 2 === 1;
                    return `
                    <div class="dtc-minimalist-card grid grid-cols-1 md:grid-cols-12 gap-8 md:gap-12 items-center py-6 border-b border-slate-100 last:border-b-0 ${isReverse ? 'md:grid-flow-dense' : ''}">
                        <div class="dtc-minimalist-img md:col-span-7 ${isReverse ? 'md:col-start-6' : ''}">
                            ${renderDtcImagePlate(imgSrc, headline, isZh, 'aspect-4/3', 'rounded-3xl', '', task.id)}
                        </div>
                        <div class="dtc-minimalist-content md:col-span-5 space-y-4 ${isReverse ? 'md:col-start-1' : ''}">
                            <span class="text-xs uppercase tracking-widest font-mono text-slate-400 font-bold block">${detailEscapeHtml(tagline)}</span>
                            <h3 class="text-2xl font-black text-slate-900 tracking-tight" contenteditable="true" onblur="updateDtcText('${task.id}', 'headline', this)" title="${isZh ? '点击可直接编辑标题' : 'Click to edit headline'}">${detailEscapeHtml(headline)}</h3>
                            <p class="text-sm text-slate-500 leading-relaxed" contenteditable="true" onblur="updateDtcText('${task.id}', 'subheadline', this)" title="${isZh ? '点击可直接编辑副标题' : 'Click to edit subheadline'}">${detailEscapeHtml(subheadline)}</p>
                            <div class="space-y-3 pt-2">
                                ${fbrList.map((item, itemIdx) => {
                                    const cleanFeature = (item.feature || '').replace(/[:：]\s*$/, '').trim();
                                    const benefitText = (item.benefit || item.result || '').trim();
                                    return `
                                <div class="border-l-2 border-slate-900 pl-3.5 py-0.5 text-xs" contenteditable="true" onblur="updateDtcFbrItem('${task.id}', ${itemIdx}, this)" title="${isZh ? '点击可直接编辑要点' : 'Click to edit highlight'}">
                                    <strong class="font-bold text-slate-900 block">${detailEscapeHtml(cleanFeature)}</strong>
                                    ${benefitText ? `<span class="text-slate-500 text-[11px] block mt-0.5">${detailEscapeHtml(benefitText)}</span>` : ''}
                                </div>`;
                                }).join('')}
                            </div>
                        </div>
                    </div>`;
                }).join('')}
            </section>` : ''}
        </div>` : ''}

        ${renderDtcTrustBar(isZh, 'minimalist')}
        ${renderDtcStepsSection(stepTasks, isZh, 'minimalist')}
        ${renderDtcSpecsSection(specsTasks, isZh, 'minimalist')}
        ${renderDtcBundleBoxSection(bundleBoxTasks, isZh, 'minimalist')}
        ${renderDtcBundleSavingsSection(bundleSavingsTasks, isZh, 'minimalist')}
        ${renderDtcOfferStackSection(isZh, 'minimalist')}
        ${renderDtcRiskReversalSection(isZh, 'minimalist')}
        ${renderDtcFaqSection(faqTasks, isZh, 'minimalist')}
    </div>`;
}

// 风格 3：便当盒磁贴风 (Bento Grid)
function renderBentoLayout(fbrTasks, stepTasks, specsTasks, bundleBoxTasks, bundleSavingsTasks, faqTasks, isZh, isDesktop) {
    return `
    <div class="dtc-pdp-wrapper dtc-style-bento ${isDesktop ? 'dtc-viewport-desktop' : 'dtc-viewport-mobile'} font-sans text-slate-900 bg-slate-50/50">
        <!-- Bento Cards Section -->
        ${fbrTasks.length ? `
        <div class="dtc-section-container" data-section="fbr">
            <div class="dtc-section-actions">
                <button type="button" class="dtc-section-copy-btn" onclick="copyDtcSectionHtml('fbr', '${isZh ? '全能配置磁贴' : 'Bento Highlights'}')" title="${isZh ? '独立复制此模块 HTML' : 'Copy section HTML'}">
                    <i class="ph ph-copy"></i><span>${isZh ? '复制模块 HTML' : 'Copy HTML'}</span>
                </button>
            </div>
            <section class="p-6 md:p-10 space-y-8">
                <div class="text-center max-w-xl mx-auto space-y-2">
                    <div class="dtc-section-tag"><i class="ph-fill ph-squares-four"></i> ${isZh ? '全能配置 模块集合' : 'ALL-IN-ONE CAPABILITIES'}</div>
                    <h2 class="text-2xl md:text-3xl font-black text-slate-900 tracking-tight">${isZh ? '为全能卓越而生' : 'Engineered for Everyday Excellence'}</h2>
                    <p class="text-xs text-slate-500">${isZh ? '每一项关键指标，均经过工业级严苛打磨。' : 'Every core metric tested and refined for uncompromising performance.'}</p>
                </div>

                <div class="dtc-bento-grid grid grid-cols-1 md:grid-cols-3 gap-5">
                    ${fbrTasks.map((task, idx) => {
                        const { tagline, headline, subheadline, fbrList, imgSrc } = prepareTaskDtcCopy(task, isZh);
                        let spanClass = 'md:col-span-1';
                        let isHeroTile = false;
                        let isWideBanner = false;

                        if (fbrTasks.length >= 3 && idx === 0) {
                            spanClass = 'md:col-span-2 md:row-span-2';
                            isHeroTile = true;
                        } else if (fbrTasks.length >= 4 && idx === 3) {
                            spanClass = 'md:col-span-3';
                            isWideBanner = true;
                        } else if (fbrTasks.length === 1) {
                            spanClass = 'md:col-span-3';
                            isHeroTile = true;
                        } else if (fbrTasks.length === 2) {
                            spanClass = 'md:col-span-3 lg:col-span-3';
                            isHeroTile = true;
                        }

                        if (isHeroTile) {
                            return `
                            <div class="${spanClass} dtc-bento-tile dtc-bento-hero bg-white rounded-3xl p-6 sm:p-8 border border-slate-200/80 shadow-xs flex flex-col justify-between group relative overflow-hidden">
                                <div class="space-y-3 mb-6">
                                    <span class="inline-block text-[11px] font-bold px-2.5 py-1 rounded-full dtc-accent-badge uppercase tracking-wider">${detailEscapeHtml(tagline)}</span>
                                    <h3 class="text-xl sm:text-2xl font-black text-slate-900 tracking-tight" contenteditable="true" onblur="updateDtcText('${task.id}', 'headline', this)" title="${isZh ? '点击可直接编辑标题' : 'Click to edit headline'}">${detailEscapeHtml(headline)}</h3>
                                    <p class="text-xs sm:text-sm text-slate-600 leading-relaxed" contenteditable="true" onblur="updateDtcText('${task.id}', 'subheadline', this)" title="${isZh ? '点击可直接编辑副标题' : 'Click to edit subheadline'}">${detailEscapeHtml(subheadline)}</p>
                                </div>
                                ${renderDtcImagePlate(imgSrc, headline, isZh, 'aspect-4/3', 'rounded-2xl', 'w-full', task.id)}
                                <div class="flex flex-wrap gap-2 pt-4">
                                    ${fbrList.map((item, itemIdx) => `
                                    <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-50 border border-slate-200/70 text-xs text-slate-800 font-bold" contenteditable="true" onblur="updateDtcFbrItem('${task.id}', ${itemIdx}, this)" title="${isZh ? '点击可直接编辑要点' : 'Click to edit highlight'}">
                                        <i class="ph-bold ph-check text-emerald-600"></i> ${detailEscapeHtml(item.feature)}
                                    </span>`).join('')}
                                </div>
                            </div>`;
                        }

                        if (isWideBanner) {
                            return `
                            <div class="${spanClass} dtc-bento-tile dtc-bento-banner rounded-3xl p-6 sm:p-8 border shadow-xs grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
                                <div class="dtc-bento-banner-img">
                                    ${renderDtcImagePlate(imgSrc, headline, isZh, 'aspect-16/9', 'rounded-2xl', '', task.id)}
                                </div>
                                <div class="dtc-bento-banner-content space-y-3">
                                    <span class="inline-block text-[11px] font-bold px-2.5 py-1 rounded-full dtc-accent-badge uppercase tracking-wider">${detailEscapeHtml(tagline)}</span>
                                    <h3 class="text-xl font-black text-slate-900 tracking-tight" contenteditable="true" onblur="updateDtcText('${task.id}', 'headline', this)" title="${isZh ? '点击可直接编辑标题' : 'Click to edit headline'}">${detailEscapeHtml(headline)}</h3>
                                    <p class="text-xs text-slate-600 leading-relaxed" contenteditable="true" onblur="updateDtcText('${task.id}', 'subheadline', this)" title="${isZh ? '点击可直接编辑副标题' : 'Click to edit subheadline'}">${detailEscapeHtml(subheadline)}</p>
                                    <div class="space-y-1.5 pt-1">
                                        ${fbrList.map((item, itemIdx) => `
                                        <div class="text-xs text-slate-700 flex items-center gap-2" contenteditable="true" onblur="updateDtcFbrItem('${task.id}', ${itemIdx}, this)" title="${isZh ? '点击可直接编辑要点' : 'Click to edit highlight'}">
                                            <i class="ph-bold ph-check-circle dtc-accent-text"></i>
                                            <strong>${detailEscapeHtml(item.feature)}:</strong> ${detailEscapeHtml(item.benefit || '')}
                                        </div>`).join('')}
                                    </div>
                                </div>
                            </div>`;
                        }

                        return `
                        <div class="${spanClass} dtc-bento-tile bg-white rounded-3xl p-5 sm:p-6 border border-slate-200/80 shadow-xs flex flex-col justify-between group space-y-4">
                            <div class="space-y-2">
                                <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">${detailEscapeHtml(tagline)}</span>
                                <h4 class="text-base font-black text-slate-900 leading-snug" contenteditable="true" onblur="updateDtcText('${task.id}', 'headline', this)" title="${isZh ? '点击可直接编辑标题' : 'Click to edit headline'}">${detailEscapeHtml(headline)}</h4>
                                <p class="text-xs text-slate-500 leading-relaxed line-clamp-2" contenteditable="true" onblur="updateDtcText('${task.id}', 'subheadline', this)" title="${isZh ? '点击可直接编辑副标题' : 'Click to edit subheadline'}">${detailEscapeHtml(subheadline)}</p>
                            </div>
                            ${renderDtcImagePlate(imgSrc, headline, isZh, 'aspect-square', 'rounded-2xl', '', task.id)}
                            <div class="text-xs text-slate-700 border-t border-slate-100 pt-2.5">
                                ${fbrList[0] ? `<span class="font-bold text-slate-900">${detailEscapeHtml(fbrList[0].feature)}:</span> <span class="text-slate-500 text-[11px]">${detailEscapeHtml(fbrList[0].benefit || '')}</span>` : ''}
                            </div>
                        </div>`;
                    }).join('')}
                </div>
            </section>
        </div>` : ''}

        ${renderDtcTrustBar(isZh, 'bento')}
        ${renderDtcStepsSection(stepTasks, isZh, 'bento')}
        ${renderDtcSpecsSection(specsTasks, isZh, 'bento')}
        ${renderDtcBundleBoxSection(bundleBoxTasks, isZh, 'bento')}
        ${renderDtcBundleSavingsSection(bundleSavingsTasks, isZh, 'bento')}
        ${renderDtcOfferStackSection(isZh, 'bento')}
        ${renderDtcRiskReversalSection(isZh, 'bento')}
        ${renderDtcFaqSection(faqTasks, isZh, 'bento')}
    </div>`;
}

// 风格 4：优雅生活画册风 (Lifestyle Lookbook)
function renderLookbookLayout(fbrTasks, stepTasks, specsTasks, bundleBoxTasks, bundleSavingsTasks, faqTasks, isZh, isDesktop) {
    return `
    <div class="dtc-pdp-wrapper dtc-style-lookbook ${isDesktop ? 'dtc-viewport-desktop' : 'dtc-viewport-mobile'} font-serif text-stone-800 bg-[#faf8f5]">
        <!-- Lookbook Section -->
        ${fbrTasks.length ? `
        <div class="dtc-section-container" data-section="fbr">
            <div class="dtc-section-actions">
                <button type="button" class="dtc-section-copy-btn" onclick="copyDtcSectionHtml('fbr', '${isZh ? '质感画册卖点' : 'Lookbook Highlights'}')" title="${isZh ? '独立复制此模块 HTML' : 'Copy section HTML'}">
                    <i class="ph ph-copy"></i><span>${isZh ? '复制模块 HTML' : 'Copy HTML'}</span>
                </button>
            </div>
            <section class="p-6 md:p-10 space-y-16">
                <div class="text-center max-w-xl mx-auto space-y-3">
                    <span class="text-[#b45309] font-sans tracking-[0.2em] text-xs uppercase font-semibold block">${isZh ? '生活美学 • 质感日常' : 'CURATED LIVING • REFINED COMFORT'}</span>
                    <h2 class="text-2xl md:text-3xl font-normal text-stone-900 tracking-tight italic">${isZh ? '融入生活的每一个美好瞬间' : 'Crafted to Complement Your Moments'}</h2>
                    <div class="w-8 h-[1px] bg-stone-300 mx-auto"></div>
                </div>

                <div class="space-y-20">
                    ${fbrTasks.map(task => {
                        const { tagline, headline, subheadline, fbrList, imgSrc } = prepareTaskDtcCopy(task, isZh);
                        return `
                        <div class="dtc-lookbook-item max-w-2xl mx-auto text-center space-y-5 sm:space-y-6">
                            <div class="dtc-lookbook-mat bg-white p-2.5 sm:p-3.5 rounded-2xl sm:rounded-3xl shadow-xs border border-stone-200/80 max-w-xl mx-auto">
                                ${renderDtcImagePlate(imgSrc, headline, isZh, 'aspect-4/3', 'rounded-xl sm:rounded-2xl', 'w-full', task.id)}
                            </div>
                            <div class="space-y-3 px-2 sm:px-4">
                                <span class="font-sans text-[11px] tracking-widest text-[#b45309] uppercase font-semibold block">${detailEscapeHtml(tagline)}</span>
                                <h3 class="text-xl sm:text-2xl font-normal text-stone-900 font-serif leading-snug" contenteditable="true" onblur="updateDtcText('${task.id}', 'headline', this)" title="${isZh ? '点击可直接编辑标题' : 'Click to edit headline'}">${detailEscapeHtml(headline)}</h3>
                                <p class="text-xs sm:text-sm font-sans text-stone-600 leading-relaxed max-w-lg mx-auto" contenteditable="true" onblur="updateDtcText('${task.id}', 'subheadline', this)" title="${isZh ? '点击可直接编辑副标题' : 'Click to edit subheadline'}">${detailEscapeHtml(subheadline)}</p>
                                <div class="dtc-lookbook-chips flex flex-wrap items-center justify-center gap-2.5 sm:gap-4 pt-2 sm:pt-3 font-sans text-xs text-stone-700">
                                    ${fbrList.map((item, itemIdx) => {
                                        const cleanFeature = (item.feature || '').replace(/[:：]\s*$/, '').trim();
                                        const benefitText = (item.benefit || item.result || '').trim();
                                        return `
                                    <div class="inline-flex items-center gap-1.5" contenteditable="true" onblur="updateDtcFbrItem('${task.id}', ${itemIdx}, this)" title="${isZh ? '点击可直接编辑要点' : 'Click to edit highlight'}">
                                        <span class="w-1.5 h-1.5 rounded-full bg-amber-700 shrink-0"></span>
                                        <strong class="font-medium text-stone-900">${detailEscapeHtml(cleanFeature)}</strong>
                                        ${benefitText ? `<span class="text-stone-500">${detailEscapeHtml(benefitText)}</span>` : ''}
                                    </div>`;
                                    }).join('')}
                                </div>
                            </div>
                        </div>`;
                    }).join('')}
                </div>
            </section>
        </div>` : ''}

        ${renderDtcTrustBar(isZh, 'lookbook')}
        ${renderDtcStepsSection(stepTasks, isZh, 'lookbook')}
        ${renderDtcSpecsSection(specsTasks, isZh, 'lookbook')}
        ${renderDtcBundleBoxSection(bundleBoxTasks, isZh, 'lookbook')}
        ${renderDtcBundleSavingsSection(bundleSavingsTasks, isZh, 'lookbook')}
        ${renderDtcOfferStackSection(isZh, 'lookbook')}
        ${renderDtcRiskReversalSection(isZh, 'lookbook')}
        ${renderDtcFaqSection(faqTasks, isZh, 'lookbook')}
    </div>`;
}

// 风格 5：硬核参数极客风 (Technical Breakdown)
function renderTechnicalLayout(fbrTasks, stepTasks, specsTasks, bundleBoxTasks, bundleSavingsTasks, faqTasks, isZh, isDesktop) {
    return `
    <div class="dtc-pdp-wrapper dtc-style-technical ${isDesktop ? 'dtc-viewport-desktop' : 'dtc-viewport-mobile'} font-mono text-slate-100 bg-[#0B0F19]">
        <!-- Technical Section -->
        ${fbrTasks.length ? `
        <div class="dtc-section-container" data-section="fbr">
            <div class="dtc-section-actions">
                <button type="button" class="dtc-section-copy-btn" onclick="copyDtcSectionHtml('fbr', '${isZh ? '硬核参数架构' : 'Technical Specs'}')" title="${isZh ? '独立复制此模块 HTML' : 'Copy section HTML'}">
                    <i class="ph ph-copy"></i><span>${isZh ? '复制模块 HTML' : 'Copy HTML'}</span>
                </button>
            </div>
            <section class="p-6 md:p-10 space-y-12">
                <div class="text-center max-w-xl mx-auto space-y-2">
                    <div class="inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-[10px] font-mono font-bold tracking-widest uppercase bg-cyan-950/80 text-cyan-400 border border-cyan-800/50">
                        <span class="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"></span> [SYSTEM ARCHITECTURE & SPECIFICATIONS]
                    </div>
                    <h2 class="text-2xl md:text-3xl font-black text-white tracking-tight font-sans">${isZh ? '极限工况下的硬核表现' : 'Engineered For Extreme Reliability'}</h2>
                    <p class="text-xs text-slate-400 font-mono">${isZh ? '经多轮高强度工况与压力极限验证。' : 'Tested and validated under demanding high-load operational cycles.'}</p>
                </div>

                <div class="space-y-12">
                    ${fbrTasks.map((task, idx) => {
                        const isEven = idx % 2 === 0;
                        const { tagline, headline, subheadline, fbrList, imgSrc } = prepareTaskDtcCopy(task, isZh);

                        return `
                        <div class="dtc-technical-card bg-slate-900/80 rounded-2xl border border-cyan-900/40 p-5 sm:p-6 md:p-8 shadow-lg shadow-cyan-950/20 grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8 items-center ${!isEven ? 'md:grid-flow-dense' : ''}">
                            <div class="dtc-technical-img ${!isEven ? 'md:col-start-2' : ''}">
                                <div class="relative">
                                    ${renderDtcImagePlate(imgSrc, headline, isZh, 'aspect-square', 'rounded-xl', 'border-cyan-900/60', task.id)}
                                    <div class="absolute top-2 left-2 px-2 py-0.5 rounded bg-cyan-950/90 border border-cyan-500/50 text-[10px] text-cyan-300 font-mono">
                                        SPEC_${String(idx + 1).padStart(2, '0')} // VERIFIED
                                    </div>
                                </div>
                            </div>
                            <div class="dtc-technical-content space-y-4 ${!isEven ? 'md:col-start-1' : ''}">
                                <div class="space-y-2">
                                    <span class="text-xs font-mono text-cyan-400 tracking-wider uppercase block">> ${detailEscapeHtml(tagline)}</span>
                                    <h3 class="text-xl md:text-2xl font-black text-white font-sans tracking-tight leading-snug" contenteditable="true" onblur="updateDtcText('${task.id}', 'headline', this)" title="${isZh ? '点击可直接编辑标题' : 'Click to edit headline'}">${detailEscapeHtml(headline)}</h3>
                                    <p class="text-xs sm:text-sm text-slate-300 font-mono leading-relaxed" contenteditable="true" onblur="updateDtcText('${task.id}', 'subheadline', this)" title="${isZh ? '点击可直接编辑副标题' : 'Click to edit subheadline'}">${detailEscapeHtml(subheadline)}</p>
                                </div>
                                <div class="space-y-2 pt-2">
                                    ${fbrList.map((item, itemIdx) => {
                                        const cleanFeature = (item.feature || '').replace(/[:：]\s*$/, '').trim();
                                        const benefitText = (item.benefit || item.result || '').trim();
                                        return `
                                    <div class="bg-slate-950/80 border border-cyan-900/50 rounded-xl p-3 flex items-start gap-3">
                                        <div class="w-5 h-5 rounded bg-cyan-950 text-cyan-400 font-mono text-xs flex items-center justify-center shrink-0 border border-cyan-800/40">></div>
                                        <div class="text-xs min-w-0" contenteditable="true" onblur="updateDtcFbrItem('${task.id}', ${itemIdx}, this)" title="${isZh ? '点击可直接编辑要点' : 'Click to edit highlight'}">
                                            <strong class="font-mono text-cyan-300 block">${detailEscapeHtml(cleanFeature)}</strong>
                                            ${benefitText ? `<span class="text-slate-400">${detailEscapeHtml(benefitText)}</span>` : ''}
                                        </div>
                                    </div>`;
                                    }).join('')}
                                </div>
                            </div>
                        </div>`;
                    }).join('')}
                </div>
            </section>
        </div>` : ''}

        ${renderDtcTrustBar(isZh, 'technical')}
        ${renderDtcStepsSection(stepTasks, isZh, 'technical')}
        ${renderDtcSpecsSection(specsTasks, isZh, 'technical')}
        ${renderDtcBundleBoxSection(bundleBoxTasks, isZh, 'technical')}
        ${renderDtcBundleSavingsSection(bundleSavingsTasks, isZh, 'technical')}
        ${renderDtcOfferStackSection(isZh, 'technical')}
        ${renderDtcRiskReversalSection(isZh, 'technical')}
        ${renderDtcFaqSection(faqTasks, isZh, 'technical')}
    </div>`;
}

// 渲染 DTC 独立站图文穿插高转化详情页预览（风格路由分发）
function renderDtcHybridPreview() {
    const container = document.getElementById('dtcHybridContainer');
    if (!container || !globalGenContext) return;

    const tasks = globalGenContext.tasks || {};
    const taskIds = Object.keys(tasks);
    const currentLang = globalGenContext?.config?.language || document.getElementById('languageSelect')?.value || 'English';
    const isZh = currentLang === 'Chinese' || currentLang === '中文';

    if (!taskIds.length) {
        container.innerHTML = `
            <div class="p-12 text-center text-slate-400 bg-white rounded-2xl border border-dashed border-slate-200 w-full max-w-2xl mx-auto">
                <i class="ph ph-shopping-bag-open text-4xl mb-2 text-slate-300"></i>
                <p class="text-sm font-medium">${isZh ? '尚未生成任何详情页模块内容' : 'No detail page modules generated yet'}</p>
                <p class="text-xs text-slate-400 mt-1">${isZh ? '请先选择模块并点击“开始生成详情页”' : 'Please select modules and start generation'}</p>
            </div>
        `;
        return;
    }

    const isDesktop = currentDtcViewport === 'desktop';

    // 模块分组分类
    const fbrTasks = [];
    const stepTasks = [];
    const specsTasks = [];
    const faqTasks = [];
    const bundleBoxTasks = [];
    const bundleSavingsTasks = [];

    const order = Array.isArray(globalGenContext.longImageOrder) && globalGenContext.longImageOrder.length
        ? globalGenContext.longImageOrder
        : taskIds;

    order.forEach(id => {
        const t = tasks[id];
        if (!t) return;
        if (t.id === 'm11') {
            faqTasks.push(t);
        } else if (t.id === 'm12' || t.id === 'm15') {
            stepTasks.push(t);
        } else if (t.id === 'm10' || t.id === 'm8') {
            specsTasks.push(t);
        } else if (t.id === 'm13') {
            bundleBoxTasks.push(t);
        } else if (t.id === 'm14') {
            bundleSavingsTasks.push(t);
        } else {
            fbrTasks.push(t);
        }
    });

    let html = '';
    const style = currentDtcLayoutStyle || 'editorial';
    switch (style) {
        case 'minimalist':
            html = renderMinimalistLayout(fbrTasks, stepTasks, specsTasks, bundleBoxTasks, bundleSavingsTasks, faqTasks, isZh, isDesktop);
            break;
        case 'bento':
            html = renderBentoLayout(fbrTasks, stepTasks, specsTasks, bundleBoxTasks, bundleSavingsTasks, faqTasks, isZh, isDesktop);
            break;
        case 'lookbook':
            html = renderLookbookLayout(fbrTasks, stepTasks, specsTasks, bundleBoxTasks, bundleSavingsTasks, faqTasks, isZh, isDesktop);
            break;
        case 'technical':
            html = renderTechnicalLayout(fbrTasks, stepTasks, specsTasks, bundleBoxTasks, bundleSavingsTasks, faqTasks, isZh, isDesktop);
            break;
        case 'editorial':
        default:
            html = renderEditorialLayout(fbrTasks, stepTasks, specsTasks, bundleBoxTasks, bundleSavingsTasks, faqTasks, isZh, isDesktop);
            break;
    }

    container.innerHTML = html;
    applyDtcBrandColorStyles();
}

// 切换 FAQ 折叠面板展开/收起
function toggleDtcAccordion(headerEl) {
    if (!headerEl) return;
    const item = headerEl.closest('.dtc-accordion-item');
    if (!item) return;
    item.classList.toggle('active');
}

// 打开全尺寸大图灯箱
function openImageLightbox(src, title = '') {
    const modal = document.getElementById('detailImageLightboxModal');
    const img = document.getElementById('lightboxImage') || document.getElementById('lightboxImg');
    const titleEl = document.getElementById('lightboxTitle');
    const dlBtn = document.getElementById('lightboxDownloadBtn');
    const dlText = document.getElementById('lightboxDownloadText');
    if (!modal || !img) return;
    img.src = src;
    const currentLang = globalGenContext?.config?.language || document.getElementById('languageSelect')?.value || 'English';
    const isZh = currentLang === 'Chinese' || currentLang === '中文';
    if (titleEl) titleEl.textContent = title || (isZh ? '模块大图预览' : 'Image Preview');
    if (dlText) dlText.textContent = isZh ? '下载原画' : 'Download Full Size';
    if (dlBtn) {
        dlBtn.href = src;
        const pad = n => n.toString().padStart(2, '0');
        const d = new Date();
        const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
        dlBtn.download = `${(title || 'detail_image').replace(/[/\\?%*:|"<>]/g, '_')}_${ts}.png`;
    }
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

// 关闭全尺寸大图灯箱
function closeImageLightbox() {
    const modal = document.getElementById('detailImageLightboxModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

// 上传全尺寸大图灯箱中的图片到云图床
function uploadLightboxImageToCloud() {
    const img = document.getElementById('lightboxImage') || document.getElementById('lightboxImg');
    const titleEl = document.getElementById('lightboxTitle');
    const title = titleEl?.textContent || 'Product Detail View';
    if (!img || !img.src) {
        if (typeof showToast === 'function') showToast('暂无有效预览图片', 'warning');
        return;
    }
    const cleanTitle = title.replace(/[/\\?%*:|"<>]/g, '_').trim();
    if (typeof window !== 'undefined' && typeof window.openUniversalImageUploader === 'function') {
        window.openUniversalImageUploader({
            sourceModule: 'details-lightbox',
            imageData: img.src,
            filename: `${cleanTitle}.png`,
            title: cleanTitle,
            altText: cleanTitle
        });
    } else {
        if (typeof showToast === 'function') showToast('云存储图床托管组件未加载', 'warning');
    }
}

// 上传单个生成模块图片到云图床
function uploadDetailModuleToCloud(modId) {
    if (!globalGenContext || !globalGenContext.tasks || !globalGenContext.tasks[modId]) {
        if (typeof showToast === 'function') showToast('未找到指定模块任务', 'warning');
        return;
    }
    const task = globalGenContext.tasks[modId];
    if (!task.imageSrc) {
        if (typeof showToast === 'function') showToast('模块图片尚未生成', 'warning');
        return;
    }
    const prodName = globalGenContext?.config?.productName || 'product';
    const displayTitle = task.displayTitle || task.title || 'module';
    const cleanProd = prodName.replace(/[/\\?%*:|"<>]/g, '_').trim();
    const cleanTitle = displayTitle.replace(/[/\\?%*:|"<>]/g, '_').trim();
    const filename = `${cleanProd}_${cleanTitle}.png`;
    const title = task.seoTitle || `${prodName} - ${displayTitle}`;
    const altText = task.seoAlt || `${displayTitle} feature view of ${prodName}`;

    if (typeof window !== 'undefined' && typeof window.openUniversalImageUploader === 'function') {
        window.openUniversalImageUploader({
            sourceModule: 'details',
            imageData: task.imageSrc,
            filename: filename,
            title: title,
            altText: altText
        });
    } else {
        if (typeof showToast === 'function') showToast('云存储图床托管组件未加载', 'warning');
    }
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeImageLightbox();
        }
    });
}

// 深度清洗导出或复制的 HTML，剥离前端行内编辑辅助属性 (contenteditable, onblur, title 等)、灯箱预览属性、图片替换按钮与单模块复制按钮，并收敛多余空行以免疫 WordPress wpautop 段落注入
function cleanDtcExportHtml(html) {
    if (!html) return '';
    let cleaned = html
        .replace(/\bdtc-viewport-mobile\b/g, 'dtc-viewport-desktop')
        .replace(/<div class="dtc-lightbox-trigger-badge[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
        .replace(/<button[^>]*class="[^"]*dtc-image-swap-btn[^"]*"[^>]*>[\s\S]*?<\/button>/gi, '')
        .replace(/<div class="dtc-section-actions[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
        .replace(/\s*contenteditable=(["'])true\1/gi, '')
        .replace(/\s*contenteditable(?=[\s>])/gi, '')
        .replace(/\s*onblur=(["'])updateDtc[a-zA-Z0-9_]*\([^)]*\)\1/gi, '')
        .replace(/\s*onclick=(["'])openImageLightbox\([^)]*\)\1/gi, '')
        .replace(/\s*onclick=(["'])(?:event\.stopPropagation\(\);\s*)?(?:openModuleImagePicker|copyDtcSectionHtml)\([^)]*\)\1/gi, '')
        .replace(/\s*title=(["'])(点击可直接编辑|Click to edit|点击查看大图|View full image|点击放大全家福|View package image|替换当前模块图片|Swap module image|替换图片|Swap image|复制此模块 HTML|Copy section HTML)[^"']*\1/gi, '')
        .replace(/\bcursor-zoom-in\b/gi, '');

    // WordPress wpautop 防护：收拢标签间多余的空行与孤立换行，避免 WP 自动插入空 <p></p> 破坏栅格
    cleaned = cleaned.replace(/>\s*[\r\n]+\s*</g, '>\n<').trim();
    return cleaned;
}

// 实时同步独立站详情页文案编辑到全局上下文
function updateDtcText(taskId, field, el) {
    if (!globalGenContext?.tasks?.[taskId] || !el) return;
    const task = globalGenContext.tasks[taskId];
    if (!task.dtcCopy) task.dtcCopy = {};
    const text = (el.innerText || el.textContent || '').trim();
    task.dtcCopy[field] = text;
}

// 实时同步核心卖点要点列表编辑到全局上下文
function updateDtcFbrItem(taskId, itemIdx, el) {
    if (!globalGenContext?.tasks?.[taskId] || !el) return;
    const task = globalGenContext.tasks[taskId];
    if (!task.dtcCopy) task.dtcCopy = {};
    if (!Array.isArray(task.dtcCopy.fbr)) task.dtcCopy.fbr = [];
    if (!task.dtcCopy.fbr[itemIdx]) task.dtcCopy.fbr[itemIdx] = { feature: '', benefit: '' };

    const strongEl = el.querySelector('strong');
    const spanEl = el.querySelector('span');
    if (strongEl && spanEl) {
        task.dtcCopy.fbr[itemIdx].feature = (strongEl.innerText || strongEl.textContent || '').replace(/[:：]\s*$/, '').trim();
        task.dtcCopy.fbr[itemIdx].benefit = (spanEl.innerText || spanEl.textContent || '').trim();
    } else {
        const full = (el.innerText || el.textContent || '').trim();
        const colonPos = full.indexOf(':') !== -1 ? full.indexOf(':') : full.indexOf('：');
        if (colonPos > 0) {
            task.dtcCopy.fbr[itemIdx].feature = full.slice(0, colonPos).trim();
            task.dtcCopy.fbr[itemIdx].benefit = full.slice(colonPos + 1).trim();
        } else {
            task.dtcCopy.fbr[itemIdx].feature = full;
            task.dtcCopy.fbr[itemIdx].benefit = '';
        }
    }
}

// 生成兼容 Shopify / WordPress / WooCommerce / PageFly 的高鲁棒性自包含样式与图标依赖
function buildDtcStandaloneStylesheet(brandColor, isModular = false, typography = null) {
    const scope = isModular ? '.dtc-modular-section' : '.dtc-pdp-wrapper';
    let resolvedColor = brandColor;
    if (typeof resolvedColor === 'string') {
        const colorMap = getDtcBrandColorMap();
        if (colorMap && colorMap[resolvedColor]) {
            resolvedColor = colorMap[resolvedColor];
        } else if (resolvedColor.startsWith('#')) {
            resolvedColor = computeCustomBrandColor(resolvedColor);
        }
    }
    const fallbackColor = (resolvedColor && typeof resolvedColor === 'object' && resolvedColor.primary)
        ? resolvedColor
        : { primary: '#4f46e5', light: '#eef2ff', border: '#c7d2fe', text: '#4338ca' };

    const fonts = getDtcFontFamiliesMap();
    const baseDefault = (typeof DTC_DEFAULT_TYPOGRAPHY !== 'undefined') ? DTC_DEFAULT_TYPOGRAPHY : {
        fontFamily: 'inter',
        titleFont: 'inherit',
        titleSize: '28px',
        titleWeight: '700',
        titleSpacing: '-0.02em',
        subtitleSize: '18px',
        subtitleWeight: '600',
        bodySize: '14px',
        bodyWeight: '400',
        bodyLineHeight: '1.6'
    };
    const activeCurrent = (typeof currentDtcTypography !== 'undefined') ? currentDtcTypography : {};
    const typo = { ...baseDefault, ...activeCurrent, ...(typography || {}) };

    const mainFontFamily = resolveFontFamilyCss(typo.fontFamily);
    const titleFontFamily = typo.titleFont === 'inherit'
        ? mainFontFamily
        : resolveFontFamilyCss(typo.titleFont);

    // 收集所需 Google Fonts 并生成 @import 规则
    const googleImports = [];
    const mainFontSpec = fonts[typo.fontFamily]?.googleFont;
    if (mainFontSpec) googleImports.push(mainFontSpec);
    if (typo.titleFont !== 'inherit' && fonts[typo.titleFont]?.googleFont && fonts[typo.titleFont]?.googleFont !== mainFontSpec) {
        googleImports.push(fonts[typo.titleFont].googleFont);
    }
    const googleFontImportRule = googleImports.length
        ? `@import url('https://fonts.googleapis.com/css2?${googleImports.map(spec => `family=${spec}`).join('&')}&display=swap');`
        : '';

    return `
<link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/bold/style.css">
<link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css">
<link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/fill/style.css">
<style>
${googleFontImportRule}
@import url('https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css');
@import url('https://unpkg.com/@phosphor-icons/web@2.1.1/src/bold/style.css');
@import url('https://unpkg.com/@phosphor-icons/web@2.1.1/src/fill/style.css');

/* ==========================================================================
   DTC PDP Engine — Self-Contained Stylesheet for Shopify, WordPress, & PageFly
   ========================================================================== */

${scope} {
    --dtc-accent: ${fallbackColor.primary};
    --dtc-accent-light: ${fallbackColor.light};
    --dtc-accent-border: ${fallbackColor.border};
    --dtc-accent-text: ${fallbackColor.text};
    --dtc-font-family: ${mainFontFamily};
    --dtc-title-font: ${titleFontFamily};
    --dtc-title-size: ${typo.titleSize || '28px'};
    --dtc-title-weight: ${typo.titleWeight || '700'};
    --dtc-title-spacing: ${typo.titleSpacing || '-0.02em'};
    --dtc-subtitle-size: ${typo.subtitleSize || '18px'};
    --dtc-subtitle-weight: ${typo.subtitleWeight || '600'};
    --dtc-body-size: ${typo.bodySize || '14px'};
    --dtc-body-weight: ${typo.bodyWeight || '400'};
    --dtc-body-line-height: ${typo.bodyLineHeight || '1.6'};
    width: 100% !important;
    max-width: 960px !important;
    margin: 0 auto !important;
    background-color: #ffffff;
    box-sizing: border-box !important;
    font-family: var(--dtc-font-family) !important;
    line-height: 1.5 !important;
    color: #1e293b !important;
    text-align: left !important;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
}

/* Defensive Resets: Immunize against WordPress & Shopify Theme Distortions */
${scope} *, ${scope} *::before, ${scope} *::after {
    box-sizing: border-box !important;
}
${scope} p {
    margin: 0 0 10px 0 !important;
    line-height: var(--dtc-body-line-height, 1.6) !important;
}
${scope} p:empty {
    display: none !important;
    margin: 0 !important;
    padding: 0 !important;
}
${scope} h1, ${scope} h2, ${scope} h3, ${scope} h4, ${scope} h5 {
    margin-top: 0 !important;
    margin-bottom: 0 !important;
    color: inherit;
    line-height: 1.25 !important;
}
${scope} ul, ${scope} ol {
    list-style: none !important;
    margin: 0 !important;
    padding: 0 !important;
}
${scope} li {
    list-style: none !important;
    margin: 0 !important;
    padding: 0 !important;
}

/* Typography Hierarchy */
${scope} h1, ${scope} h2 {
    font-family: var(--dtc-title-font, inherit) !important;
    font-size: var(--dtc-title-size, 28px) !important;
    font-weight: var(--dtc-title-weight, 700) !important;
    letter-spacing: var(--dtc-title-spacing, -0.02em) !important;
}

${scope} h3 {
    font-family: var(--dtc-title-font, inherit) !important;
    font-size: var(--dtc-subtitle-size, 18px) !important;
    font-weight: var(--dtc-subtitle-weight, 600) !important;
}

${scope} p, ${scope} .dtc-fbr-chip {
    font-family: var(--dtc-font-family, inherit) !important;
    font-size: var(--dtc-body-size, 14px) !important;
    font-weight: var(--dtc-body-weight, 400) !important;
    line-height: var(--dtc-body-line-height, 1.6) !important;
}
${scope} a {
    text-decoration: none !important;
    color: inherit !important;
}
${scope} button {
    font-family: inherit !important;
    border: none !important;
    outline: none !important;
    cursor: pointer !important;
    background: none;
}
${scope} img {
    display: block !important;
    max-width: 100% !important;
    height: auto;
    border: none !important;
    box-shadow: none !important;
    border-radius: inherit;
}
${scope} img.object-cover {
    width: 100% !important;
    height: 100% !important;
    object-fit: cover !important;
}
${scope} [class*="ph"] {
    display: inline-block !important;
    vertical-align: middle !important;
    line-height: 1 !important;
}

/* Aesthetic Styles */
.dtc-style-technical { background: #0B0F19 !important; color: #f1f5f9 !important; }
.dtc-style-technical h2, .dtc-style-technical h3, .dtc-style-technical h4 { color: #ffffff !important; }
.dtc-style-lookbook { background: #faf8f5 !important; }
.dtc-style-bento { background: #f8fafc !important; }

/* Section Spacing */
${scope} section {
    padding: 36px 24px !important;
    box-sizing: border-box !important;
}

/* Brand Accent Touchpoints */
.dtc-section-tag {
    display: inline-flex !important;
    align-items: center !important;
    gap: 5px !important;
    font-size: 11px !important;
    font-weight: 800 !important;
    text-transform: uppercase !important;
    letter-spacing: 0.08em !important;
    padding: 4px 12px !important;
    border-radius: 9999px !important;
    background: var(--dtc-accent-light, #eef2ff) !important;
    color: var(--dtc-accent-text, #4338ca) !important;
    border: 1px solid var(--dtc-accent-border, #c7d2fe) !important;
    line-height: 1 !important;
    width: fit-content !important;
}
.dtc-section-tag i {
    color: var(--dtc-accent, #4f46e5) !important;
    font-size: 13px !important;
}
.dtc-fbr-chip {
    display: flex !important;
    align-items: flex-start !important;
    gap: 10px !important;
    padding: 10px 14px !important;
    border-radius: 12px !important;
    background: rgba(248, 250, 252, 0.8) !important;
    border: 1px solid rgba(226, 232, 240, 0.8) !important;
    transition: all 0.2s ease !important;
}
.dtc-fbr-chip:hover {
    border-color: var(--dtc-accent-border, #c7d2fe) !important;
    background: #ffffff !important;
}
.dtc-fbr-check {
    width: 20px !important;
    height: 20px !important;
    border-radius: 9999px !important;
    background: var(--dtc-accent-light, #eef2ff) !important;
    color: var(--dtc-accent, #4f46e5) !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    font-size: 11px !important;
    font-weight: 900 !important;
    flex-shrink: 0 !important;
    margin-top: 2px !important;
}
.dtc-step-badge {
    background: var(--dtc-accent, #4f46e5) !important;
    color: #ffffff !important;
    border: 1px solid var(--dtc-accent, #4f46e5) !important;
}
.dtc-accent-btn, .dtc-cta-btn {
    background: var(--dtc-accent, #4f46e5) !important;
    background-image: none !important;
    color: #ffffff !important;
    border: 1px solid var(--dtc-accent, #4f46e5) !important;
    box-shadow: 0 10px 25px -5px var(--dtc-accent, rgba(79, 70, 229, 0.3)) !important;
    font-weight: 800 !important;
    cursor: pointer !important;
    transition: transform 0.15s ease, box-shadow 0.15s ease !important;
}
.dtc-accent-btn:hover, .dtc-cta-btn:hover {
    filter: brightness(1.06) !important;
    transform: translateY(-1px) !important;
}
.dtc-accent-badge {
    background-color: var(--dtc-accent-light, #eef2ff) !important;
    color: var(--dtc-accent-text, #4338ca) !important;
    border: 1px solid var(--dtc-accent-border, #c7d2fe) !important;
}
.dtc-accent-text {
    color: var(--dtc-accent, #4f46e5) !important;
}
.dtc-specs-icon {
    background-color: var(--dtc-accent-light, #eef2ff) !important;
    color: var(--dtc-accent, #4f46e5) !important;
}
.dtc-bundle-item-badge {
    background-color: var(--dtc-accent-light, #eef2ff) !important;
    color: var(--dtc-accent, #4f46e5) !important;
}
.dtc-bundle-count-badge {
    background-color: var(--dtc-accent-light, #eef2ff) !important;
    color: var(--dtc-accent-text, #4338ca) !important;
    border: 1px solid var(--dtc-accent-border, #c7d2fe) !important;
}
.dtc-bundle-savings-badge {
    background-color: var(--dtc-accent-light, rgba(79, 70, 229, 0.12)) !important;
    border: 1px solid var(--dtc-accent-border, #c7d2fe) !important;
    color: var(--dtc-accent, #4f46e5) !important;
}

/* Grids & Layout Architecture */
.dtc-alternating-grid {
    display: grid !important;
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    gap: 36px !important;
    align-items: center !important;
}
.dtc-steps-grid {
    display: grid !important;
    grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
    gap: 20px !important;
}
.dtc-step-card {
    display: flex !important;
    flex-direction: column !important;
    gap: 14px !important;
    box-sizing: border-box !important;
}
.dtc-specs-grid {
    display: grid !important;
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    gap: 24px !important;
}
.dtc-bundle-box-grid {
    display: grid !important;
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    gap: 32px !important;
    align-items: center !important;
}
.dtc-bundle-savings-grid {
    display: grid !important;
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    gap: 16px !important;
}
.dtc-bento-grid {
    display: grid !important;
    grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
    gap: 20px !important;
}
.dtc-minimalist-card {
    display: grid !important;
    grid-template-columns: 7fr 5fr !important;
    gap: 36px !important;
    align-items: center !important;
}
.dtc-technical-card {
    display: grid !important;
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    gap: 24px !important;
    align-items: center !important;
}

/* Trust Bar */
.dtc-trust-bar {
    display: grid !important;
    grid-template-columns: repeat(4, minmax(0, 1fr)) !important;
    gap: 16px !important;
    align-items: center !important;
    width: 100% !important;
    border-top: 1px solid #e2e8f0 !important;
    border-bottom: 1px solid #e2e8f0 !important;
    background: #f8fafc !important;
    padding: 16px 20px !important;
    box-sizing: border-box !important;
}
.dtc-trust-item {
    display: flex !important;
    align-items: center !important;
    gap: 10px !important;
}
.dtc-trust-icon {
    width: 38px !important;
    height: 38px !important;
    border-radius: 10px !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    font-size: 19px !important;
    background: var(--dtc-accent-light, #eef2ff) !important;
    color: var(--dtc-accent, #4f46e5) !important;
    flex-shrink: 0 !important;
}

/* FAQ Accordion: Universal JS + Native HTML5 Zero-JS <details> */
.dtc-accordion-item, details.dtc-accordion-item {
    border: 1px solid #e2e8f0 !important;
    border-radius: 16px !important;
    margin-bottom: 12px !important;
    overflow: hidden !important;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1) !important;
    background: #ffffff !important;
    box-sizing: border-box !important;
}
.dtc-accordion-header, summary.dtc-accordion-header {
    cursor: pointer !important;
    user-select: none !important;
    padding: 16px 20px !important;
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
    background: #ffffff !important;
    list-style: none !important;
    outline: none !important;
}
summary.dtc-accordion-header::-webkit-details-marker,
summary.dtc-accordion-header::marker {
    display: none !important;
}
.dtc-accordion-header:hover, summary.dtc-accordion-header:hover {
    background: #f8fafc !important;
}
.dtc-accordion-body {
    display: none;
    padding: 16px 20px !important;
    border-top: 1px solid #f1f5f9 !important;
    font-size: 14px !important;
    color: #475569 !important;
    line-height: 1.6 !important;
}
.dtc-accordion-item.active, details.dtc-accordion-item[open] {
    border-color: var(--dtc-accent-border, #818cf8) !important;
    box-shadow: 0 4px 16px -2px rgba(99, 102, 241, 0.12) !important;
}
.dtc-accordion-item.active .dtc-accordion-body, details.dtc-accordion-item[open] .dtc-accordion-body {
    display: block !important;
}
.dtc-accordion-item.active .dtc-faq-q-badge, details.dtc-accordion-item[open] .dtc-faq-q-badge {
    background-color: var(--dtc-accent, #4f46e5) !important;
    color: #ffffff !important;
}
.dtc-accordion-item.active .dtc-chevron-circle, details.dtc-accordion-item[open] .dtc-chevron-circle {
    background-color: var(--dtc-accent-light, #e0e7ff) !important;
    color: var(--dtc-accent-text, #4338ca) !important;
}
.dtc-accordion-item.active .dtc-chevron-icon, details.dtc-accordion-item[open] .dtc-chevron-icon {
    transform: rotate(180deg) !important;
}
.dtc-chevron-icon {
    transition: transform 0.25s ease !important;
}

/* Scoped Utility Emulations */
${scope} .flex { display: flex !important; }
${scope} .inline-flex { display: inline-flex !important; }
${scope} .flex-col { flex-direction: column !important; }
${scope} .flex-wrap { flex-wrap: wrap !important; }
${scope} .items-center { align-items: center !important; }
${scope} .items-start { align-items: flex-start !important; }
${scope} .justify-between { justify-content: space-between !important; }
${scope} .justify-center { justify-content: center !important; }
${scope} .justify-end { justify-content: flex-end !important; }
${scope} .shrink-0 { flex-shrink: 0 !important; }
${scope} .flex-1 { flex: 1 1 0% !important; min-width: 0 !important; }
${scope} .relative { position: relative !important; }
${scope} .absolute { position: absolute !important; }
${scope} .inset-0 { top: 0 !important; right: 0 !important; bottom: 0 !important; left: 0 !important; }
${scope} .overflow-hidden { overflow: hidden !important; }
${scope} .w-full { width: 100% !important; }
${scope} .h-full { height: 100% !important; }
${scope} .max-w-xl { max-width: 576px !important; }
${scope} .max-w-2xl { max-width: 672px !important; }
${scope} .max-w-md { max-width: 448px !important; }
${scope} .mx-auto { margin-left: auto !important; margin-right: auto !important; }
${scope} .text-center { text-align: center !important; }
${scope} .text-right { text-align: right !important; }

/* Spacings */
${scope} .space-y-1 > * + * { margin-top: 4px !important; }
${scope} .space-y-1\\.5 > * + * { margin-top: 6px !important; }
${scope} .space-y-2 > * + * { margin-top: 8px !important; }
${scope} .space-y-2\\.5 > * + * { margin-top: 10px !important; }
${scope} .space-y-3 > * + * { margin-top: 12px !important; }
${scope} .space-y-3\\.5 > * + * { margin-top: 14px !important; }
${scope} .space-y-4 > * + * { margin-top: 16px !important; }
${scope} .space-y-6 > * + * { margin-top: 24px !important; }
${scope} .space-y-8 > * + * { margin-top: 32px !important; }
${scope} .space-y-12 > * + * { margin-top: 48px !important; }
${scope} .space-y-16 > * + * { margin-top: 64px !important; }

/* Gaps */
${scope} .gap-1 { gap: 4px !important; }
${scope} .gap-1\\.5 { gap: 6px !important; }
${scope} .gap-2 { gap: 8px !important; }
${scope} .gap-2\\.5 { gap: 10px !important; }
${scope} .gap-3 { gap: 12px !important; }
${scope} .gap-3\\.5 { gap: 14px !important; }
${scope} .gap-4 { gap: 16px !important; }
${scope} .gap-5 { gap: 20px !important; }
${scope} .gap-6 { gap: 24px !important; }
${scope} .gap-8 { gap: 32px !important; }

/* Paddings */
${scope} .p-2\\.5 { padding: 10px !important; }
${scope} .p-4 { padding: 16px !important; }
${scope} .p-5 { padding: 20px !important; }
${scope} .p-6 { padding: 24px !important; }
${scope} .p-8 { padding: 32px !important; }
${scope} .px-2\\.5 { padding-left: 10px !important; padding-right: 10px !important; }
${scope} .px-3 { padding-left: 12px !important; padding-right: 12px !important; }
${scope} .px-3\\.5 { padding-left: 14px !important; padding-right: 14px !important; }
${scope} .px-4 { padding-left: 16px !important; padding-right: 16px !important; }
${scope} .px-6 { padding-left: 24px !important; padding-right: 24px !important; }
${scope} .py-1 { padding-top: 4px !important; padding-bottom: 4px !important; }
${scope} .py-1\\.5 { padding-top: 6px !important; padding-bottom: 6px !important; }
${scope} .py-2 { padding-top: 8px !important; padding-bottom: 8px !important; }
${scope} .py-2\\.5 { padding-top: 10px !important; padding-bottom: 10px !important; }
${scope} .py-3 { padding-top: 12px !important; padding-bottom: 12px !important; }
${scope} .py-4 { padding-top: 16px !important; padding-bottom: 16px !important; }
${scope} .pt-2 { padding-top: 8px !important; }
${scope} .pt-3 { padding-top: 12px !important; }

/* Radii & Shadows */
${scope} .rounded-lg { border-radius: 8px !important; }
${scope} .rounded-xl { border-radius: 12px !important; }
${scope} .rounded-2xl { border-radius: 16px !important; }
${scope} .rounded-3xl { border-radius: 24px !important; }
${scope} .rounded-full { border-radius: 9999px !important; }
${scope} .shadow-2xs { box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.03) !important; }
${scope} .shadow-xs { box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05) !important; }
${scope} .shadow-sm { box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.08), 0 1px 2px -1px rgba(0, 0, 0, 0.08) !important; }
${scope} .shadow-md { box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1) !important; }
${scope} .shadow-lg { box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1) !important; }
${scope} .shadow-xl { box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.15) !important; }

/* Borders & Colors */
${scope} .border { border: 1px solid #e2e8f0 !important; }
${scope} .border-t { border-top: 1px solid #e2e8f0 !important; }
${scope} .border-b { border-bottom: 1px solid #e2e8f0 !important; }
${scope} .border-y { border-top: 1px solid #e2e8f0 !important; border-bottom: 1px solid #e2e8f0 !important; }
${scope} .border-slate-100 { border-color: #f1f5f9 !important; }
${scope} .border-slate-200 { border-color: #e2e8f0 !important; }
${scope} .border-slate-800 { border-color: #1e293b !important; }
${scope} .bg-white { background-color: #ffffff !important; }
${scope} .bg-slate-50 { background-color: #f8fafc !important; }
${scope} .bg-slate-100 { background-color: #f1f5f9 !important; }
${scope} .bg-slate-900 { background-color: #0f172a !important; color: #ffffff !important; }
${scope} .bg-slate-950 { background-color: #020617 !important; color: #ffffff !important; }

/* Aspect Ratios */
${scope} .aspect-square { aspect-ratio: 1 / 1 !important; }
${scope} .aspect-4\\/3 { aspect-ratio: 4 / 3 !important; }
${scope} .aspect-16\\/9 { aspect-ratio: 16 / 9 !important; }

/* Typography */
${scope} .text-xs { font-size: 12px !important; line-height: 16px !important; }
${scope} .text-\\[10px\\] { font-size: 10px !important; line-height: 14px !important; }
${scope} .text-\\[11px\\] { font-size: 11px !important; line-height: 15px !important; }
${scope} .text-sm { font-size: 14px !important; line-height: 20px !important; }
${scope} .text-base { font-size: 16px !important; line-height: 24px !important; }
${scope} .text-lg { font-size: 18px !important; line-height: 28px !important; }
${scope} .text-xl { font-size: 20px !important; line-height: 28px !important; }
${scope} .text-2xl { font-size: 24px !important; line-height: 32px !important; }
${scope} .text-3xl { font-size: 30px !important; line-height: 36px !important; }
${scope} .text-4xl { font-size: 36px !important; line-height: 40px !important; }
${scope} .font-bold { font-weight: 700 !important; }
${scope} .font-black { font-weight: 900 !important; }
${scope} .font-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace !important; }
${scope} .font-serif { font-family: ui-serif, Georgia, Cambria, "Times New Roman", Times, serif !important; }
${scope} .tracking-tight { letter-spacing: -0.025em !important; }
${scope} .tracking-widest { letter-spacing: 0.1em !important; }
${scope} .uppercase { text-transform: uppercase !important; }
${scope} .truncate { overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; }

/* Text Colors */
${scope} .text-white { color: #ffffff !important; }
${scope} .text-slate-900 { color: #0f172a !important; }
${scope} .text-slate-800 { color: #1e293b !important; }
${scope} .text-slate-700 { color: #334155 !important; }
${scope} .text-slate-600 { color: #475569 !important; }
${scope} .text-slate-500 { color: #64748b !important; }
${scope} .text-slate-400 { color: #94a3b8 !important; }
${scope} .text-slate-300 { color: #cbd5e1 !important; }
${scope} .text-emerald-600 { color: #059669 !important; }
${scope} .text-emerald-400 { color: #34d399 !important; }
${scope} .text-cyan-400 { color: #22d3ee !important; }
${scope} .text-cyan-300 { color: #67e8f9 !important; }

/* Mobile Viewport Adaptation */
@media (max-width: 767px) {
    ${scope} section { padding: 24px 16px !important; }
    ${scope} h2 { font-size: 1.35rem !important; line-height: 1.3 !important; }
    ${scope} h3 { font-size: 1.15rem !important; line-height: 1.35 !important; }
    .dtc-alternating-grid { display: flex !important; flex-direction: column !important; gap: 18px !important; }
    .dtc-alternating-grid > * { width: 100% !important; max-width: 100% !important; margin: 0 !important; }
    .dtc-minimalist-hero { min-height: 280px !important; padding: 20px 16px !important; border-radius: 20px !important; }
    .dtc-minimalist-card { display: flex !important; flex-direction: column !important; gap: 16px !important; }
    .dtc-minimalist-img, .dtc-minimalist-content { width: 100% !important; max-width: 100% !important; }
    .dtc-minimalist-img { order: -1 !important; }
    .dtc-bento-grid { display: flex !important; flex-direction: column !important; gap: 14px !important; }
    .dtc-bento-tile { width: 100% !important; max-width: 100% !important; border-radius: 20px !important; }
    .dtc-bento-banner { display: flex !important; flex-direction: column !important; gap: 14px !important; padding: 18px 16px !important; }
    .dtc-bento-banner-img, .dtc-bento-banner-content { width: 100% !important; max-width: 100% !important; }
    .dtc-bento-banner-img { order: -1 !important; }
    .dtc-technical-card { display: flex !important; flex-direction: column !important; gap: 16px !important; }
    .dtc-technical-img, .dtc-technical-content { width: 100% !important; max-width: 100% !important; }
    .dtc-technical-img { order: -1 !important; }
    .dtc-steps-grid, .dtc-specs-grid, .dtc-bundle-box-grid, .dtc-bundle-savings-grid { display: flex !important; flex-direction: column !important; gap: 12px !important; }
    .dtc-trust-bar { display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 12px !important; padding: 14px 16px !important; }
}
@media (max-width: 480px) {
    .dtc-trust-bar { display: flex !important; flex-direction: column !important; gap: 10px !important; }
}
</style>
<script>
function toggleDtcAccordion(e){var t=e.closest(".dtc-accordion-item");t&&t.classList.toggle("active")}
</script>`;
}

function getGlobalGenContext() {
    if (typeof globalGenContext !== 'undefined' && globalGenContext) return globalGenContext;
    if (typeof window !== 'undefined' && window.globalGenContext) return window.globalGenContext;
    if (typeof globalThis !== 'undefined' && globalThis.globalGenContext) return globalThis.globalGenContext;
    return null;
}

function setGlobalGenContext(ctx) {
    globalGenContext = ctx;
    if (typeof window !== 'undefined') window.globalGenContext = ctx;
    if (typeof globalThis !== 'undefined') globalThis.globalGenContext = ctx;
    return globalGenContext;
}

// 获取自包含独立站单页 HTML 源码
function getStandalonePdpHtmlString() {
    const genCtx = getGlobalGenContext();
    const container = document.getElementById('dtcHybridContainer');
    if (!container || !genCtx) return '';
    if (!container.innerHTML.trim() && typeof renderDtcHybridPreview === 'function') {
        renderDtcHybridPreview();
    }
    const productName = (document.getElementById('productNameInput')?.value || '').trim() || genCtx.config?.productName || 'Product';
    const lang = genCtx.config?.language || 'en';
    const content = typeof cleanDtcExportHtml === 'function' ? cleanDtcExportHtml(container.innerHTML) : (container.innerHTML || '');
    const colorMap = typeof getDtcBrandColorMap === 'function' ? getDtcBrandColorMap() : {};
    const colorKey = typeof currentDtcBrandColor !== 'undefined' ? currentDtcBrandColor : 'indigo';
    const brandColor = (colorMap && colorMap[colorKey])
        ? colorMap[colorKey]
        : { primary: '#4f46e5', light: '#eef2ff', border: '#c7d2fe', text: '#4338ca' };

    const typo = (typeof currentDtcTypography !== 'undefined') ? currentDtcTypography : { fontFamily: 'System' };
    const standaloneStyles = typeof buildDtcStandaloneStylesheet === 'function' ? buildDtcStandaloneStylesheet(brandColor, false, typo) : '';
    const jsonLd = typeof buildDtcJsonLdSchema === 'function' ? buildDtcJsonLdSchema(genCtx) : '';
    const escName = typeof detailEscapeHtml === 'function' ? detailEscapeHtml(productName) : productName;
    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escName} - Product Details</title>
    <script src="https://cdn.tailwindcss.com"></script>
    ${standaloneStyles}
    ${jsonLd}
</head>
<body class="bg-slate-100 min-h-screen py-8 px-4" style="background-color: #f1f5f9; min-height: 100vh; padding: 32px 16px; margin: 0;">
    <main class="max-w-4xl mx-auto rounded-2xl shadow-xl overflow-hidden bg-white" style="max-width: 960px; margin: 0 auto; border-radius: 16px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1); overflow: hidden; background: #ffffff;">
        ${content}
    </main>
</body>
</html>`;
}

// 导出全套商业上架物料包 (One-Click Launch Kit .ZIP)
async function exportFullLaunchKit() {
    const btn = document.getElementById('btnExportLaunchKit');
    const origHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="ph-bold ph-spinner animate-spin text-sm"></i> <span>正在打包全套物料...</span>';
    }

    const toast = typeof showToast === 'function' ? showToast : (typeof window !== 'undefined' ? window.showToast : null);
    if (toast) toast('正在组织全渠道物料并进行图片规格预检...', 'info');

    try {
        const genCtx = getGlobalGenContext();
        const productName = (document.getElementById('productNameInput')?.value || '').trim() ||
            (genCtx && genCtx.config && genCtx.config.productName) || 'Product';

        // 1. 收集 Listing 数据
        let listingData = null;
        if (typeof getCurrentListingData === 'function') {
            listingData = getCurrentListingData();
        }
        if (!listingData && typeof collectCurrentListingDataFromDom === 'function') {
            listingData = collectCurrentListingDataFromDom();
        }

        // 2. 收集广告文案数据
        let adsData = null;
        if (typeof getCurrentAdsData === 'function') {
            adsData = getCurrentAdsData();
        }

        // 3. 收集 DTC 独立站页面源码
        const pdpHtml = getStandalonePdpHtmlString();

        // 4. 收集当前详情页生成的切图物料
        const imageItems = [];
        if (genCtx && genCtx.tasks) {
            Object.values(genCtx.tasks).forEach((t, idx) => {
                if (t && t.imageSrc && t.status !== 'error') {
                    imageItems.push({
                        name: t.displayTitle ? `mod${idx + 1}_${t.displayTitle}` : `module_${idx + 1}`,
                        data_url: t.imageSrc
                    });
                }
            });
        }

        // 5. 图像比例与电商平台规范预检
        const recommendations = [
            '1. Amazon 货架主图：强制 1:1 纯白底无边框正方形图',
            '2. Amazon A+ Banner：推荐 970x300 或 1464x600 宽屏图',
            '3. Shopify / 独立站主视觉：推荐 16:9 或 4:3 沉浸横幅',
            '4. 移动端社交落地页：推荐 3:4 黄金竖版比例'
        ];
        if (imageItems.length === 0) {
            recommendations.push('⚠️ 当前详情页暂未生成模块图片，建议先生成图片以获得完整图像包');
        } else {
            recommendations.push(`✅ 已捕获 ${imageItems.length} 个详情页切图模块，打包入库`);
        }

        // 6. 当前激活营销画像
        let activeProfile = null;
        if (typeof getActiveBrandProfile === 'function') {
            activeProfile = getActiveBrandProfile();
        } else if (typeof window !== 'undefined' && window.brandContextHub && typeof window.brandContextHub.getActiveProfile === 'function') {
            activeProfile = window.brandContextHub.getActiveProfile();
        }

        const payload = {
            product_name: productName,
            brand_name: activeProfile?.brandName || activeProfile?.name || 'Default Brand',
            category: activeProfile?.category || '',
            listing: listingData,
            ads: adsData,
            pdp_html: pdpHtml,
            image_items: imageItems,
            aspect_ratio_precheck: { recommendations },
            manifest: {
                client_version: '2026.09.17-pro',
                dtc_style: typeof currentDtcStyle !== 'undefined' ? currentDtcStyle : 'editorial',
                brand_color: typeof currentDtcBrandColor !== 'undefined' ? currentDtcBrandColor : 'indigo'
            }
        };

        const apiBase = (typeof API_BASE !== 'undefined' && API_BASE) ? API_BASE : 'http://localhost:9503';
        const res = await fetch(`${apiBase}/api/export/launch-kit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.detail || `Server returned ${res.status}`);
        }

        const data = await res.json();
        if (data.status === 'success' && data.download_url) {
            const downloadUrl = `${apiBase}${data.download_url}`;
            const link = document.createElement('a');
            link.href = downloadUrl;
            link.download = data.filename || 'Product_Launch_Kit.zip';
            if (typeof document !== 'undefined' && document.body) {
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            }

            if (toast) toast(`🎉 上架物料包【${data.filename}】已成功打包并开始下载！`, 'success');
            return data;
        } else {
            throw new Error(data.message || '打包返回数据异常');
        }
    } catch (err) {
        console.error('Launch Kit Export Error:', err);
        if (toast) toast(`物料包打包失败: ${err.message}`, 'error');
        throw err;
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = origHtml;
        }
    }
}

// 导出独立站响应式单页 HTML 源码 (离线与跨平台高保真)
function exportStandalonePdpHtml() {
    const fullHtml = getStandalonePdpHtmlString();
    if (!fullHtml) {
        showToast('没有可导出的独立站详情页内容', 'error');
        return;
    }
    const productName = (document.getElementById('productNameInput')?.value || '').trim() ||
        (globalGenContext && globalGenContext.config && globalGenContext.config.productName) || 'Product';

    const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
    const link = document.createElement('a');
    const ts = Date.now();
    const cleanName = productName.replace(/[/\\?%*:|"<>]/g, '_');
    link.download = `${cleanName}_DTC_PDP_${ts}.html`;
    link.href = URL.createObjectURL(blob);
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    const hasLocalImagesExport = /src=["'](data:image\/|https?:\/\/127\.0\.0\.1|https?:\/\/localhost|\/static\/)/i.test(fullHtml);
    if (hasLocalImagesExport) {
        showToast('独立站详情页 HTML 已导出！(提示：图片当前包含本地/Base64临时地址，建议使用【图床托管】一键上传并替换为线上 CDN 链接)', 'info');
    } else {
        showToast('独立站响应式详情页 HTML 已导出！(图片链接均已托管至云端)', 'success');
    }
}

function openStandalonePdpPreview() {
    const container = document.getElementById('dtcHybridContainer');
    if (!container || !globalGenContext) {
        showToast('没有可预览的独立站详情页内容', 'error');
        return;
    }
    if (!container.innerHTML.trim()) {
        renderDtcHybridPreview();
    }
    const productName = (document.getElementById('productNameInput')?.value || '').trim() || globalGenContext.config?.productName || 'Product';
    const lang = globalGenContext.config?.language || 'en';
    const content = cleanDtcExportHtml(container.innerHTML);
    const colorMap = getDtcBrandColorMap();
    const brandColor = (colorMap && colorMap[currentDtcBrandColor])
        ? colorMap[currentDtcBrandColor]
        : { primary: '#4f46e5', light: '#eef2ff', border: '#c7d2fe', text: '#4338ca' };

    const standaloneStyles = buildDtcStandaloneStylesheet(brandColor, false, currentDtcTypography);
    const jsonLd = buildDtcJsonLdSchema(globalGenContext);
    const fullHtml = `<!DOCTYPE html>
<html lang="${lang}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${detailEscapeHtml(productName)} - 全屏独立预览</title>
    <script src="https://cdn.tailwindcss.com"></script>
    ${standaloneStyles}
    ${jsonLd}
</head>
<body class="bg-slate-50 min-h-screen py-10 px-4 flex flex-col items-center" style="background-color: #f8fafc; min-height: 100vh; padding: 40px 16px; margin: 0;">
    <div class="fixed top-4 right-4 z-50 flex items-center gap-2 bg-slate-900/80 backdrop-blur-md text-white text-xs font-semibold px-3 py-1.5 rounded-full shadow-lg pointer-events-auto select-none print:hidden">
        <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
        <span>DTC 纯净全屏预览 (按 F12 切换手机端体验)</span>
    </div>
    <main class="w-full max-w-4xl mx-auto rounded-3xl shadow-2xl overflow-hidden bg-white border border-slate-100" style="max-width: 980px; margin: 0 auto; border-radius: 24px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.15); overflow: hidden; background: #ffffff;">
        ${content}
    </main>
</body>
</html>`;

    const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank');
    if (!win) {
        showToast('浏览器拦截了弹出窗口，请允许本站打开新标签页', 'warning');
    } else {
        showToast('已在新窗口打开纯净独立站预览', 'success');
        const revokeTimer = setTimeout(() => URL.revokeObjectURL(url), 60000);
        if (revokeTimer && typeof revokeTimer.unref === 'function') revokeTimer.unref();
    }
}

function cropImageToCanvas(imgElement, targetWidth, targetHeight) {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetWidth, targetHeight);

    const srcW = imgElement.naturalWidth || imgElement.width;
    const srcH = imgElement.naturalHeight || imgElement.height;
    if (!srcW || !srcH) return null;

    const scale = Math.max(targetWidth / srcW, targetHeight / srcH);
    const renderW = srcW * scale;
    const renderH = srcH * scale;
    const offsetX = (targetWidth - renderW) / 2;
    const offsetY = (targetHeight - renderH) / 2;

    ctx.drawImage(imgElement, offsetX, offsetY, renderW, renderH);
    return canvas;
}

async function downloadAmazonAPlusCrops() {
    if (!globalGenContext || !globalGenContext.tasks) {
        showToast('暂无已生成的详情页模块', 'warning');
        return;
    }
    const activeTasks = Object.values(globalGenContext.tasks).filter(t => t && t.imageSrc && t.status !== 'error');
    if (!activeTasks.length) {
        showToast('暂无可导出的模块图片', 'warning');
        return;
    }

    showToast('正在按 Amazon A+ 官方规范生成切图...', 'info');

    const SPECS = [
        { name: 'A+_Banner_970x300', w: 970, h: 300 },
        { name: 'A+_Header_1464x600', w: 1464, h: 600 },
        { name: 'A+_Square_300x300', w: 300, h: 300 },
        { name: 'A+_Standard_970x600', w: 970, h: 600 }
    ];

    const prodName = (document.getElementById('productNameInput')?.value || '').trim() || globalGenContext.config?.productName || 'Product';
    const safeProd = prodName.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 30);

    let count = 0;
    for (let i = 0; i < activeTasks.length; i++) {
        const task = activeTasks[i];
        const img = new Image();
        img.crossOrigin = 'anonymous';
        await new Promise(resolve => {
            img.onload = resolve;
            img.onerror = resolve;
            img.src = task.imageSrc;
        });

        if (!img.naturalWidth && !img.width) continue;

        const targetSpecs = (i === 0)
            ? [SPECS[0], SPECS[1]]
            : [SPECS[2], SPECS[3]];

        for (const spec of targetSpecs) {
            const canvas = cropImageToCanvas(img, spec.w, spec.h);
            if (!canvas) continue;
            const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
            const link = document.createElement('a');
            link.download = `${safeProd}_mod${i+1}_${spec.name}.jpg`;
            link.href = dataUrl;
            link.click();
            count++;
            await new Promise(r => setTimeout(r, 250));
        }
    }

    showToast(`Amazon A+ 规格切图已全部导出完成（共生成 ${count} 张官方合规规格图）！`, 'success');
}

// 复制兼容 Shopify / WordPress / WooCommerce / 独立站描述编辑器的完整自包含 HTML
async function copyShopifyHtml() {
    const container = document.getElementById('dtcHybridContainer');
    if (!container || !globalGenContext) {
        showToast('没有可复制的独立站详情页内容', 'error');
        return;
    }
    if (!container.innerHTML.trim()) {
        renderDtcHybridPreview();
    }
    const wrapper = container.querySelector('.dtc-pdp-wrapper');
    const rawHtml = wrapper ? wrapper.outerHTML : container.innerHTML;
    const cleanedBody = cleanDtcExportHtml(rawHtml);
    const colorMap = getDtcBrandColorMap();
    const brandColor = (colorMap && colorMap[currentDtcBrandColor])
        ? colorMap[currentDtcBrandColor]
        : { primary: '#4f46e5', light: '#eef2ff', border: '#c7d2fe', text: '#4338ca' };

    const shopifyStyles = buildDtcStandaloneStylesheet(brandColor, false, currentDtcTypography);
    const jsonLd = buildDtcJsonLdSchema(globalGenContext);
    const htmlToCopy = `${shopifyStyles.trim()}\n${cleanedBody}\n${jsonLd}`;

    try {
        if (navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(htmlToCopy);
        } else if (typeof document !== 'undefined') {
            const textarea = document.createElement('textarea');
            textarea.value = htmlToCopy;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
        }
        const hasLocalImages = /src=["'](data:image\/|https?:\/\/127\.0\.0\.1|https?:\/\/localhost|\/static\/)/i.test(htmlToCopy);
        if (hasLocalImages) {
            showToast('HTML 已复制！(提示：代码中包含本地/Base64图片，建议点击上方【图床托管】一键上传至 WordPress / Cloudflare R2 并替换为线上 CDN 链接)', 'info');
        } else {
            showToast('Shopify / WordPress / 独立站自包含 HTML 代码已复制到剪贴板！(图片链接均已托管至云端)', 'success');
        }
    } catch (err) {
        console.error('Copy HTML failed:', err);
        showToast('复制失败，请手动选择并复制', 'error');
    }
}

// 独立复制单个模块的自包含 HTML (可无缝粘贴至 Shopify / WordPress / PageFly / GemPages)
async function copyDtcSectionHtml(sectionType, sectionTitle = '') {
    const container = document.getElementById('dtcHybridContainer');
    if (!container) {
        showToast('没有可复制的详情页容器', 'error');
        return '';
    }
    const targetSection = container.querySelector(`[data-section="${sectionType}"]`);
    if (!targetSection) {
        showToast(`未找到模块 [${sectionType}] 的内容`, 'error');
        return '';
    }
    const clone = targetSection.cloneNode ? targetSection.cloneNode(true) : { ...targetSection };
    if (clone.querySelectorAll) {
        clone.querySelectorAll('.dtc-section-actions, .dtc-image-swap-btn, .dtc-lightbox-trigger-badge').forEach(el => el.remove());
    }

    const cleanedSectionHtml = cleanDtcExportHtml(clone.outerHTML || clone.innerHTML || '');
    const colorMap = getDtcBrandColorMap();
    const brandColor = (colorMap && colorMap[currentDtcBrandColor])
        ? colorMap[currentDtcBrandColor]
        : { primary: '#4f46e5', light: '#eef2ff', border: '#c7d2fe', text: '#4338ca' };

    const scopedStyles = buildDtcStandaloneStylesheet(brandColor, true, currentDtcTypography);
    const finalHtml = `${scopedStyles.trim()}\n<div class="dtc-modular-section">\n${cleanedSectionHtml}\n</div>`;

    try {
        if (navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(finalHtml);
        } else if (typeof document !== 'undefined') {
            const textarea = document.createElement('textarea');
            textarea.value = finalHtml;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
        }
        const display = sectionTitle || sectionType.toUpperCase();
        const hasLocalImages = /src=["'](https?:\/\/127\.0\.0\.1|https?:\/\/localhost|\/static\/)/i.test(finalHtml);
        if (hasLocalImages) {
            showToast(`模块 [${display}] HTML 已复制！(提示：图片当前为本地预览地址，发布前请上传至 WP 媒体库或 Shopify Files 替换)`, 'info');
        } else {
            showToast(`模块 [${display}] 独立自包含 HTML 已复制！可直接粘贴至 Shopify / WordPress / PageFly`, 'success');
        }
    } catch (err) {
        console.error('Copy section HTML failed:', err);
        showToast('复制失败，请重试', 'error');
    }
    return finalHtml;
}

// 一键复制全案模块的 SEO Title 与 Alt Text 到剪贴板 (便于直接粘贴至 Shopify / Amazon 后台)
async function copySeoMetadataToClipboard() {
    if (!globalGenContext || !globalGenContext.tasks) {
        showToast('暂无 SEO 元数据可复制', 'error');
        return '';
    }
    const productName = (document.getElementById('productNameInput')?.value || '').trim() || globalGenContext.config?.productName || 'Product';
    const config = globalGenContext.config || {};
    const tasks = globalGenContext.tasks;
    const taskIds = Object.keys(tasks);

    if (!taskIds.length) {
        showToast('暂无 SEO 元数据可复制', 'error');
        return '';
    }

    let text = `=== SEO METADATA: ${productName} ===\nPlatform: ${config.platformLabel || config.platform || 'DTC'}\nTarget Language: ${config.languageLabel || config.language || 'English'}\n\n`;

    taskIds.forEach((id, index) => {
        const task = tasks[id];
        const seo = task.seo || (typeof getModuleSeo === 'function' ? getModuleSeo(id) : {}) || {};
        text += `[Module ${index + 1}: ${task.displayTitle || task.title} (${task.id})]\n`;
        text += `• Title (${config.languageLabel || 'Target'}): ${seo.titleTarget || '-'}\n`;
        text += `• Alt Text (${config.languageLabel || 'Target'}): ${seo.altTextTarget || '-'}\n`;
        text += `• Title (中文): ${seo.titleZh || '-'}\n`;
        text += `• Alt Text (中文): ${seo.altTextZh || '-'}\n\n`;
    });

    try {
        if (navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
        } else if (typeof document !== 'undefined') {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
        }
        showToast('SEO 文本已复制到剪贴板！可直接粘贴至独立站或 Amazon 后台', 'success');
    } catch (err) {
        console.error('Copy SEO failed:', err);
        showToast('复制失败，请重试', 'error');
    }
    return text;
}

// 导出整套 SEO Meta-Data 结构化 Markdown 报告
function exportSeoMetadataSummary(format = 'markdown') {
    if (!globalGenContext || !globalGenContext.tasks) {
        showToast('暂无 SEO 元数据可导出', 'error');
        return;
    }
    const productName = (document.getElementById('productNameInput')?.value || '').trim() || globalGenContext.config?.productName || 'Product';
    const config = globalGenContext.config || {};
    const tasks = globalGenContext.tasks;
    const taskIds = Object.keys(tasks);

    if (!taskIds.length) {
        showToast('暂无 SEO 元数据可导出', 'error');
        return;
    }

    const pad = n => n.toString().padStart(2, '0');
    const d = new Date();
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    let md = `# SEO Metadata Summary: ${productName}\n\n`;
    md += `- **Date**: ${dateStr}\n`;
    md += `- **Platform**: ${config.platformLabel || config.platform || 'DTC'}\n`;
    md += `- **Target Language**: ${config.languageLabel || config.language || 'English'}\n`;
    md += `- **Market Tone**: ${config.marketTone || 'Professional'}\n\n`;
    md += `---\n\n`;
    md += `## Modules SEO Details\n\n`;

    taskIds.forEach((id, index) => {
        const task = tasks[id];
        const seo = task.seo || getModuleSeo(id) || {};
        md += `### ${index + 1}. [${task.id}] ${task.displayTitle || task.title}\n`;
        md += `- **Strategic Role**: ${task.subtitle || task.title}\n`;
        md += `- **SEO Title (${config.languageLabel || 'Target'})**: ${seo.titleTarget || '-'}\n`;
        md += `- **SEO Title (Chinese)**: ${seo.titleZh || '-'}\n`;
        md += `- **Image Alt Text (${config.languageLabel || 'Target'})**: ${seo.altTextTarget || '-'}\n`;
        md += `- **Image Alt Text (Chinese)**: ${seo.altTextZh || '-'}\n\n`;
    });

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const link = document.createElement('a');
    const ts = Date.now();
    const cleanName = productName.replace(/[/\\?%*:|"<>]/g, '_');
    link.download = `${cleanName}_SEO_Summary_${ts}.md`;
    link.href = URL.createObjectURL(blob);
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    showToast('SEO 元数据 Markdown 报告已导出！', 'success');
}

// ==============================================
// 详情页图床托管与链接替换 (PDP ASSET HOSTING & URL REPLACE)
// ==============================================

var currentStorageTarget = 'wordpress';
var pdpAssetQueue = [];
var isPdpAssetUploading = false;
var pdpStorageConfigsCache = {};
var pdpAllStorageConfigs = [];
var activeWpConfigId = 0;
var activeShopifyConfigId = 0;

// 获取当前 PDP 托管队列副本 (便于测试和外部检查)
function getPdpAssetQueue() {
    return pdpAssetQueue;
}

// 获取当前激活的存储目标唯一标识 (例如 'wordpress:1', 'shopify:2', 'r2')
function getPdpCurrentStorageDestinationKey() {
    if (currentStorageTarget === 'wordpress') {
        return `wordpress:${activeWpConfigId || 'default'}`;
    }
    if (currentStorageTarget === 'shopify') {
        return `shopify:${activeShopifyConfigId || 'default'}`;
    }
    return 'r2';
}

// 格式化生成 SEO 友好的图片文件名
function sanitizePdpFilename(name, defaultExt = 'png') {
    if (!name) return `image.${defaultExt}`;
    const cleaned = name.trim().toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5._-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    if (/\.(png|jpe?g|webp|gif)$/i.test(cleaned)) {
        return cleaned;
    }
    return `${cleaned || 'asset'}.${defaultExt}`;
}

// 从当前全局生成任务构建图片上传队列
function buildPdpAssetQueue() {
    if (!globalGenContext || !globalGenContext.tasks) {
        pdpAssetQueue = [];
        return pdpAssetQueue;
    }

    const inputVal = (document.getElementById('productNameInput')?.value || '').trim();
    const ctxName = (globalGenContext.config?.productName || '').trim();
    const productName = ctxName || inputVal || 'product';
    const cleanProductSlug = productName.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '') || 'product';

    const order = Array.isArray(globalGenContext.longImageOrder) && globalGenContext.longImageOrder.length
        ? globalGenContext.longImageOrder
        : Object.keys(globalGenContext.tasks);

    const destKey = getPdpCurrentStorageDestinationKey();

    // 索引当前已有队列项，避免重构时丢失内存中的已上传状态
    const existingMap = new Map();
    if (Array.isArray(pdpAssetQueue)) {
        pdpAssetQueue.forEach(item => {
            if (item && item.id) {
                existingMap.set(item.id, item);
            }
        });
    }

    pdpAssetQueue = order.map((taskId) => {
        const task = globalGenContext.tasks[taskId];
        if (!task) return null;
        const taskSrc = task.originalImageSrc || task.imageSrc || getModuleImageSrc(taskId) || '';
        const existingItem = existingMap.get(taskId);

        // 初始化并合并该任务的多目标上传记录
        const targetUploads = { ...(existingItem?.targetUploads || {}) };

        // 从任务历史保存的 remoteImageUrls 合并
        if (task.remoteImageUrls && typeof task.remoteImageUrls === 'object') {
            Object.entries(task.remoteImageUrls).forEach(([k, u]) => {
                if (u && !targetUploads[k]) {
                    targetUploads[k] = { remoteUrl: u, status: 'success' };
                }
            });
        }

        // 兼容处理任务上的单个 remoteImageUrl
        if (task.remoteImageUrl) {
            const u = task.remoteImageUrl;
            let inferredKey = task.activeStorageTarget || '';
            if (!inferredKey) {
                if (/wp-content/i.test(u)) {
                    inferredKey = `wordpress:${activeWpConfigId || 'default'}`;
                } else if (/cdn\.shopify\.com/i.test(u)) {
                    inferredKey = `shopify:${activeShopifyConfigId || 'default'}`;
                } else if (/r2\.dev|cloudflarestorage\.com/i.test(u)) {
                    inferredKey = 'r2';
                } else {
                    inferredKey = destKey;
                }
            }
            if (!targetUploads[inferredKey]) {
                targetUploads[inferredKey] = { remoteUrl: u, status: 'success' };
            }
            const baseType = inferredKey.split(':')[0];
            if (!targetUploads[baseType]) {
                targetUploads[baseType] = { remoteUrl: u, status: 'success' };
            }
        }

        // 查找当前存储目标下是否已有成功上传的记录
        let currentUpload = targetUploads[destKey];
        if (!currentUpload && destKey.startsWith('wordpress:')) {
            const hasSpecificWp = Object.keys(targetUploads).some(k => k.startsWith('wordpress:') && k !== 'wordpress:default');
            if (!hasSpecificWp) {
                currentUpload = targetUploads['wordpress'] || targetUploads['wordpress:default'];
            }
        }
        if (!currentUpload && destKey.startsWith('shopify:')) {
            const hasSpecificShopify = Object.keys(targetUploads).some(k => k.startsWith('shopify:') && k !== 'shopify:default');
            if (!hasSpecificShopify) {
                currentUpload = targetUploads['shopify'] || targetUploads['shopify:default'];
            }
        }

        const isRemote = Boolean(currentUpload && currentUpload.status === 'success' && currentUpload.remoteUrl);

        return {
            id: taskId,
            title: task.displayTitle || task.title || taskId,
            filename: sanitizePdpFilename(`${cleanProductSlug}-${taskId}.png`),
            originalSrc: taskSrc,
            currentSrc: task.imageSrc || taskSrc,
            remoteUrl: isRemote ? currentUpload.remoteUrl : '',
            status: isRemote ? 'success' : 'pending',
            progress: isRemote ? 100 : 0,
            error: '',
            targetUploads
        };
    }).filter(Boolean);

    return pdpAssetQueue;
}

// 根据当前激活的存储目标 (WordPress某站点 / Shopify某店铺 / R2) 同步图片队列的状态与远端链接
function syncPdpQueueStateToCurrentTarget() {
    if (!Array.isArray(pdpAssetQueue) || !pdpAssetQueue.length) {
        updatePdpAssetMetrics();
        return;
    }

    const destKey = getPdpCurrentStorageDestinationKey();

    pdpAssetQueue.forEach(item => {
        if (!item.targetUploads) {
            item.targetUploads = {};
        }

        const task = (typeof globalGenContext !== 'undefined' && globalGenContext?.tasks) ? globalGenContext.tasks[item.id] : null;
        if (task && task.remoteImageUrls && typeof task.remoteImageUrls === 'object') {
            Object.entries(task.remoteImageUrls).forEach(([k, url]) => {
                if (url && !item.targetUploads[k]) {
                    item.targetUploads[k] = { remoteUrl: url, status: 'success' };
                }
            });
        }

        let upload = item.targetUploads[destKey];
        if (!upload && destKey.startsWith('wordpress:')) {
            const hasSpecificWp = Object.keys(item.targetUploads).some(k => k.startsWith('wordpress:') && k !== 'wordpress:default');
            if (!hasSpecificWp) {
                upload = item.targetUploads['wordpress'] || item.targetUploads['wordpress:default'];
            }
        }
        if (!upload && destKey.startsWith('shopify:')) {
            const hasSpecificShopify = Object.keys(item.targetUploads).some(k => k.startsWith('shopify:') && k !== 'shopify:default');
            if (!hasSpecificShopify) {
                upload = item.targetUploads['shopify'] || item.targetUploads['shopify:default'];
            }
        }

        if (upload && upload.status === 'success' && upload.remoteUrl) {
            item.status = 'success';
            item.remoteUrl = upload.remoteUrl;
            item.progress = 100;
            item.error = '';
        } else {
            item.status = 'pending';
            item.remoteUrl = '';
            item.progress = 0;
            item.error = '';
        }
    });

    renderPdpAssetHostingQueue();
    updatePdpAssetMetrics();
}

// 刷新看板指标与按钮状态
function updatePdpAssetMetrics() {
    const total = pdpAssetQueue.length;
    const success = pdpAssetQueue.filter(i => i.status === 'success').length;
    const failed = pdpAssetQueue.filter(i => i.status === 'error').length;
    const pending = pdpAssetQueue.filter(i => i.status === 'pending' || i.status === 'uploading').length;
    const percent = total > 0 ? Math.round((success / total) * 100) : 0;

    const elTotal = document.getElementById('pdpAssetTotalCount');
    const elSuccess = document.getElementById('pdpAssetSuccessCount');
    const elFailed = document.getElementById('pdpAssetFailedCount');
    const elPending = document.getElementById('pdpAssetPendingCount');
    const elText = document.getElementById('pdpAssetProgressText');
    const elBar = document.getElementById('pdpAssetProgressBar');

    if (elTotal) elTotal.textContent = String(total);
    if (elSuccess) elSuccess.textContent = String(success);
    if (elFailed) elFailed.textContent = String(failed);
    if (elPending) elPending.textContent = String(pending);
    if (elText) elText.textContent = `${percent}%`;
    if (elBar) elBar.style.width = `${percent}%`;

    const btnRetry = document.getElementById('btnRetryFailedUploads');
    const numRetry = document.getElementById('pdpRetryFailedNum');
    if (btnRetry) {
        if (failed > 0) {
            btnRetry.classList.remove('hidden');
            if (numRetry) numRetry.textContent = String(failed);
        } else {
            btnRetry.classList.add('hidden');
        }
    }

    const btnRevert = document.getElementById('btnRevertLocalUrls');
    if (btnRevert) {
        const hasRevertible = Boolean(typeof globalGenContext !== 'undefined' && globalGenContext?.tasks && Object.values(globalGenContext.tasks).some(t => Boolean(t.originalImageSrc)));
        if (hasRevertible) {
            btnRevert.classList.remove('hidden');
        } else {
            btnRevert.classList.add('hidden');
        }
    }

    const btnApply = document.getElementById('btnApplyRemoteUrls');
    if (btnApply) {
        btnApply.disabled = success === 0;
    }
}

// 渲染图片队列清单
function renderPdpAssetHostingQueue() {
    const container = document.getElementById('pdpAssetQueueContainer');
    if (!container) return;

    if (!pdpAssetQueue.length) {
        container.innerHTML = `
            <div class="p-8 text-center text-slate-400 bg-white rounded-2xl border border-dashed border-slate-200 text-xs">
                <i class="ph ph-image-square text-3xl mb-1.5 text-slate-300 inline-block"></i>
                <p>当前没有生成的详情页图片</p>
            </div>`;
        updatePdpAssetMetrics();
        return;
    }

    let html = '';
    pdpAssetQueue.forEach((item, index) => {
        const imgSrc = item.originalSrc || item.currentSrc || '';
        let statusBadge = '';
        let actionBtn = '';

        if (item.status === 'uploading') {
            statusBadge = `<span class="px-2 py-0.5 text-[10px] font-bold rounded-md bg-blue-50 text-blue-700 border border-blue-200 flex items-center gap-1"><span class="loader w-2.5 h-2.5 border-blue-600 border-t-transparent inline-block"></span> 上传中...</span>`;
            actionBtn = `<button type="button" disabled class="px-2.5 py-1 text-xs font-bold text-slate-400 bg-slate-50 border border-slate-200 rounded-lg opacity-60 cursor-not-allowed flex items-center gap-1"><i class="ph ph-hourglass"></i> 上传中</button>`;
        } else if (item.status === 'success') {
            statusBadge = `<span class="px-2 py-0.5 text-[10px] font-bold rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1"><i class="ph-bold ph-check"></i> 上传成功</span>`;
            actionBtn = `<button type="button" onclick="copyPdpAssetRemoteUrl('${detailEscapeHtml(item.remoteUrl)}')" class="px-2.5 py-1 text-xs font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200/80 rounded-lg transition-colors flex items-center gap-1 cursor-pointer shadow-2xs" title="复制远程链接"><i class="ph-bold ph-copy"></i> 复制链接</button>`;
        } else if (item.status === 'error') {
            statusBadge = `<span class="px-2 py-0.5 text-[10px] font-bold rounded-md bg-rose-50 text-rose-700 border border-rose-200 flex items-center gap-1"><i class="ph-bold ph-x"></i> 上传失败</span>`;
            actionBtn = `<button type="button" onclick="uploadSinglePdpAssetItem(${index})" class="px-2.5 py-1 text-xs font-bold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition-colors flex items-center gap-1 cursor-pointer shadow-2xs"><i class="ph-bold ph-arrows-counter-clockwise"></i> 重试</button>`;
        } else {
            statusBadge = `<span class="px-2 py-0.5 text-[10px] font-bold rounded-md bg-slate-100 text-slate-600 border border-slate-200">等待上传</span>`;
            actionBtn = `<button type="button" onclick="uploadSinglePdpAssetItem(${index})" class="px-2.5 py-1 text-xs font-bold text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg shadow-2xs transition-colors flex items-center gap-1 cursor-pointer"><i class="ph-bold ph-upload-simple"></i> 上传</button>`;
        }

        html += `
            <div class="p-3 bg-white rounded-xl border border-slate-200/80 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-all hover:border-slate-300">
                <div class="flex items-center gap-3 min-w-0">
                    <div class="w-12 h-12 rounded-lg bg-slate-100 border border-slate-200 overflow-hidden shrink-0 flex items-center justify-center">
                        ${imgSrc ? `<img src="${detailEscapeHtml(imgSrc)}" class="w-full h-full object-cover">` : '<i class="ph ph-image text-slate-400 text-lg"></i>'}
                    </div>
                    <div class="min-w-0 flex-1">
                        <div class="font-bold text-xs text-slate-800 flex items-center gap-1.5 truncate">
                            <span>${detailEscapeHtml(item.title)}</span>
                            <span class="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-100 text-slate-500 shrink-0">${detailEscapeHtml(item.id)}</span>
                        </div>
                        <div class="text-[11px] text-slate-400 font-mono truncate mt-0.5">
                            ${detailEscapeHtml(item.filename)}
                        </div>
                        ${item.status === 'success' && item.remoteUrl ? `
                            <div class="text-[11px] text-emerald-600 font-mono truncate max-w-[280px] sm:max-w-md mt-0.5 flex items-center gap-1">
                                <i class="ph-bold ph-link text-xs shrink-0"></i>
                                <a href="${detailEscapeHtml(item.remoteUrl)}" target="_blank" class="hover:underline truncate" title="${detailEscapeHtml(item.remoteUrl)}">${detailEscapeHtml(item.remoteUrl)}</a>
                            </div>` : ''}
                        ${item.status === 'error' ? `
                            <div class="text-[11px] text-rose-600 truncate max-w-[280px] sm:max-w-md mt-0.5 flex items-center gap-1" title="${detailEscapeHtml(item.error || '上传失败')}">
                                <i class="ph-bold ph-warning-circle text-xs shrink-0"></i>
                                <span class="truncate">${detailEscapeHtml(item.error || '上传失败')}</span>
                            </div>` : ''}
                    </div>
                </div>
                <div class="flex items-center gap-2 self-end sm:self-center shrink-0">
                    ${statusBadge}
                    ${actionBtn}
                </div>
            </div>`;
    });

    container.innerHTML = html;
    updatePdpAssetMetrics();
}

// 切换存储目标: 'wordpress' | 'shopify' | 'r2'
function switchStorageTarget(target) {
    if (target !== 'wordpress' && target !== 'shopify' && target !== 'r2') return;
    const uploading = Boolean((typeof isPdpAssetUploading !== 'undefined' && isPdpAssetUploading) || (typeof globalThis !== 'undefined' && globalThis.isPdpAssetUploading));
    if (uploading) {
        showToast('正在批量上传中，请等待当前上传完成再切换存储目标', 'warning');
        return;
    }
    currentStorageTarget = target;

    const btnWp = document.getElementById('btnStorageTargetWp');
    const btnShopify = document.getElementById('btnStorageTargetShopify');
    const btnR2 = document.getElementById('btnStorageTargetR2');
    const areaWp = document.getElementById('pdpWpConfigArea');
    const areaShopify = document.getElementById('pdpShopifyConfigArea');
    const areaR2 = document.getElementById('pdpR2ConfigArea');
    const badge = document.getElementById('pdpAssetHostingModeBadge');

    const defaultBtnClass = 'px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 cursor-pointer text-slate-600 hover:text-slate-900';
    if (btnWp) btnWp.className = defaultBtnClass;
    if (btnShopify) btnShopify.className = defaultBtnClass;
    if (btnR2) btnR2.className = defaultBtnClass;

    if (areaWp) areaWp.classList.add('hidden');
    if (areaShopify) areaShopify.classList.add('hidden');
    if (areaR2) areaR2.classList.add('hidden');

    if (target === 'wordpress') {
        if (btnWp) btnWp.className = 'px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 cursor-pointer bg-white text-emerald-700 shadow-2xs';
        if (areaWp) areaWp.classList.remove('hidden');
    } else if (target === 'shopify') {
        if (btnShopify) btnShopify.className = 'px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 cursor-pointer bg-white text-green-700 shadow-2xs';
        if (areaShopify) areaShopify.classList.remove('hidden');
    } else {
        if (btnR2) btnR2.className = 'px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 cursor-pointer bg-white text-amber-700 shadow-2xs';
        if (areaR2) areaR2.classList.remove('hidden');
    }

    updatePdpAssetHostingModeBadge();
    updateStorageFeedbackForCurrentTarget();
    syncPdpQueueStateToCurrentTarget();
}

// 更新顶部存储目标徽章文案 (展示当前激活的平台及子站点/店铺名称)
function updatePdpAssetHostingModeBadge() {
    const badge = document.getElementById('pdpAssetHostingModeBadge');
    if (!badge) return;
    if (currentStorageTarget === 'wordpress') {
        const cfg = Array.isArray(pdpAllStorageConfigs) ? pdpAllStorageConfigs.find(c => c.id === activeWpConfigId) : null;
        const siteName = cfg?.name || cfg?.wp_url || (activeWpConfigId === 0 ? '新增站点' : 'WordPress');
        badge.textContent = `WordPress 媒体库 · ${siteName}`;
        badge.className = 'text-[10px] font-bold px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-800';
    } else if (currentStorageTarget === 'shopify') {
        const cfg = Array.isArray(pdpAllStorageConfigs) ? pdpAllStorageConfigs.find(c => c.id === activeShopifyConfigId) : null;
        const storeName = cfg?.name || cfg?.shopify_shop_domain || (activeShopifyConfigId === 0 ? '新增店铺' : 'Shopify');
        badge.textContent = `Shopify 官方图床 · ${storeName}`;
        badge.className = 'text-[10px] font-bold px-2 py-0.5 rounded-md bg-green-100 text-green-800';
    } else {
        const cfg = pdpStorageConfigsCache?.r2;
        const bucket = cfg?.r2_bucket_name ? ` · ${cfg.r2_bucket_name}` : '';
        badge.textContent = `Cloudflare R2${bucket}`;
        badge.className = 'text-[10px] font-bold px-2 py-0.5 rounded-md bg-amber-100 text-amber-800';
    }
}

// 更新当前存储目标的连通性检查反馈
function updateStorageFeedbackForCurrentTarget() {
    const feedback = document.getElementById('pdpStorageTestFeedback');
    if (!feedback) return;
    let cached = null;
    if (currentStorageTarget === 'wordpress') {
        cached = (Array.isArray(pdpAllStorageConfigs) && pdpAllStorageConfigs.find(c => c.id === activeWpConfigId)) || pdpStorageConfigsCache['wordpress'];
    } else if (currentStorageTarget === 'shopify') {
        cached = (Array.isArray(pdpAllStorageConfigs) && pdpAllStorageConfigs.find(c => c.id === activeShopifyConfigId)) || pdpStorageConfigsCache['shopify'];
    } else {
        cached = pdpStorageConfigsCache['r2'];
    }

    if (cached && cached.last_test_status) {
        if (cached.last_test_status === 'success') {
            feedback.innerHTML = `<span class="text-emerald-600 font-medium flex items-center gap-1"><i class="ph-bold ph-check-circle"></i> 上次测试通过: ${detailEscapeHtml(cached.last_test_message || '连接正常')}</span>`;
        } else {
            feedback.innerHTML = `<span class="text-rose-600 font-medium flex items-center gap-1"><i class="ph-bold ph-warning-circle"></i> 上次测试失败: ${detailEscapeHtml(cached.last_test_message || '无法连接')}</span>`;
        }
    } else {
        feedback.innerHTML = '<span class="text-slate-500">尚未进行连通性测试</span>';
    }
}

// 展开/收起配置抽屉
function toggleStorageConfigDrawer() {
    const drawer = document.getElementById('pdpStorageConfigDrawer');
    const chevron = document.getElementById('storageConfigChevron');
    if (!drawer) return;
    const isHidden = drawer.classList.contains('hidden');
    if (isHidden) {
        drawer.classList.remove('hidden');
        if (chevron) chevron.classList.add('rotate-180');
    } else {
        drawer.classList.add('hidden');
        if (chevron) chevron.classList.remove('rotate-180');
    }
}

// 获取存储 API 完整请求地址，自动处理 API_BASE 是否包含 /api 的兼容性
function getStorageApiUrl(subpath) {
    const raw = typeof API_BASE !== 'undefined' ? API_BASE : 'http://127.0.0.1:9503';
    const base = String(raw || '').replace(/\/+$/, '');
    const clean = String(subpath || '').replace(/^\/+/, '');
    if (!base) return `/api/${clean}`;
    return base.endsWith('/api') ? `${base}/${clean}` : `${base}/api/${clean}`;
}

// 填充 WordPress 表单字段
function fillWpFormFields(cfg) {
    const wpName = document.getElementById('storageWpName');
    const wpUrl = document.getElementById('storageWpUrl');
    const wpUser = document.getElementById('storageWpUsername');
    const wpPass = document.getElementById('storageWpAppPassword');
    if (wpName) wpName.value = cfg?.name || '';
    if (wpUrl) wpUrl.value = cfg?.wp_url || '';
    if (wpUser) wpUser.value = cfg?.wp_username || '';
    if (wpPass) {
        wpPass.value = '';
        if (cfg?.has_wp_app_password) {
            wpPass.placeholder = '•••••••• (已保存，留空则保持不变)';
        } else {
            wpPass.placeholder = '在WP用户个人资料中生成';
        }
    }
}

// 切换当前 WordPress 站点
function onWpSiteSelectChange(val) {
    const uploading = Boolean((typeof isPdpAssetUploading !== 'undefined' && isPdpAssetUploading) || (typeof globalThis !== 'undefined' && globalThis.isPdpAssetUploading));
    if (uploading) {
        showToast('正在批量上传中，请等待当前上传完成再切换站点', 'warning');
        return;
    }
    const parsedId = parseInt(val, 10);
    if (!parsedId || parsedId === 0) {
        addNewWpSite();
        return;
    }
    activeWpConfigId = parsedId;
    const cfg = Array.isArray(pdpAllStorageConfigs) ? pdpAllStorageConfigs.find(c => c.id === activeWpConfigId) : null;
    fillWpFormFields(cfg);
    updatePdpAssetHostingModeBadge();
    updateStorageFeedbackForCurrentTarget();
    syncPdpQueueStateToCurrentTarget();
}

// 新增 WordPress 站点
function addNewWpSite() {
    activeWpConfigId = 0;
    const select = document.getElementById('storageWpSelect');
    if (select) select.value = '0';
    fillWpFormFields({ name: '', wp_url: '', wp_username: '', has_wp_app_password: false });
    const nameInput = document.getElementById('storageWpName');
    if (nameInput && typeof nameInput.focus === 'function') nameInput.focus();
    updatePdpAssetHostingModeBadge();
    updateStorageFeedbackForCurrentTarget();
    syncPdpQueueStateToCurrentTarget();
}

// 删除当前 WordPress 站点
async function deleteCurrentWpSite() {
    if (!activeWpConfigId || activeWpConfigId === 0) {
        showToast('请先选择要删除的已保存站点', 'warning');
        return;
    }
    const currentCfg = Array.isArray(pdpAllStorageConfigs) ? pdpAllStorageConfigs.find(c => c.id === activeWpConfigId) : null;
    const siteName = currentCfg?.name || currentCfg?.wp_url || '当前站点';
    if (typeof confirm === 'function' && !confirm(`确定要删除 WordPress 站点 [${siteName}] 吗？`)) {
        return;
    }

    try {
        const res = await fetch(getStorageApiUrl(`storage/config/${activeWpConfigId}`), {
            method: 'DELETE'
        });
        if (res.ok) {
            showToast(`站点 [${siteName}] 已删除`, 'success');
            activeWpConfigId = 0;
            await loadStorageConfigsToModal();
        } else {
            const data = await res.json().catch(() => ({}));
            showToast(`删除失败: ${data.detail || data.message || '未知错误'}`, 'error');
        }
    } catch (err) {
        showToast(`删除失败: ${err.message}`, 'error');
    }
}

// 填充 Shopify 表单字段
function fillShopifyFormFields(cfg) {
    const shopName = document.getElementById('storageShopifyName');
    const shopDomain = document.getElementById('storageShopifyDomain');
    const shopToken = document.getElementById('storageShopifyAccessToken');
    if (shopName) shopName.value = cfg?.name || '';
    if (shopDomain) shopDomain.value = cfg?.shopify_shop_domain || '';
    if (shopToken) {
        shopToken.value = '';
        if (cfg?.has_shopify_token) {
            shopToken.placeholder = '•••••••• (已保存，留空则保持不变)';
        } else {
            shopToken.placeholder = 'shpat_xxxxxxxxxxxx';
        }
    }
}

// 切换当前 Shopify 店铺
function onShopifyStoreSelectChange(val) {
    const uploading = Boolean((typeof isPdpAssetUploading !== 'undefined' && isPdpAssetUploading) || (typeof globalThis !== 'undefined' && globalThis.isPdpAssetUploading));
    if (uploading) {
        showToast('正在批量上传中，请等待当前上传完成再切换店铺', 'warning');
        return;
    }
    const parsedId = parseInt(val, 10);
    if (!parsedId || parsedId === 0) {
        addNewShopifyStore();
        return;
    }
    activeShopifyConfigId = parsedId;
    const cfg = Array.isArray(pdpAllStorageConfigs) ? pdpAllStorageConfigs.find(c => c.id === activeShopifyConfigId) : null;
    fillShopifyFormFields(cfg);
    updatePdpAssetHostingModeBadge();
    updateStorageFeedbackForCurrentTarget();
    syncPdpQueueStateToCurrentTarget();
}

// 新增 Shopify 店铺
function addNewShopifyStore() {
    activeShopifyConfigId = 0;
    const select = document.getElementById('storageShopifySelect');
    if (select) select.value = '0';
    fillShopifyFormFields({ name: '', shopify_shop_domain: '', has_shopify_token: false });
    const nameInput = document.getElementById('storageShopifyName');
    if (nameInput && typeof nameInput.focus === 'function') nameInput.focus();
    updatePdpAssetHostingModeBadge();
    updateStorageFeedbackForCurrentTarget();
    syncPdpQueueStateToCurrentTarget();
}

// 删除当前 Shopify 店铺
async function deleteCurrentShopifyStore() {
    if (!activeShopifyConfigId || activeShopifyConfigId === 0) {
        showToast('请先选择要删除的已保存店铺', 'warning');
        return;
    }
    const currentCfg = Array.isArray(pdpAllStorageConfigs) ? pdpAllStorageConfigs.find(c => c.id === activeShopifyConfigId) : null;
    const storeName = currentCfg?.name || currentCfg?.shopify_shop_domain || '当前店铺';
    if (typeof confirm === 'function' && !confirm(`确定要删除 Shopify 店铺 [${storeName}] 吗？`)) {
        return;
    }

    try {
        const res = await fetch(getStorageApiUrl(`storage/config/${activeShopifyConfigId}`), {
            method: 'DELETE'
        });
        if (res.ok) {
            showToast(`店铺 [${storeName}] 已删除`, 'success');
            activeShopifyConfigId = 0;
            await loadStorageConfigsToModal();
        } else {
            const data = await res.json().catch(() => ({}));
            showToast(`删除失败: ${data.detail || data.message || '未知错误'}`, 'error');
        }
    } catch (err) {
        showToast(`删除失败: ${err.message}`, 'error');
    }
}

// 从后端拉取存储配置并填入表单
async function loadStorageConfigsToModal() {
    try {
        const res = await fetch(getStorageApiUrl('storage/configs'));
        if (!res.ok) return;
        const configs = await res.json().catch(() => null);
        if (!Array.isArray(configs)) return;
        pdpAllStorageConfigs = configs;
        pdpStorageConfigsCache = {};

        // 1. WordPress sites
        const wpConfigs = configs.filter(c => c.storage_type === 'wordpress' && (c.id === undefined || c.id > 0));
        const wpSelect = document.getElementById('storageWpSelect');
        if (wpSelect) {
            let optionsHtml = '';
            wpConfigs.forEach((cfg, idx) => {
                const idVal = cfg.id !== undefined ? cfg.id : (idx + 1);
                const display = typeof formatStorageDisplayLabel === 'function'
                    ? formatStorageDisplayLabel(cfg.name, cfg.wp_url, '未命名站点')
                    : (typeof window !== 'undefined' && typeof window.formatStorageDisplayLabel === 'function'
                        ? window.formatStorageDisplayLabel(cfg.name, cfg.wp_url, '未命名站点')
                        : `${cfg.name || cfg.wp_url || '未命名站点'} (${cfg.wp_url || '未配置'})`);
                const label = `${cfg.is_default ? '★ ' : ''}${display}`;
                optionsHtml += `<option value="${idVal}">${detailEscapeHtml(label)}</option>`;
            });
            optionsHtml += '<option value="0">+ 新增 WordPress 站点</option>';
            wpSelect.innerHTML = optionsHtml;
        }

        let selectedWp = null;
        if (activeWpConfigId && wpConfigs.some(c => (c.id !== undefined ? c.id : 1) === activeWpConfigId)) {
            selectedWp = wpConfigs.find(c => (c.id !== undefined ? c.id : 1) === activeWpConfigId);
        } else {
            selectedWp = wpConfigs.find(c => c.is_default) || wpConfigs[0] || null;
            activeWpConfigId = selectedWp ? (selectedWp.id !== undefined ? selectedWp.id : 1) : 0;
        }
        if (wpSelect && activeWpConfigId) wpSelect.value = String(activeWpConfigId);
        if (selectedWp) {
            pdpStorageConfigsCache['wordpress'] = selectedWp;
            fillWpFormFields(selectedWp);
        } else {
            addNewWpSite();
        }

        // 2. Shopify stores
        const shopifyConfigs = configs.filter(c => c.storage_type === 'shopify' && (c.id === undefined || c.id > 0));
        const shopifySelect = document.getElementById('storageShopifySelect');
        if (shopifySelect) {
            let optionsHtml = '';
            shopifyConfigs.forEach((cfg, idx) => {
                const idVal = cfg.id !== undefined ? cfg.id : (idx + 1);
                const display = typeof formatStorageDisplayLabel === 'function'
                    ? formatStorageDisplayLabel(cfg.name, cfg.shopify_shop_domain, '未命名店铺')
                    : (typeof window !== 'undefined' && typeof window.formatStorageDisplayLabel === 'function'
                        ? window.formatStorageDisplayLabel(cfg.name, cfg.shopify_shop_domain, '未命名店铺')
                        : `${cfg.name || cfg.shopify_shop_domain || '未命名店铺'} (${cfg.shopify_shop_domain || '未配置'})`);
                const label = `${cfg.is_default ? '★ ' : ''}${display}`;
                optionsHtml += `<option value="${idVal}">${detailEscapeHtml(label)}</option>`;
            });
            optionsHtml += '<option value="0">+ 新增 Shopify 店铺</option>';
            shopifySelect.innerHTML = optionsHtml;
        }

        let selectedShopify = null;
        if (activeShopifyConfigId && shopifyConfigs.some(c => (c.id !== undefined ? c.id : 1) === activeShopifyConfigId)) {
            selectedShopify = shopifyConfigs.find(c => (c.id !== undefined ? c.id : 1) === activeShopifyConfigId);
        } else {
            selectedShopify = shopifyConfigs.find(c => c.is_default) || shopifyConfigs[0] || null;
            activeShopifyConfigId = selectedShopify ? (selectedShopify.id !== undefined ? selectedShopify.id : 1) : 0;
        }
        if (shopifySelect && activeShopifyConfigId) shopifySelect.value = String(activeShopifyConfigId);
        if (selectedShopify) {
            pdpStorageConfigsCache['shopify'] = selectedShopify;
            fillShopifyFormFields(selectedShopify);
        } else {
            addNewShopifyStore();
        }

        // 3. Cloudflare R2
        const r2Config = configs.find(c => c.storage_type === 'r2');
        if (r2Config) {
            pdpStorageConfigsCache['r2'] = r2Config;
            const acc = document.getElementById('storageR2AccountId');
            const key = document.getElementById('storageR2AccessKeyId');
            const sec = document.getElementById('storageR2SecretKey');
            const bkt = document.getElementById('storageR2BucketName');
            const pub = document.getElementById('storageR2PublicUrl');
            const pfx = document.getElementById('storageR2PathPrefix');
            if (acc && r2Config.r2_account_id) acc.value = r2Config.r2_account_id;
            if (key && r2Config.r2_access_key_id) key.value = r2Config.r2_access_key_id;
            if (sec) {
                if (r2Config.has_r2_secret) {
                    sec.placeholder = '•••••••• (已保存，留空则保持不变)';
                } else {
                    sec.placeholder = '••••••••';
                }
            }
            if (bkt && r2Config.r2_bucket_name) bkt.value = r2Config.r2_bucket_name;
            if (pub && r2Config.r2_public_url) pub.value = r2Config.r2_public_url;
            if (pfx && r2Config.r2_path_prefix) pfx.value = r2Config.r2_path_prefix;
        }

        switchStorageTarget(currentStorageTarget);
    } catch (err) {
        console.error('Failed to load storage configs:', err);
    }
}

// 保存当前选中的存储方式配置
async function saveStorageConfigFromModal() {
    const saveBtn = document.getElementById('btnSaveStorageConfig');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<span class="loader w-3 h-3 border-white border-t-transparent inline-block"></span> 保存中...';
    }

    try {
        let payload;
        if (currentStorageTarget === 'wordpress') {
            payload = {
                id: activeWpConfigId > 0 ? activeWpConfigId : null,
                storage_type: 'wordpress',
                name: document.getElementById('storageWpName')?.value?.trim() || '',
                enabled: true,
                wp_url: document.getElementById('storageWpUrl')?.value?.trim() || '',
                wp_username: document.getElementById('storageWpUsername')?.value?.trim() || '',
                wp_app_password: document.getElementById('storageWpAppPassword')?.value?.trim() || '',
                is_default: true
            };
        } else if (currentStorageTarget === 'shopify') {
            const rawDomain = document.getElementById('storageShopifyDomain')?.value?.trim() || '';
            const cleanDomain = rawDomain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
            payload = {
                id: activeShopifyConfigId > 0 ? activeShopifyConfigId : null,
                storage_type: 'shopify',
                name: document.getElementById('storageShopifyName')?.value?.trim() || '',
                enabled: true,
                shopify_shop_domain: cleanDomain,
                shopify_access_token: document.getElementById('storageShopifyAccessToken')?.value?.trim() || '',
                is_default: true
            };
        } else {
            payload = {
                storage_type: 'r2',
                enabled: true,
                name: '默认 Cloudflare R2',
                r2_account_id: document.getElementById('storageR2AccountId')?.value?.trim() || '',
                r2_access_key_id: document.getElementById('storageR2AccessKeyId')?.value?.trim() || '',
                r2_secret_access_key: document.getElementById('storageR2SecretKey')?.value?.trim() || '',
                r2_bucket_name: document.getElementById('storageR2BucketName')?.value?.trim() || '',
                r2_public_url: document.getElementById('storageR2PublicUrl')?.value?.trim() || '',
                r2_path_prefix: document.getElementById('storageR2PathPrefix')?.value?.trim() || 'pdp/'
            };
        }

        const res = await fetch(getStorageApiUrl('storage/config'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            pdpStorageConfigsCache[currentStorageTarget] = data;
            const targetNames = { wordpress: 'WordPress', shopify: 'Shopify', r2: 'Cloudflare R2' };
            showToast(`${targetNames[currentStorageTarget] || '存储'}配置已保存！`, 'success');

            if (currentStorageTarget === 'wordpress') {
                activeWpConfigId = data.id;
                const passInput = document.getElementById('storageWpAppPassword');
                if (passInput && passInput.value) {
                    passInput.value = '';
                    passInput.placeholder = '•••••••• (已保存，留空则保持不变)';
                }
            } else if (currentStorageTarget === 'shopify') {
                activeShopifyConfigId = data.id;
                const tokenInput = document.getElementById('storageShopifyAccessToken');
                if (tokenInput && tokenInput.value) {
                    tokenInput.value = '';
                    tokenInput.placeholder = '•••••••• (已保存，留空则保持不变)';
                }
            } else {
                const secInput = document.getElementById('storageR2SecretKey');
                if (secInput && secInput.value) {
                    secInput.value = '';
                    secInput.placeholder = '•••••••• (已保存，留空则保持不变)';
                }
            }
            await loadStorageConfigsToModal();
        } else {
            const errMsg = data.detail || data.message || (res.status ? `HTTP ${res.status}: 保存失败` : '未知错误');
            showToast(`保存失败: ${errMsg}`, 'error');
        }
    } catch (err) {
        console.error('Save storage config failed:', err);
        showToast(`保存失败: ${err.message}`, 'error');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="ph-bold ph-floppy-disk"></i> 保存配置';
        }
    }
}

// 测试连通性
async function testStorageConnectionFromModal() {
    const testBtn = document.getElementById('btnTestStorageConnection');
    const feedback = document.getElementById('pdpStorageTestFeedback');

    let payload;
    if (currentStorageTarget === 'wordpress') {
        const wpUrl = document.getElementById('storageWpUrl')?.value?.trim() || '';
        const wpUsername = document.getElementById('storageWpUsername')?.value?.trim() || '';
        const wpAppPassword = document.getElementById('storageWpAppPassword')?.value?.trim() || '';
        const currentCfg = (Array.isArray(pdpAllStorageConfigs) && pdpAllStorageConfigs.find(c => c.id === activeWpConfigId)) || pdpStorageConfigsCache?.wordpress;

        if (!wpUrl) {
            showToast('请先输入 WordPress 网站地址', 'warning');
            if (feedback) feedback.innerHTML = '<span class="text-amber-600 font-medium">⚠️ 请先输入 WordPress 网站完整地址</span>';
            return;
        }
        if (!wpUsername) {
            showToast('请先输入 WordPress 用户名', 'warning');
            if (feedback) feedback.innerHTML = '<span class="text-amber-600 font-medium">⚠️ 请先输入 WordPress 管理员或作者用户名</span>';
            return;
        }
        if (!wpAppPassword && !currentCfg?.has_wp_app_password) {
            showToast('请先输入 WordPress 应用程序密码', 'warning');
            if (feedback) feedback.innerHTML = '<span class="text-amber-600 font-medium">⚠️ 请先输入 WordPress Application Password</span>';
            return;
        }

        const wpConfig = {
            id: activeWpConfigId > 0 ? activeWpConfigId : null,
            storage_type: 'wordpress',
            name: document.getElementById('storageWpName')?.value?.trim() || '',
            enabled: true,
            wp_url: wpUrl,
            wp_username: wpUsername,
            wp_app_password: wpAppPassword
        };
        payload = {
            config_id: activeWpConfigId > 0 ? activeWpConfigId : null,
            ...wpConfig,
            config_override: wpConfig
        };
    } else if (currentStorageTarget === 'shopify') {
        const rawDomain = document.getElementById('storageShopifyDomain')?.value?.trim() || '';
        const shopDomain = rawDomain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
        const shopToken = document.getElementById('storageShopifyAccessToken')?.value?.trim() || '';
        const currentCfg = (Array.isArray(pdpAllStorageConfigs) && pdpAllStorageConfigs.find(c => c.id === activeShopifyConfigId)) || pdpStorageConfigsCache?.shopify;

        if (!shopDomain) {
            showToast('请先输入 Shopify 店铺域名 (myshopify.com)', 'warning');
            if (feedback) feedback.innerHTML = '<span class="text-amber-600 font-medium">⚠️ 请先输入 Shopify 店铺域名 (myshopify.com)</span>';
            return;
        }
        if (!shopToken && !currentCfg?.has_shopify_token) {
            showToast('请先输入 Shopify Admin API Access Token (shpat_...)', 'warning');
            if (feedback) feedback.innerHTML = '<span class="text-amber-600 font-medium">⚠️ 请先输入 Shopify Access Token</span>';
            return;
        }

        const shopifyConfig = {
            id: activeShopifyConfigId > 0 ? activeShopifyConfigId : null,
            storage_type: 'shopify',
            name: document.getElementById('storageShopifyName')?.value?.trim() || '',
            enabled: true,
            shopify_shop_domain: shopDomain,
            shopify_access_token: shopToken
        };
        payload = {
            config_id: activeShopifyConfigId > 0 ? activeShopifyConfigId : null,
            ...shopifyConfig,
            config_override: shopifyConfig
        };
    } else {
        const r2AccountId = document.getElementById('storageR2AccountId')?.value?.trim() || '';
        const r2AccessKeyId = document.getElementById('storageR2AccessKeyId')?.value?.trim() || '';
        const r2SecretKey = document.getElementById('storageR2SecretKey')?.value?.trim() || '';
        const r2BucketName = document.getElementById('storageR2BucketName')?.value?.trim() || '';
        const r2PublicUrl = document.getElementById('storageR2PublicUrl')?.value?.trim() || '';
        const r2PathPrefix = document.getElementById('storageR2PathPrefix')?.value?.trim() || 'pdp/';

        if (!r2AccountId) {
            showToast('请先输入 Cloudflare Account ID', 'warning');
            if (feedback) feedback.innerHTML = '<span class="text-amber-600 font-medium">⚠️ 请先输入 Cloudflare Account ID</span>';
            return;
        }
        if (!r2AccessKeyId) {
            showToast('请先输入 R2 Access Key ID', 'warning');
            if (feedback) feedback.innerHTML = '<span class="text-amber-600 font-medium">⚠️ 请先输入 R2 Access Key ID</span>';
            return;
        }
        if (!r2SecretKey && !pdpStorageConfigsCache?.r2?.has_r2_secret) {
            showToast('请先输入 R2 Secret Access Key', 'warning');
            if (feedback) feedback.innerHTML = '<span class="text-amber-600 font-medium">⚠️ 请先输入 R2 Secret Access Key</span>';
            return;
        }
        if (!r2BucketName) {
            showToast('请先输入 R2 Bucket Name (存储桶名称)', 'warning');
            if (feedback) feedback.innerHTML = '<span class="text-amber-600 font-medium">⚠️ 请先输入 R2 Bucket Name</span>';
            return;
        }

        const r2Config = {
            storage_type: 'r2',
            enabled: true,
            r2_account_id: r2AccountId,
            r2_access_key_id: r2AccessKeyId,
            r2_secret_access_key: r2SecretKey,
            r2_bucket_name: r2BucketName,
            r2_public_url: r2PublicUrl,
            r2_path_prefix: r2PathPrefix
        };
        payload = {
            ...r2Config,
            config_override: r2Config
        };
    }

    if (testBtn) {
        testBtn.disabled = true;
        testBtn.innerHTML = '<span class="loader w-3 h-3 border-slate-700 border-t-transparent inline-block"></span> 测试中...';
    }
    if (feedback) {
        feedback.innerHTML = '<span class="text-blue-600 flex items-center gap-1"><span class="loader w-3 h-3 border-blue-600 border-t-transparent inline-block"></span> 正在测试连通性与读写鉴权...</span>';
    }

    try {
        const res = await fetch(getStorageApiUrl('storage/test'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json().catch(() => ({}));
        if (feedback) {
            if (res.ok && data.success) {
                feedback.innerHTML = `<span class="text-emerald-600 font-bold flex items-center gap-1"><i class="ph-bold ph-check-circle"></i> ✅ ${detailEscapeHtml(data.message)}</span>`;
                showToast('存储连通性测试通过！', 'success');
            } else {
                const errMsg = data.message || data.detail || (res.status ? `HTTP ${res.status}: 连接失败` : '连接失败');
                feedback.innerHTML = `<span class="text-rose-600 font-bold flex items-center gap-1"><i class="ph-bold ph-warning-circle"></i> ❌ ${detailEscapeHtml(errMsg)}</span>`;
                showToast(`连接测试失败: ${errMsg}`, 'error');
            }
        }
    } catch (err) {
        console.error('Test storage connection failed:', err);
        if (feedback) {
            feedback.innerHTML = `<span class="text-rose-600 font-bold flex items-center gap-1"><i class="ph-bold ph-warning-circle"></i> ❌ 网络请求异常: ${detailEscapeHtml(err.message)}</span>`;
        }
        showToast(`测试失败: ${err.message}`, 'error');
    } finally {
        if (testBtn) {
            testBtn.disabled = false;
            testBtn.innerHTML = '<i class="ph-bold ph-plugs"></i> 测试连通性';
        }
    }
}

// 复制单个远程链接
async function copyPdpAssetRemoteUrl(url) {
    if (!url) return;
    try {
        if (navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(url);
        } else if (typeof document !== 'undefined') {
            const textarea = document.createElement('textarea');
            textarea.value = url;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
        }
        showToast('远程图片链接已复制！', 'success');
    } catch (e) {
        showToast('复制失败，请手动复制', 'error');
    }
}

// 单张图片上传
async function uploadSinglePdpAssetItem(index) {
    if (!pdpAssetQueue || !pdpAssetQueue[index]) return;
    const item = pdpAssetQueue[index];
    if (item.status === 'uploading') return;

    item.status = 'uploading';
    item.error = '';
    renderPdpAssetHostingQueue();
    updatePdpAssetMetrics();

    try {
        const configId = currentStorageTarget === 'wordpress' ? activeWpConfigId : (currentStorageTarget === 'shopify' ? activeShopifyConfigId : null);
        const shouldCompressWebp = typeof document !== 'undefined'
            ? (document.getElementById('storageUploadCompressWebp')?.checked ?? true)
            : false;
        const targetFilename = shouldCompressWebp
            ? item.filename.replace(/\.(png|jpe?g)$/i, '.webp')
            : item.filename;

        const payload = {
            storage_type: currentStorageTarget,
            config_id: configId > 0 ? configId : null,
            image_data: item.originalSrc,
            filename: targetFilename,
            mime_type: shouldCompressWebp ? 'image/webp' : 'image/png',
            convert_to_webp: shouldCompressWebp,
            quality: 90,
            title: item.title,
            alt_text: globalGenContext?.tasks?.[item.id]?.seo?.altTextTarget || item.title
        };

        const res = await fetch(getStorageApiUrl('storage/upload-image'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success && data.remote_url) {
            item.status = 'success';
            item.remoteUrl = data.remote_url;
            item.error = '';
            item.progress = 100;

            const destKey = getPdpCurrentStorageDestinationKey();
            if (!item.targetUploads) item.targetUploads = {};
            item.targetUploads[destKey] = {
                remoteUrl: data.remote_url,
                status: 'success'
            };
            item.targetUploads[currentStorageTarget] = {
                remoteUrl: data.remote_url,
                status: 'success'
            };

            const task = globalGenContext?.tasks?.[item.id];
            if (task) {
                if (!task.remoteImageUrls) task.remoteImageUrls = {};
                task.remoteImageUrls[destKey] = data.remote_url;
                task.remoteImageUrls[currentStorageTarget] = data.remote_url;
            }
        } else {
            item.status = 'error';
            item.error = data.error || data.message || data.detail || `上传失败 (HTTP ${res.status})`;
        }
    } catch (err) {
        console.error('Upload asset error:', err);
        item.status = 'error';
        item.error = err.message || '网络连接错误';
    } finally {
        renderPdpAssetHostingQueue();
        updatePdpAssetMetrics();
    }
}

// 批量上传控制按钮状态
function updatePdpBatchUploadButtonState(uploading) {
    const btn = document.getElementById('btnStartBatchUpload');
    if (!btn) return;
    if (uploading) {
        btn.disabled = true;
        btn.innerHTML = '<span class="loader w-3.5 h-3.5 border-white border-t-transparent inline-block"></span> 正在批量上传...';
        btn.classList.add('opacity-75', 'cursor-not-allowed');
    } else {
        btn.disabled = false;
        btn.innerHTML = '<i class="ph-bold ph-rocket-launch"></i> 开始全部上传';
        btn.classList.remove('opacity-75', 'cursor-not-allowed');
    }
}

// 批量上传所有未完成/失败的图片
async function startPdpAssetBatchUpload() {
    if (isPdpAssetUploading) return;
    const pendingIndices = [];
    pdpAssetQueue.forEach((item, idx) => {
        if (item.status !== 'success') {
            pendingIndices.push(idx);
        }
    });

    if (!pendingIndices.length) {
        showToast('所有图片均已成功上传', 'info');
        return;
    }

    isPdpAssetUploading = true;
    updatePdpBatchUploadButtonState(true);

    const CONCURRENCY = 2;
    let activeCount = 0;
    let indexCursor = 0;

    return new Promise((resolve) => {
        function launchNext() {
            if (indexCursor >= pendingIndices.length && activeCount === 0) {
                isPdpAssetUploading = false;
                updatePdpBatchUploadButtonState(false);
                updatePdpAssetMetrics();
                const successCount = pdpAssetQueue.filter(i => i.status === 'success').length;
                const failCount = pdpAssetQueue.filter(i => i.status === 'error').length;
                if (failCount === 0) {
                    showToast('全案图片已全部上传至云端图床！请点击【确认替换 HTML 图片链接】应用更改', 'success');
                } else {
                    showToast(`上传完成：成功 ${successCount} 张，失败 ${failCount} 张，可点击【重试失败图片】重试`, 'warning');
                }
                resolve();
                return;
            }

            while (activeCount < CONCURRENCY && indexCursor < pendingIndices.length) {
                const targetIdx = pendingIndices[indexCursor++];
                activeCount++;
                uploadSinglePdpAssetItem(targetIdx).finally(() => {
                    activeCount--;
                    launchNext();
                });
            }
        }

        launchNext();
    });
}

// 重试所有失败的图片
function retryFailedPdpAssetUploads() {
    const failedItems = pdpAssetQueue.filter(i => i.status === 'error');
    if (!failedItems.length) {
        showToast('没有失败的上传任务', 'info');
        return;
    }
    failedItems.forEach(item => {
        item.status = 'pending';
        item.error = '';
    });
    renderPdpAssetHostingQueue();
    updatePdpAssetMetrics();
    startPdpAssetBatchUpload();
}

// 应用远程图片链接至当前详情页任务与 HTML 导出
function applyRemoteUrlsToPdpHtml() {
    const destKey = getPdpCurrentStorageDestinationKey();
    const successfulItems = pdpAssetQueue.filter(item => item.status === 'success' && item.remoteUrl);
    if (!successfulItems.length) {
        showToast('暂无上传成功的图片链接可供替换', 'warning');
        return 0;
    }

    let appliedCount = 0;
    successfulItems.forEach(item => {
        if (!item.targetUploads) item.targetUploads = {};
        item.targetUploads[destKey] = { remoteUrl: item.remoteUrl, status: 'success' };
        item.targetUploads[currentStorageTarget] = { remoteUrl: item.remoteUrl, status: 'success' };

        const task = globalGenContext?.tasks?.[item.id];
        if (task) {
            if (!task.originalImageSrc) {
                task.originalImageSrc = task.imageSrc || item.originalSrc;
            }
            task.imageSrc = item.remoteUrl;
            task.remoteImageUrl = item.remoteUrl;
            task.activeStorageTarget = destKey;
            if (!task.remoteImageUrls) task.remoteImageUrls = {};
            task.remoteImageUrls[destKey] = item.remoteUrl;
            task.remoteImageUrls[currentStorageTarget] = item.remoteUrl;
            appliedCount++;

            const modImg = document.getElementById(`content-mod-${item.id}`)?.querySelector('img');
            if (modImg) {
                modImg.src = item.remoteUrl;
            }
        }
    });

    if (typeof renderDtcHybridPreview === 'function') {
        renderDtcHybridPreview();
    }

    if (typeof saveDetailProjectToHistory === 'function') {
        saveDetailProjectToHistory();
    }

    const btnText = document.getElementById('pdpAssetHostingBtnText');
    if (btnText) {
        btnText.textContent = `图床已应用 (${appliedCount}/${pdpAssetQueue.length})`;
    }
    const btnMain = document.getElementById('btnPdpAssetHosting');
    if (btnMain) {
        btnMain.classList.remove('text-emerald-700', 'bg-emerald-50', 'border-emerald-300');
        btnMain.classList.add('text-indigo-700', 'bg-indigo-50', 'border-indigo-300');
    }

    updatePdpAssetMetrics();
    showToast(`成功将 ${appliedCount} 张云端图床链接替换至详情页 HTML 导出！`, 'success');
    closePdpAssetHostingModal();
    return appliedCount;
}

// 还原为本地图片/Base64
function revertToLocalPdpImages() {
    let revertedCount = 0;
    const destKey = getPdpCurrentStorageDestinationKey();
    Object.keys(globalGenContext?.tasks || {}).forEach(id => {
        const task = globalGenContext.tasks[id];
        if (task && task.originalImageSrc) {
            task.imageSrc = task.originalImageSrc;
            task.remoteImageUrl = '';
            delete task.remoteImageUrl;
            delete task.activeStorageTarget;
            if (task.remoteImageUrls) {
                delete task.remoteImageUrls[destKey];
                delete task.remoteImageUrls[currentStorageTarget];
            }
            revertedCount++;

            const modImg = document.getElementById(`content-mod-${id}`)?.querySelector('img');
            if (modImg) {
                modImg.src = task.originalImageSrc;
            }
        }
    });

    pdpAssetQueue.forEach(item => {
        item.remoteUrl = '';
        item.status = 'pending';
        item.progress = 0;
        item.error = '';
        if (item.targetUploads) {
            delete item.targetUploads[destKey];
            delete item.targetUploads[currentStorageTarget];
        }
    });

    if (typeof renderDtcHybridPreview === 'function') {
        renderDtcHybridPreview();
    }

    if (typeof saveDetailProjectToHistory === 'function') {
        saveDetailProjectToHistory();
    }

    const btnText = document.getElementById('pdpAssetHostingBtnText');
    if (btnText) {
        btnText.textContent = '图床托管 / 替换链接';
    }
    const btnMain = document.getElementById('btnPdpAssetHosting');
    if (btnMain) {
        btnMain.classList.add('text-emerald-700', 'bg-emerald-50', 'border-emerald-300');
        btnMain.classList.remove('text-indigo-700', 'bg-indigo-50', 'border-indigo-300');
    }

    renderPdpAssetHostingQueue();
    updatePdpAssetMetrics();
    showToast('已成功还原为本地图片/Base64！HTML 导出代码已同步恢复', 'info');
    return revertedCount;
}

// 打开图床托管模态框
function openPdpAssetHostingModal() {
    if (!globalGenContext || !globalGenContext.tasks || !Object.keys(globalGenContext.tasks).length) {
        showToast('暂无详情页生成任务或未生成图片，请先配置并生成详情页', 'warning');
        return;
    }

    const modal = document.getElementById('pdpAssetHostingModal');
    if (!modal) return;
    modal.classList.remove('hidden');

    buildPdpAssetQueue();
    loadStorageConfigsToModal();
    renderPdpAssetHostingQueue();
    updatePdpAssetMetrics();
}

// 关闭图床托管模态框
function closePdpAssetHostingModal() {
    const modal = document.getElementById('pdpAssetHostingModal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

if (typeof window !== 'undefined') {
    window.setDetailPresentationMode = setDetailPresentationMode;
    window.getDetailPresentationMode = getDetailPresentationMode;
    window.switchDetailResultView = switchDetailResultView;
    window.setDtcViewport = setDtcViewport;
    window.setDtcLayoutStyle = setDtcLayoutStyle;
    window.getDtcLayoutStyle = getDtcLayoutStyle;
    window.applyModulePreset = applyModulePreset;
    window.selectAllModules = selectAllModules;
    window.renderDtcHybridPreview = renderDtcHybridPreview;
    window.toggleDtcAccordion = toggleDtcAccordion;
    window.openImageLightbox = openImageLightbox;
    window.closeImageLightbox = closeImageLightbox;
    window.copyShopifyHtml = copyShopifyHtml;
    window.exportStandalonePdpHtml = exportStandalonePdpHtml;
    window.exportSeoMetadataSummary = exportSeoMetadataSummary;
    window.abortDetailGeneration = abortDetailGeneration;
    window.resetView = resetView;
    window.detectCurrentModulePreset = detectCurrentModulePreset;
    window.updatePresetButtonsUI = updatePresetButtonsUI;
    window.MODULE_PLATFORM_TAGS = MODULE_PLATFORM_TAGS;
    window.setProductTypeMode = setProductTypeMode;
    window.getProductTypeMode = getProductTypeMode;
    window.handleDetailImagePaste = handleDetailImagePaste;
    window.ingestDetailImageFiles = ingestDetailImageFiles;
    window.handleDetailImageDrop = handleDetailImageDrop;
    window.cleanDtcExportHtml = cleanDtcExportHtml;
    window.updateDtcText = updateDtcText;
    window.updateDtcFbrItem = updateDtcFbrItem;
    window.saveDetailProjectToHistory = saveDetailProjectToHistory;
    window.getDtcBrandColor = getDtcBrandColor;
    window.setDtcBrandColor = setDtcBrandColor;
    window.applyDtcBrandColorStyles = applyDtcBrandColorStyles;
    window.getDtcTrustBarEnabled = getDtcTrustBarEnabled;
    window.setDtcTrustBarEnabled = setDtcTrustBarEnabled;
    window.toggleDtcTrustBar = toggleDtcTrustBar;
    window.getLongImageGap = getLongImageGap;
    window.setLongImageGap = setLongImageGap;
    window.getLongImageRadius = getLongImageRadius;
    window.setLongImageRadius = setLongImageRadius;
    window.getLongImageBgColor = getLongImageBgColor;
    window.setLongImageBgColor = setLongImageBgColor;
    window.applyLongImageCanvasStyles = applyLongImageCanvasStyles;
    window.openModuleImagePicker = openModuleImagePicker;
    window.closeModuleImagePicker = closeModuleImagePicker;
    window.selectModuleImage = selectModuleImage;
    window.handleModulePickerUpload = handleModulePickerUpload;
    window.copyDtcSectionHtml = copyDtcSectionHtml;
    window.copySeoMetadataToClipboard = copySeoMetadataToClipboard;
    window.buildDtcStandaloneStylesheet = buildDtcStandaloneStylesheet;
    window.computeCustomBrandColor = computeCustomBrandColor;
    window.setDtcCustomBrandColor = setDtcCustomBrandColor;
    window.triggerDtcCustomColorPicker = triggerDtcCustomColorPicker;
    window.getDtcTypography = getDtcTypography;
    window.applyDtcTypography = applyDtcTypography;
    window.openDtcTypographyModal = openDtcTypographyModal;
    window.closeDtcTypographyModal = closeDtcTypographyModal;
    window.confirmDtcTypographyApplication = confirmDtcTypographyApplication;
    window.resetDtcTypographyToDefault = resetDtcTypographyToDefault;
    window.saveCustomTypographyTemplate = saveCustomTypographyTemplate;
    window.deleteCustomTypographyTemplate = deleteCustomTypographyTemplate;
    window.handleTypographyPresetChange = handleTypographyPresetChange;
    window.updateDtcTypographyPreview = updateDtcTypographyPreview;
    window.getSavedCustomTypographyTemplates = getSavedCustomTypographyTemplates;
    window.initDtcTypographyDropdowns = initDtcTypographyDropdowns;
    window.openPdpAssetHostingModal = openPdpAssetHostingModal;
    window.closePdpAssetHostingModal = closePdpAssetHostingModal;
    window.switchStorageTarget = switchStorageTarget;
    window.toggleStorageConfigDrawer = toggleStorageConfigDrawer;
    window.loadStorageConfigsToModal = loadStorageConfigsToModal;
    window.saveStorageConfigFromModal = saveStorageConfigFromModal;
    window.testStorageConnectionFromModal = testStorageConnectionFromModal;
    window.copyPdpAssetRemoteUrl = copyPdpAssetRemoteUrl;
    window.uploadSinglePdpAssetItem = uploadSinglePdpAssetItem;
    window.startPdpAssetBatchUpload = startPdpAssetBatchUpload;
    window.retryFailedPdpAssetUploads = retryFailedPdpAssetUploads;
    window.applyRemoteUrlsToPdpHtml = applyRemoteUrlsToPdpHtml;
    window.revertToLocalPdpImages = revertToLocalPdpImages;
    window.renderPdpAssetHostingQueue = renderPdpAssetHostingQueue;
    window.getPdpAssetQueue = getPdpAssetQueue;
    window.updatePdpAssetMetrics = updatePdpAssetMetrics;
    window.buildPdpAssetQueue = buildPdpAssetQueue;
    window.sanitizePdpFilename = sanitizePdpFilename;
    window.onWpSiteSelectChange = onWpSiteSelectChange;
    window.addNewWpSite = addNewWpSite;
    window.deleteCurrentWpSite = deleteCurrentWpSite;
    window.onShopifyStoreSelectChange = onShopifyStoreSelectChange;
    window.addNewShopifyStore = addNewShopifyStore;
    window.deleteCurrentShopifyStore = deleteCurrentShopifyStore;
    window.fillWpFormFields = fillWpFormFields;
    window.fillShopifyFormFields = fillShopifyFormFields;
    window.compressAllCurrentModuleImages = compressAllCurrentModuleImages;
    window.getPdpCurrentStorageDestinationKey = getPdpCurrentStorageDestinationKey;
    window.syncPdpQueueStateToCurrentTarget = syncPdpQueueStateToCurrentTarget;
    window.collectCurrentRenderProject = collectCurrentRenderProject;
    window.renderRestoredDetailProject = renderRestoredDetailProject;
    window.setModuleCategoryFilter = setModuleCategoryFilter;
    window.invertModuleSelection = invertModuleSelection;
    window.batchSetAllModuleText = batchSetAllModuleText;
    window.MODULE_CATEGORIES = MODULE_CATEGORIES;
}
if (typeof globalThis !== 'undefined') {
    globalThis.setDetailPresentationMode = setDetailPresentationMode;
    globalThis.getDetailPresentationMode = getDetailPresentationMode;
    globalThis.switchDetailResultView = switchDetailResultView;
    globalThis.setDtcViewport = setDtcViewport;
    globalThis.setDtcLayoutStyle = setDtcLayoutStyle;
    globalThis.getDtcLayoutStyle = getDtcLayoutStyle;
    globalThis.applyModulePreset = applyModulePreset;
    globalThis.selectAllModules = selectAllModules;
    globalThis.renderDtcHybridPreview = renderDtcHybridPreview;
    globalThis.toggleDtcAccordion = toggleDtcAccordion;
    globalThis.openImageLightbox = openImageLightbox;
    globalThis.closeImageLightbox = closeImageLightbox;
    globalThis.copyShopifyHtml = copyShopifyHtml;
    globalThis.exportStandalonePdpHtml = exportStandalonePdpHtml;
    globalThis.exportSeoMetadataSummary = exportSeoMetadataSummary;
    globalThis.abortDetailGeneration = abortDetailGeneration;
    globalThis.resetView = resetView;
    globalThis.detectCurrentModulePreset = detectCurrentModulePreset;
    globalThis.updatePresetButtonsUI = updatePresetButtonsUI;
    globalThis.MODULE_PLATFORM_TAGS = MODULE_PLATFORM_TAGS;
    globalThis.setProductTypeMode = setProductTypeMode;
    globalThis.getProductTypeMode = getProductTypeMode;
    globalThis.handleDetailImagePaste = handleDetailImagePaste;
    globalThis.ingestDetailImageFiles = ingestDetailImageFiles;
    globalThis.handleDetailImageDrop = handleDetailImageDrop;
    globalThis.cleanDtcExportHtml = cleanDtcExportHtml;
    globalThis.updateDtcText = updateDtcText;
    globalThis.updateDtcFbrItem = updateDtcFbrItem;
    globalThis.saveDetailProjectToHistory = saveDetailProjectToHistory;
    globalThis.getDtcBrandColor = getDtcBrandColor;
    globalThis.setDtcBrandColor = setDtcBrandColor;
    globalThis.applyDtcBrandColorStyles = applyDtcBrandColorStyles;
    globalThis.getDtcTrustBarEnabled = getDtcTrustBarEnabled;
    globalThis.setDtcTrustBarEnabled = setDtcTrustBarEnabled;
    globalThis.toggleDtcTrustBar = toggleDtcTrustBar;
    globalThis.renderDtcTrustBar = renderDtcTrustBar;
    globalThis.getLongImageGap = getLongImageGap;
    globalThis.setLongImageGap = setLongImageGap;
    globalThis.getLongImageRadius = getLongImageRadius;
    globalThis.setLongImageRadius = setLongImageRadius;
    globalThis.getLongImageBgColor = getLongImageBgColor;
    globalThis.setLongImageBgColor = setLongImageBgColor;
    globalThis.applyLongImageCanvasStyles = applyLongImageCanvasStyles;
    globalThis.openModuleImagePicker = openModuleImagePicker;
    globalThis.closeModuleImagePicker = closeModuleImagePicker;
    globalThis.selectModuleImage = selectModuleImage;
    globalThis.handleModulePickerUpload = handleModulePickerUpload;
    globalThis.copyDtcSectionHtml = copyDtcSectionHtml;
    globalThis.copySeoMetadataToClipboard = copySeoMetadataToClipboard;
    globalThis.buildDtcStandaloneStylesheet = buildDtcStandaloneStylesheet;
    globalThis.computeCustomBrandColor = computeCustomBrandColor;
    globalThis.setDtcCustomBrandColor = setDtcCustomBrandColor;
    globalThis.triggerDtcCustomColorPicker = triggerDtcCustomColorPicker;
    globalThis.getDtcTypography = getDtcTypography;
    globalThis.applyDtcTypography = applyDtcTypography;
    globalThis.openDtcTypographyModal = openDtcTypographyModal;
    globalThis.closeDtcTypographyModal = closeDtcTypographyModal;
    globalThis.confirmDtcTypographyApplication = confirmDtcTypographyApplication;
    globalThis.resetDtcTypographyToDefault = resetDtcTypographyToDefault;
    globalThis.saveCustomTypographyTemplate = saveCustomTypographyTemplate;
    globalThis.deleteCustomTypographyTemplate = deleteCustomTypographyTemplate;
    globalThis.handleTypographyPresetChange = handleTypographyPresetChange;
    globalThis.updateDtcTypographyPreview = updateDtcTypographyPreview;
    globalThis.getSavedCustomTypographyTemplates = getSavedCustomTypographyTemplates;
    globalThis.initDtcTypographyDropdowns = initDtcTypographyDropdowns;
    globalThis.renderDtcOfferStackSection = renderDtcOfferStackSection;
    globalThis.renderDtcRiskReversalSection = renderDtcRiskReversalSection;
    globalThis.buildDtcJsonLdSchema = buildDtcJsonLdSchema;
    globalThis.openPdpAssetHostingModal = openPdpAssetHostingModal;
    globalThis.closePdpAssetHostingModal = closePdpAssetHostingModal;
    globalThis.switchStorageTarget = switchStorageTarget;
    globalThis.toggleStorageConfigDrawer = toggleStorageConfigDrawer;
    globalThis.loadStorageConfigsToModal = loadStorageConfigsToModal;
    globalThis.saveStorageConfigFromModal = saveStorageConfigFromModal;
    globalThis.testStorageConnectionFromModal = testStorageConnectionFromModal;
    globalThis.copyPdpAssetRemoteUrl = copyPdpAssetRemoteUrl;
    globalThis.uploadSinglePdpAssetItem = uploadSinglePdpAssetItem;
    globalThis.startPdpAssetBatchUpload = startPdpAssetBatchUpload;
    globalThis.retryFailedPdpAssetUploads = retryFailedPdpAssetUploads;
    globalThis.applyRemoteUrlsToPdpHtml = applyRemoteUrlsToPdpHtml;
    globalThis.revertToLocalPdpImages = revertToLocalPdpImages;
    globalThis.renderPdpAssetHostingQueue = renderPdpAssetHostingQueue;
    globalThis.getPdpAssetQueue = getPdpAssetQueue;
    globalThis.updatePdpAssetMetrics = updatePdpAssetMetrics;
    globalThis.buildPdpAssetQueue = buildPdpAssetQueue;
    globalThis.sanitizePdpFilename = sanitizePdpFilename;
    globalThis.getStorageApiUrl = getStorageApiUrl;
    globalThis.onWpSiteSelectChange = onWpSiteSelectChange;
    globalThis.addNewWpSite = addNewWpSite;
    globalThis.deleteCurrentWpSite = deleteCurrentWpSite;
    globalThis.onShopifyStoreSelectChange = onShopifyStoreSelectChange;
    globalThis.addNewShopifyStore = addNewShopifyStore;
    globalThis.deleteCurrentShopifyStore = deleteCurrentShopifyStore;
    globalThis.fillWpFormFields = fillWpFormFields;
    globalThis.fillShopifyFormFields = fillShopifyFormFields;
    globalThis.compressAllCurrentModuleImages = compressAllCurrentModuleImages;
    globalThis.getPdpCurrentStorageDestinationKey = getPdpCurrentStorageDestinationKey;
    globalThis.syncPdpQueueStateToCurrentTarget = syncPdpQueueStateToCurrentTarget;
    globalThis.collectCurrentRenderProject = collectCurrentRenderProject;
    globalThis.renderRestoredDetailProject = renderRestoredDetailProject;
    globalThis.setModuleCategoryFilter = setModuleCategoryFilter;
    globalThis.invertModuleSelection = invertModuleSelection;
    globalThis.batchSetAllModuleText = batchSetAllModuleText;
    globalThis.MODULE_CATEGORIES = MODULE_CATEGORIES;
    globalThis.setDetailProductImage = setDetailProductImage;
    globalThis.openStandalonePdpPreview = openStandalonePdpPreview;
    globalThis.cropImageToCanvas = cropImageToCanvas;
    globalThis.downloadAmazonAPlusCrops = downloadAmazonAPlusCrops;
    globalThis.getCurrentUploadedImages = () => currentUploadedImages;
    globalThis.clearDetailInputs = clearDetailInputs;
    globalThis.uploadLightboxImageToCloud = uploadLightboxImageToCloud;
    globalThis.uploadDetailModuleToCloud = uploadDetailModuleToCloud;
    globalThis.parseSellingPointsList = parseSellingPointsList;
    globalThis.resolveModuleFocalFeature = resolveModuleFocalFeature;
    globalThis.exportFullLaunchKit = exportFullLaunchKit;
    globalThis.getStandalonePdpHtmlString = getStandalonePdpHtmlString;
    globalThis.setGlobalGenContext = setGlobalGenContext;
    globalThis.getGlobalGenContext = getGlobalGenContext;
    globalThis.toggleMediaDropdown = toggleMediaDropdown;
    globalThis.toggleCodeDropdown = toggleCodeDropdown;
    globalThis.hideAllToolbarDropdowns = hideAllToolbarDropdowns;
    globalThis.matchImageStyleForProduct = matchImageStyleForProduct;
    globalThis.applyRecommendedStyle = applyRecommendedStyle;
    globalThis.getFailedModuleTasks = getFailedModuleTasks;
    globalThis.updateDetailFailureUI = updateDetailFailureUI;
    globalThis.dismissDetailFailureAlert = dismissDetailFailureAlert;
    globalThis.retryFailedModuleImages = retryFailedModuleImages;
}
if (typeof window !== 'undefined') {
    window.setDetailProductImage = setDetailProductImage;
    window.openStandalonePdpPreview = openStandalonePdpPreview;
    window.cropImageToCanvas = cropImageToCanvas;
    window.downloadAmazonAPlusCrops = downloadAmazonAPlusCrops;
    window.getCurrentUploadedImages = () => currentUploadedImages;
    window.clearDetailInputs = clearDetailInputs;
    window.uploadLightboxImageToCloud = uploadLightboxImageToCloud;
    window.uploadDetailModuleToCloud = uploadDetailModuleToCloud;
    window.parseSellingPointsList = parseSellingPointsList;
    window.resolveModuleFocalFeature = resolveModuleFocalFeature;
    window.exportFullLaunchKit = exportFullLaunchKit;
    window.getStandalonePdpHtmlString = getStandalonePdpHtmlString;
    window.setGlobalGenContext = setGlobalGenContext;
    window.getGlobalGenContext = getGlobalGenContext;
    window.toggleMediaDropdown = toggleMediaDropdown;
    window.toggleCodeDropdown = toggleCodeDropdown;
    window.hideAllToolbarDropdowns = hideAllToolbarDropdowns;
    window.matchImageStyleForProduct = matchImageStyleForProduct;
    window.applyRecommendedStyle = applyRecommendedStyle;
    window.getFailedModuleTasks = getFailedModuleTasks;
    window.updateDetailFailureUI = updateDetailFailureUI;
    window.dismissDetailFailureAlert = dismissDetailFailureAlert;
    window.retryFailedModuleImages = retryFailedModuleImages;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        exportFullLaunchKit,
        getStandalonePdpHtmlString,
        setGlobalGenContext,
        getGlobalGenContext,
        downloadAmazonAPlusCrops,
        openStandalonePdpPreview,
        cropImageToCanvas,
        parseSellingPointsList,
        resolveModuleFocalFeature,
        toggleMediaDropdown,
        toggleCodeDropdown,
        hideAllToolbarDropdowns,
        matchImageStyleForProduct,
        applyRecommendedStyle,
        getFailedModuleTasks,
        updateDetailFailureUI,
        dismissDetailFailureAlert,
        retryFailedModuleImages
    };
}
