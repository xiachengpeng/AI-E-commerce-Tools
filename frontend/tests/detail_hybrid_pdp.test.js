const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function createTestContext(domElements = {}) {
    const elements = { ...domElements };
    const doc = {
        getElementById: (id) => elements[id] || null,
        querySelector: (selector) => {
            if (elements[selector]) return elements[selector];
            if (selector === '.dtc-pdp-wrapper') return elements['.dtc-pdp-wrapper'] || null;
            return null;
        },
        querySelectorAll: () => [],
        createElement: (tag) => {
            return {
                tagName: tag.toUpperCase(),
                value: '',
                textContent: '',
                className: '',
                classList: {
                    add: () => {},
                    remove: () => {},
                    toggle: () => {},
                    contains: () => false
                },
                appendChild: () => {},
                removeChild: () => {},
                click: () => {},
                select: () => {}
            };
        },
        body: {
            appendChild: () => {},
            removeChild: () => {}
        }
    };

    let lastToast = null;
    let switchedTab = null;

    const ctx = {
        console,
        document: doc,
        showToast: (msg, type) => { lastToast = { msg, type }; },
        switchTab: (tabId) => { switchedTab = tabId; },
        remoteLog: () => {},
        localStorage: {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {}
        },
        MARKET_TONE_MAP: { 'US Market': 'direct but compliant' },
        API_BASE: 'http://127.0.0.1:9503/api',
        fetch: async () => ({ ok: true, json: async () => ({}) })
    };

    ctx.window = ctx;
    ctx.globalThis = ctx;

    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'config.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'details.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'analysis.js'), 'utf8'), ctx);

    return { ctx, elements, getLastToast: () => lastToast, getSwitchedTab: () => switchedTab };
}

test('MODULE_PRESETS defines Amazon 7-Pack, DTC Hybrid, and TikTok Viral presets', () => {
    const { ctx } = createTestContext();
    assert.ok(ctx.MODULE_PRESETS, 'MODULE_PRESETS should be defined');
    assert.ok(ctx.MODULE_PRESETS.amazon_seven, 'amazon_seven preset exists');
    assert.deepStrictEqual([...ctx.MODULE_PRESETS.amazon_seven.ids], ['m1', 'm2', 'm3', 'm4', 'm6', 'm8', 'm11']);
    assert.ok(ctx.MODULE_PRESETS.shopify_dtc, 'shopify_dtc preset exists');
    assert.deepStrictEqual([...ctx.MODULE_PRESETS.shopify_dtc.ids], ['m1', 'm2', 'm3', 'm5', 'm7', 'm10', 'm12']);
    assert.ok(ctx.MODULE_PRESETS.tiktok_viral, 'tiktok_viral preset exists');
    assert.deepStrictEqual([...ctx.MODULE_PRESETS.tiktok_viral.ids], ['m1', 'm2', 'm3', 'm9', 'm11']);
});

test('applyModulePreset activates target modules and sets includeText=false in hybrid mode', () => {
    const { ctx, getLastToast } = createTestContext();

    assert.ok(Array.isArray(ctx.modules), 'modules array exists');
    ctx.setDetailPresentationMode('hybrid');

    ctx.applyModulePreset('amazon_seven');
    const activeIds = ctx.modules.filter(m => m.active).map(m => m.id);
    assert.deepStrictEqual([...activeIds], ['m1', 'm2', 'm3', 'm4', 'm6', 'm8', 'm11']);

    // In hybrid mode, active modules should have includeText set to false
    ctx.modules.filter(m => m.active).forEach(m => {
        assert.strictEqual(m.includeText, false, `Module ${m.id} should have includeText=false in hybrid mode`);
    });

    assert.strictEqual(getLastToast()?.type, 'success');
    assert.match(getLastToast()?.msg, /Amazon 7图套餐/);
});

test('selectAllModules toggles all modules active state', () => {
    const { ctx } = createTestContext();
    ctx.selectAllModules(true);
    assert.strictEqual(ctx.modules.every(m => m.active), true);

    ctx.selectAllModules(false);
    assert.strictEqual(ctx.modules.every(m => !m.active), true);
});

test('presentation mode and viewport toggle behave correctly', () => {
    const modeBtnHybrid = { className: '' };
    const modeBtnImages = { className: '' };
    const dtcBadge = { classList: { toggle: () => {} } };
    const modeDesc = { textContent: '' };
    const wrapper = { className: '' };

    const { ctx } = createTestContext({
        modeBtnHybrid,
        modeBtnImages,
        dtcModeBadge: dtcBadge,
        modeDescriptionHint: modeDesc,
        '.dtc-pdp-wrapper': wrapper
    });

    ctx.setDetailPresentationMode('hybrid');
    assert.strictEqual(ctx.getDetailPresentationMode(), 'hybrid');

    ctx.setDtcViewport('mobile');
    assert.strictEqual(wrapper.className.includes('dtc-viewport-mobile'), true);

    ctx.setDtcViewport('desktop');
    assert.strictEqual(wrapper.className.includes('dtc-viewport-desktop'), true);

    ctx.setDetailPresentationMode('images');
    assert.strictEqual(ctx.getDetailPresentationMode(), 'images');
});

test('parseSellingPointsResponse extracts product facts and forbidden claims', () => {
    const { ctx } = createTestContext();
    const rawJson = JSON.stringify({
        product_name: 'Smart Ergonomic Office Chair',
        selling_points: ['Adaptive lumbar support', '3D adjustable armrests', 'Breathable mesh'],
        product_facts: ['Weight capacity 330 lbs', 'BIFMA certified class-4 gas lift'],
        forbidden_claims: ['Do not claim cures spine diseases', 'Do not claim 100% lifetime warranty']
    });

    const parsed = ctx.parseSellingPointsResponse(rawJson);
    assert.strictEqual(parsed.productName, 'Smart Ergonomic Office Chair');
    assert.strictEqual(typeof parsed.sellingPoints, 'string');
    assert.match(parsed.sellingPoints, /Adaptive lumbar support/);
    assert.strictEqual(typeof parsed.productFacts, 'string');
    assert.match(parsed.productFacts, /Weight capacity 330 lbs/);
    assert.strictEqual(typeof parsed.forbiddenClaims, 'string');
    assert.match(parsed.forbiddenClaims, /Do not claim cures spine diseases/);

    const formState = ctx.resolveSellingPointsFormState(
        '',
        '',
        parsed
    );
    assert.strictEqual(formState.productName, 'Smart Ergonomic Office Chair');
    assert.match(formState.sellingPoints, /Adaptive lumbar support/);
    assert.match(formState.productFacts, /Weight capacity 330 lbs/);
    assert.match(formState.forbiddenClaims, /Do not claim cures spine diseases/);
});

test('generateDtcSectionCopy creates CRO-optimized semantic copy and fallbacks gracefully', async () => {
    const { ctx } = createTestContext();

    const heroTask = { id: 'm1', title: '首屏核心卖点', subtitle: '强力吸睛与高价值主张' };
    const config = { language: 'English', marketTone: 'direct' };

    ctx.callAI = async (cap, payload) => {
        return {
            candidates: [{
                content: {
                    parts: [{
                        text: JSON.stringify({
                            tagline: 'ULTIMATE COMFORT',
                            headline: 'Sit Better, Work Longer',
                            valueProposition: 'Engineered for all-day focus without back pain.',
                            trustBadges: ['✓ 30-Day Risk-Free Trial', '✓ Free Express Shipping']
                        })
                    }]
                }
            }]
        };
    };

    const heroCopy = await ctx.generateDtcSectionCopy(heroTask, 'Ergonomic lumbar chair', config);
    assert.strictEqual(heroCopy.tagline, 'ULTIMATE COMFORT');
    assert.strictEqual(heroCopy.headline, 'Sit Better, Work Longer');
    assert.strictEqual(heroCopy.trustBadges.length, 2);
    assert.strictEqual(heroTask.dtcCopy.tagline, 'ULTIMATE COMFORT');

    ctx.callAI = async () => { throw new Error('AI network timeout'); };
    const featureTask = { id: 'm2', title: '痛点破局对比', subtitle: '告别酸痛' };
    const fallbackCopyEn = await ctx.generateDtcSectionCopy(featureTask, 'Ergonomic lumbar chair', config);
    assert.ok(fallbackCopyEn, 'Fallback copy must be provided on failure');
    assert.strictEqual(fallbackCopyEn.tagline, 'TARGETED BENEFIT');
    assert.ok(!/[\u4e00-\u9fa5]/.test(fallbackCopyEn.tagline), 'English fallback must not contain Chinese tagline');
    assert.ok(Array.isArray(fallbackCopyEn.fbr));

    const fallbackCopyZh = await ctx.generateDtcSectionCopy(featureTask, 'Ergonomic lumbar chair', { ...config, language: 'Chinese' });
    assert.ok(fallbackCopyZh, 'Chinese fallback copy must be provided');
    assert.ok(fallbackCopyZh.tagline.includes('痛点破局对比') || fallbackCopyZh.tagline.includes('核心'), 'Chinese fallback copy contains task title or focal feature');
    assert.ok(Array.isArray(fallbackCopyZh.fbr));
});

