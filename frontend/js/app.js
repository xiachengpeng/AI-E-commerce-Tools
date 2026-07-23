/**
 * 全局应用逻辑
 */

let TEXT_ROUTE = {
    capability: "text",
    name: null,
    protocol: null,
    model: null
};
let IMAGE_ROUTE = {
    capability: "image",
    name: null,
    protocol: null,
    model: null
};

let CONCURRENCY_LIMIT = 2;
let STAGGER_DELAY = 2000;

let currentUploadedBase64 = null;
let currentUploadedImages = [];
let currentListingUploadedBase64 = null;
let globalGenContext = null; 
let currentListingDataText = null; 
let draggedItem = null;
let detailStrategyOverrides = {};

const modules = MODULES_CONFIG.map(m => ({ ...m }));

/**
 * 从后端加载配置
 */
async function loadConfig() {
    console.log("[System] Loading config from backend...");
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000); // 3s timeout

        const res = await fetch(`${API_BASE}/config`, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        const cfg = await res.json();
        TEXT_ROUTE = cfg.TEXT_ROUTE || TEXT_ROUTE;
        IMAGE_ROUTE = cfg.IMAGE_ROUTE || IMAGE_ROUTE;
        
        if (cfg.CONCURRENCY_LIMIT) CONCURRENCY_LIMIT = cfg.CONCURRENCY_LIMIT;
        if (cfg.STAGGER_DELAY) STAGGER_DELAY = cfg.STAGGER_DELAY;
        
        const routeLabel = route => (
            route?.name && route?.model
                ? `${route.name} / ${route.model}`
                : "未配置"
        );
        const logMsg = `配置加载成功 | 文本: ${routeLabel(TEXT_ROUTE)} | 图片: ${routeLabel(IMAGE_ROUTE)}`;
        console.log(`%c[系统] ${logMsg}`, "color: #10b981; font-weight: bold;");
        remoteLog(logMsg);
    } catch (e) {
        console.warn("⚠️ 无法加载后端配置 (使用本地默认值):", e.message);
    }
}

/**
 * 统一 AI 调用封装
 */
async function callAI(capability, payload) {
    const route = capability === "image" ? IMAGE_ROUTE : TEXT_ROUTE;
    const routeName = (
        route?.name && route?.model
            ? `${route.name} / ${route.model}`
            : `${capability} 路由未配置`
    );
    const logMsg = `正在调用: ${routeName}`;
    console.log(`%c[AI请求] ${logMsg}`, "color: #0891b2; font-weight: bold;");
    remoteLog(logMsg);

    return await fetchWithRetry(`${API_BASE}/api/ai/generate`, {
        method: 'POST',
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability, payload })
    });
}

/**
 * 切换主标签页
 * @param {string} tabId 标签唯一标识
 */
function switchMainTab(tabId) {
    // 1. 记录状态到本地存储
    localStorage.setItem('activeMainTab', tabId);

    if (tabId !== "settings" && typeof disconnectSettingsLogs === "function") {
        disconnectSettingsLogs();
    }
    
    // 2. 更新侧边栏 UI (通过 ID 精准匹配)
    document.querySelectorAll('.side-tab').forEach(item => {
        if (item.id === `tab-${tabId}`) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });

    // 3. 隐藏所有以 view- 开头的视图容器，并显示目标视图
    document.querySelectorAll('div[id^="view-"]').forEach(view => {
        view.classList.add('hidden');
        view.style.display = 'none'; // 双重保险
    });
    
    const targetView = document.getElementById(`view-${tabId}`);
    if (targetView) {
        targetView.classList.remove('hidden');
        targetView.style.display = 'flex'; // 恢复布局
    }
    
    if (tabId === 'analysis' && typeof xp_init === 'function') {
        xp_init();
    }

    if (tabId === "settings" && typeof initSettings === "function") {
        initSettings();
    }
    if (tabId === "settings" && typeof connectSettingsLogs === "function") {
        connectSettingsLogs();
    }
}

/**
 * 页面初始化
 */
window.onload = async () => {
    console.log("[System] window.onload triggered");
    await loadConfig();
    
    console.log("[System] Initializing UI components...");
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
    fillSelect('listingLanguageSelect', LANGUAGE_OPTIONS);
    fillSelect('adsMarketingThemeSelect', MARKETING_THEMES);
    fillSelect('adsRegionSelect', REGION_OPTIONS);
    fillSelect('adsLanguageSelect', LANGUAGE_OPTIONS);

    console.log("[System] Initializing modules...");
    if (typeof toggleCustomImageStyle === 'function') toggleCustomImageStyle();
    if (typeof initModules === 'function') initModules();
    if (typeof initTransLangTags === 'function') initTransLangTags();
    if (typeof initListingControls === 'function') initListingControls();
    if (typeof initAdsControls === 'function') initAdsControls();
    if (typeof initSquareRedrawControls === 'function') initSquareRedrawControls();
    if (typeof loadHistoryToList === 'function') loadHistoryToList();
    
    console.log("[System] Switching to initial tab...");
    const lastTab = localStorage.getItem('activeMainTab') || 'analysis';
    switchMainTab(lastTab);
    console.log("%c[System] App Ready", "color: #10b981; font-weight: bold;");
};
