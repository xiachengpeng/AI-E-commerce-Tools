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
                    removeChild: () => {},
                    scrollIntoView: () => {}
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

    const storageMap = {};
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
            _store: storageMap,
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

    ctx.setGlobalGenContext({
        tasks: [],
        generatedTasks: [],
        productFacts: ctx.buildProductFacts(),
        uploadedAssets: []
    });

    return ctx;
}

test('Full Flow Step 1: Channel First setup changes active channel and Primary CTA', () => {
    const ctx = createTestContext();
    assert.strictEqual(ctx.getDetailChannel(), 'shopify');

    // Change to Amazon
    ctx.setDetailChannel('amazon');
    assert.strictEqual(ctx.getDetailChannel(), 'amazon');
    const ctaText = ctx.document.getElementById('btnPrimaryDeliveryCTAText');
    assert.match(ctaText.textContent, /Amazon/);

    // Change to Social
    ctx.setDetailChannel('social');
    assert.strictEqual(ctx.getDetailChannel(), 'social');
    assert.match(ctaText.textContent, /社媒/);

    // Change to Generic
    ctx.setDetailChannel('generic');
    assert.strictEqual(ctx.getDetailChannel(), 'generic');
    assert.match(ctaText.textContent, /物料包/);
});

test('Full Flow Step 2: Semantic Asset Role assignment identifies primary and secondary roles', () => {
    const ctx = createTestContext();
    const mockFiles = [
        { name: 'product_front_hero.jpg' },
        { name: 'product_close_detail.png' },
        { name: 'outdoor_lifestyle_use.webp' }
    ];

    const roles = ctx.resolveAssetSemanticRoles(mockFiles);
    assert.strictEqual(roles.length, 3);
    assert.strictEqual(roles[0].physicalRole, 'primary');
    assert.strictEqual(roles[0].semanticRole, 'hero');
    assert.strictEqual(roles[1].physicalRole, 'secondary');
    assert.strictEqual(roles[1].semanticRole, 'detail');
    assert.strictEqual(roles[2].physicalRole, 'secondary');
    assert.strictEqual(roles[2].semanticRole, 'usage_scene');
});

test('Full Flow Step 3: Product Facts construction, review card rendering, and confirmation', () => {
    const ctx = createTestContext();
    const rawAiInfo = {
        productName: 'Ergonomic Office Chair',
        material: 'Breathable Mesh & Aluminum Alloy',
        color: 'Space Gray',
        dimensions: { length: 65, width: 65, height: 110, unit: 'cm' },
        weight: { value: 14.5, unit: 'kg' },
        warranty: '5 Years Warranty',
        returnPolicy: '30 Days Free Return',
        confirmedFeatures: ['Adjustable Lumbar Support', '3D Armrests']
    };

    const facts = ctx.buildProductFacts(rawAiInfo);
    assert.strictEqual(facts.productName.value, 'Ergonomic Office Chair');
    assert.strictEqual(facts.material.value, 'Breathable Mesh & Aluminum Alloy');
    assert.strictEqual(facts.material.verified, false);
    assert.strictEqual(facts.warranty.value, '5 Years Warranty');

    ctx.globalGenContext.productFacts = facts;

    // Confirm a single item
    ctx.confirmProductFactItem('material');
    assert.strictEqual(ctx.globalGenContext.productFacts.material.verified, true);

    // Confirm all items
    ctx.confirmAllProductFacts();
    assert.strictEqual(ctx.globalGenContext.productFacts.dimensions.verified, true);
    assert.strictEqual(ctx.globalGenContext.productFacts.warranty.verified, true);
    assert.strictEqual(ctx.globalGenContext.productFacts.color.verified, true);
});

