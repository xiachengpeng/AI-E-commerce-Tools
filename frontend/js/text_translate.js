/**
 * 文本翻译模块逻辑 - 单次请求多语言处理
 */

// 初始化逻辑
document.addEventListener('DOMContentLoaded', () => {
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
                target_langs: languages,
                ai_provider: AI_PROVIDER
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
            <button onclick="copySingleCard('${id}-content')" class="text-indigo-400 hover:text-indigo-600 transition-colors p-1 rounded-md hover:bg-indigo-50">
                <i class="ph ph-copy text-lg"></i>
            </button>
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
