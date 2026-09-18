const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

function loadFrontendModules() {
    const ctx = {
        console,
        setTimeout,
        clearTimeout,
        AbortController,
        addEventListener: () => {},
        removeEventListener: () => {},
        window: {
            addEventListener: () => {},
            removeEventListener: () => {}
        },
        CONCURRENCY_LIMIT: 2,
        STAGGER_DELAY: 50,
        document: {
            getElementById: () => null,
            querySelectorAll: () => [],
            addEventListener: () => {},
            removeEventListener: () => {},
            body: { appendChild: () => {}, removeChild: () => {} }
        }
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);

    const utilsJs = fs.readFileSync(path.join(root, "js", "utils.js"), "utf8");
    vm.runInContext(utilsJs, ctx);

    const configJs = fs.readFileSync(path.join(root, "js", "config.js"), "utf8");
    vm.runInContext(configJs, ctx);

    const detailsJs = fs.readFileSync(path.join(root, "js", "details.js"), "utf8");
    vm.runInContext(detailsJs, ctx);

    return ctx;
}

test("safeExtractAndParseJson handles clean, fenced, prefixed, and trailing comma JSON", () => {
    const ctx = loadFrontendModules();
    const { safeExtractAndParseJson } = ctx;

    // 1. Clean JSON
    const res1 = safeExtractAndParseJson('{"name": "Lamp", "price": 25}');
    assert.equal(res1.name, "Lamp");
    assert.equal(res1.price, 25);

    // 2. Fenced JSON with code blocks
    const res2 = safeExtractAndParseJson('```json\n{"title": "Water Bottle"}\n```');
    assert.equal(res2.title, "Water Bottle");

    // 3. Conversational prefix and suffix
    const conversational = "Here is the parsed metadata for your product:\n```json\n{\"seo\": \"best-chair\", \"active\": true}\n```\nHope this helps!";
    const res3 = safeExtractAndParseJson(conversational);
    assert.equal(res3.seo, "best-chair");
    assert.equal(res3.active, true);

    // 4. Trailing commas repair
    const trailingCommaJson = '{"items": ["a", "b",], "done": false,}';
    const res4 = safeExtractAndParseJson(trailingCommaJson);
    assert.deepEqual(Array.from(res4.items), ["a", "b"]);
    assert.equal(res4.done, false);

    // 5. Empty or invalid input
    assert.throws(() => safeExtractAndParseJson(""), /AI 返回内容为空/);
    assert.throws(() => safeExtractAndParseJson("Just plain text with no json"), /未能从 AI 响应中解析出结构化 JSON/);
});

test("buildModuleGenerationPrompt front-loads focalFeature directly into IMAGE TASK", () => {
    const ctx = loadFrontendModules();
    const task = {
        id: "m2",
        title: "核心功能证明",
        promptTitle: "Core Benefit Proof",
        prompt: "Showcase waterproof IPX8",
        focalFeature: "IPX8 级深度防水与纳米涂层",
        visualDirective: "Underwater submersion with clear air bubbles",
        role: "证明商品在水下仍能正常运行"
    };
    const prompt = ctx.buildModuleGenerationPrompt(task, "Product selling points", {});

    assert.match(prompt, /PRIMARY VISUAL FOCUS \(CRITICAL\): Feature and visualize "IPX8 级深度防水与纳米涂层"/);
    const primaryFocusIndex = prompt.indexOf("PRIMARY VISUAL FOCUS");
    const marketStyleIndex = prompt.indexOf("MARKET AND STYLE");
    assert.ok(primaryFocusIndex !== -1, "Primary visual focus must be present");
    assert.ok(primaryFocusIndex < marketStyleIndex, "Focal feature must be front-loaded before MARKET AND STYLE");
});

test("generateDtcSectionCopy prompt contains no hardcoded mock dollar prices", async () => {
    const ctx = loadFrontendModules();
    let capturedPrompt = "";
    ctx.callAI = async (cap, payload) => {
        capturedPrompt = payload?.contents?.[0]?.parts?.[0]?.text || "";
        return {
            candidates: [{
                content: {
                    parts: [{ text: JSON.stringify({ tagline: "VALUE", headline: "Bundle" }) }]
                }
            }]
        };
    };

    const bundleTask = {
        id: "m14",
        title: "组合超值算账对比",
        promptTitle: "Bundle Value and Savings Comparison",
        focalFeature: "一站式全套省心",
        role: "量化套装性价比"
    };

    await ctx.generateDtcSectionCopy(bundleTask, "Key selling points", {});
    assert.ok(!capturedPrompt.includes("$129.99"), "Prompt must not contain hardcoded $129.99");
    assert.ok(!capturedPrompt.includes("$79.99"), "Prompt must not contain hardcoded $79.99");
    assert.ok(capturedPrompt.includes("STRICT PRICING RULE"), "Prompt must enforce strict pricing rule");
});

