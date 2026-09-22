/**
 * 统一工具函数库
 */

const API_BASE = (typeof globalThis !== "undefined" && globalThis.API_BASE)
    ? globalThis.API_BASE
    : ((typeof window !== "undefined" && window.location && window.location.hostname)
        ? (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
            ? `${window.location.protocol}//127.0.0.1:9503`
            : `${window.location.protocol}//${window.location.hostname}:9503`)
        : "http://127.0.0.1:9503");

if (typeof globalThis !== "undefined") {
    globalThis.API_BASE = API_BASE;
}
if (typeof window !== "undefined") {
    window.API_BASE = API_BASE;
}

/**
 * 格式化图片地址，确保 /static 路径能正确请求后端端口
 */
function formatImgSrc(src) {
    if (!src) return '';
    if (typeof src === 'string') {
        if (src.startsWith('data:image') || src.startsWith('http')) return src;
        if (src.startsWith('/static')) {
            const base = typeof API_BASE !== 'undefined' ? API_BASE : 'http://localhost:9503';
            return base + src;
        }
    }
    return src;
}

/**
 * 格式化存储目标显示名称，避免名称中已包含URL/域名时重复追加
 */
function formatStorageDisplayLabel(name, targetUrlOrDomain, fallback = "未命名") {
    const rawName = (name || "").trim();
    const rawTarget = (targetUrlOrDomain || "").trim();

    if (!rawName && !rawTarget) {
        return fallback;
    }
    if (!rawTarget) {
        return rawName || fallback;
    }
    if (!rawName) {
        return rawTarget;
    }

    const cleanTarget = rawTarget.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
    const cleanName = rawName.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
    if (cleanName === cleanTarget) {
        return rawTarget;
    }

    if (rawName.includes(rawTarget) || (cleanTarget && cleanName.includes(cleanTarget))) {
        return rawName;
    }

    return `${rawName} (${rawTarget})`;
}

/**
 * 安全写入 localStorage，捕获并处理 QuotaExceededError，防止超出 5MB 配额崩溃
 * @param {string} key 键名
 * @param {string} value 待存数据
 * @param {string[]} [customPurgeKeys] 可选的淘汰清除键列表
 * @returns {boolean} 是否写入成功
 */
function safeLocalStorageSet(key, value, customPurgeKeys = []) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (e) {
        const isQuotaError = e && (
            e.name === 'QuotaExceededError' ||
            e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
            e.code === 22 ||
            e.code === 1014
        );
        if (isQuotaError) {
            console.warn(`[Storage] localStorage 配额超限，尝试清理临时缓存: key=${key}`);
            const defaultPurgeKeys = [
                'xuanpin_last_result_v26',
                'xuanpin_last_result_v25',
                'xp_temp_preview',
                'dtc_typography_preview_cache'
            ];
            const allPurgeKeys = [...new Set([...(Array.isArray(customPurgeKeys) ? customPurgeKeys : []), ...defaultPurgeKeys])];
            try {
                for (const pk of allPurgeKeys) {
                    if (typeof localStorage.removeItem === 'function') {
                        localStorage.removeItem(pk);
                    }
                }
                localStorage.setItem(key, value);
                return true;
            } catch (retryErr) {
                console.error(`[Storage] 淘汰旧缓存后仍无法写入 localStorage: key=${key}`, retryErr);
                return false;
            }
        }
        console.warn(`[Storage] localStorage 写入失败: key=${key}`, e);
        return false;
    }
}

/**
 * 从 AI 原始文本中健壮提取并容错解析 JSON 对象
 */
function safeExtractAndParseJson(text) {
    if (!text || typeof text !== 'string') {
        throw new Error('AI 返回内容为空');
    }
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
        throw new Error('未能从 AI 响应中解析出结构化 JSON');
    }
    let candidate = cleaned.slice(firstBrace, lastBrace + 1);
    try {
        return JSON.parse(candidate);
    } catch (_e) {
        candidate = candidate.replace(/,\s*([}\]])/g, '$1');
        return JSON.parse(candidate);
    }
}

