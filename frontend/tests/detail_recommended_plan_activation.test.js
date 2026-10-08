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
        querySelector: (selector) => elements[selector] || null,
        querySelectorAll: () => [],
        createElement: (tag) => ({
            tagName: tag.toUpperCase(),
            value: '',
            textContent: '',
            className: '',
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
            appendChild: () => {},
            removeChild: () => {},
            click: () => {},
            select: () => {}
        }),
        body: { appendChild: () => {}, removeChild: () => {} }
    };

    let lastToast = null;
    const ctx = {
        console,
        document: doc,
        setTimeout,
        clearTimeout,
        AbortController,
        DOMException: typeof DOMException !== 'undefined' ? DOMException : undefined,
        remoteLog: () => {},
        localStorage: {
            _store: {},
            getItem(k) { return this._store[k] || null; },
            setItem(k, v) { this._store[k] = String(v); },
            removeItem(k) { delete this._store[k]; }
        },
        MARKET_TONE_MAP: { 'US Market': 'direct but compliant' },
        API_BASE: 'http://127.0.0.1:9503/api',
        fetch: async () => ({ ok: true, json: async () => ({}) })
    };

    ctx.window = ctx;
    ctx.globalThis = ctx;

    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'config.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'utils.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'details.js'), 'utf8'), ctx);

    ctx.showToast = (msg, type) => { lastToast = { msg, type }; };
    ctx.globalThis.showToast = ctx.showToast;
    if (ctx.window) ctx.window.showToast = ctx.showToast;

    return { ctx, elements, getLastToast: () => lastToast };
}

test('applyRecommendedDetailPlan activates modules in global modules array and updates stats badge', () => {
    const statsBadge = { textContent: '未选择模块', className: '' };
    const grid = { innerHTML: '', insertAdjacentHTML: () => {} };
    const summaryContainer = { innerHTML: '' };

    const { ctx } = createTestContext({
        moduleSelectionStatsBadge: statsBadge,
        moduleGrid: grid,
        aiPlanSummaryContainer: summaryContainer
    });

    const plan = ctx.buildRecommendedDetailPlan({
        targetChannel: 'shopify',
        productFacts: {
            productName: { value: 'Ergonomic Office Chair', verified: true },
            category: 'furniture'
        }
    });

    assert.ok(plan.includedModules.length > 0, 'Plan must include recommended modules');

    // Initially, all modules in modules array are active: false
    const initialActive = ctx.modules.filter(m => m.active);
    assert.strictEqual(initialActive.length, 0, 'Initially no modules are active');

    // Apply the plan
    ctx.applyRecommendedDetailPlan(plan);

    // After applying, ctx.modules must have the included modules active!
    const activeAfter = ctx.modules.filter(m => m.active);
    assert.strictEqual(
        activeAfter.length,
        plan.includedModules.length,
        `Active modules count (${activeAfter.length}) must match plan included modules count (${plan.includedModules.length})`
    );

    // Stats badge must NOT say '未选择模块'
    assert.doesNotMatch(statsBadge.textContent, /未选择模块/, 'Stats badge must be updated with active count');
    assert.match(statsBadge.textContent, /已选 \d+ 模块/, 'Stats badge should show selected count');
});

test('getCurrentStrategyTasks automatically applies currentRecommendedPlan if no modules are manually checked', () => {
    const sellingPointsText = { value: 'High quality ergonomic design' };
    const statsBadge = { textContent: '', className: '' };
    const grid = { innerHTML: '', insertAdjacentHTML: () => {} };

    const { ctx } = createTestContext({
        sellingPointsText,
        moduleSelectionStatsBadge: statsBadge,
        moduleGrid: grid
    });

    // Ensure all modules are inactive
    ctx.modules.forEach(m => { m.active = false; });

    // Set a recommended plan
    const plan = ctx.buildRecommendedDetailPlan({ targetChannel: 'shopify' });
    ctx.currentRecommendedPlan = plan;

    // Call getCurrentStrategyTasks without manual selection
    const tasks = ctx.getCurrentStrategyTasks();

    assert.ok(tasks && tasks.length > 0, 'Tasks should be generated from the recommended plan when no modules manually active');
});

test('initModules automatically activates recommended modules on initial plan render', () => {
    const statsBadge = { textContent: '未选择模块', className: '' };
    const grid = { innerHTML: '', insertAdjacentHTML: () => {} };
    const summaryContainer = { innerHTML: '' };

    const { ctx } = createTestContext({
        moduleSelectionStatsBadge: statsBadge,
        moduleGrid: grid,
        aiPlanSummaryContainer: summaryContainer
    });

    // Reset modules to all inactive
    ctx.modules.forEach(m => { m.active = false; });
    ctx.currentRecommendedPlan = null;
    ctx.userExplicitlyClearedModules = false;

    // Calling initModules should build recommended plan and activate them!
    ctx.initModules();

    const activeCount = ctx.modules.filter(m => m.active).length;
    assert.ok(activeCount > 0, 'Recommended modules should be active after initModules');
    assert.match(statsBadge.textContent, /已选 \d+ 模块/);
});

test('selectAllModules(false) sets userExplicitlyClearedModules and prevents auto-activation', async () => {
    const statsBadge = { textContent: '', className: '' };
    const grid = { innerHTML: '', insertAdjacentHTML: () => {} };
    const summaryContainer = { innerHTML: '' };
    const imageUpload = { value: 'test.jpg' };
    const sellingPointsText = { value: 'Ergonomic features' };

    const { ctx, getLastToast } = createTestContext({
        moduleSelectionStatsBadge: statsBadge,
        moduleGrid: grid,
        aiPlanSummaryContainer: summaryContainer,
        imageUpload,
        sellingPointsText
    });

    // Explicitly clear all modules
    ctx.selectAllModules(false);
    assert.strictEqual(ctx.userExplicitlyClearedModules, true);
    assert.strictEqual(ctx.modules.filter(m => m.active).length, 0);

    // Now calling generateAIPage should show error toast '请至少选择一个模块' and NOT auto-apply
    await ctx.generateAIPage();
    const toast = getLastToast();
    assert.ok(toast, 'Should show error toast');
    assert.strictEqual(toast.msg, '请至少选择一个模块');
    assert.strictEqual(toast.type, 'error');
});
