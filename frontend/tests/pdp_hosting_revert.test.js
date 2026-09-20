const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function createMockElement(id = '', extra = {}) {
    const classes = new Set(extra.classes || []);
    return {
        id,
        tagName: 'DIV',
        value: extra.value || '',
        placeholder: extra.placeholder || '',
        textContent: extra.textContent || '',
        innerHTML: extra.innerHTML || '',
        className: extra.className || '',
        style: { width: '0%', ...extra.style },
        disabled: !!extra.disabled,
        classList: {
            add: (...cls) => cls.forEach(c => classes.add(c)),
            remove: (...cls) => cls.forEach(c => classes.delete(c)),
            toggle: (c, force) => {
                if (typeof force === 'boolean') {
                    if (force) classes.add(c);
                    else classes.delete(c);
                    return force;
                }
                if (classes.has(c)) {
                    classes.delete(c);
                    return false;
                }
                classes.add(c);
                return true;
            },
            contains: (c) => classes.has(c)
        },
        querySelector: (sel) => null,
        querySelectorAll: (sel) => [],
        appendChild: () => {},
        removeChild: () => {},
        click: () => {},
        select: () => {},
        focus: () => {},
        blur: () => {},
        ...extra
    };
}

function createAssetHostingTestContext() {
    const elements = {
        pdpAssetHostingModal: createMockElement('pdpAssetHostingModal', { classes: ['hidden'] }),
        pdpAssetHostingModeBadge: createMockElement('pdpAssetHostingModeBadge'),
        btnStorageTargetWp: createMockElement('btnStorageTargetWp'),
        btnStorageTargetShopify: createMockElement('btnStorageTargetShopify'),
        btnStorageTargetR2: createMockElement('btnStorageTargetR2'),
        btnToggleStorageConfig: createMockElement('btnToggleStorageConfig'),
        storageConfigChevron: createMockElement('storageConfigChevron'),
        pdpStorageConfigDrawer: createMockElement('pdpStorageConfigDrawer', { classes: ['hidden'] }),
        pdpWpConfigArea: createMockElement('pdpWpConfigArea'),
        storageWpSelect: createMockElement('storageWpSelect', { value: '0' }),
        storageWpName: createMockElement('storageWpName', { value: '' }),
        btnAddWpSite: createMockElement('btnAddWpSite'),
        btnDeleteWpSite: createMockElement('btnDeleteWpSite'),
        storageWpUrl: createMockElement('storageWpUrl', { value: '' }),
        storageWpUsername: createMockElement('storageWpUsername', { value: '' }),
        storageWpAppPassword: createMockElement('storageWpAppPassword', { value: '' }),
        pdpShopifyConfigArea: createMockElement('pdpShopifyConfigArea', { classes: ['hidden'] }),
        storageShopifySelect: createMockElement('storageShopifySelect', { value: '0' }),
        storageShopifyName: createMockElement('storageShopifyName', { value: '' }),
        storageShopifyDomain: createMockElement('storageShopifyDomain', { value: '' }),
        storageShopifyAccessToken: createMockElement('storageShopifyAccessToken', { value: '' }),
        btnAddShopifySite: createMockElement('btnAddShopifySite'),
        btnDeleteShopifySite: createMockElement('btnDeleteShopifySite'),
        pdpR2ConfigArea: createMockElement('pdpR2ConfigArea', { classes: ['hidden'] }),
        storageR2AccountId: createMockElement('storageR2AccountId', { value: '' }),
        storageR2AccessKeyId: createMockElement('storageR2AccessKeyId', { value: '' }),
        storageR2SecretKey: createMockElement('storageR2SecretKey', { value: '' }),
        storageR2BucketName: createMockElement('storageR2BucketName', { value: '' }),
        storageR2PublicBaseUrl: createMockElement('storageR2PublicBaseUrl', { value: '' }),
        pdpAssetHostingBtnText: createMockElement('pdpAssetHostingBtnText'),
        btnPdpAssetHosting: createMockElement('btnPdpAssetHosting'),
        pdpAssetTotalCount: createMockElement('pdpAssetTotalCount'),
        pdpAssetUploadedCount: createMockElement('pdpAssetUploadedCount'),
        pdpAssetPendingCount: createMockElement('pdpAssetPendingCount'),
        pdpAssetFailedCount: createMockElement('pdpAssetFailedCount'),
        pdpAssetProgressBar: createMockElement('pdpAssetProgressBar'),
        pdpAssetListContainer: createMockElement('pdpAssetListContainer'),
        pdpAssetBatchError: createMockElement('pdpAssetBatchError', { classes: ['hidden'] }),
        btnStartPdpUpload: createMockElement('btnStartPdpUpload'),
        btnApplyRemoteUrlsToHtml: createMockElement('btnApplyRemoteUrlsToHtml'),
        btnRevertLocalUrls: createMockElement('btnRevertLocalUrls')
    };

    let lastToast = null;

    const ctx = {
        console,
        setTimeout,
        clearTimeout,
        document: {
            getElementById: (id) => elements[id] || null,
            querySelector: (sel) => elements[sel] || null,
            querySelectorAll: () => [],
            createElement: (tag) => createMockElement(tag)
        },
        showToast: (msg, type) => { lastToast = { msg, type }; },
        remoteLog: () => {},
        localStorage: {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {}
        },
        MARKET_TONE_MAP: { 'US Market': 'direct' },
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

test('revertToLocalPdpImages preserves remote URLs and targetUploads without data loss', () => {
    const { ctx, elements } = createAssetHostingTestContext();
    ctx.renderDtcHybridPreview = () => {};
    ctx.saveDetailProjectToHistory = () => {};

    const destKey = 'wordpress:default';
    const remoteUrl = 'https://wp.myshop.com/wp-content/uploads/2026/09/hero.webp';

    ctx.globalGenContext = {
        config: { productName: 'Ergonomic Desk' },
        tasks: {
            m1: {
                id: 'm1',
                title: 'Hero Module',
                originalImageSrc: 'data:image/png;base64,original_local_blob',
                imageSrc: remoteUrl,
                remoteImageUrl: remoteUrl,
                activeStorageTarget: destKey,
                remoteImageUrls: {
                    [destKey]: remoteUrl
                }
            }
        }
    };

    // Initialize asset queue and set upload record
    ctx.buildPdpAssetQueue();
    const item = ctx.pdpAssetQueue.find(i => i.id === 'm1');
    assert.ok(item, 'Queue item should exist');
    item.targetUploads = {
        [destKey]: { remoteUrl, status: 'success' }
    };
    item.remoteUrl = remoteUrl;
    item.status = 'uploaded';

    // Execute revert
    const reverted = ctx.revertToLocalPdpImages();

    // 1. Verify preview/HTML is reverted to local
    assert.strictEqual(reverted, 1);
    assert.strictEqual(ctx.globalGenContext.tasks.m1.imageSrc, 'data:image/png;base64,original_local_blob');
    assert.strictEqual(ctx.globalGenContext.tasks.m1.remoteImageUrl, undefined);
    assert.strictEqual(ctx.globalGenContext.tasks.m1.activeStorageTarget, undefined);

    // 2. CRITICAL: remoteImageUrls in task must NOT be deleted!
    assert.strictEqual(
        ctx.globalGenContext.tasks.m1.remoteImageUrls?.[destKey],
        remoteUrl,
        'remoteImageUrls entry for target destination must be preserved'
    );

    // 3. CRITICAL: item.targetUploads in queue must NOT be deleted!
    assert.strictEqual(
        item.targetUploads?.[destKey]?.remoteUrl,
        remoteUrl,
        'targetUploads record must be preserved so user does not need to re-upload'
    );
});