if (typeof globalThis !== 'undefined') {
    globalThis.formatImgSrc = formatImgSrc;
    globalThis.formatStorageDisplayLabel = formatStorageDisplayLabel;
    globalThis.safeExtractAndParseJson = safeExtractAndParseJson;
}

/**
 * 将日志发送至后端终端
 */
async function remoteLog(message, fields = {}) {
    try {
        fetch(`${API_BASE}/log`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                level: fields.level || "info",
                source: fields.source || "frontend",
                capability: fields.capability || null,
                message: String(message).replace(/%c/g, "")
            })
        }).catch(() => {});
    } catch (e) {}
}

/**
 * 统一弹窗提示
 */
function appendToastContent(toast, message, icon, documentRef = document) {
    const iconElement = documentRef.createElement('i');
    iconElement.className = `ph ${icon} text-lg`;

    const messageElement = documentRef.createElement('span');
    messageElement.textContent = String(message ?? '');

    toast.appendChild(iconElement);
    toast.appendChild(messageElement);
}

function showToast(message, type = 'info') {
    if (typeof globalThis !== 'undefined' && globalThis.showToast && globalThis.showToast !== showToast) {
        return globalThis.showToast(message, type);
    }
    if (typeof document === 'undefined') return;
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    let bgClass = type === 'success' ? 'bg-emerald-600' : (type === 'error' ? 'bg-red-500' : (type === 'warning' ? 'bg-amber-500' : 'bg-gray-800'));
    let icon = type === 'success' ? 'ph-check-circle' : (type === 'error' ? 'ph-warning-circle' : 'ph-info');
    toast.className = `toast-enter flex items-center gap-2 ${bgClass} text-white px-4 py-3 rounded-xl shadow-xl text-sm font-medium tracking-wide`;
    appendToastContent(toast, message, icon);
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0'; toast.style.transform = 'translateY(-10px)'; toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

/**
 * 生成符合 RFC4122 v4 规范的唯一标识符 (UUID)
 */
function generateUuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * 带重试机制的 Fetch
 */
const DEFAULT_NON_RETRYABLE_STATUSES = [400, 401, 403, 404, 409, 422];

async function fetchWithRetry(url, options, retries = 5, retryOptions = {}) {
    const maxAttempts = (retryOptions.disableRetry || retries <= 1) ? 1 : retries;
    const delays = [1000, 2000, 4000, 8000, 16000];
    const nonRetryableStatuses = new Set([
        ...DEFAULT_NON_RETRYABLE_STATUSES,
        ...(retryOptions.nonRetryableStatuses || [])
    ]);
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const res = await fetch(url, options);
            if (!res.ok) {
                let error = new Error(`HTTP ${res.status}`);
                if (typeof retryOptions.createError === "function") {
                    const customError = await retryOptions.createError(res);
                    if (customError instanceof Error) error = customError;
                }
                if (nonRetryableStatuses.has(res.status) || maxAttempts === 1) {
                    error.retryable = false;
                    throw error;
                }
                throw error;
            }
            return await res.json();
        } catch (e) {
            if (e.name === 'AbortError' || options?.signal?.aborted || e.retryable === false || i === maxAttempts - 1) throw e;
            await new Promise(r => setTimeout(r, delays[i]));
        }
    }
}

/**
 * 复制文本到剪贴板
 */
function copyText(inputId) {
    const el = document.getElementById(inputId);
    if (!el) return;
    
    // 兼容性获取：优先取 .value (input/textarea)，其次取 .innerText (div/span)
    let text = el.value !== undefined ? el.value : el.innerText;
    
    if (!text) {
        showToast('内容为空，无法复制', 'warning');
        return;
    }

    const textArea = document.createElement("textarea");
    textArea.value = text;
    document.body.appendChild(textArea);
    textArea.select();
    try { 
        document.execCommand('copy'); 
        showToast('已复制到剪贴板', 'success'); 
    } catch (e) { 
        showToast('复制失败', 'error'); 
    }
    document.body.removeChild(textArea);
}