test('generateDtcSectionCopy strictly grounds prompt with product name, focal feature, and anti-hallucination rules', async () => {
    const { ctx } = createTestContext();

    let capturedPrompt = '';
    ctx.callAI = async (cap, payload) => {
        capturedPrompt = payload?.contents?.[0]?.parts?.[0]?.text || '';
        return {
            candidates: [{
                content: {
                    parts: [{
                        text: JSON.stringify({
                            tagline: 'PREMIUM CRAFT',
                            headline: 'Precision Ceramic Teapot',
                            subheadline: 'Handcrafted borosilicate body ensures pure tea aroma.',
                            fbr: [
                                { feature: 'Heat Resistant', benefit: 'Withstands boiling temperature safely.' },
                                { feature: 'Fine Infuser', benefit: 'Filters fine tea leaves without residue.' }
                            ]
                        })
                    }]
                }
            }]
        };
    };

    const teapotTask = {
        id: 'm2',
        title: '核心功能证明',
        displayTitle: '核心功能证明 02',
        variant: 1,
        totalVariants: 3,
        focalFeature: '耐热高硼硅玻璃内胆与精密滤网',
        role: '展示高硼硅玻璃耐高温与无茶渣过滤体验'
    };

    const config = {
        productName: 'Handcrafted Glass Teapot',
        brandName: 'ZenBrew',
        language: 'English'
    };

    const copy = await ctx.generateDtcSectionCopy(teapotTask, 'Handcrafted borosilicate glass teapot with stainless mesh', config);
    assert.ok(copy, 'Copy must be generated');
    assert.strictEqual(copy.tagline, 'PREMIUM CRAFT');

    // Verify prompt grounding
    assert.ok(capturedPrompt.includes('Handcrafted Glass Teapot'), 'Prompt must contain product name');
    assert.ok(capturedPrompt.includes('ZenBrew'), 'Prompt must contain brand name');
    assert.ok(capturedPrompt.includes('耐热高硼硅玻璃内胆与精密滤网'), 'Prompt must contain focal feature');
    assert.ok(capturedPrompt.includes('NO INVENTED MATERIALS'), 'Prompt must enforce no invented materials');
    assert.ok(capturedPrompt.includes('NO INVENTED ACCESSORIES OR ELECTRONICS'), 'Prompt must enforce no invented electronics');
    assert.ok(!capturedPrompt.includes('Apple, Dyson, Anker'), 'Prompt must not bias towards 3C hardware brands');
});

test('renderDtcHybridPreview builds complete DTC PDP structure with Hero, FBR, Steps, Specs, and FAQ', () => {
    const container = { innerHTML: '', querySelector: () => null };
    const { ctx } = createTestContext({
        dtcHybridContainer: container
    });

    const mockGenContext = {
        config: { productName: 'ErgoPro High-Back Chair', language: 'English' },
        sellingPoints: 'Premium ergonomic lumbar support with breathable mesh.',
        primaryImage: { base64: 'data:image/png;base64,primaryHeroMock' },
        tasks: {
            m1: {
                id: 'm1',
                title: '首屏核心卖点',
                imageSrc: 'data:image/png;base64,heroImgMock',
                dtcCopy: {
                    tagline: 'NEXT-GEN SEATING',
                    headline: 'Engineered For Pure Focus',
                    valueProposition: 'Experience all-day posture support without fatigue.',
                    trustBadges: ['✓ 30-Day Guarantee', '✓ 5-Year Warranty']
                }
            },
            m2: {
                id: 'm2',
                title: '核心痛点解决',
                imageSrc: 'data:image/png;base64,m2ImgMock',
                dtcCopy: {
                    tagline: 'PAIN RELIEF',
                    headline: 'End Lower Back Fatigue',
                    subheadline: 'Dynamic lumbar arch naturally aligns spine curvature.',
                    fbr: [{ feature: 'Dynamic Lumbar Pillow', benefit: 'Self-adjusts to posture', result: 'Zero strain after 10 hours' }]
                }
            },
            m12: {
                id: 'm12',
                title: '简易使用指南',
                dtcCopy: {
                    tagline: 'EFFORTLESS ASSEMBLY',
                    headline: 'Ready In 3 Simple Steps',
                    steps: [
                        { step: 1, title: 'Unbox', instruction: 'Lay out the pre-assembled base and cylinder.' },
                        { step: 2, title: 'Click In', instruction: 'Snap wheels into heavy-duty base.' },
                        { step: 3, title: 'Relax', instruction: 'Sit and adjust armrests to ideal height.' }
                    ]
                }
            },
            m10: {
                id: 'm10',
                title: '规格参数与包装清单',
                dtcCopy: {
                    tagline: 'SPECIFICATIONS',
                    headline: 'Full Technical Specs',
                    packageIncludes: ['1 × ErgoPro Chair', '1 × Hex Tool Kit', '1 × Manual'],
                    specifications: [{ label: 'Max Load', value: '330 lbs' }]
                }
            },
            m11: {
                id: 'm11',
                title: '常见疑虑解答 FAQ',
                dtcCopy: {
                    faqs: [
                        { q: 'Is assembly complicated?', a: 'No, all tools and 3-step guide are included.' }
                    ]
                }
            }
        },
        longImageOrder: ['m1', 'm2', 'm12', 'm10', 'm11']
    };

    vm.runInContext('globalGenContext = ' + JSON.stringify(mockGenContext) + ';', ctx);
    ctx.renderDtcHybridPreview();

    const output = container.innerHTML;
    assert.ok(output.includes('dtc-pdp-wrapper'), 'Contains dtc-pdp-wrapper');
    assert.ok(output.includes('NEXT-GEN SEATING'), 'Contains m1 Tagline in FBR');
    assert.ok(output.includes('Engineered For Pure Focus'), 'Contains m1 Headline in FBR');
    assert.ok(!output.includes('dtc-hero-grid'), 'Hero Grid layout has been removed');
    assert.ok(!output.includes('Special Launch Price'), 'Mock Buy Box price anchor has been removed');
    assert.ok(output.includes('dtc-fbr-chip'), 'Contains FBR chip component');
    assert.ok(output.includes('Dynamic Lumbar Pillow'), 'Contains FBR Feature');
    assert.ok(output.includes('EFFORTLESS ASSEMBLY'), 'Contains Steps Tagline');
    assert.ok(output.includes('Ready In 3 Simple Steps'), 'Contains Steps Headline');
    assert.ok(output.includes('Full Technical Specs'), 'Contains Specs Headline');
    assert.ok(output.includes('dtc-accordion-item'), 'Contains FAQ Accordion');
    assert.ok(!output.includes('ORDER NOW'), 'Final CTA Order button has been removed');
    assert.ok(!output.includes('24/7 Specialist Team Ready'), 'FAQ bottom specialist team badge has been removed');
});

test('toggleDtcAccordion toggles active class on parent item', () => {
    const { ctx } = createTestContext();

    const itemEl = {
        classList: {
            active: false,
            toggle: function (cls) {
                if (cls === 'active') this.active = !this.active;
            }
        }
    };
    const headerEl = {
        closest: (selector) => {
            if (selector === '.dtc-accordion-item') return itemEl;
            return null;
        }
    };

    ctx.toggleDtcAccordion(headerEl);
    assert.strictEqual(itemEl.classList.active, true, 'Accordion should be active after 1st click');

    ctx.toggleDtcAccordion(headerEl);
    assert.strictEqual(itemEl.classList.active, false, 'Accordion should be inactive after 2nd click');
});

test('xp_transferToDetails bridges competitor analysis insights into detail inputs', () => {
    const productNameInput = { value: '' };
    const sellingPointsText = { value: '' };
    const productFactsText = { value: '' };
    const forbiddenClaimsText = { value: '' };
    const detailRegionSelect = { value: '', dispatchEvent: () => {} };

    const { ctx, getLastToast } = createTestContext({
        productNameInput,
        sellingPointsText,
        productFactsText,
        forbiddenClaimsText,
        detailRegionSelect
    });

    const sampleCompetitorProduct = {
        product_name: '轻量化户外超大天幕帐篷 ||| Ultralight Camping Tarp Shelter',
        core_selling_points: [
            { point: '210T防撕裂牛津布，PU3000mm抗暴雨' },
            { point: '涂银防晒科技，UPF50+阻隔99%紫外线' }
        ],
        differentiation_opportunities: [
            { opportunity: '标配加粗铝合金支撑杆与反光加固风绳' }
        ],
        specs: {
            '防暴雨级别': 'PU3000mm',
            '配件': '标配加粗铝合金支撑杆与反光加固风绳'
        },
        battle_card: {
            pricing_tier: '中高端',
            fatal_vulnerabilities: [
                '遇强风时压胶缝线处漏水',
                '严禁虚假宣传防十级大风'
            ]
        },
        customer_objections: [
            { objection: '暴雨下真的不会渗水吗？', defense: '全压胶热封工艺配合3000mm水压测试' }
        ],
        target_countries: ['美国', '欧洲']
    };

    ctx.xp_transferToDetails(sampleCompetitorProduct);

    // Assert product name
    assert.strictEqual(productNameInput.value, '轻量化户外超大天幕帐篷');

    // Assert selling points
    assert.match(sellingPointsText.value, /【核心卖点与功能】/);
    assert.match(sellingPointsText.value, /210T防撕裂牛津布/);
    assert.match(sellingPointsText.value, /【差异化改良突破点】/);
    assert.match(sellingPointsText.value, /标配加粗铝合金支撑杆/);

    // Assert product facts
    assert.match(productFactsText.value, /防暴雨级别: PU3000mm/);
    assert.match(productFactsText.value, /标配加粗铝合金支撑杆与反光加固风绳/);

    // Assert forbidden claims / fatal weaknesses
    assert.match(forbiddenClaimsText.value, /规避竞品缺陷: 严禁虚假宣传防十级大风/);
    assert.match(forbiddenClaimsText.value, /规避竞品缺陷: 遇强风时压胶缝线处漏水/);

    // Assert objection transfer
    assert.ok(Array.isArray(ctx.window.xp_transferredObjections));
    assert.strictEqual(ctx.window.xp_transferredObjections.length, 1);

    // Assert toast
    assert.strictEqual(getLastToast()?.type, 'success');
});

