/**
 * 文本翻译模块逻辑 - 单次请求多语言处理
 */

// 初始化逻辑
document.addEventListener('DOMContentLoaded', () => {
    renderTextTranslationLanguages();
    const customSelect = document.getElementById('customLangSelect');
    const optionsList = document.getElementById('langOptionsList');
    
    if (customSelect) {
        customSelect.addEventListener('click', (e) => {
            e.stopPropagation();
            optionsList.classList.toggle('hidden');
        });

        optionsList.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        document.addEventListener('click', () => {
            optionsList.classList.add('hidden');
        });
    }
});

function renderTextTranslationLanguages() {
    const container = document.getElementById('textTranslationLanguageOptions');
    if (!container || typeof ALL_LANGUAGE_OPTIONS === 'undefined') return;
    container.innerHTML = ALL_LANGUAGE_OPTIONS.map(language => `
        <label class="lang-option-item p-4 flex items-center gap-3 hover:bg-indigo-50 cursor-pointer border-b border-gray-50 transition-colors">
            <input type="checkbox" value="${language.value}" class="lang-checkbox w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500">
            <span class="text-sm font-bold text-gray-600">${language.textLabel}</span>
        </label>
    `).join('');
}

/**
 * 确认语言选择并更新 UI 显示
 */
function confirmLangSelection() {
    const checkboxes = document.querySelectorAll('.lang-checkbox:checked');
    const selectedText = document.getElementById('selectedLangText');
    const optionsList = document.getElementById('langOptionsList');
    
    if (checkboxes.length === 0) {
        selectedText.innerText = '选择目标语言';
    } else if (checkboxes.length === 1) {
        selectedText.innerText = checkboxes[0].parentElement.querySelector('span').innerText;
    } else {
        selectedText.innerText = `已选 ${checkboxes.length} 种语言`;
    }
    
    optionsList.classList.add('hidden');
}

/**
 * 一键应用大区语言预设
 */
function applyTextLangPreset(presetKey) {
    const presets = {
        western5: ['English', 'German', 'French', 'Spanish', 'Italian'],
        sea_latam: ['Thai', 'Spanish', 'Portuguese', 'English'],
        east_asia: ['Japanese', 'Korean']
    };

    const targetLangs = presets[presetKey] || [];
    const checkboxes = document.querySelectorAll('.lang-checkbox');
    checkboxes.forEach(cb => {
        cb.checked = targetLangs.includes(cb.value);
    });

    confirmLangSelection();
}

/**
 * 批量翻译主函数 - 现在只发起一次请求
 */
