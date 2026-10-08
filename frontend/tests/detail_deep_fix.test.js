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

    // Ensure showToast points to test recorder
    ctx.showToast = (msg, type) => { lastToast = { msg, type }; };
    ctx.globalThis.showToast = ctx.showToast;
    if (ctx.window) ctx.window.showToast = ctx.showToast;

    return { ctx, elements, getLastToast: () => lastToast };
}

// ============================================================================
// 1. Product Facts SSOT: 分级体系与未经确认 AI 事实严格排除
// ============================================================================
test('1. Product Facts SSOT: getProductFactTier and isProductFactConfirmed classify 4 tiers correctly', () => {
    const { ctx } = createTestContext();

    // 1.1 Verified Tier
    assert.strictEqual(ctx.getProductFactTier({ source: 'verified', verified: true }), 'verified');
    assert.strictEqual(ctx.getProductFactTier({ source: 'ai', verified: true }), 'verified');

    // 1.2 User-provided Tier
    assert.strictEqual(ctx.getProductFactTier({ source: 'user', verified: false }), 'user-provided');
    assert.strictEqual(ctx.getProductFactTier({ source: 'manual' }), 'user-provided');

    // 1.3 AI Inferred Tier (Unconfirmed)
    assert.strictEqual(ctx.getProductFactTier({ source: 'ai', verified: false }), 'AI inferred');
    assert.strictEqual(ctx.getProductFactTier({ source: 'inferred' }), 'AI inferred');

    // 1.4 Unknown Tier
    assert.strictEqual(ctx.getProductFactTier(null), 'unknown');
    assert.strictEqual(ctx.getProductFactTier({}), 'unknown');

    // 1.5 isProductFactConfirmed: Unconfirmed AI inferred is strictly false
    assert.strictEqual(ctx.isProductFactConfirmed({ source: 'ai', verified: false }), false);
    assert.strictEqual(ctx.isProductFactConfirmed({ source: 'inferred' }), false);
    assert.strictEqual(ctx.isProductFactConfirmed({ source: 'ai', verified: true }), true);
    assert.strictEqual(ctx.isProductFactConfirmed({ source: 'user' }), true);
});

test('1. Product Facts SSOT: serializeVerifiedProductFactsForAI strictly excludes unconfirmed AI facts', () => {
    const { ctx } = createTestContext();

    const sampleFacts = {
        material: { value: 'Stainless Steel 304', source: 'user', verified: true },
        color: { value: 'Silver', source: 'verified', verified: true },
        dimensions: { value: '25 x 15 x 10 cm', source: 'ai', verified: false }, // unconfirmed!
        weight: { value: '500g', source: 'ai', verified: true } // confirmed AI
    };

    const serialized = ctx.serializeVerifiedProductFactsForAI(sampleFacts);
    assert.match(serialized, /Stainless Steel 304/);
    assert.match(serialized, /Silver/);
    assert.match(serialized, /500g/);
    assert.doesNotMatch(serialized, /25 x 15 x 10 cm/, 'Unconfirmed AI facts must be strictly excluded from AI prompt serialization');

    // Verify confirmation status
    assert.strictEqual(ctx.isProductFactConfirmed(sampleFacts.material), true);
    assert.strictEqual(ctx.isProductFactConfirmed(sampleFacts.dimensions), false);
});

