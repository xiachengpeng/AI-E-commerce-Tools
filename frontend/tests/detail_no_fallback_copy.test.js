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

test('generateDtcSectionCopy strictly returns null and sets error on AI failure (NO fake fallbackCopy)', async () => {
    const { ctx } = createTestContext();
    ctx.callAI = async () => { throw new Error('AI upstream timeout 504'); };

    const task = { id: 'm2', title: '痛点破局对比', subtitle: '告别腰痛' };
    const res = await ctx.generateDtcSectionCopy(task, 'Ergonomic lumbar chair', { language: 'English' });

    assert.strictEqual(res, null, 'Must return null on failure, never fabricate fallback copy');
    assert.strictEqual(task.dtcCopy, null, 'task.dtcCopy must be null on failure');
    assert.ok(task.dtcCopyError, 'task.dtcCopyError must record failure reason');
    assert.match(task.dtcCopyError, /timeout/i);
});

test('generateDtcSectionCopy does NOT inject fake bundle items or fake $129.99 pricing on failure', async () => {
    const { ctx } = createTestContext();
    ctx.callAI = async () => { throw new Error('Model rate limited'); };

    const bundleBoxTask = { id: 'm13', title: '开箱全家福' };
    const resBox = await ctx.generateDtcSectionCopy(bundleBoxTask, 'Ceramic Mug', { language: 'Chinese' });
    assert.strictEqual(resBox, null);
    assert.strictEqual(bundleBoxTask.dtcCopy, null);

    const bundleSavingsTask = { id: 'm18', title: '组合立省对比' };
    const resSavings = await ctx.generateDtcSectionCopy(bundleSavingsTask, 'Ceramic Mug', { language: 'Chinese' });
    assert.strictEqual(resSavings, null);
    assert.strictEqual(bundleSavingsTask.dtcCopy, null);
});

test('prepareTaskDtcCopy flags hasCopy=false and does NOT invent fake slogans when dtcCopy is null', () => {
    const { ctx } = createTestContext();
    const failedTask = {
        id: 'm1',
        title: '核心优势',
        subtitle: '极致体验',
        dtcCopy: null,
        dtcCopyError: 'Network error',
        subStatus: { copy: 'failed' }
    };

    const copyData = ctx.prepareTaskDtcCopy(failedTask, false);
    assert.strictEqual(copyData.hasCopy, false, 'hasCopy must be false when dtcCopy is null');
    assert.strictEqual(copyData.isCopyFailed, true, 'isCopyFailed must be true');
    assert.notStrictEqual(copyData.headline, 'Engineered for Performance', 'Must NOT inject fake default English headline');
    assert.strictEqual(copyData.fbrList.length, 0, 'fbrList must be empty on failure, not invented claims');
});

test('renderDtcStepsSection renders explicit failure notice and blocks fabricated steps when steps missing', () => {
    const { ctx } = createTestContext();
    const taskWithoutSteps = [{
        id: 'm10',
        uniqueId: 'task-steps-1',
        title: '使用步骤',
        dtcCopy: null,
        subStatus: { copy: 'failed' }
    }];

    const html = ctx.renderDtcStepsSection(taskWithoutSteps, true, 'editorial');
    assert.ok(!html.includes('取出主机并确认随附配件齐全'), 'Must NOT invent fake host unpacking steps');
    assert.ok(!html.includes('60秒极速上手'), 'Must NOT invent fake 60s setup steps');
    assert.ok(html.includes('步骤文案未生成') || html.includes('文案生成失败') || html.includes('重试生成'), 'Must render failure status or retry notice');
    assert.ok(html.includes('retryTaskAuxiliaryStep'), 'Must provide retry button for auxiliary step');
});

test('renderDtcSpecsSection blocks fabricated aerospace alloy and CE/FCC certs when specs missing', () => {
    const { ctx } = createTestContext();
    const taskWithoutSpecs = [{
        id: 'm8',
        uniqueId: 'task-specs-1',
        title: '规格参数',
        dtcCopy: null,
        subStatus: { copy: 'failed' }
    }];

    const html = ctx.renderDtcSpecsSection(taskWithoutSpecs, true, 'editorial');
    assert.ok(!html.includes('航空级合金与环保符合材料'), 'Must NOT invent fake aerospace alloy');
    assert.ok(!html.includes('CE, FCC, RoHS 国际合规认证'), 'Must NOT invent fake CE/FCC certifications');
    assert.ok(!html.includes('1 × 核心设备主机'), 'Must NOT invent fake 1x master unit');
    assert.ok(html.includes('规格参数') || html.includes('未生成') || html.includes('重试'), 'Must render failure notice or clean fallback');
});