async function executeBatchTextTranslation() {
    const inputText = document.getElementById('transInputText').value.trim();
    const checkboxes = document.querySelectorAll('.lang-checkbox:checked');
    const container = document.getElementById('transResultsContainer');
    const placeholder = document.getElementById('transResultPlaceholder');
    const btn = document.getElementById('btnDoTextTranslate');
    const progress = document.getElementById('batchProgress');

    if (!inputText) {
        showToast('请输入原文内容', 'error');
        return;
    }
    if (checkboxes.length === 0) {
        showToast('请至少选择一种目标语言', 'warning');
        return;
    }

    // 1. UI 准备与防御性校验
    const origBtnHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.innerHTML = '<i class="ph ph-spinner animate-spin"></i> 正在处理中...';
        btn.disabled = true;
    }
    
    if (progress) {
        progress.classList.remove('hidden');
        progress.innerText = 'AI 正在思考所有语言...';
    }
    
    if (placeholder) placeholder.classList.add('hidden');
    if (container) container.innerHTML = ''; 

    // 获取选中的语言名称和值
    const languages = [];
    const langLabelMap = {}; // value -> label
    checkboxes.forEach(cb => {
        const val = cb.value;
        const label = cb.parentElement.querySelector('span').innerText;
        languages.push(val);
        langLabelMap[val] = label;
        
        // 先插入 Loading 状态的卡片
        const cardId = `res-card-${val.toLowerCase()}`;
        const cardHtml = `
            <div id="${cardId}" class="bg-white rounded-xl border border-indigo-50 p-6 shadow-sm animate-pulse">
                <div class="flex justify-between items-center mb-4">
                    <span class="px-3 py-1 bg-gray-100 text-gray-400 rounded-full text-[10px] font-black uppercase tracking-widest">${label}</span>
                    <i class="ph ph-circle-notch animate-spin text-indigo-300"></i>
                </div>
                <div class="space-y-2">
                    <div class="h-3 bg-gray-50 rounded w-3/4"></div>
                    <div class="h-3 bg-gray-50 rounded w-full"></div>
                </div>
            </div>
        `;
        container.insertAdjacentHTML('beforeend', cardHtml);
    });

    try {
        // 2. 发起单次请求
        const response = await fetch(`${API_BASE}/api/translate-text`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: inputText,
                target_langs: languages
            })
        });
        
        const data = await response.json();

        if (data.status === 'success' && data.translations) {
            // 3. 处理并显示返回的所有翻译
            Object.entries(data.translations).forEach(([langKey, translatedText]) => {
                const langValue = languages.find(l => langKey.includes(l) || l.includes(langKey)) || langKey;
                const cardId = `res-card-${langValue.toLowerCase()}`;
                const label = langLabelMap[langValue] || langKey;
                
                updateResultCard(cardId, label, translatedText);
            });

            // 4. 只保存一条聚合历史记录
            saveToHistory('text-translation', {
                source_text: inputText,
                target_lang: '批量翻译', // 标识这是批量任务
                result: data.translations   // 这是一个包含所有翻译的对象
            });

            showToast('批量翻译完成', 'success');
        } else {
            throw new Error(data.message || '翻译任务失败');
        }
    } catch (error) {
        console.error('Batch Translation Error:', error);
        showToast(error.message, 'error');
        // 全局错误处理：将所有 Loading 卡片转为错误状态
        languages.forEach(val => {
            const cardId = `res-card-${val.toLowerCase()}`;
            const label = langLabelMap[val];
            updateResultCardError(cardId, label, '翻译请求失败');
        });
    } finally {
        btn.innerHTML = origBtnHtml;
        btn.disabled = false;
        progress.classList.add('hidden');
    }
}

/**
 * 更新结果卡片 (成功)
 */
function updateResultCard(id, langName, text) {
    const card = document.getElementById(id);
    if (!card) return;

    card.classList.remove('animate-pulse', 'border-indigo-50');
    card.classList.add('border-gray-100', 'hover:border-indigo-200', 'hover:shadow-md', 'transition-all');
    
    card.innerHTML = `
        <div class="flex justify-between items-center mb-3">
            <span class="px-3 py-1 bg-indigo-50 text-indigo-600 rounded-full text-[10px] font-black uppercase tracking-widest">${langName}</span>
            <div class="flex items-center gap-1.5">
                <button onclick="sendTranslatedTextToListing('${id}-content')" class="text-xs text-indigo-600 hover:text-indigo-800 hover:bg-indigo-50 px-2 py-1 rounded transition-colors font-bold flex items-center gap-1 cursor-pointer" title="一键将该语言译文填入 Listing 创作中心">
                    <i class="ph ph-shopping-cart"></i> <span class="text-[10px]">带入 Listing</span>
                </button>
                <button onclick="sendTranslatedTextToAds('${id}-content')" class="text-xs text-purple-600 hover:text-purple-800 hover:bg-purple-50 px-2 py-1 rounded transition-colors font-bold flex items-center gap-1 cursor-pointer" title="一键将该语言译文填入广告文案营销中心">
                    <i class="ph ph-megaphone"></i> <span class="text-[10px]">带入广告</span>
                </button>
                <button onclick="copySingleCard('${id}-content')" class="text-gray-400 hover:text-indigo-600 transition-colors p-1 rounded-md hover:bg-indigo-50 cursor-pointer" title="复制译文">
                    <i class="ph ph-copy text-base"></i>
                </button>
            </div>
        </div>
        <div id="${id}-content" class="text-gray-700 text-sm leading-relaxed whitespace-pre-wrap">${text}</div>
    `;
}

