const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("index.html contains universal uploader modal and script tag", () => {
    assert.match(indexHtml, /id="universalUploaderModal"/);
    assert.match(indexHtml, /id="univUploadWebpToggle"/);
    assert.match(indexHtml, /id="univUploadQuality"/);
    assert.match(indexHtml, /id="univUploadTitle"/);
    assert.match(indexHtml, /id="univUploadAltText"/);
    assert.match(indexHtml, /id="univUploadFilename"/);
    assert.match(indexHtml, /id="univResultUrlInput"/);
    assert.match(indexHtml, /id="btnUnivStartUpload"/);
    assert.match(indexHtml, /src="js\/universal_uploader\.js"/);
});

test("index.html contains upload-to-cloud buttons in generation modules", () => {
    // 尺寸重绘 (Square/Size redraw)
    assert.match(indexHtml, /id="squareRedrawBatchUploadBtn"/);
    assert.match(indexHtml, /id="squareRedrawUploadToStorageBtn"/);

    // AI 消除 (Watermark removal)
    assert.match(indexHtml, /id="watermarkRemovalUploadCloud"/);

    // 图片翻译 (Image translate)
    assert.match(indexHtml, /id="transBatchUploadBtn"/);

    // 详情页灯箱 (Details lightbox)
    assert.match(indexHtml, /id="lightboxUploadBtn"/);
});

function createUniversalUploaderContext(customConfigs = []) {
    const elements = {};
    function getOrCreate(id) {
        if (!elements[id]) {
            const classSet = new Set();
            elements[id] = {
                id,
                value: "",
                textContent: "",
                innerHTML: "",
                src: "",
                href: "",
                hidden: false,
                disabled: false,
                checked: false,
                classList: {
                    add: (...cls) => cls.forEach(c => classSet.add(c)),
                    remove: (...cls) => cls.forEach(c => classSet.delete(c)),
                    contains: (c) => classSet.has(c),
                    toggle: (c, force) => {
                        if (force === undefined) {
                            if (classSet.has(c)) classSet.delete(c);
                            else classSet.add(c);
                        } else if (force) {
                            classSet.add(c);
                        } else {
                            classSet.delete(c);
                        }
                    }
                },
                appendChild: (child) => {},
                addEventListener: () => {},
                setAttribute: () => {},
                removeAttribute: () => {},
                focus: () => {},
                getContext: () => ({
                    arc() {}, beginPath() {}, clearRect() {}, drawImage() {}, fill() {}, fillRect() {},
                    restore() {}, save() {}, setLineDash() {}, stroke() {}, strokeRect() {}
                }),
                getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 800 })
            };
        }
        return elements[id];
    }

    let lastToast = null;
    const fetchCalls = [];

    const defaultConfigs = customConfigs.length > 0 ? customConfigs : [
        { id: 1, storage_type: "r2", enabled: true, r2_bucket_name: "test-bucket", r2_public_url: "https://cdn.example.com" },
        { id: 2, storage_type: "shopify", enabled: true, name: "US Store", shopify_shop_domain: "mystore.myshopify.com" },
        { id: 3, storage_type: "wordpress", enabled: true, name: "Blog WP", wp_url: "https://myblog.com" }
    ];

    const ctx = {
        console,
        API_BASE: "http://localhost:9503",
        URL: {
            createObjectURL: () => "blob:mock-object-url",
            revokeObjectURL: () => {}
        },
        document: {
            getElementById: (id) => getOrCreate(id),
            querySelector: (sel) => {
                if (sel.startsWith("#")) return getOrCreate(sel.slice(1));
                return null;
            },
            querySelectorAll: () => [],
            createElement: (tag) => {
                const el = getOrCreate(`created_${tag}_${Math.random().toString(36).slice(2, 6)}`);
                el.tagName = tag.toUpperCase();
                return el;
            }
        },
        showToast: (msg, type) => { lastToast = { msg, type }; },
        switchMainTab: () => {},
        switchSettingsTab: () => {},
        requestAnimationFrame: (cb) => cb(),
        cancelAnimationFrame: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        setTimeout,
        clearTimeout,
        Image: class {
            constructor() {
                this.naturalWidth = 800;
                this.naturalHeight = 800;
                this._src = "";
            }
            set src(val) {
                this._src = val;
                setTimeout(() => { if (this.onload) this.onload(); }, 2);
            }
            get src() {
                return this._src;
            }
        },
        FileReader: class {
            readAsDataURL(blob) {
                this.result = blob?.dataUrl || "data:image/png;base64,c291cmNl";
                this.onload?.();
            }
        },
        navigator: {
            clipboard: {
                writeText: async (text) => { ctx._copiedText = text; }
            }
        },
        fetch: async (url, opts = {}) => {
            fetchCalls.push({ url, opts });
            if (url.includes("/api/storage/configs")) {
                return {
                    ok: true,
                    json: async () => defaultConfigs
                };
            }
            if (url.includes("/api/storage/upload-image")) {
                const body = JSON.parse(opts.body || "{}");
                return {
                    ok: true,
                    json: async () => ({
                        success: true,
                        remote_url: `https://cdn.example.com/uploads/${body.filename || "test.webp"}`,
                        storage_type: body.storage_type,
                        filename: body.filename
                    })
                };
            }
            return {
                ok: true,
                blob: async () => ({ dataUrl: "data:image/png;base64,c291cmNl" }),
                json: async () => ({})
            };
        }
    };

    ctx.window = ctx;
    ctx.globalThis = ctx;

    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(root, "js", "universal_uploader.js"), "utf8"), ctx);

    return { ctx, elements, fetchCalls, getLastToast: () => lastToast };
}