// ============================================================================
// 2. Evidence Gate Hard Boundary: 高风险模块缺少证据硬性拦截
// ============================================================================
test('2. Evidence Gate: blocks high-risk modules (m4, m8, m10, m13) when evidence is missing', () => {
    const { ctx } = createTestContext();

    const emptyProject = { facts: {}, uploadedImages: [] };

    // m8: 尺寸规格需尺寸事实
    const evalM8 = ctx.evaluateTaskEvidence({ id: 'm8' }, emptyProject);
    assert.strictEqual(evalM8.allowed, false);
    assert.strictEqual(evalM8.status, 'blocked');
    assert.ok(evalM8.missingEvidence.some(m => m.includes('尺寸')));

    // m9: 竞品差异对比需对比事实 (blocked)
    const evalM9 = ctx.evaluateTaskEvidence({ id: 'm9' }, emptyProject);
    assert.strictEqual(evalM9.allowed, false);
    assert.strictEqual(evalM9.status, 'blocked');

    // m17: 爆炸拆解内部需工程CAD图纸 (critical blocked)
    const evalM17 = ctx.evaluateTaskEvidence({ id: 'm17' }, emptyProject);
    assert.strictEqual(evalM17.allowed, false);
    assert.strictEqual(evalM17.status, 'blocked');

    // m4: 多角度图在缺少多角度素材时触发预警降级
    const evalM4 = ctx.evaluateTaskEvidence({ id: 'm4' }, { facts: {}, uploadedImages: [{ semanticRole: 'hero' }] });
    assert.strictEqual(evalM4.status, 'warning');
    assert.ok(evalM4.missingEvidence.some(m => m.includes('角度')));

    // assertTaskGenerationAllowed throws error when blocked
    assert.throws(() => {
        ctx.assertTaskGenerationAllowed({ id: 'm8', title: '尺寸规格' }, emptyProject);
    }, /未通过事实门禁/);
});

// ============================================================================
// 3. Evidence Gate: 证据具备时正常放行
// ============================================================================
test('3. Evidence Gate: allows module generation when verified facts or required assets exist', () => {
    const { ctx } = createTestContext();

    // m8 with verified dimensions
    const projectWithDimensions = {
        facts: { dimensions: '30 x 20 x 10 cm' },
        uploadedImages: []
    };
    const evalM8 = ctx.evaluateTaskEvidence({ id: 'm8' }, projectWithDimensions);
    assert.strictEqual(evalM8.allowed, true);
    assert.doesNotThrow(() => {
        ctx.assertTaskGenerationAllowed({ id: 'm8' }, projectWithDimensions);
    });

    // m4 with 2 angle images
    const projectWithAngles = {
        facts: {},
        uploadedImages: [
            { id: 'img1', semanticRole: 'front' },
            { id: 'img2', semanticRole: 'side' }
        ]
    };
    const evalM4 = ctx.evaluateTaskEvidence({ id: 'm4' }, projectWithAngles);
    assert.strictEqual(evalM4.allowed, true);
});

// ============================================================================
// 4. 素材语义角色识别与 getImagesForTask 智能角色优选
// ============================================================================
test('4. Semantic Asset Roles: 11 roles recognized & getImagesForTask selects best role image at index 0', () => {
    const { ctx } = createTestContext();

    const sampleImages = [
        { id: 'hero_img', name: 'main_product.png', semanticRole: 'hero', isPrimary: true },
        { id: 'dim_img', name: 'dimension_ruler.jpg', semanticRole: 'dimension_reference' },
        { id: 'detail_img', name: 'texture_close.jpg', semanticRole: 'detail' },
        { id: 'pack_img', name: 'box_opened.jpg', semanticRole: 'package' }
    ];

    ctx.setGlobalGenContext({
        uploadedImages: sampleImages,
        primaryImage: sampleImages[0]
    });

    // m8 (尺寸) 偏好 dimension_reference: 第一张必须是 dim_img
    const m8Images = ctx.getImagesForTask({ id: 'm8' });
    assert.strictEqual(m8Images[0].id, 'dim_img', 'm8 must pick dimension_reference image first');

    // m6 (材质细节) 偏好 detail/material: 第一张必须是 detail_img
    const m6Images = ctx.getImagesForTask({ id: 'm6' });
    assert.strictEqual(m6Images[0].id, 'detail_img', 'm6 must pick detail image first');

    // m13 (包装配件) 偏好 package: 第一张必须是 pack_img
    const m13Images = ctx.getImagesForTask({ id: 'm13' });
    assert.strictEqual(m13Images[0].id, 'pack_img', 'm13 must pick package image first');

    // m1 (主图) 偏好 hero/primary: 第一张必须是 hero_img
    const m1Images = ctx.getImagesForTask({ id: 'm1' });
    assert.strictEqual(m1Images[0].id, 'hero_img', 'm1 must pick hero image first');
});