/**
 * 更新结果卡片 (失败)
 */
function updateResultCardError(id, langName, msg) {
    const card = document.getElementById(id);
    if (!card) return;

    card.classList.remove('animate-pulse', 'border-indigo-50');
    card.classList.add('border-red-100', 'bg-red-50/30');
    
    card.innerHTML = `
        <div class="flex justify-between items-center mb-3">
            <span class="px-3 py-1 bg-red-100 text-red-600 rounded-full text-[10px] font-black uppercase tracking-widest">${langName}</span>
            <i class="ph ph-warning-circle text-red-400"></i>
        </div>
        <div class="text-red-400 text-xs italic">${msg}</div>
    `;
}

/**
 * 将翻译结果带入 Listing 描述与五点
 */
function sendTranslatedTextToListing(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const text = el.innerText.trim();
    if (!text) return;
    const listingInput = document.getElementById('listingRawInput');
    if (listingInput) {
        listingInput.value = text;
        const tabSwitcher = typeof switchMainTab === 'function' ? switchMainTab : (typeof window !== 'undefined' && window.switchMainTab ? window.switchMainTab : (typeof globalThis !== 'undefined' ? globalThis.switchMainTab : null));
        if (tabSwitcher) tabSwitcher('listing');
        if (typeof showToast === 'function') showToast('已将该语言译文填入 Listing 创作中心！', 'success');
    }
}

/**
 * 将翻译结果带入广告文案营销中心
 */
function sendTranslatedTextToAds(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const text = el.innerText.trim();
    if (!text) return;
    const adsInput = document.getElementById('adsProductDesc');
    if (adsInput) {
        adsInput.value = text;
        const tabSwitcher = typeof switchMainTab === 'function' ? switchMainTab : (typeof window !== 'undefined' && window.switchMainTab ? window.switchMainTab : (typeof globalThis !== 'undefined' ? globalThis.switchMainTab : null));
        if (tabSwitcher) tabSwitcher('ads');
        if (typeof showToast === 'function') showToast('已将该语言译文填入广告文案营销中心！', 'success');
    }
}

/**
 * 复制单个卡片内容
 */
function copySingleCard(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;
    
    const text = el.innerText;
    navigator.clipboard.writeText(text).then(() => {
        showToast('该语言结果已复制', 'success');
    });
}

/**
 * 复制全部结果
 */
function copyAllResults() {
    const contentElements = document.querySelectorAll('[id$="-content"]');
    if (contentElements.length === 0) {
        showToast('当前没有翻译结果', 'warning');
        return;
    }
    
    let combinedText = "";
    contentElements.forEach(el => {
        const langName = el.parentElement.querySelector('span').innerText;
        combinedText += `【${langName}】\n${el.innerText}\n\n`;
    });
    
    navigator.clipboard.writeText(combinedText.trim()).then(() => {
        showToast('全部结果已按格式复制', 'success');
    });
}

if (typeof window !== 'undefined') {
    window.applyTextLangPreset = applyTextLangPreset;
    window.sendTranslatedTextToListing = sendTranslatedTextToListing;
    window.sendTranslatedTextToAds = sendTranslatedTextToAds;
}
if (typeof globalThis !== 'undefined') {
    globalThis.applyTextLangPreset = applyTextLangPreset;
    globalThis.sendTranslatedTextToListing = sendTranslatedTextToListing;
    globalThis.sendTranslatedTextToAds = sendTranslatedTextToAds;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        ...(module.exports || {}),
        applyTextLangPreset,
        sendTranslatedTextToListing,
        sendTranslatedTextToAds,
        confirmLangSelection,
        executeBatchTextTranslation,
        copySingleCard,
        copyAllResults
    };
}