test("sanitizeNameForSeo cleans filenames into human readable SEO text", () => {
    const { ctx } = createUniversalUploaderContext();
    const clean = ctx.universalUploader.sanitizeNameForSeo("ergonomic_office-chair_v2.png");
    assert.strictEqual(clean, "ergonomic office chair v2");

    const empty = ctx.universalUploader.sanitizeNameForSeo("");
    assert.strictEqual(empty, "");
});

test("switchUniversalStorageTarget activates selected storage and updates sub-selections", async () => {
    const { ctx, elements } = createUniversalUploaderContext();

    await ctx.openUniversalImageUploader({
        sourceModule: "square-redraw",
        imageData: "data:image/png;base64,sample",
        filename: "office_chair.png"
    });

    // Switch to Shopify
    ctx.switchUniversalStorageTarget("shopify");
    assert.ok(elements.univTabTarget_shopify.classList.contains("border-indigo-600"));
    assert.ok(!elements.univPaneTarget_shopify.classList.contains("hidden"));
    assert.ok(elements.univPaneTarget_r2.classList.contains("hidden"));

    // Switch to WordPress
    ctx.switchUniversalStorageTarget("wordpress");
    assert.ok(elements.univTabTarget_wordpress.classList.contains("border-indigo-600"));
    assert.ok(!elements.univPaneTarget_wordpress.classList.contains("hidden"));
});

test("openUniversalImageUploader initializes inputs with WebP compression and SEO title defaults", async () => {
    const { ctx, elements } = createUniversalUploaderContext();

    await ctx.openUniversalImageUploader({
        sourceModule: "details",
        imageData: "data:image/png;base64,sample123",
        filename: "premium-wireless-earbuds.png",
        title: "Wireless Earbuds Pro Active Noise Cancelling",
        altText: "Premium black wireless earbuds charging case"
    });

    assert.strictEqual(elements.univUploadFilename.value, "premium-wireless-earbuds.png");
    assert.strictEqual(elements.univUploadTitle.value, "Wireless Earbuds Pro Active Noise Cancelling");
    assert.strictEqual(elements.univUploadAltText.value, "Premium black wireless earbuds charging case");
    assert.strictEqual(elements.univUploadWebpToggle.checked, true);
    assert.strictEqual(elements.univUploadQuality.value, 90);
    assert.ok(!elements.universalUploaderModal.classList.contains("hidden"));
});

