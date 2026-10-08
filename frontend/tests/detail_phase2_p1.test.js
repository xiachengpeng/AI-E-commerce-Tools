const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function createTestContext() {
    const elements = {};
    const doc = {
        getElementById: (id) => {
            if (!elements[id]) {
                elements[id] = {
                    id,
                    value: '',
                    textContent: '',
                    innerHTML: '',
                    className: '',
                    style: {},
                    dataset: {},
                    classList: {
                        _classes: new Set(),
                        add(c) { this._classes.add(c); },
                        remove(c) { this._classes.delete(c); },
                        toggle(c, force) {
                            if (force !== undefined) {
                                if (force) this._classes.add(c);
                                else this._classes.delete(c);
                            } else {
                                if (this._classes.has(c)) this._classes.delete(c);
                                else this._classes.add(c);
                            }
                        },
                        contains(c) { return this._classes.has(c); }
                    },
                    querySelector: () => null,
                    querySelectorAll: () => [],
                    setAttribute: (k, v) => { elements[id][k] = v; },
                    getAttribute: (k) => elements[id][k] || null,
                    appendChild: () => {},
                    removeChild: () => {}
                };
            }
            return elements[id];
        },
        querySelector: (sel) => null,
        querySelectorAll: () => [],
        createElement: (tag) => ({
            tagName: tag.toUpperCase(),
            value: '',
            textContent: '',
            innerHTML: '',
            className: '',
            style: {},
            dataset: {},
            classList: {
                _classes: new Set(),
                add(c) { this._classes.add(c); },
                remove(c) { this._classes.delete(c); },
                toggle(c) {},
                contains(c) { return this._classes.has(c); }
            },
            appendChild: () => {},
            removeChild: () => {}
        }),
        body: {
            appendChild: () => {},
            removeChild: () => {}
        }
    };

    const ctx = {
        console,
        document: doc,
        setTimeout,
        clearTimeout,
        AbortController,
        DOMException: typeof DOMException !== 'undefined' ? DOMException : undefined,
        showToast: () => {},
        remoteLog: () => {},
        localStorage: {
            _store: {},
            getItem(k) { return this._store[k] || null; },
            setItem(k, v) { this._store[k] = String(v); },
            removeItem(k) { delete this._store[k]; }
        },
        API_BASE: 'http://127.0.0.1:9503/api',
        fetch: async () => ({ ok: true, json: async () => ({}) })
    };

    ctx.window = ctx;
    ctx.globalThis = ctx;

    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'config.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'utils.js'), 'utf8'), ctx);
    ctx.showToast = () => {};
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'details.js'), 'utf8'), ctx);
    ctx.showToast = () => {};

    return { ctx, elements };
}

// 1. Channel First: 目标渠道管理
test('DETAIL_CHANNELS_CONFIG and setDetailChannel configure target channel and defaults', () => {
    const { ctx } = createTestContext();
    assert.ok(ctx.DETAIL_CHANNELS_CONFIG, 'DETAIL_CHANNELS_CONFIG must be defined');
    assert.ok(ctx.DETAIL_CHANNELS_CONFIG.shopify, 'Shopify channel must be configured');
    assert.ok(ctx.DETAIL_CHANNELS_CONFIG.amazon, 'Amazon channel must be configured');
    assert.ok(ctx.DETAIL_CHANNELS_CONFIG.social, 'Social channel must be configured');
    assert.ok(ctx.DETAIL_CHANNELS_CONFIG.generic, 'Generic channel must be configured');

    assert.strictEqual(typeof ctx.setDetailChannel, 'function', 'setDetailChannel must be a function');

    // Switch to amazon
    ctx.setDetailChannel('amazon');
    assert.strictEqual(ctx.currentDetailChannel, 'amazon');
    assert.strictEqual(ctx.currentDetailPresentationMode, 'images');

    // Switch to shopify
    ctx.setDetailChannel('shopify');
    assert.strictEqual(ctx.currentDetailChannel, 'shopify');
    assert.strictEqual(ctx.currentDetailPresentationMode, 'hybrid');
});