test('preset buttons UI and module platform tags reflect active presets accurately', () => {
    const presetBtnAmazon = { className: '', innerHTML: '' };
    const presetBtnDtc = { className: '', innerHTML: '' };
    const presetBtnTiktok = { className: '', innerHTML: '' };
    const hintEl = { className: '', innerHTML: '', classList: { remove: () => {}, add: () => {} } };
    const moduleGridEl = { innerHTML: '', insertAdjacentHTML: function(pos, html) { this.innerHTML += html; } };

    const { ctx } = createTestContext({
        presetBtn_amazon_seven: presetBtnAmazon,
        presetBtn_shopify_dtc: presetBtnDtc,
        presetBtn_tiktok_viral: presetBtnTiktok,
        presetActiveHint: hintEl,
        moduleGrid: moduleGridEl
    });

    // When amazon_seven is applied
    ctx.applyModulePreset('amazon_seven');
    assert.strictEqual(ctx.detectCurrentModulePreset(), 'amazon_seven');
    assert.ok(presetBtnAmazon.className.includes('bg-amber-500'));
    assert.ok(presetBtnAmazon.innerHTML.includes('(已选)'));
    assert.ok(moduleGridEl.innerHTML.includes('Amazon 7图'));
    assert.ok(moduleGridEl.innerHTML.includes('独立站 DTC'));

    // When shopify_dtc is applied
    ctx.applyModulePreset('shopify_dtc');
    assert.strictEqual(ctx.detectCurrentModulePreset(), 'shopify_dtc');
    assert.ok(presetBtnDtc.className.includes('bg-indigo-600'));
    assert.ok(presetBtnDtc.innerHTML.includes('(已选)'));
    assert.ok(!presetBtnAmazon.innerHTML.includes('(已选)'));

    // When cleared
    ctx.selectAllModules(false);
    assert.strictEqual(ctx.detectCurrentModulePreset(), null);
    assert.ok(!presetBtnDtc.innerHTML.includes('(已选)'));
});