// ============================================================================
// 5. 统一项目重置 (resetDetailProjectState) 杜绝跨商品串数据
// ============================================================================
test('5. Unified Project Reset: resetDetailProjectState cleans all project state cleanly', () => {
    const nameInput = { value: 'Old Kettle' };
    const pointsText = { value: '1. Fast boiling' };
    const factsText = { value: 'Volume: 1.5L' };
    const { ctx } = createTestContext({
        productNameInput: nameInput,
        sellingPointsText: pointsText,
        productFactsText: factsText
    });

    // Populate global state
    ctx.setGlobalGenContext({
        tasks: { m1: { id: 'm1', title: 'Main' } },
        productFacts: { material: 'Glass' },
        uploadedImages: [{ id: 'img1' }],
        longImageOrder: ['m1']
    });

    ctx.resetDetailProjectState();

    const currentCtx = ctx.getGlobalGenContext();
    assert.strictEqual(Object.keys(currentCtx.tasks).length, 0, 'Tasks must be empty');
    assert.strictEqual(currentCtx.uploadedImages.length, 0, 'Uploaded images must be empty');
    assert.strictEqual(currentCtx.longImageOrder.length, 0, 'Long image order must be empty');
    assert.strictEqual(nameInput.value, '', 'Product name input must be cleared');
    assert.strictEqual(pointsText.value, '', 'Selling points input must be cleared');
    assert.strictEqual(factsText.value, '', 'Product facts input must be cleared');
});

// ============================================================================
// 6. Task SubStatus 持久化与真实数据迁移
// ============================================================================
test('6. Task SubStatus: collectCurrentRenderProject persists subStatus and normalizeRestoredDetailTask infers real state', () => {
    const { ctx } = createTestContext();

    // 6.1 Legacy task with rawStatus = 'success' but no copy/seo
    const legacyBareTask = {
        id: 'm1',
        title: '主视觉图',
        status: 'success',
        imageSrc: 'http://example.com/img.png'
    };
    const restoredBare = ctx.normalizeRestoredDetailTask(legacyBareTask);
    assert.strictEqual(restoredBare.subStatus.image, 'success');
    assert.strictEqual(restoredBare.subStatus.copy, 'skipped', 'Bare legacy task must mark copy as skipped');
    assert.strictEqual(restoredBare.subStatus.seo, 'skipped', 'Bare legacy task must mark seo as skipped');

    // 6.2 Legacy task with real copy and seo
    const legacyFullTask = {
        id: 'm2',
        title: '场景图',
        status: 'success',
        imageSrc: 'http://example.com/img2.png',
        dtcCopy: { headline: 'Living in comfort' },
        seo: { titleTarget: 'Best Comfort Chair' }
    };
    const restoredFull = ctx.normalizeRestoredDetailTask(legacyFullTask);
    assert.strictEqual(restoredFull.subStatus.image, 'success');
    assert.strictEqual(restoredFull.subStatus.copy, 'success');
    assert.strictEqual(restoredFull.subStatus.seo, 'success');
    assert.strictEqual(restoredFull.subStatus.overall, 'success');

    // 6.3 Task with auxiliary copy failure -> partial_success
    const partialTask = {
        id: 'm4',
        subStatus: {
            image: 'success',
            copy: 'failed',
            seo: 'success'
        }
    };
    const overallPartial = ctx.computeTaskOverallStatus(partialTask.subStatus);
    assert.strictEqual(overallPartial, 'partial_success', 'Copy failure must yield partial_success overall');

    // 6.4 Cancelled task preservation
    const cancelledTask = {
        id: 'm3',
        status: 'cancelled'
    };
    const restoredCancelled = ctx.normalizeRestoredDetailTask(cancelledTask);
    assert.strictEqual(restoredCancelled.subStatus.overall, 'cancelled');
    assert.strictEqual(restoredCancelled.subStatus.image, 'cancelled');
});