test("executeUniversalImageUpload submits WebP converted payload and displays remote CDN URL", async () => {
    const { ctx, elements, fetchCalls, getLastToast } = createUniversalUploaderContext();

    let uploadSuccessData = null;
    await ctx.openUniversalImageUploader({
        sourceModule: "watermark-removal",
        imageData: "data:image/png;base64,cleanimage",
        filename: "cleaned_product.png",
        onSuccess: (data) => { uploadSuccessData = data; }
    });

    // Set fields
    elements.univUploadTitle.value = "Cleaned Product Photo";
    elements.univUploadAltText.value = "Product without watermarks";
    elements.univUploadWebpToggle.checked = true;
    elements.univUploadQuality.value = 92;

    await ctx.executeUniversalImageUpload();

    const uploadCall = fetchCalls.find(c => c.url.includes("/api/storage/upload-image"));
    assert.ok(uploadCall, "upload-image API should have been called");
    const payload = JSON.parse(uploadCall.opts.body);
    assert.strictEqual(payload.convert_to_webp, true);
    assert.strictEqual(payload.quality, 92);
    assert.strictEqual(payload.title, "Cleaned Product Photo");
    assert.strictEqual(payload.alt_text, "Product without watermarks");
    assert.ok(payload.filename.endsWith(".webp"));

    // Verify UI feedback
    assert.ok(!elements.univUploadResultCard.classList.contains("hidden"));
    assert.strictEqual(elements.univResultUrlInput.value, uploadSuccessData.remote_url);
    const toast = getLastToast();
    assert.ok(toast);
    assert.strictEqual(toast.type, "success");
});

test("openUniversalBatchUploader renders queue items and executes batch processing", async () => {
    const { ctx, elements, fetchCalls, getLastToast } = createUniversalUploaderContext();

    const batchItems = [
        { id: "b1", filename: "img1.png", imageData: "data:image/png;base64,1", title: "View 1", altText: "Alt 1" },
        { id: "b2", filename: "img2.png", imageData: "data:image/png;base64,2", title: "View 2", altText: "Alt 2" }
    ];

    let batchCompleteResults = null;
    await ctx.openUniversalBatchUploader({
        sourceModule: "translate",
        items: batchItems,
        onComplete: (results) => { batchCompleteResults = results; }
    });

    assert.ok(!elements.univBatchUploadContainer.classList.contains("hidden"));
    assert.ok(elements.univSingleUploadContainer.classList.contains("hidden"));

    await ctx.executeUniversalImageUpload();

    const uploadCalls = fetchCalls.filter(c => c.url.includes("/api/storage/upload-image"));
    assert.strictEqual(uploadCalls.length, 2);
    assert.strictEqual(batchCompleteResults.length, 2);
    const toast = getLastToast();
    assert.ok(toast);
    assert.strictEqual(toast.type, "success");
    assert.ok(toast.msg.includes("批量上传完成：成功 2 / 2 项"));
});

test("square_redraw.js uploadSquareRedrawItemToCloud and batchUploadSquareRedrawToCloud trigger uploader", async () => {
    const { ctx } = createUniversalUploaderContext();

    let singleOptions = null;
    let batchOptions = null;
    ctx.openUniversalImageUploader = (opts) => { singleOptions = opts; };
    ctx.openUniversalBatchUploader = (opts) => { batchOptions = opts; };

    // Load square_redraw.js
    vm.runInContext(fs.readFileSync(path.join(root, "js", "square_redraw.js"), "utf8"), ctx);

    ctx.setSquareRedrawImages([
        { id: "sr_1", filename: "chair.jpg", output_url: "data:image/jpeg;base64,chair_done", status: "done" },
        { id: "sr_2", filename: "desk.jpg", output_url: "data:image/jpeg;base64,desk_done", status: "done" }
    ]);

    // Single upload
    ctx.uploadSquareRedrawItemToCloud("sr_1");
    assert.ok(singleOptions);
    assert.strictEqual(singleOptions.sourceModule, "square-redraw");
    assert.strictEqual(singleOptions.filename, "chair_resized.png");
    assert.strictEqual(singleOptions.title, "chair");

    // Batch upload
    ctx.batchUploadSquareRedrawToCloud();
    assert.ok(batchOptions);
    assert.strictEqual(batchOptions.sourceModule, "square-redraw");
    assert.strictEqual(batchOptions.items.length, 2);
    assert.strictEqual(batchOptions.items[0].filename, "chair_resized.png");
    assert.strictEqual(batchOptions.items[1].filename, "desk_resized.png");
});