test('bundle product mode, bundle_suite preset, and kit cohesion lock behave correctly', () => {
    const presetBtnBundle = { className: '', innerHTML: '' };
    const bannerEl = {
        className: '',
        classList: {
            classes: new Set(['hidden']),
            toggle: function(cls, force) {
                if (force) this.classes.add(cls);
                else this.classes.delete(cls);
            },
            contains: function(cls) { return this.classes.has(cls); }
        }
    };
    const btnSingle = { className: '' };
    const btnBundle = { className: '' };
    const hintEl = { textContent: '' };
    const moduleGridEl = { innerHTML: '', insertAdjacentHTML: function(pos, html) { this.innerHTML += html; } };

    const { ctx } = createTestContext({
        presetBtn_bundle_suite: presetBtnBundle,
        bundleModeBanner: bannerEl,
        productTypeBtnSingle: btnSingle,
        productTypeBtnBundle: btnBundle,
        uploadImageHint: hintEl,
        moduleGrid: moduleGridEl
    });

    // 1. Check MODULE_PRESETS bundle_suite definition
    assert.ok(ctx.MODULE_PRESETS.bundle_suite, 'bundle_suite preset exists');
    assert.deepStrictEqual([...ctx.MODULE_PRESETS.bundle_suite.ids], ['m1', 'm13', 'm2', 'm16', 'm15', 'm14', 'm11']);

    // 2. Product type mode toggle
    assert.strictEqual(ctx.getProductTypeMode(), 'single');
    ctx.setProductTypeMode('bundle');
    assert.strictEqual(ctx.getProductTypeMode(), 'bundle');
    assert.ok(btnBundle.className.includes('bg-emerald-600'));
    assert.match(hintEl.textContent, /套装模式/);

    // 3. Kit Cohesion Lock prompt
    const bundlePrompt = ctx.buildProductLockPrompt({ productType: 'bundle', productFacts: '1x Main drill, 24x Bits' });
    assert.match(bundlePrompt, /KIT COHESION LOCK/);
    assert.match(bundlePrompt, /authentic relative physical proportions/i);
    assert.match(bundlePrompt, /confirmed bundle package facts and piece counts/i);

    const singlePrompt = ctx.buildProductLockPrompt({ productType: 'single' });
    assert.match(singlePrompt, /PRODUCT LOCK/);
    assert.doesNotMatch(singlePrompt, /KIT COHESION LOCK/);

    // 4. Apply bundle_suite preset
    ctx.applyModulePreset('bundle_suite');
    assert.strictEqual(ctx.detectCurrentModulePreset(), 'bundle_suite');
    assert.ok(presetBtnBundle.className.includes('bg-emerald-600'));
    assert.ok(presetBtnBundle.innerHTML.includes('(已选)'));
    assert.ok(moduleGridEl.innerHTML.includes('套装/礼包'));

    // 5. Render DTC Hybrid preview with bundle modules
    const hybridContainer = { innerHTML: '' };
    ctx.document.getElementById = (id) => {
        if (id === 'dtcHybridContainer') return hybridContainer;
        return null;
    };
    ctx.globalGenContext = {
        config: { productName: '28-Piece Cordless Drill Kit', productType: 'bundle' },
        sellingPoints: 'Pro-grade cordless drill with 24 accessories',
        primaryImage: { base64: 'data:image/jpeg;base64,mock' },
        tasks: {
            m1: { id: 'm1', title: '首屏认知', imageSrc: 'data:image/jpeg;base64,hero', dtcCopy: { headline: 'All-in-One Power Solution' } },
            m13: {
                id: 'm13',
                title: '全家福拆解清单',
                imageSrc: 'data:image/jpeg;base64,box',
                dtcCopy: {
                    headline: "What's in the Box",
                    items: [
                        { name: 'Drill Driver', count: '1×', desc: 'Brushless motor' },
                        { name: 'Titanium Bits', count: '24×', desc: 'Precision steel' }
                    ]
                }
            },
            m14: {
                id: 'm14',
                title: '组合超值算账对比',
                imageSrc: 'data:image/jpeg;base64,save',
                dtcCopy: {
                    headline: 'Bundle & Save',
                    bundleComparison: {
                        singleItemsTotal: '$149.99',
                        bundlePrice: '$89.99',
                        savingsText: 'Save $60 (40% OFF)',
                        perks: ['All 24 drill bits included', 'Free sturdy tool case']
                    }
                }
            }
        }
    };

    ctx.renderDtcHybridPreview();
    assert.match(hybridContainer.innerHTML, /What's In The Box/i);
    assert.match(hybridContainer.innerHTML, /Drill Driver/);
    assert.match(hybridContainer.innerHTML, /Titanium Bits/);
    assert.match(hybridContainer.innerHTML, /Bundle &amp; Save|Bundle & Save/);
    assert.match(hybridContainer.innerHTML, /\$149\.99/);
    assert.match(hybridContainer.innerHTML, /\$89\.99/);
});

test('updateDtcText, updateDtcFbrItem, and cleanDtcExportHtml support inline editing and clean export', () => {
    const { ctx } = createTestContext();

    ctx.globalGenContext = {
        tasks: {
            m1: {
                id: 'm1',
                dtcCopy: { headline: 'Old Headline', valueProposition: 'Old Value' }
            },
            m2: {
                id: 'm2',
                dtcCopy: {
                    headline: 'Old FBR Headline',
                    fbr: [
                        { feature: 'Old Feature', benefit: 'Old Benefit' }
                    ]
                }
            }
        }
    };

    // 1. updateDtcText updates headline
    const headlineEl = { innerText: 'New Crisp 4-Word Headline' };
    ctx.updateDtcText('m1', 'headline', headlineEl);
    assert.strictEqual(ctx.globalGenContext.tasks.m1.dtcCopy.headline, 'New Crisp 4-Word Headline');

    // 2. updateDtcFbrItem updates feature and benefit from strong and span
    const fbrItemEl = {
        querySelector: (sel) => {
            if (sel === 'strong') return { innerText: 'Ultra-Soft Wool:' };
            if (sel === 'span') return { innerText: 'Silky and clump-free texture.' };
            return null;
        }
    };
    ctx.updateDtcFbrItem('m2', 0, fbrItemEl);
    assert.strictEqual(ctx.globalGenContext.tasks.m2.dtcCopy.fbr[0].feature, 'Ultra-Soft Wool');
    assert.strictEqual(ctx.globalGenContext.tasks.m2.dtcCopy.fbr[0].benefit, 'Silky and clump-free texture.');

    // 3. updateDtcFbrItem handles plain colon-separated string fallback
    const plainFbrEl = {
        querySelector: () => null,
        innerText: 'Quick Assembly : Setup completed in under 60 seconds.'
    };
    ctx.updateDtcFbrItem('m2', 0, plainFbrEl);
    assert.strictEqual(ctx.globalGenContext.tasks.m2.dtcCopy.fbr[0].feature, 'Quick Assembly');
    assert.strictEqual(ctx.globalGenContext.tasks.m2.dtcCopy.fbr[0].benefit, 'Setup completed in under 60 seconds.');

    // 4. cleanDtcExportHtml strips contenteditable, onblur, edit titles, and lightbox preview triggers
    const dirtyHtml = `<h3 contenteditable="true" onblur="updateDtcText('m1', 'headline', this)" title="点击可直接编辑标题">Title</h3><div contenteditable="true" onblur="updateDtcFbrItem('m2', 0, this)" title="点击可直接编辑要点"><strong>Feat:</strong> <span>Ben</span></div><div class="dtc-lightbox-trigger-badge absolute bottom-3">View Full</div><img src="test.png" class="cursor-zoom-in" onclick="openImageLightbox('test.png', 'Preview')" title="View full image">`;
    const cleanedHtml = ctx.cleanDtcExportHtml(dirtyHtml);
    assert.ok(!cleanedHtml.includes('contenteditable'), 'Must strip contenteditable');
    assert.ok(!cleanedHtml.includes('onblur'), 'Must strip onblur');
    assert.ok(!cleanedHtml.includes('点击可直接编辑'), 'Must strip editor title tooltip');
    assert.ok(!cleanedHtml.includes('dtc-lightbox-trigger-badge'), 'Must strip lightbox trigger badge');
    assert.ok(!cleanedHtml.includes('openImageLightbox'), 'Must strip openImageLightbox onclick');
    assert.ok(!cleanedHtml.includes('cursor-zoom-in'), 'Must strip cursor-zoom-in');
    assert.ok(!cleanedHtml.includes('View full image'), 'Must strip lightbox title tooltip');
    assert.ok(cleanedHtml.includes('Title'), 'Retains content');
    assert.ok(cleanedHtml.includes('<strong>Feat:</strong> <span>Ben</span>'), 'Retains inner DOM');
});

test('openImageLightbox and closeImageLightbox manage modal state and target lightboxImage element', () => {
    function makeElement(classes = '') {
        const cls = new Set(classes.split(' ').filter(Boolean));
        const el = {
            className: classes,
            value: '',
            innerHTML: '',
            src: '',
            href: '',
            download: '',
            textContent: '',
            classList: {
                add: (c) => cls.add(c),
                remove: (c) => cls.delete(c),
                toggle: (c, force) => {
                    if (force !== undefined) {
                        force ? cls.add(c) : cls.delete(c);
                    } else {
                        cls.has(c) ? cls.delete(c) : cls.add(c);
                    }
                },
                contains: (c) => cls.has(c)
            }
        };
        return el;
    }

    const modal = makeElement('hidden');
    const lightboxImage = makeElement();
    const lightboxTitle = makeElement();
    const lightboxDownloadBtn = makeElement();
    const lightboxDownloadText = makeElement();

    const { ctx } = createTestContext({
        detailImageLightboxModal: modal,
        lightboxImage: lightboxImage,
        lightboxTitle: lightboxTitle,
        lightboxDownloadBtn: lightboxDownloadBtn,
        lightboxDownloadText: lightboxDownloadText
    });

    // 1. Open lightbox
    ctx.openImageLightbox('http://127.0.0.1:9503/static/outputs/test.png', 'Ergo Chair Hero');
    assert.strictEqual(modal.classList.contains('hidden'), false, 'Modal should not be hidden');
    assert.strictEqual(modal.classList.contains('flex'), true, 'Modal should have flex class');
    assert.strictEqual(lightboxImage.src, 'http://127.0.0.1:9503/static/outputs/test.png', 'Image src should be set');
    assert.strictEqual(lightboxTitle.textContent, 'Ergo Chair Hero', 'Title should be set');
    assert.strictEqual(lightboxDownloadBtn.href, 'http://127.0.0.1:9503/static/outputs/test.png');
    assert.strictEqual(lightboxDownloadText.textContent, 'Download Full Size');

    // 2. Close lightbox
    ctx.closeImageLightbox();
    assert.strictEqual(modal.classList.contains('hidden'), true, 'Modal should be hidden');
    assert.strictEqual(modal.classList.contains('flex'), false, 'Modal should remove flex class');
});

test('renderRestoredDetailProject correctly activates hybrid view, restores language, and formats relative image paths', () => {
    function makeElement(classes = '') {
        const cls = new Set(classes.split(' ').filter(Boolean));
        const el = {
            className: classes,
            value: '',
            innerHTML: '',
            insertAdjacentHTML: (pos, html) => {
                el.innerHTML += html;
            },
            classList: {
                add: (c) => cls.add(c),
                remove: (c) => cls.delete(c),
                toggle: (c, force) => {
                    if (force !== undefined) {
                        force ? cls.add(c) : cls.delete(c);
                    } else {
                        cls.has(c) ? cls.delete(c) : cls.add(c);
                    }
                },
                contains: (c) => cls.has(c)
            }
        };
        return el;
    }

    const languageSelect = makeElement();
    const showcaseArea = makeElement('flex');
    const resultArea = makeElement('hidden');
    const modulesResultContainer = makeElement();
    const dtcHybridContainer = makeElement('hidden');
    const btnViewHybrid = makeElement();
    const btnViewGallery = makeElement();
    const dtcViewportControls = makeElement('hidden');
    const modeBtnHybrid = makeElement();
    const modeBtnImages = makeElement();

    const { ctx } = createTestContext({
        languageSelect,
        sellingPointsText: makeElement(),
        productNameInput: makeElement(),
        productFactsText: makeElement(),
        forbiddenClaimsText: makeElement(),
        showcaseArea,
        resultArea,
        modulesResultContainer,
        dtcHybridContainer,
        btnViewHybrid,
        btnViewGallery,
        dtcViewportControls,
        modeBtnHybrid,
        modeBtnImages
    });

    const mockProject = {
        kind: 'detail-page-project',
        presentationMode: 'hybrid',
        config: {
            language: 'English',
            aspectRatio: '1:1'
        },
        sellingPoints: 'Premium ergonomic chair',
        uploadedImages: [
            { imageSrc: '/static/uploads/input1.png' }
        ],
        modules: [
            {
                id: 'm1',
                title: '首屏核心卖点',
                imageSrc: '/static/outputs/mod1.png',
                active: true,
                dtcCopy: {
                    tagline: 'ULTIMATE COMFORT',
                    headline: 'Engineered for Performance',
                    valueProposition: 'All day ergonomic support',
                    trustBadges: ['30-Day Guarantee']
                }
            },
            {
                id: 'm2',
                title: '核心痛点解决',
                imageSrc: '/static/outputs/mod2.png',
                active: true,
                dtcCopy: {
                    tagline: 'PAIN RELIEF',
                    headline: 'End Lower Back Pain',
                    fbr: [{ feature: 'Lumbar support', benefit: 'Relieves lower back pain' }]
                }
            }
        ]
    };

    const success = ctx.renderRestoredDetailProject(mockProject);
    assert.strictEqual(success, true, 'Restoration must succeed');
    assert.strictEqual(languageSelect.value, 'English', 'Language select must be restored');
    assert.strictEqual(ctx.getDetailResultView(), 'hybrid', 'Result view must be hybrid');
    assert.strictEqual(dtcHybridContainer.classList.contains('hidden'), false, 'DTC container must not be hidden');
    assert.strictEqual(modulesResultContainer.classList.contains('hidden'), true, 'Modules gallery container must be hidden');

    // Check formatted task image URLs
    assert.strictEqual(ctx.globalGenContext.tasks.m1.imageSrc, 'http://127.0.0.1:9503/static/outputs/mod1.png');
    assert.strictEqual(ctx.globalGenContext.tasks.m2.imageSrc, 'http://127.0.0.1:9503/static/outputs/mod2.png');

    // Check rendered hybrid HTML has no 404 relative paths
    assert.ok(dtcHybridContainer.innerHTML.includes('http://127.0.0.1:9503/static/outputs/mod1.png'));
    assert.ok(dtcHybridContainer.innerHTML.includes('http://127.0.0.1:9503/static/outputs/mod2.png'));
});

test('renderDtcHybridPreview strictly filters out Chinese characters when target language is English', () => {
    function makeElement(classes = '') {
        const cls = new Set(classes.split(' ').filter(Boolean));
        return {
            className: classes,
            value: '',
            innerHTML: '',
            classList: {
                add: (c) => cls.add(c),
                remove: (c) => cls.delete(c),
                contains: (c) => cls.has(c)
            }
        };
    }

    const dtcHybridContainer = makeElement();
    const { ctx } = createTestContext({
        dtcHybridContainer
    });

    ctx.globalGenContext = {
        config: { productName: 'ErgoPro Chair', language: 'English' },
        sellingPoints: 'Premium ergonomic chair',
        tasks: {
            m1: {
                id: 'm1',
                title: '首屏核心卖点',
                imageSrc: 'http://127.0.0.1:9503/static/outputs/m1.png',
                dtcCopy: {
                    tagline: '首屏核心卖点',
                    headline: '体验极致舒适',
                    valueProposition: '全天候支撑您的脊椎',
                    trustBadges: ['✓ 30天免费试用']
                }
            },
            m2: {
                id: 'm2',
                title: '核心痛点解决',
                imageSrc: 'http://127.0.0.1:9503/static/outputs/m2.png',
                dtcCopy: {
                    tagline: '核心痛点解决',
                    headline: '告别腰酸背痛',
                    subheadline: '人体工学校准',
                    fbr: [{ feature: '动态腰靠', benefit: '自动适应坐姿' }]
                }
            }
        }
    };

    ctx.renderDtcHybridPreview();

    // When language is English, Chinese text must be replaced with English defaults and no Chinese characters should appear in the rendered container
    const hasChinese = /[\u4e00-\u9fa5]/.test(dtcHybridContainer.innerHTML);
    assert.strictEqual(hasChinese, false, `Rendered HTML must not contain Chinese characters, but found: ${dtcHybridContainer.innerHTML.match(/[\u4e00-\u9fa5]+/g)}`);
    assert.ok(dtcHybridContainer.innerHTML.includes('TARGETED BENEFIT'));
    assert.ok(dtcHybridContainer.innerHTML.includes('View full image'));
});

test('DTC_LAYOUT_STYLES defines 5 distinct aesthetic styles with full metadata', () => {
    const { ctx } = createTestContext();
    assert.ok(ctx.DTC_LAYOUT_STYLES, 'DTC_LAYOUT_STYLES must be defined');
    const styles = ['editorial', 'minimalist', 'bento', 'lookbook', 'technical'];
    styles.forEach(id => {
        const style = ctx.DTC_LAYOUT_STYLES[id];
        assert.ok(style, `Style ${id} must exist in DTC_LAYOUT_STYLES`);
        assert.strictEqual(style.id, id);
        assert.ok(style.name, `Style ${id} must have a name`);
        assert.ok(style.nameEn, `Style ${id} must have an English name`);
        assert.ok(style.desc, `Style ${id} must have a description`);
        assert.ok(style.badge, `Style ${id} must have a badge`);
    });
});

test('getDtcLayoutStyle and setDtcLayoutStyle manage layout style state and UI sync', () => {
    const dtcLayoutStyleSelect = { value: 'editorial' };
    const resultStyleSelect = { value: 'editorial' };
    const dtcCurrentStyleBadge = { textContent: '' };
    const dtcStyleDescriptionHint = { textContent: '' };
    const dtcHybridContainer = { innerHTML: '' };

    const { ctx } = createTestContext({
        dtcLayoutStyleSelect,
        resultStyleSelect,
        dtcCurrentStyleBadge,
        dtcStyleDescriptionHint,
        dtcHybridContainer
    });

    assert.strictEqual(ctx.getDtcLayoutStyle(), 'editorial');

    // Switch to minimalist
    ctx.setDtcLayoutStyle('minimalist', false);
    assert.strictEqual(ctx.getDtcLayoutStyle(), 'minimalist');
    assert.strictEqual(dtcLayoutStyleSelect.value, 'minimalist');
    assert.strictEqual(resultStyleSelect.value, 'minimalist');
    assert.match(dtcCurrentStyleBadge.textContent, /苹果大图|极简|Minimalist/i);
    assert.ok(dtcStyleDescriptionHint.textContent.length > 0);

    // Switch to bento
    ctx.setDtcLayoutStyle('bento', false);
    assert.strictEqual(ctx.getDtcLayoutStyle(), 'bento');
    assert.strictEqual(dtcLayoutStyleSelect.value, 'bento');
    assert.strictEqual(resultStyleSelect.value, 'bento');

    // Switch to lookbook
    ctx.setDtcLayoutStyle('lookbook', false);
    assert.strictEqual(ctx.getDtcLayoutStyle(), 'lookbook');
    assert.strictEqual(dtcLayoutStyleSelect.value, 'lookbook');

    // Switch to technical
    ctx.setDtcLayoutStyle('technical', false);
    assert.strictEqual(ctx.getDtcLayoutStyle(), 'technical');
    assert.strictEqual(dtcLayoutStyleSelect.value, 'technical');

    // Invalid style falls back to editorial
    ctx.setDtcLayoutStyle('invalid_style', false);
    assert.strictEqual(ctx.getDtcLayoutStyle(), 'editorial');
    assert.strictEqual(dtcLayoutStyleSelect.value, 'editorial');
});

test('renderDtcHybridPreview supports all 5 styles and clean HTML export across styles', () => {
    const dtcHybridContainer = { innerHTML: '' };
    const { ctx } = createTestContext({
        dtcHybridContainer
    });

    ctx.globalGenContext = {
        config: { productName: 'Ergonomic Standing Desk Pro', language: 'English' },
        sellingPoints: 'Dual-motor standing desk with anti-collision memory',
        tasks: {
            m1: {
                id: 'm1',
                title: '首屏核心卖点',
                imageSrc: 'http://127.0.0.1:9503/static/outputs/desk1.png',
                dtcCopy: {
                    tagline: 'PEAK PERFORMANCE',
                    headline: 'Effortless Height Transition',
                    subheadline: 'Whisper-quiet dual motors take you from sitting to standing in under 8 seconds.',
                    fbr: [
                        { feature: 'Dual Motor Power', benefit: 'Smooth lift up to 300 lbs capacity' },
                        { feature: 'Memory Presets', benefit: '4 programmable heights with 1-touch recall' }
                    ]
                }
            },
            m2: {
                id: 'm2',
                title: '材质与耐用度',
                imageSrc: 'http://127.0.0.1:9503/static/outputs/desk2.png',
                dtcCopy: {
                    tagline: 'SOLID CRAFTSMANSHIP',
                    headline: 'Industrial Steel Frame',
                    subheadline: 'Zero wobble even at maximum extended height.',
                    fbr: [
                        { feature: 'Heavy-Duty Steel', benefit: 'Built for decades of everyday durability' }
                    ]
                }
            },
            m11: {
                id: 'm11',
                title: '常见疑虑解答',
                dtcCopy: {
                    faqs: [
                        { q: 'Is assembly complicated?', a: 'Setup takes under 20 minutes with pre-drilled holes and clear instructions.' }
                    ]
                }
            }
        }
    };

    // 1. Test Editorial Layout
    ctx.setDtcLayoutStyle('editorial', false);
    ctx.renderDtcHybridPreview();
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-style-editorial'), 'Must contain dtc-style-editorial');
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-alternating-grid'), 'Must contain dtc-alternating-grid');
    assert.ok(dtcHybridContainer.innerHTML.includes('contenteditable="true"'), 'Must have inline editing attribute');
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-lightbox-trigger-badge'), 'Must have lightbox trigger badge');

    // 2. Test Minimalist Layout
    ctx.setDtcLayoutStyle('minimalist', false);
    ctx.renderDtcHybridPreview();
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-style-minimalist'), 'Must contain dtc-style-minimalist');
    assert.ok(dtcHybridContainer.innerHTML.includes('PEAK PERFORMANCE'), 'Hero section must include tagline');
    assert.ok(dtcHybridContainer.innerHTML.includes('Effortless Height Transition'), 'Must include headline');
    assert.ok(dtcHybridContainer.innerHTML.includes('backdrop-blur-md'), 'Must contain frosted glass capsules');

    // 3. Test Bento Layout
    ctx.setDtcLayoutStyle('bento', false);
    ctx.renderDtcHybridPreview();
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-style-bento'), 'Must contain dtc-style-bento');
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-bento-grid'), 'Must contain dtc-bento-grid');

    // 4. Test Lookbook Layout
    ctx.setDtcLayoutStyle('lookbook', false);
    ctx.renderDtcHybridPreview();
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-style-lookbook'), 'Must contain dtc-style-lookbook');
    assert.ok(dtcHybridContainer.innerHTML.includes('font-serif'), 'Must include font-serif aesthetic');

    // 5. Test Technical Layout
    ctx.setDtcLayoutStyle('technical', false);
    ctx.renderDtcHybridPreview();
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-style-technical'), 'Must contain dtc-style-technical');
    assert.ok(dtcHybridContainer.innerHTML.includes('bg-[#0B0F19]'), 'Must include dark cyber background');
    assert.ok(dtcHybridContainer.innerHTML.includes('SPEC_01'), 'Must include technical spec tag');

    // Test cleanDtcExportHtml removes editor & lightbox attributes from technical layout
    const dirtyHtml = dtcHybridContainer.innerHTML;
    const cleanHtml = ctx.cleanDtcExportHtml(dirtyHtml);
    assert.ok(!cleanHtml.includes('contenteditable'), 'Clean HTML must strip contenteditable');
    assert.ok(!cleanHtml.includes('onblur='), 'Clean HTML must strip onblur');
    assert.ok(!cleanHtml.includes('dtc-lightbox-trigger-badge'), 'Clean HTML must strip lightbox badges');
    assert.ok(!cleanHtml.includes('openImageLightbox'), 'Clean HTML must strip lightbox triggers');
    assert.ok(cleanHtml.includes('Effortless Height Transition'), 'Clean HTML retains text content');
});

test('collectCurrentRenderProject and renderRestoredDetailProject persist and restore layoutStyle', () => {
    const dtcHybridContainer = { innerHTML: '', classList: { toggle: () => {} } };
    const modulesResultContainer = {
        innerHTML: '',
        insertAdjacentHTML: (pos, html) => { modulesResultContainer.innerHTML += html; },
        classList: { toggle: () => {} }
    };
    const resultArea = { classList: { remove: () => {}, add: () => {} } };

    const { ctx } = createTestContext({
        dtcHybridContainer,
        modulesResultContainer,
        resultArea
    });

    ctx.globalGenContext = {
        config: { productName: 'Ultra Gaming Monitor', language: 'English' },
        sellingPoints: '240Hz OLED Curved Gaming Display',
        longImageOrder: ['m1'],
        tasks: {
            m1: {
                id: 'm1',
                title: '首屏核心卖点',
                imageSrc: 'http://127.0.0.1:9503/static/outputs/mon1.png',
                dtcCopy: { headline: 'True 240Hz Speed' }
            }
        }
    };

    // Set layoutStyle to technical
    ctx.setDtcLayoutStyle('technical', false);
    assert.strictEqual(ctx.getDtcLayoutStyle(), 'technical');

    // Collect project snapshot
    const project = ctx.collectCurrentRenderProject('final_preview.png');
    assert.ok(project, 'Project snapshot collected');
    assert.strictEqual(project.layoutStyle, 'technical', 'Saved project must record current layoutStyle');

    // Switch current style to lookbook
    ctx.setDtcLayoutStyle('lookbook', false);
    assert.strictEqual(ctx.getDtcLayoutStyle(), 'lookbook');

    // Restore saved project
    const restored = ctx.renderRestoredDetailProject(project);
    assert.strictEqual(restored, true, 'Project must restore successfully');
    assert.strictEqual(ctx.getDtcLayoutStyle(), 'technical', 'Restored project must restore layoutStyle to technical');
});

test('mobile viewport styling and responsive structure across all 5 styles', () => {
    const dtcHybridContainer = { innerHTML: '', classList: { toggle: () => {} } };
    const { ctx } = createTestContext({
        dtcHybridContainer
    });

    ctx.globalGenContext = {
        config: { productName: 'Ergonomic Desk & Chair Kit', language: 'English' },
        sellingPoints: 'Premium ergonomic system',
        longImageOrder: ['m1', 'm2', 'm3', 'm4', 'm12', 'm10', 'm13', 'm14', 'm11'],
        tasks: {
            m1: { id: 'm1', title: '首屏核心卖点', imageSrc: 'http://127.0.0.1:9503/static/m1.png', dtcCopy: { headline: 'Hero Head', tagline: 'TAG1', subheadline: 'Sub1', fbr: [{ feature: 'F1', benefit: 'B1' }] } },
            m2: { id: 'm2', title: '核心痛点解决', imageSrc: 'http://127.0.0.1:9503/static/m2.png', dtcCopy: { headline: 'Pain Head', tagline: 'TAG2', subheadline: 'Sub2', fbr: [{ feature: 'F2', benefit: 'B2' }] } },
            m3: { id: 'm3', title: '材质工艺', imageSrc: 'http://127.0.0.1:9503/static/m3.png', dtcCopy: { headline: 'Material Head', tagline: 'TAG3', subheadline: 'Sub3', fbr: [{ feature: 'F3', benefit: 'B3' }] } },
            m4: { id: 'm4', title: '全景展示', imageSrc: 'http://127.0.0.1:9503/static/m4.png', dtcCopy: { headline: 'Banner Head', tagline: 'TAG4', subheadline: 'Sub4', fbr: [{ feature: 'F4', benefit: 'B4' }] } },
            m12: { id: 'm12', title: '使用指南', dtcCopy: { headline: 'Steps Head', steps: [{ step: 1, title: 'S1', instruction: 'I1' }] } },
            m10: { id: 'm10', title: '规格清单', dtcCopy: { headline: 'Specs Head', specifications: [{ label: 'L', value: 'V' }], packageIncludes: ['P1'] } },
            m13: { id: 'm13', title: '套装开箱', imageSrc: 'http://127.0.0.1:9503/static/box.png', dtcCopy: { headline: 'Box Head', items: [{ name: 'N1', count: '1x' }] } },
            m14: { id: 'm14', title: '套装立省', dtcCopy: { headline: 'Save Head', bundleComparison: { bundlePrice: '$99' } } },
            m11: { id: 'm11', title: '常见问题', dtcCopy: { faqs: [{ q: 'Q1', a: 'A1' }] } }
        }
    };

    // Activate mobile viewport
    ctx.setDtcViewport('mobile');

    // 1. Editorial mobile layout
    ctx.setDtcLayoutStyle('editorial', false);
    ctx.renderDtcHybridPreview();
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-viewport-mobile'));
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-alternating-grid'));
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-bundle-box-grid'));
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-bundle-savings-grid'));

    // 2. Minimalist mobile layout
    ctx.setDtcLayoutStyle('minimalist', false);
    ctx.renderDtcHybridPreview();
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-viewport-mobile'));
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-minimalist-hero'));
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-minimalist-card'));
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-minimalist-img'));
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-minimalist-content'));

    // 3. Bento mobile layout
    ctx.setDtcLayoutStyle('bento', false);
    ctx.renderDtcHybridPreview();
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-viewport-mobile'));
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-bento-grid'));
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-bento-tile'));
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-bento-hero'));
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-bento-banner'));
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-bento-banner-img'));

    // 4. Lookbook mobile layout
    ctx.setDtcLayoutStyle('lookbook', false);
    ctx.renderDtcHybridPreview();
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-viewport-mobile'));
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-lookbook-item'));
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-lookbook-mat'));
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-lookbook-chips'));

    // 5. Technical mobile layout
    ctx.setDtcLayoutStyle('technical', false);
    ctx.renderDtcHybridPreview();
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-viewport-mobile'));
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-technical-card'));
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-technical-img'));
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-technical-content'));

    // Reset viewport to desktop
    ctx.setDtcViewport('desktop');
    ctx.renderDtcHybridPreview();
    assert.ok(dtcHybridContainer.innerHTML.includes('dtc-viewport-desktop'));
});

test('cleanDtcExportHtml normalizes mobile viewport and copyShopifyHtml includes self-contained dependencies', async () => {
    let clipboardText = '';
    const { ctx } = createTestContext({
        dtcHybridContainer: {
            innerHTML: '<div class="dtc-pdp-wrapper dtc-style-editorial dtc-viewport-mobile"><div class="dtc-accordion-item"><div class="dtc-accordion-header" onclick="toggleDtcAccordion(this)">Q</div><div class="dtc-accordion-body">A</div></div></div>',
            querySelector: (sel) => {
                if (sel === '.dtc-pdp-wrapper') {
                    return {
                        outerHTML: '<div class="dtc-pdp-wrapper dtc-style-editorial dtc-viewport-mobile"><div class="dtc-accordion-item"><div class="dtc-accordion-header" onclick="toggleDtcAccordion(this)">Q</div><div class="dtc-accordion-body">A</div></div></div>'
                    };
                }
                return null;
            }
        }
    });

    // 1. cleanDtcExportHtml normalizes dtc-viewport-mobile to dtc-viewport-desktop
    const mobileHtml = '<div class="dtc-pdp-wrapper dtc-viewport-mobile">content</div>';
    const cleaned = ctx.cleanDtcExportHtml(mobileHtml);
    assert.ok(!cleaned.includes('dtc-viewport-mobile'), 'Should remove dtc-viewport-mobile');
    assert.ok(cleaned.includes('dtc-viewport-desktop'), 'Should replace with dtc-viewport-desktop');

    // 2. copyShopifyHtml includes Phosphor webfont, scoped CSS, and accordion script
    ctx.navigator = {
        clipboard: {
            writeText: async (text) => { clipboardText = text; }
        }
    };
    ctx.globalGenContext = { tasks: { m1: {} } };

    await ctx.copyShopifyHtml();
    assert.ok(clipboardText.includes('phosphor-icons'), 'Must include phosphor-icons link');
    assert.ok(clipboardText.includes('.dtc-pdp-wrapper'), 'Must include scoped CSS');
    assert.ok(clipboardText.includes('toggleDtcAccordion'), 'Must include accordion toggle script');
    assert.ok(clipboardText.includes('dtc-viewport-desktop'), 'Exported wrapper should be desktop responsive');
    assert.ok(!clipboardText.includes('dtc-viewport-mobile'), 'Exported wrapper must not have dtc-viewport-mobile');
});

test('DTC_BRAND_COLORS defines 7 presets and setDtcBrandColor applies dynamic CSS properties', () => {
    const brandProps = {};
    const wrapper = {
        style: {
            setProperty: (k, v) => { brandProps[k] = v; }
        }
    };
    const brandSelect = { value: '' };
    const resultSelect = { value: '' };
    const badge = { textContent: '' };
    const indicator = { style: {} };

    const { ctx } = createTestContext({
        '.dtc-pdp-wrapper': wrapper,
        dtcBrandColorSelect: brandSelect,
        resultColorSelect: resultSelect,
        dtcCurrentColorBadge: badge,
        dtcColorIndicator: indicator
    });

    assert.ok(ctx.DTC_BRAND_COLORS, 'DTC_BRAND_COLORS exists');
    assert.strictEqual(Object.keys(ctx.DTC_BRAND_COLORS).length, 7);
    assert.ok(ctx.DTC_BRAND_COLORS.indigo);
    assert.ok(ctx.DTC_BRAND_COLORS.emerald);
    assert.ok(ctx.DTC_BRAND_COLORS.orange);
    assert.ok(ctx.DTC_BRAND_COLORS.rose);
    assert.ok(ctx.DTC_BRAND_COLORS.cyan);
    assert.ok(ctx.DTC_BRAND_COLORS.slate);
    assert.ok(ctx.DTC_BRAND_COLORS.amber);

    assert.strictEqual(ctx.getDtcBrandColor(), 'indigo');

    ctx.setDtcBrandColor('emerald', false);
    assert.strictEqual(ctx.getDtcBrandColor(), 'emerald');
    assert.strictEqual(brandProps['--dtc-accent'], '#059669');
    assert.strictEqual(brandProps['--dtc-accent-light'], '#ecfdf5');
    assert.strictEqual(brandProps['--dtc-accent-border'], '#a7f3d0');
    assert.strictEqual(brandProps['--dtc-accent-text'], '#047857');
    assert.strictEqual(brandSelect.value, 'emerald');
    assert.strictEqual(resultSelect.value, 'emerald');
    assert.strictEqual(indicator.style.backgroundColor, '#059669');

    ctx.setDtcBrandColor('orange', false);
    assert.strictEqual(ctx.getDtcBrandColor(), 'orange');
    assert.strictEqual(brandProps['--dtc-accent'], '#ea580c');
    assert.strictEqual(brandProps['--dtc-accent-light'], '#fff7ed');
    assert.strictEqual(brandProps['--dtc-accent-border'], '#ffedd5');
    assert.strictEqual(brandProps['--dtc-accent-text'], '#c2410c');
    assert.strictEqual(brandSelect.value, 'orange');
    assert.strictEqual(resultSelect.value, 'orange');
    assert.strictEqual(indicator.style.backgroundColor, '#ea580c');
});

test('CRO Trust Guarantee Bar toggles and renders 4 guarantees in both languages', () => {
    const toggle = { checked: false };
    const { ctx } = createTestContext({
        dtcTrustBarToggle: toggle
    });

    assert.strictEqual(ctx.getDtcTrustBarEnabled(), true); // default enabled
    ctx.setDtcTrustBarEnabled(false, false);
    assert.strictEqual(ctx.getDtcTrustBarEnabled(), false);
    assert.strictEqual(toggle.checked, false);

    ctx.toggleDtcTrustBar(true);
    assert.strictEqual(ctx.getDtcTrustBarEnabled(), true);
    assert.strictEqual(toggle.checked, true);

    const enHtml = ctx.renderDtcTrustBar(false, 'editorial');
    assert.ok(enHtml.includes('dtc-trust-bar'));
    assert.ok(enHtml.includes('Free Shipping'));
    assert.ok(enHtml.includes('30-Day Money Back'));
    assert.ok(enHtml.includes('1-Year Warranty'));
    assert.ok(enHtml.includes('24/7 Dedicated Support'));
    assert.ok(enHtml.includes('ph-truck'));
    assert.ok(enHtml.includes('ph-shield-check'));
    assert.ok(enHtml.includes('ph-seal-check'));
    assert.ok(enHtml.includes('ph-headset'));

    const zhHtml = ctx.renderDtcTrustBar(true, 'editorial');
    assert.ok(zhHtml.includes('全场免运费'));
    assert.ok(zhHtml.includes('30天无忧试用'));
    assert.ok(zhHtml.includes('1年正品联保'));
    assert.ok(zhHtml.includes('7×24专属客服'));
});

test('selectModuleImage swaps module image, restores status, and updates DOM', () => {
    const { ctx } = createTestContext();
    ctx.globalGenContext = {
        tasks: {
            m1: {
                id: 'm1',
                imageSrc: 'http://127.0.0.1:9503/static/old.png',
                status: 'error',
                error: 'generation failed'
            }
        }
    };
    ctx.currentUploadedImages = ['/primary.png', '/angle1.png', '/angle2.png'];

    ctx.selectModuleImage('m1', '/angle1.png');

    const task = ctx.globalGenContext.tasks['m1'];
    assert.strictEqual(task.imageSrc, '/angle1.png');
    assert.strictEqual(task.status, 'success');
    assert.strictEqual(task.error, '');
});

test('cleanDtcExportHtml strips swap buttons and modular copy buttons', () => {
    const { ctx } = createTestContext();
    const rawWithControls = `
    <div class="dtc-section-container" data-section="fbr">
        <div class="dtc-section-actions">
            <button onclick="copyDtcSectionHtml('fbr', '核心卖点')">复制</button>
        </div>
        <div class="dtc-image-plate">
            <img src="/test.png">
            <button type="button" class="dtc-image-swap-btn" onclick="event.stopPropagation(); openModuleImagePicker('m1')" title="替换当前模块图片">
                <i class="ph-bold ph-swap"></i> 换图
            </button>
        </div>
    </div>`;

    const cleaned = ctx.cleanDtcExportHtml(rawWithControls);
    assert.ok(!cleaned.includes('dtc-image-swap-btn'), 'Should strip swap button');
    assert.ok(!cleaned.includes('dtc-section-actions'), 'Should strip section actions');
    assert.ok(!cleaned.includes('openModuleImagePicker'), 'Should strip openModuleImagePicker call');
    assert.ok(!cleaned.includes('copyDtcSectionHtml'), 'Should strip copyDtcSectionHtml call');
    assert.ok(cleaned.includes('<img src="/test.png">'), 'Should preserve image content');
});

test('copyDtcSectionHtml copies scoped modular HTML and copySeoMetadataToClipboard formats structured SEO', async () => {
    let copiedText = '';
    const mockClipboard = {
        writeText: async (text) => { copiedText = text; }
    };

    const sectionFbr = {
        outerHTML: '<section class="dtc-section-container" data-section="fbr"><h2>Key Features</h2><p>Feature text</p></section>',
        innerHTML: '<h2>Key Features</h2><p>Feature text</p>',
        querySelectorAll: () => []
    };

    const container = {
        querySelector: (sel) => {
            if (sel === '[data-section="fbr"]') return sectionFbr;
            return null;
        }
    };

    const { ctx } = createTestContext({
        dtcHybridContainer: container
    });
    ctx.navigator = { clipboard: mockClipboard };
    ctx.setDtcBrandColor('cyan', false);

    const fbrResult = await ctx.copyDtcSectionHtml('fbr', '核心卖点');
    assert.ok(fbrResult.includes('dtc-modular-section'));
    assert.ok(fbrResult.includes('--dtc-accent: #0891b2'));
    assert.ok(fbrResult.includes('Key Features'));
    assert.strictEqual(copiedText, fbrResult);

    // Test copySeoMetadataToClipboard
    ctx.globalGenContext = {
        config: {
            productName: 'Ergonomic Standing Desk',
            platform: 'Shopify',
            platformLabel: 'Shopify DTC',
            language: 'en',
            languageLabel: 'English'
        },
        tasks: {
            m1: {
                id: 'm1',
                title: '首屏核心卖点',
                displayTitle: 'Hero Showcase',
                seo: {
                    titleTarget: 'Motorized Standing Desk - Dual Motor Heavy Duty',
                    altTextTarget: 'Ergonomic motorized standing desk front view at 120cm height',
                    titleZh: '电动升降桌 - 双电机大承重',
                    altTextZh: '电动升降桌正面图 120cm 高度'
                }
            }
        }
    };

    const seoResult = await ctx.copySeoMetadataToClipboard();
    assert.ok(seoResult.includes('=== SEO METADATA: Ergonomic Standing Desk ==='));
    assert.ok(seoResult.includes('Shopify DTC'));
    assert.ok(seoResult.includes('[Module 1: Hero Showcase (m1)]'));
    assert.ok(seoResult.includes('Motorized Standing Desk - Dual Motor Heavy Duty'));
    assert.ok(seoResult.includes('Ergonomic motorized standing desk front view at 120cm height'));
    assert.ok(seoResult.includes('电动升降桌 - 双电机大承重'));
    assert.strictEqual(copiedText, seoResult);
});

test('Long Image customization controls gap, radius, and canvas background', () => {
    const canvas = {
        style: {
            backgroundColor: '#ffffff'
        }
    };
    const { ctx } = createTestContext({
        longImageCanvas: canvas
    });

    ctx.setLongImageGap(24);
    assert.strictEqual(ctx.getLongImageGap(), 24);

    ctx.setLongImageRadius(16);
    assert.strictEqual(ctx.getLongImageRadius(), 16);

    ctx.setLongImageBgColor('#0f172a');
    assert.strictEqual(ctx.getLongImageBgColor(), '#0f172a');
    assert.strictEqual(canvas.style.backgroundColor, '#0f172a');
});

test('buildDtcStandaloneStylesheet generates self-contained styles with WordPress and Shopify immunity', () => {
    const { ctx } = createTestContext();
    const color = { primary: '#ea580c', light: '#fff7ed', border: '#ffedd5', text: '#c2410c' };

    // 1. Full PDP Stylesheet
    const fullPdpCss = ctx.buildDtcStandaloneStylesheet(color, false);
    assert.ok(fullPdpCss.includes('.dtc-pdp-wrapper'), 'Must include .dtc-pdp-wrapper scope');
    assert.ok(fullPdpCss.includes('--dtc-accent: #ea580c'), 'Must bind brand primary color');
    assert.ok(fullPdpCss.includes('@import url'), 'Must include Phosphor @import inside <style>');
    assert.ok(fullPdpCss.includes('<link rel="stylesheet"'), 'Must include Phosphor <link>');
    assert.ok(fullPdpCss.includes('p:empty'), 'Must contain defensive reset for WordPress empty paragraphs');
    assert.ok(fullPdpCss.includes('list-style: none !important'), 'Must contain defensive reset for theme list bullets');
    assert.ok(fullPdpCss.includes('box-sizing: border-box !important'), 'Must enforce border-box on all elements');
    assert.ok(fullPdpCss.includes('img.object-cover'), 'Must enforce object-fit cover on images');
    assert.ok(fullPdpCss.includes('.dtc-alternating-grid'), 'Must include alternating grid layout');
    assert.ok(fullPdpCss.includes('.dtc-steps-grid'), 'Must include steps grid layout');
    assert.ok(fullPdpCss.includes('.dtc-specs-grid'), 'Must include specs grid layout');
    assert.ok(fullPdpCss.includes('.dtc-trust-bar'), 'Must include trust bar grid layout');
    assert.ok(fullPdpCss.includes('details.dtc-accordion-item[open]'), 'Must support native zero-JS details element');

    // 2. Modular Section Stylesheet
    const modularCss = ctx.buildDtcStandaloneStylesheet(color, true);
    assert.ok(modularCss.includes('.dtc-modular-section'), 'Must include .dtc-modular-section scope');
    assert.ok(modularCss.includes('--dtc-accent: #ea580c'), 'Must bind brand primary color');
    assert.ok(modularCss.includes('details.dtc-accordion-item[open]'), 'Must support zero-JS details in modular section');
});

test('cleanDtcExportHtml compresses newlines to neutralize WordPress wpautop paragraph injection', () => {
    const { ctx } = createTestContext();
    const rawHtmlWithGaps = `
    <div class="dtc-alternating-grid">

        <div class="item-1">

            <h3>Title</h3>

        </div>


        <div class="item-2">
            <p>Content</p>
        </div>

    </div>`;

    const cleaned = ctx.cleanDtcExportHtml(rawHtmlWithGaps);
    assert.ok(!/>\s*[\r\n]{2,}\s*</.test(cleaned), 'Must not contain double line breaks between tags');
    assert.ok(cleaned.includes('>'), 'Retains tags');
});

test('renderDtcFaqSection outputs semantic details and summary with zero-JS and script resilience', () => {
    const { ctx } = createTestContext();
    const mockTasks = [{
        id: 'faq1',
        dtcCopy: {
            faqs: [
                { q: 'How fast is delivery?', a: 'Standard shipping arrives in 3-5 days.' },
                { q: 'Can I return it?', a: '30-day money back guarantee.' }
            ]
        }
    }];

    const html = ctx.renderDtcFaqSection(mockTasks, false, 'editorial');
    assert.ok(html.includes('<details class="dtc-accordion-item'), 'FAQ card must be rendered as semantic <details>');
    assert.ok(html.includes('<summary class="dtc-accordion-header'), 'FAQ header must be rendered as semantic <summary>');
    assert.ok(html.includes('open'), 'First FAQ item must have open attribute by default');
    assert.ok(html.includes('How fast is delivery?'), 'Contains question text');
    assert.ok(html.includes('Standard shipping arrives in 3-5 days.'), 'Contains answer text');
});

test('renderDtcImagePlate includes SEO alt and lazy loading for Shopify and WordPress performance', () => {
    const { ctx } = createTestContext();
    const plate = ctx.renderDtcImagePlate('https://cdn.example.com/desk.jpg', 'Hero Desk Showcase', false);
    assert.ok(plate.includes('alt="Hero Desk Showcase"'), 'Must have alt text for SEO compliance');
    assert.ok(plate.includes('loading="lazy"'), 'Must have loading="lazy" for web performance');
    assert.ok(plate.includes('aspect-square'), 'Must retain aspect ratio class');
});

test('computeCustomBrandColor and setDtcCustomBrandColor calculate dynamic palette and apply custom brand styles', () => {
    const { ctx } = createTestContext();

    // 1. computeCustomBrandColor calculations
    const customViolet = ctx.computeCustomBrandColor('#8b5cf6');
    assert.strictEqual(customViolet.id, 'custom');
    assert.strictEqual(customViolet.primary, '#8b5cf6');
    assert.ok(customViolet.light.startsWith('rgb('), 'Must derive rgb light background');
    assert.ok(customViolet.border.startsWith('rgb('), 'Must derive rgb border');
    assert.ok(customViolet.text.startsWith('rgb('), 'Must derive rgb text');

    // 2. Shorthand hex #f00 expands to #ff0000
    const customRed = ctx.computeCustomBrandColor('#f00');
    assert.strictEqual(customRed.primary, '#ff0000');

    // 3. Fallback on invalid hex
    const invalidFallback = ctx.computeCustomBrandColor('not-a-color');
    assert.strictEqual(invalidFallback.primary, '#4f46e5');

    // 4. setDtcCustomBrandColor updates currentDtcBrandColor, map, and indicator
    const indicator = { style: {} };
    const badge = { textContent: '' };
    const customPanel = { classList: { remove: () => {}, add: () => {} } };
    const customInput = { value: '' };
    const customHexInput = { value: '' };

    const ctxWithDom = createTestContext({
        dtcColorIndicator: indicator,
        dtcCurrentColorBadge: badge,
        dtcCustomColorPanel: customPanel,
        dtcCustomColorInput: customInput,
        dtcCustomColorHex: customHexInput
    }).ctx;

    ctxWithDom.setDtcCustomBrandColor('#10b981', false);
    assert.strictEqual(ctxWithDom.getDtcBrandColor(), 'custom');
    assert.strictEqual(indicator.style.backgroundColor, '#10b981');
    assert.strictEqual(badge.textContent, '#10B981');
});

test('DTC_FONT_FAMILIES, DTC_TYPOGRAPHY_PRESETS, and DTC_DEFAULT_TYPOGRAPHY are properly defined and accessible', () => {
    const { ctx } = createTestContext();

    assert.ok(ctx.DTC_FONT_FAMILIES, 'DTC_FONT_FAMILIES must exist');
    assert.ok(ctx.DTC_FONT_FAMILIES.inter, 'Inter font must exist');
    assert.ok(ctx.DTC_FONT_FAMILIES.playfair, 'Playfair Display font must exist');
    assert.ok(ctx.DTC_FONT_FAMILIES['plus-jakarta'], 'Plus Jakarta Sans font must exist');

    assert.ok(ctx.DTC_TYPOGRAPHY_PRESETS, 'DTC_TYPOGRAPHY_PRESETS must exist');
    assert.ok(ctx.DTC_TYPOGRAPHY_PRESETS.modern, 'Modern preset must exist');
    assert.ok(ctx.DTC_TYPOGRAPHY_PRESETS.luxury, 'Luxury preset must exist');
    assert.ok(ctx.DTC_TYPOGRAPHY_PRESETS.tech, 'Tech preset must exist');
    assert.ok(ctx.DTC_TYPOGRAPHY_PRESETS.pop, 'Pop preset must exist');
    assert.ok(ctx.DTC_TYPOGRAPHY_PRESETS.minimalist, 'Minimalist preset must exist');

    assert.ok(ctx.DTC_DEFAULT_TYPOGRAPHY, 'DTC_DEFAULT_TYPOGRAPHY must exist');
    assert.strictEqual(ctx.DTC_DEFAULT_TYPOGRAPHY.templateId, 'modern');
    assert.strictEqual(ctx.DTC_DEFAULT_TYPOGRAPHY.fontFamily, 'inter');
    assert.strictEqual(ctx.DTC_DEFAULT_TYPOGRAPHY.titleWeight, '700');
});

test('applyDtcTypography and getDtcTypography manage typography state and inject CSS variables', () => {
    let injectedStyleText = '';
    const mockStyleEl = {
        id: '',
        set textContent(val) { injectedStyleText = val; },
        get textContent() { return injectedStyleText; }
    };

    const docMock = {
        getElementById: (id) => id === 'dtc-dynamic-typography-style' ? mockStyleEl : null,
        querySelector: () => null,
        createElement: (tag) => tag === 'style' ? mockStyleEl : {},
        head: { appendChild: () => {} },
        body: { appendChild: () => {}, removeChild: () => {} }
    };

    const { ctx } = createTestContext();
    ctx.document = docMock;

    const luxuryConfig = {
        templateId: 'luxury',
        fontFamily: 'plus-jakarta',
        titleFont: 'playfair',
        titleSize: '32px',
        titleWeight: '600',
        titleSpacing: '0.01em',
        subtitleSize: '18px',
        subtitleWeight: '500',
        bodySize: '14px',
        bodyWeight: '300',
        bodyLineHeight: '1.7'
    };

    ctx.applyDtcTypography(luxuryConfig, false);
    const activeTypo = ctx.getDtcTypography();
    assert.strictEqual(activeTypo.templateId, 'luxury');
    assert.strictEqual(activeTypo.fontFamily, 'plus-jakarta');
    assert.strictEqual(activeTypo.titleFont, 'playfair');
    assert.strictEqual(activeTypo.titleSize, '32px');

    assert.ok(injectedStyleText.includes('--dtc-title-size: 32px !important'), 'Injected CSS must set title size');
    assert.ok(injectedStyleText.includes('--dtc-title-weight: 600 !important'), 'Injected CSS must set title weight');
    assert.ok(injectedStyleText.includes('--dtc-body-line-height: 1.7 !important'), 'Injected CSS must set body line-height');
});

test('saveCustomTypographyTemplate and deleteCustomTypographyTemplate manage user templates in localStorage', () => {
    const storage = {};
    const { ctx } = createTestContext();
    ctx.localStorage = {
        getItem: (k) => storage[k] || null,
        setItem: (k, v) => { storage[k] = v; },
        removeItem: (k) => { delete storage[k]; }
    };

    // 1. Initial saved templates empty
    let saved = ctx.getSavedCustomTypographyTemplates();
    assert.strictEqual(Object.keys(saved).length, 0);

    // 2. Save a custom template
    storage.dtc_saved_typography_templates = JSON.stringify({
        store1: {
            name: 'Store Elegant',
            fontFamily: 'playfair',
            titleFont: 'playfair',
            titleSize: '36px',
            titleWeight: '700'
        }
    });

    saved = ctx.getSavedCustomTypographyTemplates();
    assert.ok(saved.store1, 'Custom template store1 must be returned');
    assert.strictEqual(saved.store1.name, 'Store Elegant');
    assert.strictEqual(saved.store1.titleSize, '36px');
});

test('buildDtcStandaloneStylesheet with custom brand color and typography embeds Google Web Fonts import and rules', () => {
    const { ctx } = createTestContext();
    const customBrandColor = ctx.computeCustomBrandColor('#059669');
    const customTypography = {
        fontFamily: 'poppins',
        titleFont: 'playfair',
        titleSize: '32px',
        titleWeight: '700',
        titleSpacing: '-0.01em',
        subtitleSize: '18px',
        subtitleWeight: '600',
        bodySize: '14px',
        bodyWeight: '500',
        bodyLineHeight: '1.6'
    };

    const standaloneCss = ctx.buildDtcStandaloneStylesheet(customBrandColor, false, customTypography);

    // 1. Google Fonts @import
    assert.ok(standaloneCss.includes('@import url(\'https://fonts.googleapis.com/css2?'), 'Must include Google Fonts @import');
    assert.ok(standaloneCss.includes('Poppins'), 'Must include Poppins in Google font import');
    assert.ok(standaloneCss.includes('Playfair+Display'), 'Must include Playfair Display in Google font import');

    // 2. Color and Typography variables
    assert.ok(standaloneCss.includes('--dtc-accent: #059669;'), 'Must set custom brand accent color');
    assert.ok(standaloneCss.includes('--dtc-title-size: 32px;'), 'Must set custom title size');
    assert.ok(standaloneCss.includes('--dtc-title-weight: 700;'), 'Must set custom title weight');
    assert.ok(standaloneCss.includes('--dtc-body-weight: 500;'), 'Must set custom body weight');

    // 3. Heading selectors
    assert.ok(standaloneCss.includes('.dtc-pdp-wrapper h1, .dtc-pdp-wrapper h2'), 'Must scope heading rules');
    assert.ok(standaloneCss.includes('.dtc-pdp-wrapper h3'), 'Must scope subtitle rules');
});

test('collectCurrentRenderProject and renderRestoredDetailProject persist and restore customBrandColor and typography', () => {
    const { ctx } = createTestContext();
    ctx.globalGenContext = {
        tasks: {
            m1: { id: 'm1', title: 'Feature', status: 'success', imageSrc: 'img1.png' }
        },
        config: { productName: 'Ergonomic Desk' }
    };

    // Set custom brand color and custom typography
    ctx.setDtcCustomBrandColor('#7c3aed', false);
    ctx.applyDtcTypography({
        templateId: 'tech',
        fontFamily: 'plus-jakarta',
        titleFont: 'space-grotesk',
        titleSize: '32px',
        titleWeight: '800',
        titleSpacing: '-0.03em',
        subtitleSize: '18px',
        subtitleWeight: '700',
        bodySize: '14px',
        bodyWeight: '400',
        bodyLineHeight: '1.5'
    }, false);

    // Collect project snapshot
    const project = ctx.collectCurrentRenderProject('final.png');
    assert.strictEqual(project.brandColor, 'custom');
    assert.strictEqual(project.customBrandColor, '#7c3aed');
    assert.ok(project.typography);
    assert.strictEqual(project.typography.templateId, 'tech');
    assert.strictEqual(project.typography.titleFont, 'space-grotesk');

    // Restore to another context with proper DOM containers
    const dtcHybridContainer = { innerHTML: '', classList: { toggle: () => {} } };
    const modulesResultContainer = {
        innerHTML: '',
        insertAdjacentHTML: (pos, html) => { modulesResultContainer.innerHTML += html; },
        classList: { toggle: () => {} }
    };
    const resultArea = { classList: { remove: () => {}, add: () => {} } };

    const restoredCtx = createTestContext({
        dtcHybridContainer,
        modulesResultContainer,
        resultArea
    }).ctx;
    const restored = restoredCtx.renderRestoredDetailProject(project);
    assert.strictEqual(restored, true, 'Project must restore successfully');

    assert.strictEqual(restoredCtx.getDtcBrandColor(), 'custom');
    const restoredTypo = restoredCtx.getDtcTypography();
    assert.strictEqual(restoredTypo.templateId, 'tech');
    assert.strictEqual(restoredTypo.titleFont, 'space-grotesk');
    assert.strictEqual(restoredTypo.titleWeight, '800');
});