test('Full Flow Step 4: AI Plan recommendation with evidence gate and channel presets', () => {
    const ctx = createTestContext();

    // Partial facts (lacks warranty, returns, certifications)
    const partialFacts = ctx.buildProductFacts({
        productName: 'Bluetooth Headphones',
        material: 'Polycarbonate',
        color: 'Matte Black'
    });
    partialFacts.material.verified = true;
    partialFacts.color.verified = true;

    const plan = ctx.buildRecommendedDetailPlan({
        targetChannel: 'shopify',
        productFacts: partialFacts,
        assets: [{ physicalRole: 'primary' }, { physicalRole: 'secondary' }]
    });
    assert.ok(plan.includedModules.length > 0);
    assert.ok(plan.includedModules.some(m => m.id === 'm1')); // Hero always recommended

    // High-risk modules without evidence should be blocked or excluded
    const m17Evidence = ctx.validateContentPlanEvidence(['m17'], partialFacts);
    assert.strictEqual(m17Evidence.blocked.length > 0, true);
    assert.strictEqual(m17Evidence.blocked[0].riskLevel, 'high');

    // Apply recommended plan
    ctx.applyRecommendedDetailPlan(plan);
    const m1Box = ctx.document.getElementById('mod-m1');
    assert.strictEqual(m1Box.checked, true);
});

test('Full Flow Step 5: Multi-substatus task lifecycle, composite status, and auxiliary retry', () => {
    const ctx = createTestContext();
    const task = {
        uniqueId: 'task_lifecycle_1',
        moduleId: 'm1',
        title: 'Hero Section',
        subStatus: {
            overall: 'pending',
            image: 'pending',
            compression: 'pending',
            seo: 'pending',
            copy: 'pending',
            upload: 'pending'
        }
    };

    // Image running
    ctx.setTaskSubStatus(task, { image: 'running' });
    assert.strictEqual(ctx.getTaskOverallStatus(task), 'running');

    // Image succeeds, copy running
    ctx.setTaskSubStatus(task, { image: 'success', copy: 'running' });
    assert.strictEqual(ctx.getTaskOverallStatus(task), 'running');

    // Copy and SEO complete
    ctx.setTaskSubStatus(task, { copy: 'success', seo: 'success' });
    assert.strictEqual(ctx.getTaskOverallStatus(task), 'success');

    // If SEO fails, overall becomes partial_success
    ctx.setTaskSubStatus(task, { seo: 'failed' });
    assert.strictEqual(ctx.getTaskOverallStatus(task), 'partial_success');

    // Decoupled cancelled status
    task.status = 'cancelled';
    ctx.setTaskSubStatus(task, { image: 'cancelled' });
    ctx.globalGenContext.tasks = { [task.uniqueId]: task };
    assert.strictEqual(ctx.getFailedModuleTasks().length, 0);
    assert.strictEqual(ctx.getCancelledModuleTasks().length, 1);
});

test('Full Flow Step 6: 3-column Studio workspace, ordering, visibility, inspector edits, and WCAG AA contrast', () => {
    const ctx = createTestContext();
    const t1 = {
        uniqueId: 'task_1',
        moduleId: 'm1',
        title: 'Hero Banner',
        status: 'success',
        dtcCopy: { headline: 'Initial Title', subheadline: 'Initial Subtitle' },
        seo: { seoTitle: 'Initial SEO Title', seoAlt: 'Initial SEO Alt' },
        imageUrl: 'data:image/png;base64,111'
    };
    const t2 = {
        uniqueId: 'task_2',
        moduleId: 'm2',
        title: 'Feature Showcase',
        status: 'success',
        dtcCopy: { headline: 'Feature Title', subheadline: 'Feature Subtitle' },
        seo: { seoTitle: 'Feature SEO Title', seoAlt: 'Feature SEO Alt' },
        imageUrl: 'data:image/png;base64,222'
    };

    ctx.globalGenContext.tasks = [t1, t2];

    // Move t1 down
    ctx.moveDetailTask('task_1', 'down');
    assert.strictEqual(ctx.globalGenContext.tasks[0].uniqueId, 'task_2');
    assert.strictEqual(ctx.globalGenContext.tasks[1].uniqueId, 'task_1');

    // Move t1 back up
    ctx.moveDetailTask('task_1', 'up');
    assert.strictEqual(ctx.globalGenContext.tasks[0].uniqueId, 'task_1');

    // Toggle visibility
    ctx.toggleDetailTaskVisibility('task_1');
    assert.strictEqual(t1.isHidden, true);
    ctx.toggleDetailTaskVisibility('task_1');
    assert.strictEqual(t1.isHidden, false);

    // Inspector hot update
    ctx.setActiveInspectorTask('task_1');
    assert.strictEqual(ctx.getActiveInspectorTask().uniqueId, 'task_1');

    ctx.updateDetailTaskContent('task_1', { headline: 'Updated Banner Headline' });
    assert.strictEqual(t1.dtcCopy.headline, 'Updated Banner Headline');

    ctx.updateDetailTaskSeo('task_1', { seoTitle: 'Optimized Meta Title' });
    assert.strictEqual(t1.seo.seoTitle, 'Optimized Meta Title');

    // Image version recording & rollback
    ctx.recordTaskImageVersion('task_1', 'data:image/png;base64,333', 'Added warm lighting');
    assert.strictEqual(t1.imageVersions.length, 1);
    assert.strictEqual(t1.imageUrl, 'data:image/png;base64,333');

    ctx.rollbackTaskImageVersion('task_1', t1.imageVersions[0].versionId);
    assert.strictEqual(t1.imageUrl, 'data:image/png;base64,111');

    // WCAG AA contrast check
    const ratioBlackOnWhite = ctx.calculateContrastRatio('#000000', '#FFFFFF');
    assert.ok(ratioBlackOnWhite >= 20.0);
    const accessibleText = ctx.getAccessibleContrastColor('#FFFFFF', '#94a3b8');
    assert.ok(ctx.calculateContrastRatio('#FFFFFF', accessibleText) >= 4.5);
});

