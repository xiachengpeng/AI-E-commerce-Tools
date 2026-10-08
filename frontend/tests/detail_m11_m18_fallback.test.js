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

// ============================================================================
// m11 Case A: 无 Warranty / Return / Shipping / Support 降级为 customer_care
// ============================================================================
test('m11 Case A: Without verified warranty/trust facts, downgrades to customer_care mode without blocking', () => {
    const { ctx } = createTestContext();

    const emptyProject = {
        facts: { warranty: null, returnPolicy: null },
        uploadedImages: [{ id: 'img1', semanticRole: 'hero' }]
    };

    const evalM11 = ctx.evaluateTaskEvidence({ id: 'm11' }, emptyProject);
    assert.strictEqual(evalM11.allowed, true, 'm11 without warranty must be allowed');
    assert.strictEqual(evalM11.status, 'warning', 'm11 without warranty must have status warning');
    assert.strictEqual(evalM11.mode, 'customer_care', 'm11 without warranty must specify mode customer_care');

    // assertTaskGenerationAllowed should NOT throw
    assert.doesNotThrow(() => {
        ctx.assertTaskGenerationAllowed({ id: 'm11', title: '信任/售后背书' }, emptyProject);
    });

    // Prompt check: should use customer care brief and forbid fake guarantees
    const prompt = ctx.buildModuleGenerationPrompt(
        { id: 'm11', title: '信任/售后背书', mode: evalM11.mode },
        '',
        { productName: 'Wireless Earbuds' }
    );
    assert.match(prompt, /customer care|brand trust|purchase confidence/i);
    assert.match(prompt, /Do not invent warranty duration/i);
    assert.doesNotMatch(prompt, /2-Year Warranty/i);
    assert.doesNotMatch(prompt, /30-Day Return/i);
});

// ============================================================================
// m11 Case B: Verified Facts 含有 30-day returns
// ============================================================================
test('m11 Case B: With verified return policy, allows displaying return policy without inventing fake warranty', () => {
    const { ctx } = createTestContext();

    const projectWithReturn = {
        facts: {
            returnPolicy: { value: '30-day returns', source: 'user', verified: true },
            warranty: null
        },
        uploadedImages: [{ id: 'img1', semanticRole: 'hero' }]
    };

    const evalM11 = ctx.evaluateTaskEvidence({ id: 'm11' }, projectWithReturn);
    assert.strictEqual(evalM11.allowed, true);
    assert.strictEqual(evalM11.status, 'passed');
    assert.strictEqual(evalM11.mode, 'after_sales');

    const prompt = ctx.buildModuleGenerationPrompt(
        { id: 'm11', title: '信任/售后背书', mode: evalM11.mode },
        '30-day returns',
        { productName: 'Wireless Earbuds', productFacts: '30-day returns' }
    );
    assert.match(prompt, /30-day returns/i);
    assert.match(prompt, /Do not invent warranty duration/i);
});

// ============================================================================
// m18 Case A: 无 Reviews 降级为 unboxing_visual
// ============================================================================
test('m18 Case A: Without verified customer reviews, downgrades to unboxing_visual mode without blocking', () => {
    const { ctx } = createTestContext();

    const emptyProject = {
        facts: { verifiedReviews: [], realReviews: [] },
        uploadedImages: [{ id: 'img1', semanticRole: 'hero' }]
    };

    const evalM18 = ctx.evaluateTaskEvidence({ id: 'm18' }, emptyProject);
    assert.strictEqual(evalM18.allowed, true, 'm18 without reviews must be allowed via fallback');
    assert.strictEqual(evalM18.status, 'warning', 'm18 without reviews must have status warning');
    assert.strictEqual(evalM18.mode, 'unboxing_visual', 'm18 without reviews must specify mode unboxing_visual');

    // assertTaskGenerationAllowed should NOT throw
    assert.doesNotThrow(() => {
        ctx.assertTaskGenerationAllowed({ id: 'm18', title: 'UGC买家秀/社交背书' }, emptyProject);
    });

    // Prompt check: should use dedicated unboxing brief and strictly forbid 5-star / fake reviews
    const prompt = ctx.buildModuleGenerationPrompt(
        { id: 'm18', title: 'UGC买家秀/社交背书', mode: evalM18.mode },
        '',
        { productName: 'Wireless Earbuds' }
    );
    assert.match(prompt, /unboxing|lifestyle creator|hands-on/i);
    assert.match(prompt, /STRICT UGC TRUTH MANDATE|Do not render star ratings/i);
    assert.doesNotMatch(prompt, /★★★★★/);
    assert.doesNotMatch(prompt, /5-star review quote card/i);
});

// ============================================================================
// m18 Case B: 有真实 Review 进入 review_mode
// ============================================================================
test('m18 Case B: With verified customer reviews, activates review_mode using verified feedback', () => {
    const { ctx } = createTestContext();

    const projectWithReviews = {
        facts: {
            verifiedReviews: [
                { author: 'Sarah K.', text: 'The sound isolation is incredible.', rating: 5 }
            ]
        },
        uploadedImages: [{ id: 'img1', semanticRole: 'hero' }]
    };

    const evalM18 = ctx.evaluateTaskEvidence({ id: 'm18' }, projectWithReviews);
    assert.strictEqual(evalM18.allowed, true);
    assert.strictEqual(evalM18.status, 'passed');
    assert.strictEqual(evalM18.mode, 'review_mode');

    const prompt = ctx.buildModuleGenerationPrompt(
        { id: 'm18', title: 'UGC买家秀/社交背书', mode: evalM18.mode },
        'Sarah K.: The sound isolation is incredible.',
        { productName: 'Wireless Earbuds' }
    );
    assert.match(prompt, /Sarah K/i);
    assert.match(prompt, /The sound isolation is incredible/i);
});

// ============================================================================
// m17 Regression: 无内部工程资料依然 blocked
// ============================================================================
test('m17 Regression: Without internal engineering assets, remains strictly blocked (critical safety)', () => {
    const { ctx } = createTestContext();

    const emptyProject = {
        facts: {},
        uploadedImages: [{ id: 'img1', semanticRole: 'hero' }]
    };

    const evalM17 = ctx.evaluateTaskEvidence({ id: 'm17' }, emptyProject);
    assert.strictEqual(evalM17.allowed, false, 'm17 must remain blocked');
    assert.strictEqual(evalM17.status, 'blocked');

    assert.throws(() => {
        ctx.assertTaskGenerationAllowed({ id: 'm17', title: '爆炸拆解/精密构造' }, emptyProject);
    }, /未通过事实门禁/);
});
