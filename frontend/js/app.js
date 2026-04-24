/**
 * 全局应用逻辑
 */

let API_KEY = "";
let TEXT_MODEL  = "";
let IMAGE_MODEL = "";
let AI_PROVIDER = "gemini";
let ACCESS_TOKEN = "";
let PROJECT_ID = "";
let LOCATION = "";

let CONCURRENCY_LIMIT = 2;
let STAGGER_DELAY = 2000;

let currentUploadedBase64 = null;
let currentListingUploadedBase64 = null;
let globalGenContext = null; 
let currentListingDataText = null; 
let draggedItem = null;

const modules = MODULES_CONFIG.map(m => ({ ...m }));

/**
 * 从后端加载配置
 */
async function loadConfig() {
    try {
        const res = await fetch(`${API_BASE}/config`);
        const cfg = await res.json();
        API_KEY      = cfg.API_KEY;
        TEXT_MODEL   = cfg.TEXT_MODEL;
        IMAGE_MODEL  = cfg.IMAGE_MODEL;
        AI_PROVIDER  = cfg.AI_PROVIDER || "gemini";
        ACCESS_TOKEN = cfg.ACCESS_TOKEN || "";
        PROJECT_ID   = cfg.PROJECT_ID || "";
        LOCATION     = cfg.LOCATION || "";
        
        if (cfg.CONCURRENCY_LIMIT) CONCURRENCY_LIMIT = cfg.CONCURRENCY_LIMIT;
        if (cfg.STAGGER_DELAY) STAGGER_DELAY = cfg.STAGGER_DELAY;
        
        const logMsg = `配置加载成功 | 平台: ${AI_PROVIDER} | 模型: ${TEXT_MODEL} | 并发限制: ${CONCURRENCY_LIMIT} | 启动间隔: ${STAGGER_DELAY}ms`;
        console.log(`%c[系统] ${logMsg}`, "color: #4f46e5; font-weight: bold;");
        remoteLog(logMsg);
    } catch (e) {
        console.error("❌ 无法加载后端配置:", e);
    }
}

/**
 * 统一 AI 调用封装
 */
async function callAI(modelId, payload) {
    const logMsg = `正在调用模型: ${modelId} (${AI_PROVIDER})`;
    console.log(`%c[AI请求] ${logMsg}`, "color: #0891b2; font-weight: bold;");
    remoteLog(logMsg);
    let url = "";
    let headers = { "Content-Type": "application/json" };

    if (AI_PROVIDER === "vertex") {
        url = `https://aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${modelId}:generateContent`;
        headers["Authorization"] = `Bearer ${ACCESS_TOKEN}`;
    } else {
        url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${API_KEY}`;
    }

    return await fetchWithRetry(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload)
    });
}

/**
 * 主视图切换
 */
function switchMainTab(tab) {
    ['generate', 'translate', 'listing', 'xuanpin'].forEach(t => {
        const btn = document.getElementById(`tab-${t}`);
        const view = document.getElementById(`view-${t}`);
        if (btn) btn.classList.toggle('active', t === tab);
        if (view) {
            if (t === tab) {
                view.classList.remove('hidden');
                view.style.display = 'flex';
            } else {
                view.style.display = 'none';
                view.classList.add('hidden');
            }
        }
    });
    if (tab === 'xuanpin' && typeof xp_init === 'function') {
        xp_init();
    }
}

/**
 * 页面初始化
 */
window.onload = async () => {
    await loadConfig();
    const fillSelect = (id, options) => {
        const sel = document.getElementById(id);
        if (!sel) return;
        options.forEach(opt => { const el = document.createElement('option'); el.value = opt.value; el.innerHTML = opt.label; sel.appendChild(el); });
    };
    
    fillSelect('imageStyleSelect',  IMAGE_STYLE_OPTIONS);
    fillSelect('platformSelect',    PLATFORM_OPTIONS);
    fillSelect('regionSelect',      REGION_OPTIONS);
    fillSelect('languageSelect',    LANGUAGE_OPTIONS);
    fillSelect('aspectRatioSelect', ASPECT_RATIO_OPTIONS);
    fillSelect('marketingThemeSelect', MARKETING_THEMES);
    fillSelect('listingStyleSelect', LISTING_STYLE_OPTIONS);
    
    fillSelect('listingMarketingThemeSelect', MARKETING_THEMES);
    fillSelect('listingRegionSelect', REGION_OPTIONS);

    if (typeof initModules === 'function') initModules();
    if (typeof initTransLangTags === 'function') initTransLangTags();
    if (typeof loadHistoryToList === 'function') loadHistoryToList();
    
    switchMainTab('generate');
};