/**
 * 复制指定区块文本
 */
function copySectionText(containerId, langType) {
    const el = document.getElementById(containerId);
    if (!el) return;
    let text = '';
    const selector = langType === 'target' ? '.target-text' : '.zh-text';

    if (el.tagName === 'UL') {
        const lis = el.querySelectorAll('li');
        lis.forEach(li => {
            const txt = li.querySelector(selector)?.textContent;
            if(txt) text += txt + '\n';
        });
    } else if (containerId === 'resListingQA') {
        const qas = el.querySelectorAll('.bg-indigo-50\\/50');
        qas.forEach(qa => {
           const lines = qa.querySelectorAll(selector);
           if(lines.length >= 2) {
               text += `Q: ${lines[0].textContent}\nA: ${lines[1].textContent}\n\n`;
           }
        });
    } else {
        const txt = (el.matches && el.matches(selector)) ? el.textContent : el.querySelector(selector)?.textContent;
        if(txt) text = txt;
    }

    const textArea = document.createElement("textarea");
    textArea.value = text.trim();
    document.body.appendChild(textArea);
    textArea.select();
    try { document.execCommand('copy'); showToast(`已复制${langType==='target'?'外文':'中文'}文本`, 'success'); } catch(e){}
    document.body.removeChild(textArea);
}

/**
 * 通用图片下载函数 (支持 URL 和 Base64)
 */