test("translate.js translateSingleImageToLang prompt enforces pixel-faithful invariants", () => {
    const code = fs.readFileSync(path.join(root, "js", "translate.js"), "utf8");
    assert.ok(code.includes("ZERO PRODUCT MODIFICATION"), "Translate prompt must enforce ZERO PRODUCT MODIFICATION");
    assert.ok(code.includes("TYPOGRAPHY INPAINTING & LOCALIZATION"), "Translate prompt must enforce typography inpainting");
    assert.ok(!code.includes("Completely redraw the image. Do NOT return the original image"), "Translate prompt must not instruct complete redraw");
});

test("buildProductLockPrompt strictly enforces zero-drift mandate, anti-morphing, and feature boundaries", () => {
    const ctx = loadFrontendModules();

    // 单品模式
    const singleLock = ctx.buildProductLockPrompt({ productType: 'single' });
    assert.ok(singleLock.includes("STRICT ZERO-DRIFT MANDATE (PHYSICAL INVARIANT)"), "Must include strict zero-drift mandate");
    assert.ok(singleLock.includes("100% IDENTICAL"), "Must require 100% identical reproduction");
    assert.ok(singleLock.includes("ABSOLUTE PROHIBITION ON PRODUCT MORPHING"), "Must prohibit product morphing");
    assert.ok(singleLock.includes("FEATURE VISUALIZATION BOUNDARY"), "Must set feature visualization boundary");
    assert.ok(singleLock.includes("NEVER modify or distort the physical product itself"), "Must prohibit modifying product to illustrate features");

    // 套装模式
    const bundleLock = ctx.buildProductLockPrompt({ productType: 'bundle' });
    assert.ok(bundleLock.includes("STRICT KIT ZERO-DRIFT POLICY"), "Must include strict kit zero-drift policy");
    assert.ok(bundleLock.includes("Under no circumstance may any item in the kit be altered"), "Must prohibit altering kit items");
});

test("buildModuleGenerationPrompt front-loads product consistency and seals with HARD RULES and repaint defense", () => {
    const ctx = loadFrontendModules();
    const task = {
        id: "m2",
        title: "核心功能证明",
        promptTitle: "Core Benefit Proof",
        prompt: "Showcase fast wireless charging with glowing aura",
        focalFeature: "15W 磁吸快充与冰感降温",
        role: "证明充电迅速且不发烫"
    };

    // 默认出图
    const normalPrompt = ctx.buildModuleGenerationPrompt(task, "Selling points text", {});
    assert.ok(normalPrompt.includes("Consistency Mandate: The product in this image MUST be 100% IDENTICAL"), "Must front-load consistency mandate in IMAGE TASK");
    assert.ok(normalPrompt.includes("STRICT PRODUCT FIDELITY (IMMUTABLE)"), "Must seal with immutable product fidelity in HARD RULES");

    // 带重绘提示词
    const repaintPrompt = ctx.buildModuleGenerationPrompt(task, "Selling points text", {}, "把底座换成带提手的支架");
    assert.ok(repaintPrompt.includes("NEVER alter or redesign the physical product itself"), "Repaint rule must strictly defend physical product identity");
});

test("index.html contains strictProductLockToggle with zero-drift constraint badge", () => {
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    assert.ok(html.includes('id="strictProductLockToggle"'), "index.html must contain strictProductLockToggle");
    assert.ok(html.includes("严格锁定商品一致性"), "index.html must display product consistency label");
    assert.ok(html.includes("零变形约束"), "index.html must display zero-drift constraint badge");
});