test('Full Flow Step 7: Long Image Synchronization, Publish Readiness, and Autosave Draft cycle', () => {
    const ctx = createTestContext();
    const tasks = [
        {
            uniqueId: 'task_a',
            moduleId: 'm1',
            title: 'Hero Module',
            status: 'success',
            imageUrl: 'https://cdn.example.com/hero.webp',
            uploadedUrl: 'https://cdn.example.com/hero.webp',
            dtcCopy: { headline: 'Hero Head', subheadline: 'Hero Sub' },
            seo: { title: 'Hero SEO', alt: 'Hero Alt' }
        },
        {
            uniqueId: 'task_b',
            moduleId: 'm2',
            title: 'Feature Module',
            status: 'success',
            imageUrl: 'https://cdn.example.com/features.webp',
            uploadedUrl: 'https://cdn.example.com/features.webp',
            dtcCopy: { headline: 'Feat Head', subheadline: 'Feat Sub' },
            seo: { title: 'Feat SEO', alt: 'Feat Alt' }
        }
    ];

    ctx.globalGenContext.tasks = tasks;

    // 1. Long image synchronization
    ctx.syncEditorOrderToLongImage();
    assert.deepStrictEqual(Array.from(ctx.globalGenContext.longImageOrder), ['task_a', 'task_b']);

    // 2. Publish readiness computation (all images, copy, hosting, and SEO present -> 100%)
    const readiness = ctx.computePublishReadiness(tasks, 'shopify');
    assert.strictEqual(readiness.score, 100);
    assert.strictEqual(readiness.isReadyToPublish, true);

    // 3. Autosave draft cycle
    ctx.setDetailChannel('shopify');
    ctx.saveStudioDraft();
    const savedRaw = ctx.localStorage.getItem('dtc_studio_current_draft');
    assert.ok(savedRaw);
    const savedDraft = JSON.parse(savedRaw);
    assert.strictEqual(savedDraft.channel, 'shopify');
    assert.strictEqual(savedDraft.tasks.length, 2);

    // Clear studio memory and restore from draft
    ctx.globalGenContext.tasks = [];
    const restored = ctx.restoreStudioDraft();
    assert.strictEqual(restored, true);
    assert.strictEqual(ctx.globalGenContext.tasks.length, 2);
    assert.strictEqual(ctx.globalGenContext.tasks[0].uniqueId, 'task_a');

    // 4. Primary channel publish execution
    let modalOpened = false;
    ctx.openDetailDtcHtmlModal = () => { modalOpened = true; };
    ctx.executePrimaryChannelPublish();
    assert.strictEqual(modalOpened, true);
});