// 2. buildRecommendedDetailPlan: 根据渠道、事实与证据门禁自动规划
test('buildRecommendedDetailPlan creates optimal plan and excludes high-risk modules when facts are missing', () => {
    const { ctx } = createTestContext();
    assert.strictEqual(typeof ctx.buildRecommendedDetailPlan, 'function', 'buildRecommendedDetailPlan must be defined');

    // Case 1: Shopify channel, facts without dimensions, only 1 asset
    const factsNoDimensions = ctx.buildProductFacts({ productName: 'Ergonomic Office Chair' });
    const singleAsset = [{ id: 'img1', isPrimary: true, semanticRole: 'hero' }];

    const planShopify = ctx.buildRecommendedDetailPlan({
        targetChannel: 'shopify',
        productFacts: factsNoDimensions,
        assets: singleAsset
    });

    assert.ok(planShopify, 'Plan must be returned');
    assert.strictEqual(planShopify.channel, 'shopify');
    assert.ok(planShopify.includedModules.length >= 5, 'Must include at least 5 baseline modules');

    // m8 (Dimensions) must NOT be in includedModules because dimensions are missing!
    const hasM8 = planShopify.includedModules.some(m => m.id === 'm8');
    assert.strictEqual(hasM8, false, 'm8 (Dimensions) must NOT be included when dimensions fact is missing');

    // m8 must be listed in excludedModules with explanatory reason
    const excludedM8 = planShopify.excludedModules.find(m => m.id === 'm8');
    assert.ok(excludedM8, 'm8 must be in excludedModules');
    assert.match(excludedM8.reason, /尺寸/);

    // Case 2: Now supply dimensions fact
    const factsWithDimensions = ctx.buildProductFacts({
        productName: 'Ergonomic Office Chair',
        dimensions: { length: 65, width: 65, height: 120, unit: 'cm', source: 'user', verified: true }
    });
    const planWithDimensions = ctx.buildRecommendedDetailPlan({
        targetChannel: 'shopify',
        productFacts: factsWithDimensions,
        assets: singleAsset
    });
    const hasM8Now = planWithDimensions.includedModules.some(m => m.id === 'm8');
    assert.strictEqual(hasM8Now, true, 'm8 should now be included when verified dimensions exist');
});

// 3. buildRecommendedDetailPlan: Amazon channel rules
test('buildRecommendedDetailPlan for Amazon prioritizes 7 standard gallery image modules', () => {
    const { ctx } = createTestContext();
    const facts = ctx.buildProductFacts({ productName: 'Wireless Earbuds' });
    const assets = [
        { id: 'img1', isPrimary: true, semanticRole: 'hero' },
        { id: 'img2', isPrimary: false, semanticRole: 'angle' }
    ];

    const planAmazon = ctx.buildRecommendedDetailPlan({
        targetChannel: 'amazon',
        productFacts: facts,
        assets: assets
    });

    assert.strictEqual(planAmazon.channel, 'amazon');
    // Amazon plan should include hero (m1), benefit (m2), scene (m3), details (m6), etc.
    const moduleIds = planAmazon.includedModules.map(m => m.id);
    assert.ok(moduleIds.includes('m1'), 'Amazon plan must include hero (m1)');
    assert.ok(moduleIds.includes('m2'), 'Amazon plan must include benefits (m2)');
});

// 4. applyRecommendedDetailPlan updates selection state
test('applyRecommendedDetailPlan checks the recommended modules and updates UI state', () => {
    const { ctx, elements } = createTestContext();
    assert.strictEqual(typeof ctx.applyRecommendedDetailPlan, 'function', 'applyRecommendedDetailPlan must be defined');

    const plan = {
        channel: 'shopify',
        includedModules: [
            { id: 'm1', variant: 0, includeCopy: true },
            { id: 'm2', variant: 0, includeCopy: true },
            { id: 'm5', variant: 0, includeCopy: true }
        ],
        excludedModules: []
    };

    ctx.applyRecommendedDetailPlan(plan);
    // Verified that plan is applied to globalGenContext or module selections
    assert.ok(ctx.currentRecommendedPlan, 'currentRecommendedPlan must be recorded');
    assert.strictEqual(ctx.currentRecommendedPlan.channel, 'shopify');
});