test("matchImageStyleForProduct accurately infers visual style and layout style across diverse categories", () => {
    const ctx = loadFrontendModules();
    const { matchImageStyleForProduct } = ctx;
    assert.equal(typeof matchImageStyleForProduct, "function");

    // 1. 3C数码 / 无人机 / 智能硬件
    const droneResult = matchImageStyleForProduct("4K HD Foldable GPS Drone with obstacle avoidance");
    assert.equal(droneResult.label, "Apple Keynote 极简发布会风");
    assert.equal(droneResult.layoutStyle, "minimalist");

    // 2. 奢华精工机械 / 腕表
    const watchResult = matchImageStyleForProduct("Luxury Skeleton Mechanical Tourbillon Watch Titanium");
    assert.equal(watchResult.label, "奢华精工机械透视风");
    assert.equal(watchResult.layoutStyle, "technical");

    // 3. 美妆个护
    const beautyResult = matchImageStyleForProduct("Hydrating Anti-aging Face Serum and Moisturizing Cream");
    assert.equal(beautyResult.label, "美妆个护高级风");
    assert.equal(beautyResult.layoutStyle, "lookbook");

    // 4. 健康护理
    const healthResult = matchImageStyleForProduct("Deep Tissue Percussion Massager Gun for Muscle Relief");
    assert.equal(healthResult.label, "健康护理克制风");
    assert.equal(healthResult.layoutStyle, "editorial");

    // 5. 运动健身
    const fitnessResult = matchImageStyleForProduct("Under Desk Walking Pad Treadmill for Home Office");
    assert.equal(fitnessResult.label, "运动健身专业风");
    assert.equal(fitnessResult.layoutStyle, "editorial");

    // 6. 户外硬核装备
    const outdoorResult = matchImageStyleForProduct("Ultralight Waterproof 4-Season Camping Tent with Backpack");
    assert.equal(outdoorResult.label, "户外硬核装备风");
    assert.equal(outdoorResult.layoutStyle, "editorial");

    // 7. 家居生活
    const homeResult = matchImageStyleForProduct("Modern Minimalist Fabric Sofa and Coffee Table Living Room");
    assert.equal(homeResult.label, "家居场景实拍风");
    assert.equal(homeResult.layoutStyle, "bento");

    // 8. 默认回退
    const defaultResult = matchImageStyleForProduct("");
    assert.equal(defaultResult.label, "Shopify高级生活方式风");
    assert.equal(defaultResult.layoutStyle, "editorial");
});

test("applyRecommendedStyle updates select dropdown, shows AI badge, and syncs layout template", () => {
    const ctx = loadFrontendModules();

    const mockElements = {
        imageStyleSelect: { value: '' },
        aiMatchedStyleBadge: {
            classList: {
                _classes: new Set(['hidden']),
                add(c) { this._classes.add(c); },
                remove(c) { this._classes.delete(c); },
                contains(c) { return this._classes.has(c); }
            },
            title: '',
            textContent: ''
        },
        resultStyleSelect: { value: 'editorial' },
        customImageStyleContainer: {
            classList: {
                _classes: new Set(['hidden']),
                add(c) { this._classes.add(c); },
                remove(c) { this._classes.delete(c); },
                toggle(c, force) { if (force) this._classes.add(c); else this._classes.delete(c); }
            }
        }
    };

    ctx.document.getElementById = (id) => mockElements[id] || null;

    // Apply 3C Drone style
    const matched = ctx.applyRecommendedStyle("Apple Keynote 极简发布会风", "无人机 4K 航拍");
    assert.ok(matched);
    assert.equal(matched.label, "Apple Keynote 极简发布会风");
    assert.equal(mockElements.imageStyleSelect.value, matched.value);
    assert.ok(!mockElements.aiMatchedStyleBadge.classList.contains('hidden'), "Badge must not be hidden");
    assert.ok(mockElements.aiMatchedStyleBadge.textContent.includes("Apple Keynote 极简发布会风"));
    assert.equal(mockElements.resultStyleSelect.value, "minimalist", "Layout template must sync to minimalist");
});

test("buildSellingPointsExtractionPrompt requests recommended_image_style and parser extracts it", () => {
    const ctx = loadFrontendModules();
    const prompt = ctx.buildSellingPointsExtractionPrompt(1, "", "", "TWS Wireless Earbuds", "English");
    assert.ok(prompt.includes('"recommended_image_style"'), "Prompt must request recommended_image_style field");

    const parsed = ctx.parseSellingPointsResponse(JSON.stringify({
        product_name: "TWS Earbuds",
        selling_points: "Great sound",
        product_facts: "Bluetooth 5.3",
        forbidden_claims: "No water damage",
        recommended_image_style: "Apple Keynote 极简发布会风"
    }));
    assert.equal(parsed.recommendedImageStyle, "Apple Keynote 极简发布会风");
});