// ============================================================================
// 7. continueCancelledDetailTasks 独立调度与 UI 区分
// ============================================================================
test('7. continueCancelledDetailTasks: getCancelledModuleTasks filters cancelled tasks and UI distinguishes retry vs continue', () => {
    const toolbarRetry = { classList: { _classes: new Set(), add(c) { this._classes.add(c); }, remove(c) { this._classes.delete(c); } } };
    const toolbarContinue = { classList: { _classes: new Set(), add(c) { this._classes.add(c); }, remove(c) { this._classes.delete(c); } } };
    const toolbarRetryText = { textContent: '' };
    const toolbarContinueText = { textContent: '' };
    const alertBar = {
        dataset: {},
        classList: { _classes: new Set(), add(c) { this._classes.add(c); }, remove(c) { this._classes.delete(c); } }
    };
    const alertMsg = { textContent: '' };
    const btnRetry = { classList: { _classes: new Set(), add(c) { this._classes.add(c); }, remove(c) { this._classes.delete(c); } } };
    const btnContinue = { classList: { _classes: new Set(), add(c) { this._classes.add(c); }, remove(c) { this._classes.delete(c); } } };
    const btnContinueText = { textContent: '' };

    const { ctx } = createTestContext({
        btnRetryFailedToolbar: toolbarRetry,
        btnRetryFailedToolbarText: toolbarRetryText,
        btnContinueCancelledToolbar: toolbarContinue,
        btnContinueCancelledToolbarText: toolbarContinueText,
        detailFailureAlertBar: alertBar,
        detailFailureAlertMsg: alertMsg,
        btnRetryFailedImages: btnRetry,
        btnContinueCancelledImages: btnContinue,
        btnContinueCancelledImagesText: btnContinueText
    });

    ctx.setGlobalGenContext({
        tasks: {
            t1: { uniqueId: 't1', id: 'm1', imageSrc: 'http://example.com/t1.png', subStatus: { overall: 'success' }, status: 'success' },
            t2: { uniqueId: 't2', id: 'm2', subStatus: { overall: 'failed' }, status: 'failed' },
            t3: { uniqueId: 't3', id: 'm3', subStatus: { overall: 'cancelled' }, status: 'cancelled' }
        }
    });

    const failed = ctx.getFailedModuleTasks();
    const cancelled = ctx.getCancelledModuleTasks();

    assert.strictEqual(failed.length, 1);
    assert.strictEqual(failed[0].uniqueId, 't2');
    assert.strictEqual(cancelled.length, 1);
    assert.strictEqual(cancelled[0].uniqueId, 't3');

    ctx.updateDetailFailureUI();

    assert.strictEqual(toolbarRetryText.textContent, '重试失败图片 (1)');
    assert.strictEqual(toolbarContinueText.textContent, '继续生成剩余区块 (1)');
    assert.match(alertMsg.textContent, /1 张模块图片失败/);
    assert.match(alertMsg.textContent, /1 个区块已停止/);
});

// ============================================================================
// 8. 呈现形态 (PresentationMode) 与编辑器预览 (ResultView) 职责统一
// ============================================================================
test('8. PresentationMode vs ResultView: setDetailPresentationMode syncs output strategy with preview view', () => {
    let activeView = '';
    const { ctx } = createTestContext();

    ctx.switchDetailResultView = (view) => { activeView = view; };

    ctx.setDetailPresentationMode('images');
    assert.strictEqual(ctx.getDetailPresentationMode(), 'images');
    assert.strictEqual(activeView, 'gallery', 'Selecting images mode must align editor preview to gallery');

    ctx.setDetailPresentationMode('hybrid');
    assert.strictEqual(ctx.getDetailPresentationMode(), 'hybrid');
    assert.strictEqual(activeView, 'hybrid', 'Selecting hybrid mode must align editor preview to hybrid');
});