test("watermark_removal.js uploadWatermarkRemovalResultToCloud triggers uploader", async () => {
    const { ctx } = createUniversalUploaderContext();

    let openedOptions = null;
    ctx.openUniversalImageUploader = (opts) => { openedOptions = opts; };

    // Load watermark removal core and script
    vm.runInContext(fs.readFileSync(path.join(root, "js", "watermark_removal_core.js"), "utf8"), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, "js", "watermark_removal.js"), "utf8"), ctx);
    ctx.initWatermarkRemoval();

    // Mock successful watermark result
    const restored = await ctx.restoreWatermarkRemovalHistory({
        source_url: "/static/orig.png",
        result_url: "/static/cleaned.png",
        filename: "product_watermarked.png",
        width: 800,
        height: 800,
        regions: [{ x: 0, y: 0, width: 0.2, height: 0.2 }]
    });
    assert.strictEqual(restored, true);

    ctx.uploadWatermarkRemovalResultToCloud();
    assert.ok(openedOptions);
    assert.strictEqual(openedOptions.sourceModule, "watermark-removal");
    assert.strictEqual(openedOptions.filename, "product_watermarked-cleaned.png");
    assert.ok(openedOptions.imageData.includes("/static/cleaned.png"));
});

test("translate.js uploadTransSlotToCloud and uploadSelectedTransToCloud trigger uploader", () => {
    const { ctx, elements } = createUniversalUploaderContext();

    let singleOptions = null;
    let batchOptions = null;
    ctx.openUniversalImageUploader = (opts) => { singleOptions = opts; };
    ctx.openUniversalBatchUploader = (opts) => { batchOptions = opts; };

    // Load translate.js
    vm.runInContext(fs.readFileSync(path.join(root, "js", "config.js"), "utf8"), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, "js", "translate.js"), "utf8"), ctx);

    // Create fake translated img element
    const slotImg = ctx.document.getElementById("slot1-img");
    slotImg.tagName = "IMG";
    slotImg.src = "data:image/png;base64,translated_result";

    // Test uploadTransSlotToCloud
    ctx.uploadTransSlotToCloud("slot1-img", "banner-en");
    assert.ok(singleOptions);
    assert.strictEqual(singleOptions.sourceModule, "translate");
    assert.strictEqual(singleOptions.filename, "banner-en_translated.png");
    assert.strictEqual(singleOptions.imageData, "data:image/png;base64,translated_result");
});

