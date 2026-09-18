const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function createAbortTestContext(domElements = {}) {
    const elements = { ...domElements };
    const doc = {
        getElementById: (id) => elements[id] || null,
        querySelector: (selector) => elements[selector] || null,
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

    const ctx = {
        console,
        document: doc,
        setTimeout,
        clearTimeout,
        AbortController,
        DOMException: typeof DOMException !== 'undefined' ? DOMException : undefined,
        showToast: (msg, type) => { lastToast = { msg, type }; },
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
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'utils.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'details.js'), 'utf8'), ctx);

    ctx.showToast = (msg, type) => { lastToast = { msg, type }; };

    return { ctx, elements, getLastToast: () => lastToast };
}

test('abortDetailGeneration returns false when idle and true when active', () => {
    const generateBtn = { disabled: false, innerHTML: '' };
    const abortBtn = { classList: { add: () => {}, remove: () => {} } };
    const statusBar = { classList: { add: () => {}, remove: () => {} } };

    const { ctx, getLastToast } = createAbortTestContext({
        generateBtn,
        abortDetailGenBtn: abortBtn,
        detailGenerationStatusBar: statusBar
    });

    // When idle
    assert.strictEqual(ctx.abortDetailGeneration(), false);

    // Simulate active generation
    vm.runInContext('isDetailGenerating = true; detailGenerationAbortController = new AbortController();', ctx);

    const res = ctx.abortDetailGeneration();
    assert.strictEqual(res, true);
    assert.strictEqual(vm.runInContext('isDetailGenerating', ctx), false);
    assert.strictEqual(getLastToast()?.type, 'info');
    assert.match(getLastToast()?.msg, /已终止生成流程/);
});

test('abortableDelay resolves normally or rejects immediately on abort signal', async () => {
    const { ctx } = createAbortTestContext();

    // 1. Normal delay
    const start = Date.now();
    await ctx.abortableDelay(20);
    assert.ok(Date.now() - start >= 15);

    // 2. Pre-aborted signal
    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(
        () => ctx.abortableDelay(100, preAborted.signal),
        (err) => err.name === 'AbortError'
    );

    // 3. Abort midway
    const midwayController = new AbortController();
    const midwayPromise = ctx.abortableDelay(500, midwayController.signal);
    setTimeout(() => midwayController.abort(), 20);
    await assert.rejects(
        () => midwayPromise,
        (err) => err.name === 'AbortError'
    );
});

test('fetchWithRetry immediately stops and throws on AbortError without retrying', async () => {
    const { ctx } = createAbortTestContext();

    let fetchCount = 0;
    ctx.fetch = async () => {
        fetchCount++;
        const err = new Error('The user aborted a request.');
        err.name = 'AbortError';
        throw err;
    };

    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        () => ctx.fetchWithRetry('http://test.local', { signal: controller.signal }, 5),
        (err) => err.name === 'AbortError'
    );

    // Should only be called once, never retrying through delays
    assert.strictEqual(fetchCount, 1);
});

test('updateDetailGeneratingUI toggles buttons and status bar correctly', () => {
    let btnDisabled = false;
    let abortBtnHidden = true;
    let statusBarHidden = true;

    const generateBtn = {
        set disabled(val) { btnDisabled = val; },
        get disabled() { return btnDisabled; },
        innerHTML: ''
    };
    const abortDetailGenBtn = {
        classList: {
            add: (cls) => { if (cls === 'hidden') abortBtnHidden = true; },
            remove: (cls) => { if (cls === 'hidden') abortBtnHidden = false; }
        }
    };
    const detailGenerationStatusBar = {
        classList: {
            add: (cls) => { if (cls === 'hidden') statusBarHidden = true; },
            remove: (cls) => { if (cls === 'hidden') statusBarHidden = false; }
        }
    };
    const detailGenProgressText = { textContent: '' };

    const { ctx } = createAbortTestContext({
        generateBtn,
        abortDetailGenBtn,
        detailGenerationStatusBar,
        detailGenProgressText
    });

    // When starting generation
    ctx.updateDetailGeneratingUI(true, 2, 7);
    assert.strictEqual(btnDisabled, true);
    assert.strictEqual(abortBtnHidden, false);
    assert.strictEqual(statusBarHidden, false);
    assert.match(detailGenProgressText.textContent, /2\/7/);

    // When finishing/aborted
    ctx.updateDetailGeneratingUI(false);
    assert.strictEqual(btnDisabled, false);
    assert.strictEqual(abortBtnHidden, true);
    assert.strictEqual(statusBarHidden, true);
});

test('generateSingleWrap marks task as cancelled on abort rather than triggering fallback', async () => {
    let badgeClass = '';
    let badgeText = '';
    let contentHtml = '';

    const contentDiv = {
        set innerHTML(val) { contentHtml = val; },
        get innerHTML() { return contentHtml; },
        classList: { add: () => {}, remove: () => {} },
        style: {}
    };
    const statusBadge = {
        set className(val) { badgeClass = val; },
        set textContent(val) { badgeText = val; }
    };
    const regenBtn = { classList: { add: () => {}, remove: () => {} } };

    const { ctx } = createAbortTestContext({
        'content-mod-m1': contentDiv,
        'status-badge-m1': statusBadge,
        'regen-btn-m1': regenBtn
    });

    const abortController = new AbortController();
    ctx.globalGenContext = {
        config: { aspectRatio: '1:1' },
        sellingPoints: 'Lumbar support chair',
        primaryImage: { base64: 'data:image/png;base64,mock', mimeType: 'image/png', data: 'mock' },
        tasks: {
            m1: { id: 'm1', uniqueId: 'm1', title: '首屏卖点', status: 'pending' }
        }
    };

    ctx.callAI = async () => {
        // Abort while request is pending
        abortController.abort();
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
    };

    const result = await ctx.generateSingleWrap('m1', false, '', abortController.signal);

    assert.strictEqual(result.status, 'cancelled');
    assert.strictEqual(ctx.globalGenContext.tasks.m1.status, 'cancelled');
    assert.strictEqual(ctx.globalGenContext.tasks.m1.isFallback, false);
    assert.strictEqual(badgeText, '已终止');
    assert.match(contentHtml, /生成已手动终止/);
});

test('resetView returns from result area to showcase area', () => {
    let resultHidden = false;
    let showcaseHidden = true;

    const resultArea = {
        classList: {
            add: (cls) => { if (cls === 'hidden') resultHidden = true; },
            remove: (cls) => { if (cls === 'hidden') resultHidden = false; }
        }
    };
    const showcaseArea = {
        classList: {
            add: (cls) => { if (cls === 'hidden') showcaseHidden = true; },
            remove: (cls) => { if (cls === 'hidden') showcaseHidden = false; }
        }
    };

    const { ctx } = createAbortTestContext({
        resultArea,
        showcaseArea
    });

    ctx.resetView();

    assert.strictEqual(resultHidden, true);
    assert.strictEqual(showcaseHidden, false);
});

test('generateSingleWrap marks task as error on AI failure without substituting mock raw photo', async () => {
    let badgeClass = '';
    let badgeText = '';
    let contentHtml = '';
    let regenBtnHidden = true;

    const contentDiv = {
        set innerHTML(val) { contentHtml = val; },
        get innerHTML() { return contentHtml; },
        classList: { add: () => {}, remove: () => {} },
        style: {}
    };
    const statusBadge = {
        set className(val) { badgeClass = val; },
        set textContent(val) { badgeText = val; }
    };
    const regenBtn = {
        classList: {
            add: (cls) => { if (cls === 'hidden') regenBtnHidden = true; },
            remove: (cls) => { if (cls === 'hidden') regenBtnHidden = false; }
        }
    };

    const { ctx } = createAbortTestContext({
        'content-mod-m1': contentDiv,
        'status-badge-m1': statusBadge,
        'regen-btn-m1': regenBtn
    });

    ctx.globalGenContext = {
        config: { aspectRatio: '1:1' },
        sellingPoints: 'Lumbar support chair',
        primaryImage: { base64: 'data:image/png;base64,raw_user_photo', mimeType: 'image/png', data: 'mock' },
        tasks: {
            m1: { id: 'm1', uniqueId: 'm1', title: '首屏卖点', status: 'pending' }
        }
    };

    ctx.callAI = async () => {
        throw new Error('Image model quota exceeded');
    };

    const result = await ctx.generateSingleWrap('m1', false, '');

    assert.strictEqual(result.status, 'error');
    assert.strictEqual(ctx.globalGenContext.tasks.m1.status, 'error');
    assert.strictEqual(ctx.globalGenContext.tasks.m1.isFallback, false);
    assert.strictEqual(ctx.globalGenContext.tasks.m1.imageSrc, '');
    assert.strictEqual(badgeText, '失败');
    assert.match(contentHtml, /图片生成失败/);
    assert.match(contentHtml, /Image model quota exceeded/);
    assert.match(contentHtml, /点击重新生成此模块/);
    assert.strictEqual(regenBtnHidden, false);
});