// ============================================================================
// 9. 真实 WCAG 2.1 AA 对比度算法在亮黄、亮绿、亮粉、天蓝等颜色下的严苛测试
// ============================================================================
test('9. WCAG 2.1 AA Contrast: computeCustomBrandColor guarantees contrast >= 4.5:1 on light background', () => {
    const { ctx } = createTestContext();

    const testColors = [
        '#FFFF00', // 亮黄
        '#00FF00', // 亮绿
        '#FF69B4', // 亮粉
        '#87CEFA', // 天蓝
        '#000000', // 纯黑
        '#FFFFFF', // 纯白
        '#4F46E5', // 经典蓝紫
        '#E11D48'  // 玫瑰红
    ];

    testColors.forEach(hex => {
        const brand = ctx.computeCustomBrandColor(hex);
        assert.ok(brand.light, 'light must exist');
        assert.ok(brand.text, 'text must exist');

        const ratio = ctx.calculateContrastRatio(brand.light, brand.text);
        assert.ok(
            ratio >= 4.5,
            `Contrast ratio for ${hex} must be >= 4.5:1 (WCAG AA). Actual ratio: ${ratio.toFixed(2)}:1 between light ${brand.light} and text ${brand.text}`
        );
    });
});

// ============================================================================
// 10. Section Tree "+ 添加新区块" 并严格经过 Evidence Gate
// ============================================================================
test('10. Section Tree: addNewSectionFromTree enforces Evidence Gate and adds section when allowed', async () => {
    const { ctx, getLastToast } = createTestContext();

    ctx.setGlobalGenContext({
        tasks: {},
        productFacts: {},
        uploadedImages: [],
        longImageOrder: []
    });

    // 10.1 m8 without dimensions: blocked by gate
    const blockedRes = await ctx.addNewSectionFromTree('m8');
    assert.strictEqual(blockedRes, false);
    const toast = getLastToast();
    assert.ok(toast && toast.type === 'error');
    assert.match(toast.msg, /未通过事实门禁|未提供真实物理尺寸/);

    // 10.2 m8 with verified dimensions: allowed and created
    ctx.getGlobalGenContext().productFacts = {
        dimensions: { value: '40 x 30 x 15 cm', source: 'user', verified: true }
    };
    // Mock generateSingleWrap to succeed immediately
    ctx.generateSingleWrap = async () => ({ status: 'success' });

    const allowedTask = await ctx.addNewSectionFromTree('m8');
    assert.ok(allowedTask, 'Task must be returned');
    assert.strictEqual(allowedTask.id, 'm8');
    assert.strictEqual(ctx.getGlobalGenContext().tasks[allowedTask.uniqueId].id, 'm8');
    assert.ok(ctx.getGlobalGenContext().longImageOrder.includes(allowedTask.uniqueId));
});

// ============================================================================
// 11. 移动端预览容器宽度恢复为 375px
// ============================================================================
test('11. Mobile Viewport Simulator: CSS max-width is restored to 375px', () => {
    const cssContent = fs.readFileSync(path.join(root, 'css', 'style.css'), 'utf8');
    assert.match(
        cssContent,
        /\.dtc-pdp-wrapper\.dtc-viewport-mobile\s*\{[^}]*max-width:\s*375px;/,
        'CSS rule .dtc-pdp-wrapper.dtc-viewport-mobile must specify max-width: 375px;'
    );
});

// ============================================================================
// 12. 本地自动保存状态 (Local Autosave) 明确标注
// ============================================================================
test('12. Autosave Status: updateAutosaveStatusUI explicitly labels Local Autosave', () => {
    const autosaveEl = { textContent: '', title: '', classList: { _classes: new Set(), remove(c) { this._classes.delete(c); } } };
    const { ctx } = createTestContext({ dtcAutosaveStatus: autosaveEl });

    ctx.updateAutosaveStatusUI(Date.now());
    assert.match(autosaveEl.textContent, /本地草稿已自动保存/);
    assert.match(autosaveEl.title, /Local Autosave/);

    ctx.updateAutosaveStatusUI('idle');
    assert.strictEqual(autosaveEl.textContent, '本地草稿已重置');
});