test("details.js uploadLightboxImageToCloud and uploadDetailModuleToCloud trigger uploader", () => {
    const { ctx } = createUniversalUploaderContext();

    let singleOptions = null;
    ctx.openUniversalImageUploader = (opts) => { singleOptions = opts; };

    // Load details.js
    vm.runInContext(fs.readFileSync(path.join(root, "js", "config.js"), "utf8"), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, "js", "app.js"), "utf8"), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, "js", "details.js"), "utf8"), ctx);

    // 1. Test uploadLightboxImageToCloud
    const lightboxImg = ctx.document.getElementById("lightboxImage");
    lightboxImg.src = "data:image/png;base64,lightbox_hd";
    const lightboxTitle = ctx.document.getElementById("lightboxTitle");
    lightboxTitle.textContent = "Ergonomic Lumbar Support View";

    ctx.uploadLightboxImageToCloud();
    assert.ok(singleOptions);
    assert.strictEqual(singleOptions.sourceModule, "details-lightbox");
    assert.strictEqual(singleOptions.filename, "Ergonomic Lumbar Support View.png");
    assert.strictEqual(singleOptions.imageData, "data:image/png;base64,lightbox_hd");

    // 2. Test uploadDetailModuleToCloud
    singleOptions = null;
    ctx.globalGenContext = {
        config: { productName: "Ergonomic Office Chair", language: "English" },
        tasks: {
            "m1": {
                uniqueId: "m1",
                displayTitle: "首屏卖点",
                title: "Hero View",
                imageSrc: "data:image/jpeg;base64,hero_image",
                seoTitle: "Best Ergonomic Office Chair for Back Pain",
                seoAlt: "Ergonomic chair with mesh back and adjustable lumbar"
            }
        }
    };

    ctx.uploadDetailModuleToCloud("m1");
    assert.ok(singleOptions);
    assert.strictEqual(singleOptions.sourceModule, "details");
    assert.strictEqual(singleOptions.filename, "Ergonomic Office Chair_首屏卖点.png");
    assert.strictEqual(singleOptions.title, "Best Ergonomic Office Chair for Back Pain");
    assert.strictEqual(singleOptions.altText, "Ergonomic chair with mesh back and adjustable lumbar");
});

test("generateSmartSeoMetadata cleans generic names and prevents 'in 英文' mixed text", () => {
    const { ctx } = createUniversalUploaderContext();

    // Mock active brand profile for a real custom brand
    ctx.brandContextHub = {
        getActiveProfile: () => ({
            brandName: "LuxeAura",
            name: "Hydrating Facial Serum",
            category: "Beauty & Skincare",
            differentiators: "Hyaluronic Acid"
        })
    };

    // Test 1: Generic filename 描述图_05.png translated to English
    const enMeta = ctx.universalUploader.generateSmartSeoMetadata({
        filename: "描述图_05.png",
        sourceModule: "translate",
        lang: "English"
    });

    assert.ok(!enMeta.title.includes("描述图"));
    assert.ok(!enMeta.title.includes("in 英文"));
    assert.ok(!enMeta.altText.includes("in 英文"));
    assert.ok(enMeta.title.includes("LuxeAura"));
    assert.ok(enMeta.title.includes("05"));
    assert.ok(enMeta.title.includes("[EN]"));
    assert.ok(enMeta.altText.includes("English localized product showcase"));

    // Test 2: Generic filename 详情图_02.png in Chinese
    const zhMeta = ctx.universalUploader.generateSmartSeoMetadata({
        filename: "详情图_02.png",
        sourceModule: "translate",
        lang: "Chinese"
    });
    assert.ok(!zhMeta.title.includes("详情图"));
    assert.ok(zhMeta.title.includes("核心卖点展示"));
    assert.ok(zhMeta.title.includes("[ZH]"));
    assert.ok(zhMeta.altText.includes("高清细节功能展示"));

    // Test 3: Generic filename in Thai
    const thMeta = ctx.universalUploader.generateSmartSeoMetadata({
        filename: "image_03.jpg",
        sourceModule: "translate",
        lang: "Thai"
    });
    assert.ok(!thMeta.title.includes("image_03"));
    assert.ok(thMeta.title.includes("[TH]"));
    assert.ok(thMeta.altText.includes("ภาษาไทย"));

    // Test 4: Generic placeholder detection
    assert.strictEqual(ctx.universalUploader.isGenericPlaceholderName("描述图_05"), true);
    assert.strictEqual(ctx.universalUploader.isGenericPlaceholderName("详情图"), true);
    assert.strictEqual(ctx.universalUploader.isGenericPlaceholderName("image_1"), true);
    assert.strictEqual(ctx.universalUploader.isGenericPlaceholderName("ti_1789617078_a8b9c"), true);
    assert.strictEqual(ctx.universalUploader.isGenericPlaceholderName("ergonomic_office_chair_black"), false);
});