function downloadImage(src, filename) {
    if (!src) return;
    const link = document.createElement('a');
    link.href = src;
    link.download = filename.endsWith('.png') || filename.endsWith('.jpg') ? filename : `${filename}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

/**
 * 安全解析 JSON
 */
function jsonParseSafe(str) {
    if (typeof str === 'object' && str !== null) return str;
    try {
        return JSON.parse(str);
    } catch (e) {
        console.error("JSON Parse Error:", e, str);
        return {};
    }
}

/**
 * 从剪贴板事件中提取所有图片文件 (File 对象)
 */
function extractImageFilesFromClipboard(event) {
    const clipboardData = event?.clipboardData || event?.originalEvent?.clipboardData;
    if (!clipboardData) return [];

    const files = [];
    const items = clipboardData.items;
    if (items && items.length > 0) {
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item && item.type && item.type.startsWith('image/')) {
                const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
                if (file) {
                    files.push(file);
                }
            }
        }
    }

    if (files.length === 0 && clipboardData.files && clipboardData.files.length > 0) {
        for (let i = 0; i < clipboardData.files.length; i++) {
            const file = clipboardData.files[i];
            if (file && file.type && file.type.startsWith('image/')) {
                files.push(file);
            }
        }
    }

    return files;
}

/**
 * 判断是否应跳过图片粘贴拦截 (例如用户正在向文本输入框粘贴纯文本)
 */
function shouldIgnoreImagePaste(event) {
    const target = event?.target;
    if (!target) return false;

    // 若粘贴目标是已知的图片上传容器或触发按钮，绝不跳过
    if (typeof target.closest === 'function') {
        if (
            target.closest('#imagePreviewContainer') ||
            target.closest('label[for="imageUpload"]') ||
            target.closest('#listingImagePreviewContainer') ||
            target.closest('label[for="listingImageUpload"]') ||
            target.closest('#adsImagePreviewContainer') ||
            target.closest('label[for="adsImageUpload"]') ||
            target.closest('#squareRedrawEmptyState') ||
            target.closest('label[for="squareRedrawUpload"]') ||
            target.closest('#transDropZone') ||
            target.closest('label[for="transImageUpload"]') ||
            target.closest('#watermarkRemovalUpload') ||
            target.closest('#watermarkRemovalCanvasStage')
        ) {
            return false;
        }
    }

    const isInput = target.tagName === 'INPUT' && target.type !== 'file';
    const isTextarea = target.tagName === 'TEXTAREA';
    const isContentEditable = Boolean(target.isContentEditable);

    if (isInput || isTextarea || isContentEditable) {
        const clipboardData = event?.clipboardData || event?.originalEvent?.clipboardData;
        const text = clipboardData?.getData ? clipboardData.getData('text/plain') : '';
        // 用户在文本输入区域粘贴文本时，保持默认文本粘贴行为
        if (text && text.trim().length > 0) {
            return true;
        }
    }

    return false;
}

/**
 * 获取当前活动的业务标签 ID
 */
function getActiveTabForImagePaste() {
    if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
        const visibleView = document.querySelector('div[id^="view-"]:not(.hidden)');
        if (visibleView && visibleView.id) {
            return visibleView.id.replace(/^view-/, '');
        }
    }
    if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
        return localStorage.getItem('activeMainTab') || 'generate';
    }
    return 'generate';
}

/**
 * 根据触发目标或当前活跃视图确定图片粘贴的目标模块
 */
function resolveImagePasteTarget(event) {
    const target = event?.target;
    if (target && typeof target.closest === 'function') {
        if (target.closest('#view-generate') || target.closest('#imagePreviewContainer') || target.closest('label[for="imageUpload"]')) return 'generate';
        if (target.closest('#view-listing') || target.closest('#listingImagePreviewContainer') || target.closest('label[for="listingImageUpload"]')) return 'listing';
        if (target.closest('#view-ads') || target.closest('#adsImagePreviewContainer') || target.closest('label[for="adsImageUpload"]')) return 'ads';
        if (target.closest('#view-square-redraw') || target.closest('#squareRedrawEmptyState') || target.closest('label[for="squareRedrawUpload"]')) return 'square-redraw';
        if (target.closest('#view-translate') || target.closest('#transDropZone') || target.closest('label[for="transImageUpload"]')) return 'translate';
        if (target.closest('#view-watermark-removal') || target.closest('#watermarkRemovalUpload') || target.closest('#watermarkRemovalCanvasStage')) return 'watermark-removal';
    }
    return getActiveTabForImagePaste();
}

/**
 * 将粘贴的图片文件分发到对应模块的摄取函数
 */
function dispatchImagePaste(files, targetTab) {
    if (!files || !files.length) return;

    switch (targetTab) {
        case 'generate':
        case 'details':
            if (typeof handleDetailImagePaste === 'function') {
                handleDetailImagePaste(files);
            } else if (typeof ingestDetailImageFiles === 'function') {
                ingestDetailImageFiles(files);
            }
            break;
        case 'listing':
            if (typeof handleListingImagePaste === 'function') {
                handleListingImagePaste(files[0]);
            } else if (typeof ingestListingImageFile === 'function') {
                ingestListingImageFile(files[0]);
            }
            break;
        case 'ads':
            if (typeof handleAdsImagePaste === 'function') {
                handleAdsImagePaste(files[0]);
            } else if (typeof ingestAdsImageFile === 'function') {
                ingestAdsImageFile(files[0]);
            }
            break;
        case 'square-redraw':
            if (typeof handleSquareRedrawImagePaste === 'function') {
                handleSquareRedrawImagePaste(files);
            } else if (typeof loadSquareRedrawFiles === 'function') {
                loadSquareRedrawFiles(files);
            }
            break;
        case 'translate':
            if (typeof handleTranslateImagePaste === 'function') {
                handleTranslateImagePaste(files);
            } else if (typeof loadTransFiles === 'function') {
                loadTransFiles(files);
            }
            break;
        case 'watermark-removal':
            if (typeof handleWatermarkImagePaste === 'function') {
                handleWatermarkImagePaste(files[0]);
            } else if (typeof window !== 'undefined' && typeof window.handleWatermarkImagePaste === 'function') {
                window.handleWatermarkImagePaste(files[0]);
            }
            break;
        default:
            console.warn('[Paste] No image paste handler for tab:', targetTab);
            break;
    }
}

/**
 * 全局图片粘贴处理事件
 */
function handleGlobalImagePaste(event) {
    if (shouldIgnoreImagePaste(event)) {
        return;
    }
    const imageFiles = extractImageFilesFromClipboard(event);
    if (!imageFiles || imageFiles.length === 0) {
        return;
    }

    if (typeof event.preventDefault === 'function') {
        event.preventDefault();
    }

    const targetTab = resolveImagePasteTarget(event);
    dispatchImagePaste(imageFiles, targetTab);
}

let _globalImagePasteBound = false;
function setupGlobalImagePaste() {
    if (_globalImagePasteBound) return;
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('paste', handleGlobalImagePaste);
        _globalImagePasteBound = true;
    }
}

/**
 * 格式化字节大小为易读字符串
 */
function formatBytes(bytes, decimals = 1) {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const idx = Math.min(sizes.length - 1, Math.max(0, i));
    return parseFloat((bytes / Math.pow(k, idx)).toFixed(dm)) + ' ' + sizes[idx];
}

/**
 * 估算 Base64 Data URL 对应的原始二进制字节数
 */
function estimateBase64Bytes(dataUrl = '') {
    if (typeof dataUrl !== 'string' || !dataUrl) return 0;
    const commaIdx = dataUrl.indexOf(',');
    const b64Str = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
    return Math.round((b64Str.length * 3) / 4);
}

/**
 * 高保真 WebP 图片压缩引擎 (优先浏览器 Canvas 硬件加速，失败时自动兜底后端 API)
 * @param {string} source - Base64 Data URL 或可访问的图片 URL
 * @param {object} options - 选项配置 { quality: 0.90, maxDimension: 0 }
 * @returns {Promise<{ dataUrl: string, originalSize: number, compressedSize: number, savingsPercent: number, changed: boolean, mimeType: string }>}
 */
async function compressImageToWebp(source, options = {}) {
    if (!source || typeof source !== 'string') {
        return { dataUrl: source, originalSize: 0, compressedSize: 0, savingsPercent: 0, changed: false, mimeType: '' };
    }

    const quality = typeof options.quality === 'number' ? Math.max(0.1, Math.min(1.0, options.quality)) : 0.90;
    const origSize = estimateBase64Bytes(source);

    // 1. 尝试浏览器前端原生 Canvas 转换 (零网络延迟，硬件加速)
    if (typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof Image !== 'undefined') {
        try {
            const result = await new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => {
                    try {
                        const canvas = document.createElement('canvas');
                        canvas.width = img.naturalWidth || img.width;
                        canvas.height = img.naturalHeight || img.height;
                        const ctx = canvas.getContext('2d');
                        if (!ctx) return reject(new Error('Canvas 2D context not available'));
                        ctx.drawImage(img, 0, 0);

                        const webpData = canvas.toDataURL('image/webp', quality);
                        if (!webpData.startsWith('data:image/webp')) {
                            // 浏览器不支持在 canvas 中输出 WebP，交给后端处理
                            return reject(new Error('Canvas image/webp not supported in this browser'));
                        }

                        const newSize = estimateBase64Bytes(webpData);
                        // 智能体积保护：只有确实减小了才替换
                        if (origSize > 0 && newSize >= origSize && source.startsWith('data:image/webp')) {
                            resolve({
                                dataUrl: source,
                                originalSize: origSize,
                                compressedSize: origSize,
                                savingsPercent: 0,
                                changed: false,
                                mimeType: 'image/webp'
                            });
                        } else {
                            const savings = Math.max(0, origSize - newSize);
                            const savingsPercent = origSize > 0 ? Math.round((savings / origSize) * 1000) / 10 : 0;
                            resolve({
                                dataUrl: webpData,
                                originalSize: origSize,
                                compressedSize: newSize,
                                savingsPercent,
                                changed: true,
                                mimeType: 'image/webp'
                            });
                        }
                    } catch (e) {
                        reject(e);
                    }
                };
                img.onerror = (err) => reject(new Error('Image failed to load for WebP compression: ' + err));
                img.src = source;
            });

            if (result && result.dataUrl) return result;
        } catch (clientErr) {
            // 前端 canvas 异常时，静默继续尝试后端 API 转换
        }
    }

    // 2. 尝试调用后端 Pillow API 转换 (/api/image/compress-webp)
    if (typeof fetch === 'function' && source.startsWith('data:image/')) {
        try {
            const apiBase = typeof API_BASE !== 'undefined' ? API_BASE : 'http://localhost:9503';
            const res = await fetch(`${apiBase}/api/image/compress-webp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image_data: source,
                    quality: Math.round(quality * 100)
                })
            });
            if (res.ok) {
                const json = await res.json();
                if (json?.status === 'success' && json?.webp_data) {
                    const stats = json.stats || {};
                    return {
                        dataUrl: json.webp_data,
                        originalSize: stats.original_size || origSize,
                        compressedSize: stats.compressed_size || estimateBase64Bytes(json.webp_data),
                        savingsPercent: stats.savings_percent || 0,
                        changed: true,
                        mimeType: 'image/webp'
                    };
                }
            }
        } catch (apiErr) {
            console.warn('[WebP] Backend compression API fallback failed:', apiErr);
        }
    }

    // 3. 兜底保障：若都不支持则保持原格式
    return {
        dataUrl: source,
        originalSize: origSize,
        compressedSize: origSize,
        savingsPercent: 0,
        changed: false,
        mimeType: source.startsWith('data:image/webp') ? 'image/webp' : ''
    };
}