test("Toolbar dropdown handlers correctly toggle and hide menus", () => {
    const ctx = loadFrontendModules();

    const mockMenus = {
        mediaExportDropdownMenu: {
            classList: {
                _classes: new Set(['hidden']),
                add(c) { this._classes.add(c); },
                remove(c) { this._classes.delete(c); },
                toggle(c) { if (this._classes.has(c)) this._classes.delete(c); else this._classes.add(c); },
                contains(c) { return this._classes.has(c); }
            }
        },
        codeExportDropdownMenu: {
            classList: {
                _classes: new Set(['hidden']),
                add(c) { this._classes.add(c); },
                remove(c) { this._classes.delete(c); },
                toggle(c) { if (this._classes.has(c)) this._classes.delete(c); else this._classes.add(c); },
                contains(c) { return this._classes.has(c); }
            }
        }
    };

    ctx.document.getElementById = (id) => mockMenus[id] || null;

    // Toggle Media Dropdown
    ctx.toggleMediaDropdown();
    assert.ok(!mockMenus.mediaExportDropdownMenu.classList.contains('hidden'), "Media menu should be open");
    assert.ok(mockMenus.codeExportDropdownMenu.classList.contains('hidden'), "Code menu should be closed");

    // Toggle Code Dropdown
    ctx.toggleCodeDropdown();
    assert.ok(mockMenus.mediaExportDropdownMenu.classList.contains('hidden'), "Media menu should be closed");
    assert.ok(!mockMenus.codeExportDropdownMenu.classList.contains('hidden'), "Code menu should be open");

    // Hide all
    ctx.hideAllToolbarDropdowns();
    assert.ok(mockMenus.mediaExportDropdownMenu.classList.contains('hidden'), "Media menu should be hidden");
    assert.ok(mockMenus.codeExportDropdownMenu.classList.contains('hidden'), "Code menu should be hidden");
});

test("index.html contains two-tier result toolbar and dedicated visual style selector with badge", () => {
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

    // Sidebar style selector
    assert.ok(html.includes('id="imageStyleSelect"'), "index.html must contain imageStyleSelect");
    assert.ok(html.includes('id="aiMatchedStyleBadge"'), "index.html must contain aiMatchedStyleBadge");
    assert.ok(html.includes("画面风格 (AI 视觉生成)"), "Sidebar label must clearly indicate AI visual generation");

    // Toolbar tier 2 dropdowns
    assert.ok(html.includes('id="mediaExportDropdownContainer"'), "index.html must contain mediaExportDropdownContainer");
    assert.ok(html.includes('id="mediaExportDropdownMenu"'), "index.html must contain mediaExportDropdownMenu");
    assert.ok(html.includes('id="codeExportDropdownContainer"'), "index.html must contain codeExportDropdownContainer");
    assert.ok(html.includes('id="codeExportDropdownMenu"'), "index.html must contain codeExportDropdownMenu");
    assert.ok(html.includes('id="btnExportLaunchKit"'), "index.html must retain btnExportLaunchKit");

    // Retry failed images UI elements
    assert.ok(html.includes('id="btnRetryFailedToolbar"'), "index.html must contain btnRetryFailedToolbar");
    assert.ok(html.includes('id="detailFailureAlertBar"'), "index.html must contain detailFailureAlertBar");
    assert.ok(html.includes('id="btnRetryFailedImages"'), "index.html must contain btnRetryFailedImages");
});

test("getFailedModuleTasks accurately filters out success tasks and isolates failed/cancelled/missing tasks", () => {
    const ctx = loadFrontendModules();
    const { getFailedModuleTasks } = ctx;

    ctx.globalGenContext = {
        tasks: {
            m1_0: { uniqueId: 'm1_0', id: 'm1', title: 'Hero', status: 'success', imageSrc: 'data:image/png;base64,valid' },
            m2_0: { uniqueId: 'm2_0', id: 'm2', title: 'Feature', status: 'error', error: 'Network timeout', imageSrc: '' },
            m3_0: { uniqueId: 'm3_0', id: 'm3', title: 'Scene', status: 'cancelled', imageSrc: '' },
            m4_0: { uniqueId: 'm4_0', id: 'm4', title: 'Specs', status: 'fallback', isFallback: true, imageSrc: 'data:image/png;base64,mock' }
        }
    };

    const failed = getFailedModuleTasks();
    assert.equal(failed.length, 3, "Must identify exactly 3 failed/cancelled/fallback tasks");
    assert.equal(failed.map(t => t.uniqueId).join(','), 'm2_0,m3_0,m4_0');
});

