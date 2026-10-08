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

    return { ctx, elements, getLastToast: () => lastToast };
}

// 1. resolveSellingPointsFormState: 人工输入最高优先级保护
test('resolveSellingPointsFormState preserves existing user selling points and does not overwrite', () => {
    const { ctx } = createTestContext();
    const existingName = 'User Defined Blender';
    const existingPoints = '1. User crafted point A\n2. User crafted point B';
    const parsedResult = {
        productName: 'AI Generated Name',
        sellingPoints: 'AI Generated Selling Points 123',
        productFacts: 'AI Facts',
        forbiddenClaims: 'AI Forbidden'
    };

    const nextState = ctx.resolveSellingPointsFormState(existingName, existingPoints, parsedResult);
    assert.strictEqual(nextState.productName, existingName, 'Product name must not be overwritten');
    assert.strictEqual(nextState.sellingPoints, existingPoints, 'Selling points must not be silently overwritten when user already has input');
    assert.strictEqual(nextState.didFillProductName, false);
    assert.strictEqual(nextState.didPreserveUserSellingPoints, true);
});

// 2. resolveAssetSemanticRoles: 资产语义角色识别
test('resolveAssetSemanticRoles assigns appropriate semantic roles based on metadata and fallback', () => {
    const { ctx } = createTestContext();
    assert.strictEqual(typeof ctx.resolveAssetSemanticRoles, 'function', 'resolveAssetSemanticRoles must be a function');

    const sampleImages = [
        { id: 'img_1', name: 'front_main.jpg', isPrimary: true },
        { id: 'img_2', name: 'back_port_detail.png', isPrimary: false },
        { id: 'img_3', name: 'package_box.jpg', isPrimary: false }
    ];
    const roles = ctx.resolveAssetSemanticRoles(sampleImages);
    assert.strictEqual(roles.length, 3);
    assert.strictEqual(roles[0].semanticRole, 'hero');
});

// 3. Product Facts: 构建与合并
test('buildProductFacts and mergeProductFacts correctly adhere to source priorities', () => {
    const { ctx } = createTestContext();
    assert.strictEqual(typeof ctx.buildProductFacts, 'function', 'buildProductFacts must be defined');
    assert.strictEqual(typeof ctx.mergeProductFacts, 'function', 'mergeProductFacts must be defined');

    const defaultFacts = ctx.buildProductFacts();
    assert.ok(defaultFacts && typeof defaultFacts === 'object');
    assert.ok('productName' in defaultFacts);
    assert.ok('category' in defaultFacts);
    assert.ok('dimensions' in defaultFacts);
    assert.ok('warranty' in defaultFacts);

    // Merge facts: user verified takes precedence over AI vision
    const userFacts = {
        dimensions: { length: 20, width: 10, height: 5, unit: 'cm', source: 'user', verified: true }
    };
    const visionFacts = {
        dimensions: { length: 99, width: 99, height: 99, unit: 'cm', source: 'vision', verified: false }
    };
    const merged = ctx.mergeProductFacts(userFacts, visionFacts);
    assert.strictEqual(merged.dimensions.length, 20);
    assert.strictEqual(merged.dimensions.verified, true);
});

// 4. Module Evidence Gate: 门禁拦截
test('validateContentPlanEvidence blocks or warns high-risk modules with insufficient evidence', () => {
    const { ctx } = createTestContext();
    assert.strictEqual(typeof ctx.validateContentPlanEvidence, 'function', 'validateContentPlanEvidence must be defined');

    const factsWithoutDimensions = ctx.buildProductFacts();
    const assetsOnlyOne = [{ id: 'img_1', isPrimary: true, semanticRole: 'hero' }];

    // Test m8 (Size & Dimensions): without dimensions, must be blocked
    const resultM8 = ctx.validateContentPlanEvidence([{ id: 'm8' }], factsWithoutDimensions, assetsOnlyOne);
    assert.ok(resultM8.blocked.some(item => item.id === 'm8'), 'm8 must be blocked without dimensions');

    // Test m4 (Multi-angle): only 1 asset, must be blocked or warning
    const resultM4 = ctx.validateContentPlanEvidence([{ id: 'm4' }], factsWithoutDimensions, assetsOnlyOne);
    assert.ok(resultM4.blocked.some(item => item.id === 'm4') || resultM4.warnings.some(item => item.id === 'm4'), 'm4 must be blocked or warned when only 1 image is uploaded');

    // Test m17 (Exploded View): without structural cad/internal photo, must be blocked
    const resultM17 = ctx.validateContentPlanEvidence([{ id: 'm17' }], factsWithoutDimensions, assetsOnlyOne);
    assert.ok(resultM17.blocked.some(item => item.id === 'm17'), 'm17 must be blocked without internal structure evidence');
});