test('renderDtcBundleBoxSection blocks fabricated 4-accessory kit when items missing', () => {
    const { ctx } = createTestContext();
    const taskWithoutBox = [{
        id: 'm13',
        uniqueId: 'task-box-1',
        title: '开箱全家福',
        dtcCopy: null,
        subStatus: { copy: 'failed' }
    }];

    const html = ctx.renderDtcBundleBoxSection(taskWithoutBox, true, 'editorial');
    assert.ok(!html.includes('多功能配件模组'), 'Must NOT invent fake accessory pack');
    assert.ok(!html.includes('极速快充适配器'), 'Must NOT invent fake power adapter');
    assert.ok(!html.includes('定制防护收纳盒'), 'Must NOT invent fake protective travel case');
    assert.ok(html.includes('未生成') || html.includes('失败') || html.includes('重试'), 'Must render failure notice or retry button');
});

test('renderDtcBundleSavingsSection blocks fabricated $129.99 pricing and discounts when comparison missing', () => {
    const { ctx } = createTestContext();
    const taskWithoutSavings = [{
        id: 'm18',
        uniqueId: 'task-savings-1',
        title: '组合立省对比',
        dtcCopy: null,
        subStatus: { copy: 'failed' }
    }];

    const html = ctx.renderDtcBundleSavingsSection(taskWithoutSavings, true, 'editorial');
    assert.ok(!html.includes('$129.99'), 'Must NOT invent fake $129.99 pricing');
    assert.ok(!html.includes('$79.99'), 'Must NOT invent fake $79.99 bundle price');
    assert.ok(!html.includes('立省 $50'), 'Must NOT invent fake save $50 discount');
    assert.ok(html.includes('未生成') || html.includes('失败') || html.includes('重试'), 'Must render explicit failure notice');
});

test('renderDtcFaqSection blocks fabricated 24h shipping and 1-year warranty when faqs missing', () => {
    const { ctx } = createTestContext();
    const faqTask = [{
        id: 'm17',
        uniqueId: 'task-faq-1',
        title: '常见疑问解答',
        dtcCopy: null,
        subStatus: { copy: 'failed' }
    }];

    const html = ctx.renderDtcFaqSection(faqTask, true, 'editorial');
    assert.ok(!html.includes('所有订单均在24小时内处理完毕'), 'Must NOT invent fake 24-hour shipping policy');
    assert.ok(!html.includes('每份购买均自动享有一年官方正品保修'), 'Must NOT invent fake 1-year warranty policy');
    assert.ok(!html.includes('我们为您提供30天无风险试用体验'), 'Must NOT invent fake 30-day money back guarantee');
    assert.ok(html.includes('未生成') || html.includes('失败') || html.includes('重试'), 'Must render failure notice or retry button');
});

test('renderEditorialLayout renders explicit copy failure card with retry button when copy fails', () => {
    const { ctx } = createTestContext();
    const fbrTasks = [{
        id: 'm1',
        uniqueId: 'task-fbr-1',
        title: '核心优势',
        subtitle: '核心卖点',
        imageSrc: 'https://example.com/img.jpg',
        dtcCopy: null,
        dtcCopyError: 'API call failed 500',
        subStatus: { overall: 'partial_success', image: 'success', copy: 'failed' }
    }];

    const html = ctx.renderEditorialLayout(fbrTasks, [], [], [], [], [], true, true);
    assert.ok(!html.includes('Engineered for Exceptional Daily Performance'), 'Must NOT contain fake default English headline');
    assert.ok(html.includes('文案生成失败') || html.includes('未应用任何虚构兜底内容'), 'Must explicitly display failure notice');
    assert.ok(html.includes('retryTaskAuxiliaryStep'), 'Must provide copy retry action');
});