test("updateDetailFailureUI syncs toolbar retry button and failure alert bar correctly", () => {
    const ctx = loadFrontendModules();

    const mockElements = {
        btnRetryFailedToolbar: {
            classList: {
                _classes: new Set(['hidden']),
                add(c) { this._classes.add(c); },
                remove(c) { this._classes.delete(c); },
                contains(c) { return this._classes.has(c); }
            }
        },
        btnRetryFailedToolbarText: { textContent: '' },
        detailFailureAlertBar: {
            classList: {
                _classes: new Set(['hidden']),
                add(c) { this._classes.add(c); },
                remove(c) { this._classes.delete(c); },
                contains(c) { return this._classes.has(c); }
            },
            dataset: {}
        },
        detailFailureAlertMsg: { textContent: '' }
    };

    ctx.document.getElementById = (id) => mockElements[id] || null;

    // 1. With failed tasks
    ctx.globalGenContext = {
        tasks: {
            m1_0: { uniqueId: 'm1_0', status: 'success', imageSrc: 'data:image/png;base64,valid' },
            m2_0: { uniqueId: 'm2_0', status: 'error', imageSrc: '' },
            m3_0: { uniqueId: 'm3_0', status: 'cancelled', imageSrc: '' }
        }
    };

    ctx.updateDetailFailureUI();
    assert.ok(!mockElements.btnRetryFailedToolbar.classList.contains('hidden'), "Toolbar retry button must be shown");
    assert.equal(mockElements.btnRetryFailedToolbarText.textContent, "重试失败图片 (2)");
    assert.ok(!mockElements.detailFailureAlertBar.classList.contains('hidden'), "Alert bar must be shown");
    assert.ok(mockElements.detailFailureAlertMsg.textContent.includes("2 张模块图片"));

    // 2. Dismiss alert bar
    ctx.dismissDetailFailureAlert();
    assert.ok(mockElements.detailFailureAlertBar.classList.contains('hidden'), "Alert bar should be dismissed");
    assert.equal(mockElements.detailFailureAlertBar.dataset.dismissed, "true");

    // 3. When all tasks succeed
    ctx.globalGenContext.tasks.m2_0.status = 'success';
    ctx.globalGenContext.tasks.m2_0.imageSrc = 'data:image/png;base64,new';
    ctx.globalGenContext.tasks.m3_0.status = 'success';
    ctx.globalGenContext.tasks.m3_0.imageSrc = 'data:image/png;base64,new2';

    ctx.updateDetailFailureUI();
    assert.ok(mockElements.btnRetryFailedToolbar.classList.contains('hidden'), "Toolbar retry button must hide when 0 failures");
    assert.ok(mockElements.detailFailureAlertBar.classList.contains('hidden'), "Alert bar must hide when 0 failures");
});

test("retryFailedModuleImages retries ONLY the failed tasks and preserves successful ones", async () => {
    const ctx = loadFrontendModules();

    const retriedTaskIds = [];
    ctx.generateSingleWrap = async (uniqueId) => {
        retriedTaskIds.push(uniqueId);
        const task = ctx.globalGenContext.tasks[uniqueId];
        task.status = 'success';
        task.imageSrc = 'data:image/png;base64,retried_success';
        return { status: 'success', task };
    };

    const toasts = [];
    ctx.showToast = (msg, type) => toasts.push({ msg, type });

    ctx.globalGenContext = {
        tasks: {
            m1_0: { uniqueId: 'm1_0', title: 'Hero', status: 'success', imageSrc: 'data:image/png;base64,already_good' },
            m2_0: { uniqueId: 'm2_0', title: 'Feature', status: 'error', imageSrc: '' },
            m3_0: { uniqueId: 'm3_0', title: 'Scene', status: 'cancelled', imageSrc: '' }
        }
    };

    await ctx.retryFailedModuleImages();

    // Verify only m2_0 and m3_0 were retried
    assert.deepEqual(retriedTaskIds, ['m2_0', 'm3_0'], "Must only retry the failed tasks");

    // Verify m1_0 was not touched
    assert.equal(ctx.globalGenContext.tasks.m1_0.imageSrc, 'data:image/png;base64,already_good');

    // Verify all are now success
    assert.equal(ctx.getFailedModuleTasks().length, 0);
    assert.ok(toasts.some(t => t.msg.includes("所有失败图片已全部成功恢复生成")), "Must report full recovery");
});