// 5. Task 多子状态模型与 computeTaskOverallStatus
test('computeTaskOverallStatus calculates composite status correctly', () => {
    const { ctx } = createTestContext();
    assert.strictEqual(typeof ctx.computeTaskOverallStatus, 'function', 'computeTaskOverallStatus must be defined');

    // All success
    const statusSuccess = {
        image: 'success',
        compression: 'success',
        seo: 'success',
        copy: 'success',
        upload: 'idle'
    };
    assert.strictEqual(ctx.computeTaskOverallStatus(statusSuccess), 'success');

    // Image success but copy failed -> partial_success
    const statusPartial = {
        image: 'success',
        compression: 'success',
        seo: 'success',
        copy: 'failed',
        upload: 'idle'
    };
    assert.strictEqual(ctx.computeTaskOverallStatus(statusPartial), 'partial_success');

    // Image failed -> failed
    const statusFailed = {
        image: 'failed',
        compression: 'skipped',
        seo: 'skipped',
        copy: 'skipped',
        upload: 'idle'
    };
    assert.strictEqual(ctx.computeTaskOverallStatus(statusFailed), 'failed');

    // Cancelled -> cancelled
    const statusCancelled = {
        image: 'cancelled',
        compression: 'skipped',
        seo: 'skipped',
        copy: 'skipped',
        upload: 'idle'
    };
    assert.strictEqual(ctx.computeTaskOverallStatus(statusCancelled), 'cancelled');
});

// 6. getFailedModuleTasks and getCancelledModuleTasks decoupling
test('getFailedModuleTasks strictly excludes cancelled tasks and getCancelledModuleTasks returns them', () => {
    const { ctx } = createTestContext();
    assert.strictEqual(typeof ctx.getCancelledModuleTasks, 'function', 'getCancelledModuleTasks must be defined');

    ctx.globalGenContext = {
        tasks: {
            'mod_1': { uniqueId: 'mod_1', status: 'error', imageSrc: '' },
            'mod_2': { uniqueId: 'mod_2', status: 'cancelled', imageSrc: '' },
            'mod_3': { uniqueId: 'mod_3', status: 'success', imageSrc: 'http://img.png' }
        }
    };

    const failed = ctx.getFailedModuleTasks();
    const cancelled = ctx.getCancelledModuleTasks();

    assert.strictEqual(failed.length, 1);
    assert.strictEqual(failed[0].uniqueId, 'mod_1');
    assert.strictEqual(cancelled.length, 1);
    assert.strictEqual(cancelled[0].uniqueId, 'mod_2');
});

// 7. normalizeRestoredDetailTask backwards compatibility with string status
test('normalizeRestoredDetailTask migrates legacy string status to multi-state object', () => {
    const { ctx } = createTestContext();
    const legacyTask = {
        id: 'm1',
        title: 'Hero',
        status: 'success',
        imageSrc: 'http://example.com/hero.png',
        seo: { titleTarget: 'Hero SEO' },
        dtcCopy: { headline: 'Hero Headline' }
    };

    const normalized = ctx.normalizeRestoredDetailTask(legacyTask, 'm1');
    assert.ok(typeof normalized.subStatus === 'object', 'subStatus must be an object');
    assert.strictEqual(normalized.subStatus.overall, 'success');
    assert.strictEqual(normalized.subStatus.image, 'success');
    assert.strictEqual(normalized.subStatus.seo, 'success');
    assert.strictEqual(normalized.subStatus.copy, 'success');
    assert.strictEqual(normalized.status, 'success');
});