test("generateSmartSeoMetadata ignores factory sample_ergonomic_chair to avoid false chair titles on generic images", () => {
    const { ctx } = createUniversalUploaderContext();

    // Factory sample profile (ErgoPro 工学椅)
    ctx.brandContextHub = {
        getActiveProfile: () => ({
            id: "sample_ergonomic_chair",
            brandName: "ErgoPro",
            name: "自适应动态腰托人体工学椅",
            category: "办公家具 / 人体工学"
        })
    };

    // Generic upload with no explicit chair in DOM
    const enMeta = ctx.universalUploader.generateSmartSeoMetadata({
        filename: "描述图_05.png",
        sourceModule: "translate",
        lang: "English"
    });

    // Must NOT contain ErgoPro or chair
    assert.ok(!enMeta.title.includes("ErgoPro"), "Should not contain demo brand ErgoPro");
    assert.ok(!enMeta.title.includes("Chair"), "Should not invent Chair for arbitrary images");
    assert.ok(enMeta.title.includes("E-commerce Product"), "Should fall back to neutral e-commerce label");
    assert.ok(enMeta.title.includes("05"));

    // In Chinese mode
    const zhMeta = ctx.universalUploader.generateSmartSeoMetadata({
        filename: "描述图_01.png",
        sourceModule: "translate",
        lang: "Chinese"
    });
    assert.ok(!zhMeta.title.includes("ErgoPro"));
    assert.ok(!zhMeta.title.includes("工学椅"));
    assert.ok(zhMeta.title.includes("商品 - 本地化核心卖点展示"));
});

test("openUniversalBatchUploader displays batch WebP badge and renders editable SEO inputs", async () => {
    const { ctx, elements } = createUniversalUploaderContext();

    ctx.brandContextHub = {
        getActiveProfile: () => ({
            brandName: "AeroSound",
            name: "Wireless ANC Earbuds",
            category: "Consumer Electronics"
        })
    };

    const batchItems = [
        { id: "b1", filename: "描述图_05.png", imageData: "data:image/png;base64,1", title: "描述图_05 EN", altText: "描述图_05 in 英文", lang: "English" },
        { id: "b2", filename: "custom_sound_view.png", imageData: "data:image/png;base64,2", title: "AeroSound Custom View", altText: "Custom View Alt", lang: "English" }
    ];

    await ctx.openUniversalBatchUploader({
        sourceModule: "translate",
        items: batchItems
    });

    // 1. WebP Batch badge is displayed
    assert.ok(!elements.univWebpBatchBadge.classList.contains("hidden"));

    // 2. Item 1 generic title is auto-healed in rendered HTML
    const renderedHtml = elements.univBatchItemList.innerHTML;
    assert.ok(renderedHtml.includes("univBatchTitle_0"));
    assert.ok(renderedHtml.includes("univBatchAlt_0"));
    assert.ok(!renderedHtml.includes("描述图_05 EN"));
    assert.ok(!renderedHtml.includes("描述图_05 in 英文"));
    assert.ok(renderedHtml.includes("AeroSound"));
    assert.ok(renderedHtml.includes("[EN]"));

    // 3. Item 2 clean title is preserved in rendered HTML
    assert.ok(renderedHtml.includes("AeroSound Custom View"));

    // 4. Batch apply smart SEO tool
    ctx.batchApplySmartSeoToQueue();
    assert.ok(elements.univBatchTitle_0);
    assert.ok(elements.univBatchTitle_0.value.includes("AeroSound"));
    assert.ok(elements.univBatchTitle_1.value.includes("AeroSound"));

    // 5. Batch apply hint tool
    elements.univBatchProductHint.value = "Smart Sport Watch";
    ctx.universalUploader.batchApplyHintToQueue();
    assert.ok(elements.univBatchTitle_0.value.includes("Smart Sport Watch"));
});