if (typeof globalThis !== 'undefined') {
    globalThis.formatBytes = formatBytes;
    globalThis.estimateBase64Bytes = estimateBase64Bytes;
    globalThis.compressImageToWebp = compressImageToWebp;
    globalThis.generateUuid = generateUuid;
}

if (typeof module !== "undefined") {
    module.exports = {
        formatImgSrc,
        appendToastContent,
        generateUuid,
        fetchWithRetry,
        extractImageFilesFromClipboard,
        shouldIgnoreImagePaste,
        getActiveTabForImagePaste,
        resolveImagePasteTarget,
        dispatchImagePaste,
        handleGlobalImagePaste,
        setupGlobalImagePaste,
        formatBytes,
        estimateBase64Bytes,
        compressImageToWebp,
        formatStorageDisplayLabel,
        debounce,
        resetAllAppDraftsAndState
    };
}

function debounce(fn, wait = 300) {
    let timer = null;
    return function(...args) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            fn.apply(this, args);
        }, wait);
    };
}

function resetAllAppDraftsAndState(options = {}) {
    const shouldPrompt = (typeof options === 'object' && options !== null && options.prompt === true);
    if (shouldPrompt && typeof window !== 'undefined' && typeof window.confirm === 'function') {
        const confirmed = window.confirm('⚠️ 警告：确定要清空所有模块的输入草稿、竞品分析与临时缓存吗？\n未保存的内容将永久丢失！');
        if (!confirmed) {
            return false;
        }
    }
    if (typeof localStorage === 'undefined') return false;
    const keysToRemove = [
        'xuanpin_last_result_v27',
        'xuanpin_last_urls_v27',
        'ai_ecommerce_listing_draft_v1',
        'ai_ecommerce_ads_draft_v1',
        'xp_last_analysis_response',
        'xp_last_analysis_urls',
        'listing_input_draft',
        'ads_input_draft'
    ];
    keysToRemove.forEach(k => {
        try { localStorage.removeItem(k); } catch (_) {}
    });
    if (typeof xp_resetAnalysisSession === 'function') {
        try { xp_resetAnalysisSession(); } catch (_) {}
    }
    if (typeof clearListingDraft === 'function') {
        try { clearListingDraft(); } catch (_) {}
    }
    if (typeof clearAdsDraft === 'function') {
        try { clearAdsDraft(); } catch (_) {}
    }
    if (typeof clearDetailInputs === 'function') {
        try { clearDetailInputs(); } catch (_) {}
    }
    if (typeof showToast === 'function') {
        showToast('已彻底清空所有模块残留与草稿缓存，恢复干净初始状态！', 'success');
    }
}