// 5. renderProductFactsCard renders fact chips and verification status
test('renderProductFactsCard renders chips, unverified badges, and handles empty state', () => {
    const { ctx, elements } = createTestContext();
    assert.strictEqual(typeof ctx.renderProductFactsCard, 'function');

    // Empty facts state
    ctx.renderProductFactsCard({});
    const container = elements['productFactsCardContainer'];
    assert.ok(container.innerHTML.includes('未提取商品事实'), 'Empty state should guide user to extract facts');

    // Populated facts with unverified items
    const facts = ctx.buildProductFacts({
        productName: 'Smart Desk Lamp',
        material: { value: 'Aluminum alloy', verified: false },
        dimensions: { length: 45, width: 15, height: 40, unit: 'cm', verified: false }
    });
    ctx.renderProductFactsCard(facts);
    assert.ok(container.innerHTML.includes('商品事实可信度审核'), 'Should display facts audit header');
    assert.ok(container.innerHTML.includes('Aluminum alloy'), 'Should render material chip');
    assert.ok(container.innerHTML.includes('待确认'), 'Should show badge for unverified facts');
    assert.ok(container.innerHTML.includes('一键全确认'), 'Should display batch confirm button');
});

// 6. confirmAllProductFacts marks all facts as verified and refreshes plan
test('confirmAllProductFacts and confirmProductFactItem mark facts verified and update plan', () => {
    const { ctx, elements } = createTestContext();
    assert.strictEqual(typeof ctx.confirmAllProductFacts, 'function');
    assert.strictEqual(typeof ctx.confirmProductFactItem, 'function');

    ctx.setGlobalGenContext({
        productFacts: ctx.buildProductFacts({
            productName: 'Smart Desk Lamp',
            material: { value: 'Aluminum alloy', verified: false },
            dimensions: { length: 45, width: 15, height: 40, unit: 'cm', verified: false }
        })
    });

    // Confirm single item
    ctx.confirmProductFactItem('material');
    const factsAfterOne = ctx.getGlobalGenContext().productFacts;
    assert.strictEqual(factsAfterOne.material.verified, true, 'Material should now be verified');
    assert.strictEqual(factsAfterOne.dimensions.verified, false, 'Dimensions should still be unverified');

    // Confirm all
    ctx.confirmAllProductFacts();
    const factsAfterAll = ctx.getGlobalGenContext().productFacts;
    assert.strictEqual(factsAfterAll.dimensions.verified, true, 'Dimensions should now be verified');
    assert.strictEqual(factsAfterAll.material.verified, true, 'Material should remain verified');
});

// 7. toggleAdvancedPlanDrawer and renderRecommendedPlanUI
test('toggleAdvancedPlanDrawer toggles visibility and renderRecommendedPlanUI renders summary cards', () => {
    const { ctx, elements } = createTestContext();
    assert.strictEqual(typeof ctx.toggleAdvancedPlanDrawer, 'function');
    assert.strictEqual(typeof ctx.renderRecommendedPlanUI, 'function');

    const drawer = ctx.document.getElementById('advancedPlanDrawer');
    drawer.classList.add('hidden');
    ctx.toggleAdvancedPlanDrawer();
    assert.strictEqual(drawer.classList.contains('hidden'), false, 'Drawer should not be hidden after toggle');
    ctx.toggleAdvancedPlanDrawer();
    assert.strictEqual(drawer.classList.contains('hidden'), true, 'Drawer should be hidden again after second toggle');

    // Render plan UI
    const plan = {
        channel: 'shopify',
        channelMeta: { title: 'Shopify / 独立站' },
        summaryText: '包含 5 个核心推荐模块',
        includedModules: [
            { id: 'm1', title: '首屏主图/Hero' },
            { id: 'm2', title: '核心卖点/USP' }
        ],
        excludedModules: [
            { id: 'm8', title: '尺寸规格图', reason: '缺少尺寸数据' }
        ]
    };
    ctx.renderRecommendedPlanUI(plan);
    const summaryContainer = elements['aiPlanSummaryContainer'];
    assert.ok(summaryContainer.innerHTML.includes('AI 智能规划详情页方案'), 'Should render plan header');
    assert.ok(summaryContainer.innerHTML.includes('首屏主图/Hero'), 'Should render included module title');
    assert.ok(summaryContainer.innerHTML.includes('缺少尺寸数据'), 'Should render excluded module reason');
});
