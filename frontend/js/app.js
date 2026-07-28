/**
 * 全局应用逻辑
 */

let TEXT_ROUTE = null;
let IMAGE_ROUTE = null;
let PUBLIC_AI_ROUTES_LOADED = false;

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
 * 从后端刷新公开 AI 路由。
 */
async function refreshPublicAIRoutes() {
    console.log("[System] Loading config from backend...");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    try {
        const res = await fetch(`${API_BASE}/config`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const cfg = await res.json();
        TEXT_ROUTE = cfg?.TEXT_ROUTE || null;
        IMAGE_ROUTE = cfg?.IMAGE_ROUTE || null;
        PUBLIC_AI_ROUTES_LOADED = true;

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
        return { TEXT_ROUTE, IMAGE_ROUTE };
    } catch (error) {
        PUBLIC_AI_ROUTES_LOADED = false;
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * 首次加载配置失败时保留安全的未配置状态。
 */
async function loadConfig() {
    try {
        return await refreshPublicAIRoutes();
    } catch (_error) {
        console.warn("⚠️ 无法加载后端配置，请检查后端连接后重试");
        return null;
    }
}

function unconfiguredAIRouteMessage(capability) {
    const label = capability === "image" ? "图片" : "文本";
    return `${label} AI 未配置，请前往设置页面配置`;
}

async function currentPublicAIRoute(capability) {
    let route = capability === "image" ? IMAGE_ROUTE : TEXT_ROUTE;
    if (!PUBLIC_AI_ROUTES_LOADED || !route?.name || !route?.model) {
        try {
            await refreshPublicAIRoutes();
        } catch (_error) {
            throw new Error("无法获取 AI 路由配置，请检查后端连接后重试");
        }
        route = capability === "image" ? IMAGE_ROUTE : TEXT_ROUTE;
    }
    if (!route?.name || !route?.model) {
        throw new Error(unconfiguredAIRouteMessage(capability));
    }
    return route;
}

async function safeAIRouteConflictError(response, capability) {
    let data = {};
    try {
        data = await response.json();
    } catch (_error) {
        data = {};
    }
    const expected = unconfiguredAIRouteMessage(capability);
    const message = data?.detail === expected
        ? expected
        : "AI 路由配置不可用，请前往设置页面检查";
    return new Error(message);
}

/**
 * 统一 AI 调用封装
 */
async function callAI(capability, payload) {
    const route = await currentPublicAIRoute(capability);
    const logMsg = `正在调用模型: ${route.model} (${route.name})`;
    console.log(`%c[AI请求] ${logMsg}`, "color: #0891b2; font-weight: bold;");
    remoteLog(logMsg);

    return await fetchWithRetry(`${API_BASE}/api/ai/generate`, {
        method: 'POST',
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability, payload })
    }, 5, {
        nonRetryableStatuses: [409],
        createError: response => safeAIRouteConflictError(
            response,
            capability
        )
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
    if (tabId === "watermark-removal" && typeof initWatermarkRemoval === "function") {
        initWatermarkRemoval();
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
    if (typeof initWatermarkRemoval === 'function') initWatermarkRemoval();
    if (typeof loadHistoryToList === 'function') loadHistoryToList();
    
    console.log("[System] Switching to initial tab...");
    const lastTab = localStorage.getItem('activeMainTab') || 'analysis';
    switchMainTab(lastTab);
    console.log("%c[System] App Ready", "color: #10b981; font-weight: bold;");
};