test("recognizeImageWithVisionAI inspects image pixels and returns structured e-commerce SEO metadata", async () => {
    const { ctx } = createUniversalUploaderContext();

    let capturedCall = null;
    ctx.callAI = async (capability, payload) => {
        capturedCall = { capability, payload };
        return {
            candidates: [
                {
                    content: {
                        parts: [
                            {
                                text: JSON.stringify({
                                    productName: "Velvet Matte Lipstick",
                                    category: "Beauty & Makeup",
                                    title: "Velvet Matte Lipstick Long-Lasting Waterproof - Ruby Red Angle View",
                                    altText: "Ruby red matte lipstick in sleek magnetic casing shown open at 45 degree angle",
                                    slug: "velvet_matte_lipstick_ruby_red_view"
                                })
                            }
                        ]
                    }
                }
            ]
        };
    };

    const res = await ctx.universalUploader.recognizeImageWithVisionAI("data:image/png;base64,test_pixel_data", {
        targetLang: "English",
        hint: "Cosmetics"
    });

    assert.ok(capturedCall);
    assert.strictEqual(capturedCall.capability, "text");
    const parts = capturedCall.payload.contents[0].parts;
    assert.ok(parts.some(p => p.inlineData && p.inlineData.data === "test_pixel_data"));
    assert.ok(parts.some(p => p.text && p.text.includes("Cosmetics")));

    assert.strictEqual(res.productName, "Velvet Matte Lipstick");
    assert.strictEqual(res.category, "Beauty & Makeup");
    assert.strictEqual(res.slug, "velvet_matte_lipstick_ruby_red_view");
    assert.ok(res.title.includes("Ruby Red"));
    assert.ok(res.altText.includes("magnetic casing"));
});

test("triggerSingleVisionAiSeo and triggerBatchVisionAiSeo accurately update DOM inputs", async () => {
    const { ctx, elements } = createUniversalUploaderContext();

    ctx.callAI = async (capability, payload) => {
        return {
            candidates: [
                {
                    content: {
                        parts: [
                            {
                                text: JSON.stringify({
                                    productName: "Mechanical Gaming Keyboard",
                                    category: "PC Gaming Accessories",
                                    title: "RGB Backlit Mechanical Gaming Keyboard - Blue Switch Feature View",
                                    altText: "Close-up of blue mechanical switches under dynamic RGB keycaps",
                                    slug: "rgb_mechanical_gaming_keyboard_view"
                                })
                            }
                        ]
                    }
                }
            ]
        };
    };

    // 1. Single mode test
    await ctx.openUniversalImageUploader({
        sourceModule: "translate",
        imageData: "data:image/png;base64,keyboard_img",
        filename: "描述图_01.png"
    });

    await ctx.universalUploader.triggerSingleVisionAiSeo();
    assert.ok(elements.univUploadTitle.value.includes("Mechanical Gaming Keyboard"));
    assert.ok(elements.univUploadAltText.value.includes("RGB keycaps"));
    assert.strictEqual(elements.univUploadFilename.value, "rgb_mechanical_gaming_keyboard_view.png");

    // 2. Batch mode test
    await ctx.openUniversalBatchUploader({
        sourceModule: "translate",
        items: [
            { id: "k1", filename: "img_01.png", imageData: "data:image/png;base64,key1", title: "", altText: "" }
        ]
    });

    await ctx.universalUploader.triggerBatchVisionAiSeo();
    assert.ok(elements.univBatchTitle_0.value.includes("Mechanical Gaming Keyboard"));
    assert.ok(elements.univBatchAlt_0.value.includes("blue mechanical switches"));
    assert.ok(elements.univBatchFile_0.value.includes("rgb_mechanical_gaming_keyboard_view_1.png"));
    assert.ok(elements.univBatchStatus_0.innerHTML.includes("已识别"));
});