/**
 * 解析输入框对应的已保存密钥元数据
 */
function resolveSecretMeta(input) {
    if (!input) return null;
    if (input.dataset && input.dataset.secretCategory && input.dataset.secretField) {
        return {
            category: input.dataset.secretCategory,
            field: input.dataset.secretField,
            id: input.dataset.secretId ? parseInt(input.dataset.secretId, 10) : null
        };
    }
    const id = input.id;
    if (id === "settingsProviderApiKey") {
        const providerId = (typeof settingsState !== "undefined" && settingsState.editingProviderId) ||
            parseInt(typeof document !== "undefined" ? document.getElementById("settingsProviderId")?.value : null, 10);
        return providerId ? { category: "ai_provider", field: "api_key", id: providerId } : null;
    }
    if (id === "settingsProviderBalanceAccessToken") {
        const providerId = (typeof settingsState !== "undefined" && settingsState.editingProviderId) ||
            parseInt(typeof document !== "undefined" ? document.getElementById("settingsProviderId")?.value : null, 10);
        return providerId ? { category: "ai_provider", field: "balance_access_token", id: providerId } : null;
    }
    if (id === "settingsUsageApiKey") {
        const providerId = (typeof currentUsageQueryProviderId !== "undefined" && currentUsageQueryProviderId) ||
            parseInt(typeof document !== "undefined" ? document.getElementById("settingsUsageQueryProviderId")?.value : null, 10) ||
            (typeof settingsState !== "undefined" && settingsState.editingProviderId);
        return providerId ? { category: "usage_query", field: "balance_custom_key", id: providerId } : null;
    }
    if (id === "settingsFirecrawlApiKey") {
        return { category: "crawler", field: "api_key", id: null };
    }
    if (id === "settingsWpAppPassword") {
        const cfgId = (typeof settingsState !== "undefined" && settingsState.activeWpConfigId) ||
            parseInt(typeof document !== "undefined" ? document.getElementById("settingsWpSelect")?.value : null, 10);
        return cfgId ? { category: "storage", field: "wp_app_password", id: cfgId } : null;
    }
    if (id === "settingsShopifyAccessToken") {
        const cfgId = (typeof settingsState !== "undefined" && settingsState.activeShopifyConfigId) ||
            parseInt(typeof document !== "undefined" ? document.getElementById("settingsShopifySelect")?.value : null, 10);
        return cfgId ? { category: "storage", field: "shopify_access_token", id: cfgId } : null;
    }
    if (id === "settingsR2SecretKey") {
        let cfgId = (typeof settingsState !== "undefined" && settingsState.activeR2ConfigId);
        if (!cfgId && typeof getSettingsStorageConfigs === "function") {
            const r2 = getSettingsStorageConfigs().find(c => c.storage_type === "r2");
            cfgId = r2?.id;
        }
        return cfgId ? { category: "storage", field: "r2_secret_key", id: cfgId } : null;
    }
    if (id === "storageWpAppPassword") {
        const cfgId = (typeof activeWpConfigId !== "undefined" && activeWpConfigId) ||
            parseInt(typeof document !== "undefined" ? document.getElementById("wpSiteSelect")?.value : null, 10);
        return cfgId ? { category: "storage", field: "wp_app_password", id: cfgId } : null;
    }
    if (id === "storageShopifyAccessToken") {
        const cfgId = (typeof activeShopifyConfigId !== "undefined" && activeShopifyConfigId) ||
            parseInt(typeof document !== "undefined" ? document.getElementById("shopifyStoreSelect")?.value : null, 10);
        return cfgId ? { category: "storage", field: "shopify_access_token", id: cfgId } : null;
    }
    if (id === "storageR2SecretKey") {
        let cfgId = (typeof activeR2ConfigId !== "undefined" && activeR2ConfigId);
        if (!cfgId && typeof getStorageConfigs === "function") {
            const r2 = getStorageConfigs().find(c => c.storage_type === "r2");
            cfgId = r2?.id;
        }
        return cfgId ? { category: "storage", field: "r2_secret_key", id: cfgId } : null;
    }
    return null;
}

