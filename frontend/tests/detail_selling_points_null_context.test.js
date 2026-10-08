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

test('generateSellingPoints does not throw when globalGenContext is null', async () => {
    const aiWriteBtn = { innerHTML: '提炼卖点', disabled: false };
    const productNameInput = { value: 'Ergonomic Desk Chair' };
    const sellingPointsText = { value: '' };
    const productFactsText = { value: '' };
    const forbiddenClaimsText = { value: '' };

    const { ctx } = createTestContext({
        aiWriteBtn,
        productNameInput,
        sellingPointsText,
        productFactsText,
        forbiddenClaimsText
    });

    // Explicitly set globalGenContext to null, simulating fresh page load before any image generation
    ctx.globalGenContext = null;
    if (ctx.window) ctx.window.globalGenContext = null;
    if (ctx.globalThis) ctx.globalThis.globalGenContext = null;

    // Mock callAI to return mock selling points
    ctx.callAI = async () => ({
        candidates: [{
            content: {
                parts: [{
                    text: JSON.stringify({
                        product_name: 'Ergonomic Desk Chair',
                        selling_points: '1. Lumbar support\n2. Breathable mesh',
                        product_facts: 'Mesh back, aluminum base',
                        forbidden_claims: 'No medical pain cure',
                        recommended_image_style: 'Apple Keynote 极简发布会风'
                    })
                }]
            }
        }]
    });

    let remoteLogErrors = [];
    ctx.remoteLog = (msg) => {
        if (msg.includes('失败') || msg.includes('error') || msg.includes('Error')) {
            remoteLogErrors.push(msg);
        }
    };

    // Calling generateSellingPoints must NOT fail with Cannot set properties of null (setting 'productFacts')
    await ctx.generateSellingPoints();

    assert.strictEqual(
        remoteLogErrors.length,
        0,
        `generateSellingPoints failed with remoteLog: ${remoteLogErrors.join('; ')}`
    );
    assert.ok(ctx.globalGenContext, 'globalGenContext should have been initialized');
    assert.ok(ctx.globalGenContext.productFacts, 'productFacts should be set on globalGenContext');
    assert.strictEqual(ctx.globalGenContext.productFacts.productName.value, 'Ergonomic Desk Chair');
});

test('confirmAllProductFacts and confirmProductFactItem handle null globalGenContext gracefully', () => {
    const { ctx } = createTestContext();

    ctx.globalGenContext = null;
    assert.doesNotThrow(() => {
        ctx.confirmAllProductFacts();
    });
    assert.ok(ctx.globalGenContext, 'globalGenContext should be initialized');
    assert.ok(ctx.globalGenContext.productFacts, 'productFacts should be populated');

    ctx.globalGenContext = null;
    assert.doesNotThrow(() => {
        ctx.confirmProductFactItem('material');
    });
    assert.ok(ctx.globalGenContext, 'globalGenContext should be initialized');
    assert.ok(ctx.globalGenContext.productFacts, 'productFacts should be populated');
});