/**
 * 切换密码/密钥输入框明文与掩码状态，若输入框处于留空占位态且存在已保存密钥，则向后端按需拉取真实明文密钥
 * @param {string|HTMLInputElement} inputIdOrEl - 输入框 ID 或 DOM 元素
 * @param {HTMLElement} [toggleBtn] - 触发切换的按钮 DOM 元素
 */
async function togglePasswordVisibility(inputIdOrEl, toggleBtn) {
    const input = typeof inputIdOrEl === "string" ? (typeof document !== "undefined" ? document.getElementById(inputIdOrEl) : null) : inputIdOrEl;
    if (!input) return;

    const isPassword = input.type === "password";

    // 尝试拉取真实密钥：仅当当前是 password 状态（将切为 text）且当前输入框为空（显示已保存 placeholder）
    if (isPassword && !input.value) {
        if (input.dataset && input.dataset.cachedSecret) {
            input.value = input.dataset.cachedSecret;
            input.dataset.isOriginalRevealed = "true";
        } else {
            const meta = resolveSecretMeta(input);
            if (meta) {
                const icon = typeof toggleBtn?.querySelector === "function" ? (toggleBtn.querySelector("i") || toggleBtn) : toggleBtn;
                if (icon) icon.className = "ph ph-spinner animate-spin";
                if (toggleBtn) toggleBtn.disabled = true;

                try {
                    const apiBase = (typeof API_BASE !== "undefined" && API_BASE) ? API_BASE : "http://127.0.0.1:9503";
                    const fetchFn = typeof fetch === "function" ? fetch : (typeof globalThis !== "undefined" ? globalThis.fetch : null);
                    if (fetchFn) {
                        const res = await fetchFn(`${apiBase}/api/settings/secrets/reveal`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(meta),
                        });
                        if (res && res.ok) {
                            const data = await res.json();
                            if (data && data.status === "success" && data.secret) {
                                input.value = data.secret;
                                if (input.dataset) {
                                    input.dataset.cachedSecret = data.secret;
                                    input.dataset.isOriginalRevealed = "true";
                                }
                            }
                        }
                    }
                } catch (err) {
                    console.warn("Failed to reveal secret:", err);
                } finally {
                    if (toggleBtn) toggleBtn.disabled = false;
                }
            }
        }
    } else if (!isPassword) {
        // 当前是 text，切回 password
        // 若当前内容正是未修改过的拉取密钥，切回留空占位态保持干净
        if (input.dataset && input.dataset.isOriginalRevealed === "true" && input.value === input.dataset.cachedSecret) {
            input.value = "";
        }
    }

    input.type = isPassword ? "text" : "password";

    if (toggleBtn) {
        const icon = typeof toggleBtn.querySelector === "function" ? (toggleBtn.querySelector("i") || toggleBtn) : toggleBtn;
        if (icon) {
            icon.className = isPassword ? "ph ph-eye-slash" : "ph ph-eye";
        }
        if (typeof toggleBtn.setAttribute === "function") {
            toggleBtn.setAttribute("title", isPassword ? "隐藏明文密钥" : "显示明文密钥");
            toggleBtn.setAttribute("aria-label", isPassword ? "隐藏明文密钥" : "显示明文密钥");
        }
    }
}

if (typeof globalThis !== 'undefined') {
    globalThis.safeLocalStorageSet = safeLocalStorageSet;
    globalThis.debounce = debounce;
    globalThis.resetAllAppDraftsAndState = resetAllAppDraftsAndState;
    globalThis.togglePasswordVisibility = togglePasswordVisibility;
}
if (typeof window !== 'undefined') {
    window.safeLocalStorageSet = safeLocalStorageSet;
    window.resetAllAppDraftsAndState = resetAllAppDraftsAndState;
    window.togglePasswordVisibility = togglePasswordVisibility;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        ...(module.exports || {}),
        togglePasswordVisibility,
    };
}
