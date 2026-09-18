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

function createAssetHostingTestContext(overrides = {}) {
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
        storageR2PublicUrl: createMockElement('storageR2PublicUrl', { value: '' }),
        storageR2PathPrefix: createMockElement('storageR2PathPrefix', { value: 'pdp/' }),
        pdpStorageTestFeedback: createMockElement('pdpStorageTestFeedback'),
        btnTestStorageConnection: createMockElement('btnTestStorageConnection'),
        btnSaveStorageConfig: createMockElement('btnSaveStorageConfig'),
        pdpAssetTotalCount: createMockElement('pdpAssetTotalCount'),
        pdpAssetSuccessCount: createMockElement('pdpAssetSuccessCount'),
        pdpAssetFailedCount: createMockElement('pdpAssetFailedCount'),
        pdpAssetPendingCount: createMockElement('pdpAssetPendingCount'),
        pdpAssetProgressText: createMockElement('pdpAssetProgressText'),
        pdpAssetProgressBar: createMockElement('pdpAssetProgressBar'),
        btnStartBatchUpload: createMockElement('btnStartBatchUpload'),
        btnRetryFailedUploads: createMockElement('btnRetryFailedUploads', { classes: ['hidden'] }),
        pdpRetryFailedNum: createMockElement('pdpRetryFailedNum'),
        btnRevertLocalUrls: createMockElement('btnRevertLocalUrls', { classes: ['hidden'] }),
        btnApplyRemoteUrls: createMockElement('btnApplyRemoteUrls', { disabled: true }),
        pdpAssetQueueContainer: createMockElement('pdpAssetQueueContainer'),
        pdpAssetHostingBtnText: createMockElement('pdpAssetHostingBtnText', { textContent: '图床托管 / 替换链接' }),
        btnPdpAssetHosting: createMockElement('btnPdpAssetHosting'),
        productNameInput: createMockElement('productNameInput', { value: 'Smart Lumbar Pillow' }),
        dtcHybridContainer: createMockElement('dtcHybridContainer', { innerHTML: '<div class="dtc-pdp-wrapper"></div>' }),
        ...(overrides.elements || {})
    };

    let lastToast = null;
    let fetchCalls = [];

    const doc = {
        getElementById: (id) => elements[id] || null,
        querySelector: (sel) => {
            if (elements[sel]) return elements[sel];
            if (sel === '.dtc-pdp-wrapper') return elements.dtcHybridContainer;
            return null;
        },
        querySelectorAll: () => [],
        createElement: (tag) => createMockElement(tag),
        body: {
            appendChild: () => {},
            removeChild: () => {}
        }
    };

    const ctx = {
        console,
        document: doc,
        showToast: (msg, type) => { lastToast = { msg, type }; },
        remoteLog: () => {},
        API_BASE: 'http://127.0.0.1:9503/api',
        fetch: async (url, opts = {}) => {
            fetchCalls.push({ url, opts });
            if (overrides.mockFetch) {
                return overrides.mockFetch(url, opts);
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ success: true })
            };
        }
    };

    ctx.window = ctx;
    ctx.globalThis = ctx;

    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'config.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'details.js'), 'utf8'), ctx);

    return {
        ctx,
        elements,
        getLastToast: () => lastToast,
        getFetchCalls: () => fetchCalls
    };
}

test('sanitizePdpFilename cleans special chars and provides extension', () => {
    const { ctx } = createAssetHostingTestContext();
    assert.strictEqual(ctx.sanitizePdpFilename('My Product! @#$ Photo'), 'my-product-photo.png');
    assert.strictEqual(ctx.sanitizePdpFilename('banner_test.jpg'), 'banner_test.jpg');
    assert.strictEqual(ctx.sanitizePdpFilename(''), 'image.png');
});

test('openPdpAssetHostingModal warns if no detail generation tasks exist', () => {
    const { ctx, elements, getLastToast } = createAssetHostingTestContext();
    ctx.globalGenContext = null;

    ctx.openPdpAssetHostingModal();
    assert.ok(elements.pdpAssetHostingModal.classList.contains('hidden'), 'Modal should remain hidden');
    assert.strictEqual(getLastToast()?.type, 'warning');
});

test('buildPdpAssetQueue builds queue items from globalGenContext tasks', () => {
    const { ctx } = createAssetHostingTestContext();
    ctx.globalGenContext = {
        config: { productName: 'Ergonomic Desk' },
        longImageOrder: ['m1', 'm2'],
        tasks: {
            m1: { id: 'm1', title: 'Main View', displayTitle: '主图模块', imageSrc: 'data:image/png;base64,abc123' },
            m2: { id: 'm2', title: 'Specs', displayTitle: '参数模块', imageSrc: 'data:image/png;base64,def456' }
        }
    };

    const queue = ctx.buildPdpAssetQueue();
    assert.strictEqual(queue.length, 2);
    assert.strictEqual(queue[0].id, 'm1');
    assert.strictEqual(queue[0].title, '主图模块');
    assert.strictEqual(queue[0].status, 'pending');
    assert.ok(queue[0].filename.includes('ergonomic-desk-m1.png'));
    assert.strictEqual(queue[1].id, 'm2');
});

test('switchStorageTarget toggles Shopify, WordPress and Cloudflare R2 configurations', () => {
    const { ctx, elements } = createAssetHostingTestContext();

    // Switch to Shopify
    ctx.switchStorageTarget('shopify');
    assert.ok(!elements.pdpShopifyConfigArea.classList.contains('hidden'), 'Shopify area visible');
    assert.ok(elements.pdpWpConfigArea.classList.contains('hidden'), 'WP area hidden');
    assert.ok(elements.pdpR2ConfigArea.classList.contains('hidden'), 'R2 area hidden');
    assert.ok(elements.pdpAssetHostingModeBadge.textContent.includes('Shopify'));

    // Switch to R2
    ctx.switchStorageTarget('r2');
    assert.ok(!elements.pdpR2ConfigArea.classList.contains('hidden'), 'R2 area visible');
    assert.ok(elements.pdpWpConfigArea.classList.contains('hidden'), 'WP area hidden');
    assert.ok(elements.pdpShopifyConfigArea.classList.contains('hidden'), 'Shopify area hidden');
    assert.ok(elements.pdpAssetHostingModeBadge.textContent.includes('Cloudflare R2'));

    // Switch back to WP
    ctx.switchStorageTarget('wordpress');
    assert.ok(elements.pdpR2ConfigArea.classList.contains('hidden'), 'R2 area hidden');
    assert.ok(elements.pdpShopifyConfigArea.classList.contains('hidden'), 'Shopify area hidden');
    assert.ok(!elements.pdpWpConfigArea.classList.contains('hidden'), 'WP area visible');
    assert.ok(elements.pdpAssetHostingModeBadge.textContent.includes('WordPress'));
});

test('toggleStorageConfigDrawer toggles visibility of configuration drawer', () => {
    const { ctx, elements } = createAssetHostingTestContext();
    assert.ok(elements.pdpStorageConfigDrawer.classList.contains('hidden'));

    ctx.toggleStorageConfigDrawer();
    assert.ok(!elements.pdpStorageConfigDrawer.classList.contains('hidden'));
    assert.ok(elements.storageConfigChevron.classList.contains('rotate-180'));

    ctx.toggleStorageConfigDrawer();
    assert.ok(elements.pdpStorageConfigDrawer.classList.contains('hidden'));
    assert.ok(!elements.storageConfigChevron.classList.contains('rotate-180'));
});

test('loadStorageConfigsToModal populates form fields and preserves masked password', async () => {
    const mockConfigs = [
        {
            id: 1,
            storage_type: 'wordpress',
            name: 'My WP Site',
            enabled: true,
            is_default: true,
            wp_url: 'https://my-wp-site.com',
            wp_username: 'wp_admin',
            has_wp_app_password: true,
            wp_app_password_masked: '••••••••'
        },
        {
            id: 2,
            storage_type: 'shopify',
            name: 'My Shopify Store',
            enabled: true,
            is_default: true,
            shopify_shop_domain: 'mystore.myshopify.com',
            has_shopify_token: true,
            shopify_token_masked: 'shpat_••••1234'
        },
        {
            id: 3,
            storage_type: 'r2',
            enabled: true,
            r2_account_id: 'acc123',
            r2_access_key_id: 'key456',
            has_r2_secret: true,
            r2_secret_masked: '••••••••',
            r2_bucket_name: 'shop-bucket',
            r2_public_url: 'https://cdn.myshop.com',
            r2_path_prefix: 'products/'
        }
    ];

    const { ctx, elements } = createAssetHostingTestContext({
        mockFetch: async (url) => {
            if (url.includes('/api/storage/configs')) {
                return { ok: true, json: async () => mockConfigs };
            }
            return { ok: true, json: async () => ({}) };
        }
    });

    await ctx.loadStorageConfigsToModal();

    assert.strictEqual(elements.storageWpName.value, 'My WP Site');
    assert.strictEqual(elements.storageWpUrl.value, 'https://my-wp-site.com');
    assert.strictEqual(elements.storageWpUsername.value, 'wp_admin');
    assert.ok(elements.storageWpAppPassword.placeholder.includes('••••••••'));

    assert.strictEqual(elements.storageShopifyName.value, 'My Shopify Store');
    assert.strictEqual(elements.storageShopifyDomain.value, 'mystore.myshopify.com');
    assert.ok(elements.storageShopifyAccessToken.placeholder.includes('••••••••'));

    assert.strictEqual(elements.storageR2AccountId.value, 'acc123');
    assert.strictEqual(elements.storageR2AccessKeyId.value, 'key456');
    assert.strictEqual(elements.storageR2BucketName.value, 'shop-bucket');
    assert.strictEqual(elements.storageR2PublicUrl.value, 'https://cdn.myshop.com');
    assert.strictEqual(elements.storageR2PathPrefix.value, 'products/');
});

test('multi-site WordPress switching and adding new site', async () => {
    const mockConfigs = [
        {
            id: 10,
            storage_type: 'wordpress',
            name: 'Site A',
            wp_url: 'https://site-a.com',
            wp_username: 'user_a',
            has_wp_app_password: true
        },
        {
            id: 20,
            storage_type: 'wordpress',
            name: 'Site B',
            wp_url: 'https://site-b.com',
            wp_username: 'user_b',
            has_wp_app_password: false
        }
    ];

    const { ctx, elements } = createAssetHostingTestContext({
        mockFetch: async (url) => {
            if (url.includes('/api/storage/configs')) {
                return { ok: true, json: async () => mockConfigs };
            }
            return { ok: true, json: async () => ({}) };
        }
    });

    await ctx.loadStorageConfigsToModal();

    // Default should be site A (id 10)
    assert.strictEqual(elements.storageWpUrl.value, 'https://site-a.com');
    assert.strictEqual(elements.storageWpUsername.value, 'user_a');

    // Switch to site B (id 20)
    ctx.onWpSiteSelectChange('20');
    assert.strictEqual(elements.storageWpUrl.value, 'https://site-b.com');
    assert.strictEqual(elements.storageWpUsername.value, 'user_b');

    // Switch to add new site ('0')
    ctx.onWpSiteSelectChange('0');
    assert.strictEqual(elements.storageWpUrl.value, '');
    assert.strictEqual(elements.storageWpUsername.value, '');
    assert.strictEqual(elements.storageWpName.value, '');
});

test('multi-store Shopify switching and adding new store', async () => {
    const mockConfigs = [
        {
            id: 101,
            storage_type: 'shopify',
            name: 'Store US',
            shopify_shop_domain: 'us-store.myshopify.com',
            has_shopify_token: true
        },
        {
            id: 102,
            storage_type: 'shopify',
            name: 'Store EU',
            shopify_shop_domain: 'eu-store.myshopify.com',
            has_shopify_token: false
        }
    ];

    const { ctx, elements } = createAssetHostingTestContext({
        mockFetch: async (url) => {
            if (url.includes('/api/storage/configs')) {
                return { ok: true, json: async () => mockConfigs };
            }
            return { ok: true, json: async () => ({}) };
        }
    });

    await ctx.loadStorageConfigsToModal();

    // Default should be Store US (id 101)
    assert.strictEqual(elements.storageShopifyDomain.value, 'us-store.myshopify.com');

    // Switch to Store EU (id 102)
    ctx.onShopifyStoreSelectChange('102');
    assert.strictEqual(elements.storageShopifyDomain.value, 'eu-store.myshopify.com');

    // Switch to add new store ('0')
    ctx.onShopifyStoreSelectChange('0');
    assert.strictEqual(elements.storageShopifyDomain.value, '');
    assert.strictEqual(elements.storageShopifyName.value, '');
});

test('saveStorageConfigFromModal posts configuration payload to backend', async () => {
    let savedPayload = null;
    const { ctx, elements, getLastToast } = createAssetHostingTestContext({
        mockFetch: async (url, opts) => {
            if (url.includes('/api/storage/configs')) {
                return { ok: true, json: async () => [] };
            }
            if (url.includes('/api/storage/config')) {
                savedPayload = JSON.parse(opts.body);
                return { ok: true, json: async () => savedPayload };
            }
            return { ok: true, json: async () => ({}) };
        }
    });

    ctx.switchStorageTarget('wordpress');
    elements.storageWpName.value = 'Primary Blog';
    elements.storageWpUrl.value = 'https://mysite.com';
    elements.storageWpUsername.value = 'editor';
    elements.storageWpAppPassword.value = 'abcd 1234 efgh 5678';

    await ctx.saveStorageConfigFromModal();

    assert.ok(savedPayload);
    assert.strictEqual(savedPayload.storage_type, 'wordpress');
    assert.strictEqual(savedPayload.name, 'Primary Blog');
    assert.strictEqual(savedPayload.wp_url, 'https://mysite.com');
    assert.strictEqual(savedPayload.wp_username, 'editor');
    assert.strictEqual(savedPayload.wp_app_password, 'abcd 1234 efgh 5678');
    assert.strictEqual(getLastToast()?.type, 'success');
});

test('saveStorageConfigFromModal posts Shopify configuration payload', async () => {
    let savedPayload = null;
    const { ctx, elements, getLastToast } = createAssetHostingTestContext({
        mockFetch: async (url, opts) => {
            if (url.includes('/api/storage/configs')) {
                return { ok: true, json: async () => [] };
            }
            if (url.includes('/api/storage/config')) {
                savedPayload = JSON.parse(opts.body);
                return { ok: true, json: async () => savedPayload };
            }
            return { ok: true, json: async () => ({}) };
        }
    });

    ctx.switchStorageTarget('shopify');
    elements.storageShopifyName.value = 'Fashion Boutique';
    elements.storageShopifyDomain.value = 'https://fashion-boutique.myshopify.com';
    elements.storageShopifyAccessToken.value = 'shpat_987654321fedcba';

    await ctx.saveStorageConfigFromModal();

    assert.ok(savedPayload);
    assert.strictEqual(savedPayload.storage_type, 'shopify');
    assert.strictEqual(savedPayload.name, 'Fashion Boutique');
    assert.strictEqual(savedPayload.shopify_shop_domain, 'fashion-boutique.myshopify.com');
    assert.strictEqual(savedPayload.shopify_access_token, 'shpat_987654321fedcba');
    assert.strictEqual(getLastToast()?.type, 'success');
});

test('testStorageConnectionFromModal displays connection status in feedback area', async () => {
    const { ctx, elements, getLastToast } = createAssetHostingTestContext({
        mockFetch: async (url) => {
            if (url.includes('/api/storage/test')) {
                return {
                    ok: true,
                    json: async () => ({ success: true, message: 'WordPress REST API 连接成功！已识别用户: editor' })
                };
            }
            return { ok: true, json: async () => ({}) };
        }
    });

    ctx.switchStorageTarget('wordpress');
    elements.storageWpUrl.value = 'https://mysite.com';
    elements.storageWpUsername.value = 'editor';
    elements.storageWpAppPassword.value = 'abcd 1234 efgh 5678';

    await ctx.testStorageConnectionFromModal();

    assert.ok(elements.pdpStorageTestFeedback.innerHTML.includes('连接成功'));
    assert.strictEqual(getLastToast()?.type, 'success');
});

test('testStorageConnectionFromModal displays connection status for Shopify', async () => {
    let requestedPayload = null;
    const { ctx, elements, getLastToast } = createAssetHostingTestContext({
        mockFetch: async (url, opts) => {
            if (url.includes('/api/storage/test')) {
                requestedPayload = JSON.parse(opts.body);
                return {
                    ok: true,
                    json: async () => ({ success: true, message: 'Shopify Admin API 连接成功！已连接店铺: mystore.myshopify.com (My Shop)' })
                };
            }
            return { ok: true, json: async () => ({}) };
        }
    });

    ctx.switchStorageTarget('shopify');
    elements.storageShopifyName.value = 'My Shop';
    elements.storageShopifyDomain.value = 'mystore.myshopify.com';
    elements.storageShopifyAccessToken.value = 'shpat_12345678abcdef';

    await ctx.testStorageConnectionFromModal();

    assert.ok(requestedPayload);
    assert.strictEqual(requestedPayload.storage_type, 'shopify');
    assert.strictEqual(requestedPayload.shopify_shop_domain, 'mystore.myshopify.com');
    assert.ok(elements.pdpStorageTestFeedback.innerHTML.includes('Shopify Admin API 连接成功'));
    assert.strictEqual(getLastToast()?.type, 'success');
});

test('uploadSinglePdpAssetItem dispatches upload with config_id to Shopify', async () => {
    let uploadPayload = null;
    const mockConfigs = [
        {
            id: 88,
            storage_type: 'shopify',
            name: 'Shopify Store 88',
            shopify_shop_domain: 'store88.myshopify.com',
            has_shopify_token: true
        }
    ];

    const { ctx } = createAssetHostingTestContext({
        mockFetch: async (url, opts) => {
            if (url.includes('/api/storage/configs')) {
                return { ok: true, json: async () => mockConfigs };
            }
            if (url.includes('/api/storage/upload-image')) {
                uploadPayload = JSON.parse(opts.body);
                return {
                    ok: true,
                    json: async () => ({
                        success: true,
                        remote_url: 'https://cdn.shopify.com/s/files/1/0000/files/desk-m1.png'
                    })
                };
            }
            return { ok: true, json: async () => ({}) };
        }
    });

    await ctx.loadStorageConfigsToModal();
    ctx.switchStorageTarget('shopify');

    ctx.globalGenContext = {
        config: { productName: 'Desk' },
        tasks: {
            m1: { id: 'm1', title: 'Main', imageSrc: 'data:image/png;base64,fakeimage' }
        }
    };

    ctx.buildPdpAssetQueue();
    await ctx.uploadSinglePdpAssetItem(0);

    assert.ok(uploadPayload);
    assert.strictEqual(uploadPayload.storage_type, 'shopify');
    assert.strictEqual(uploadPayload.config_id, 88);
    const queue = ctx.getPdpAssetQueue();
    assert.strictEqual(queue[0].status, 'success');
    assert.strictEqual(queue[0].remoteUrl, 'https://cdn.shopify.com/s/files/1/0000/files/desk-m1.png');
});

test('uploadSinglePdpAssetItem uploads item and sets remote URL on success', async () => {
    const { ctx } = createAssetHostingTestContext({
        mockFetch: async (url, opts) => {
            if (url.includes('/api/storage/upload-image')) {
                return {
                    ok: true,
                    json: async () => ({
                        success: true,
                        remote_url: 'https://cdn.myshop.com/pdp/desk-m1.png'
                    })
                };
            }
            return { ok: true, json: async () => ({}) };
        }
    });

    ctx.globalGenContext = {
        config: { productName: 'Desk' },
        tasks: {
            m1: { id: 'm1', title: 'Main', imageSrc: 'data:image/png;base64,fakeimage' }
        }
    };

    ctx.buildPdpAssetQueue();
    const queue = ctx.getPdpAssetQueue();
    assert.strictEqual(queue[0].status, 'pending');

    await ctx.uploadSinglePdpAssetItem(0);

    assert.strictEqual(queue[0].status, 'success');
    assert.strictEqual(queue[0].remoteUrl, 'https://cdn.myshop.com/pdp/desk-m1.png');
    assert.strictEqual(queue[0].progress, 100);
});

test('applyRemoteUrlsToPdpHtml replaces task.imageSrc, stores originalImageSrc, and updates preview', () => {
    const { ctx, elements, getLastToast } = createAssetHostingTestContext();
    let previewRendered = false;
    ctx.renderDtcHybridPreview = () => { previewRendered = true; };
    ctx.saveDetailProjectToHistory = () => {};

    ctx.globalGenContext = {
        config: { productName: 'Desk' },
        tasks: {
            m1: { id: 'm1', title: 'Main', imageSrc: 'data:image/png;base64,local123' },
            m2: { id: 'm2', title: 'Specs', imageSrc: 'data:image/png;base64,local456' }
        }
    };

    ctx.buildPdpAssetQueue();
    const queue = ctx.getPdpAssetQueue();

    // Mark m1 as uploaded successfully, m2 as pending
    queue[0].status = 'success';
    queue[0].remoteUrl = 'https://cdn.myshop.com/pdp/desk-m1.png';

    const applied = ctx.applyRemoteUrlsToPdpHtml();

    assert.strictEqual(applied, 1);
    assert.strictEqual(ctx.globalGenContext.tasks.m1.originalImageSrc, 'data:image/png;base64,local123');
    assert.strictEqual(ctx.globalGenContext.tasks.m1.imageSrc, 'https://cdn.myshop.com/pdp/desk-m1.png');
    assert.strictEqual(ctx.globalGenContext.tasks.m1.remoteImageUrl, 'https://cdn.myshop.com/pdp/desk-m1.png');

    // m2 untouched
    assert.strictEqual(ctx.globalGenContext.tasks.m2.imageSrc, 'data:image/png;base64,local456');
    assert.ok(!ctx.globalGenContext.tasks.m2.originalImageSrc);

    assert.ok(previewRendered, 'renderDtcHybridPreview should be called');
    assert.strictEqual(getLastToast()?.type, 'success');
    assert.ok(elements.pdpAssetHostingBtnText.textContent.includes('图床已应用'));
});

test('revertToLocalPdpImages restores original image and resets status', () => {
    const { ctx, elements, getLastToast } = createAssetHostingTestContext();
    let previewRendered = false;
    ctx.renderDtcHybridPreview = () => { previewRendered = true; };
    ctx.saveDetailProjectToHistory = () => {};

    ctx.globalGenContext = {
        config: { productName: 'Desk' },
        tasks: {
            m1: {
                id: 'm1',
                title: 'Main',
                originalImageSrc: 'data:image/png;base64,local123',
                imageSrc: 'https://cdn.myshop.com/pdp/desk-m1.png',
                remoteImageUrl: 'https://cdn.myshop.com/pdp/desk-m1.png'
            }
        }
    };

    ctx.buildPdpAssetQueue();
    const reverted = ctx.revertToLocalPdpImages();

    assert.strictEqual(reverted, 1);
    assert.strictEqual(ctx.globalGenContext.tasks.m1.imageSrc, 'data:image/png;base64,local123');
    assert.strictEqual(ctx.globalGenContext.tasks.m1.remoteImageUrl, undefined);
    assert.ok(previewRendered, 'renderDtcHybridPreview should be called');
    assert.strictEqual(getLastToast()?.type, 'info');
    assert.strictEqual(elements.pdpAssetHostingBtnText.textContent, '图床托管 / 替换链接');
});

test('Zero-Touch Policy: closing modal without applying changes keeps imageSrc untouched', () => {
    const { ctx, elements } = createAssetHostingTestContext();

    ctx.globalGenContext = {
        config: { productName: 'Desk' },
        tasks: {
            m1: { id: 'm1', title: 'Main', imageSrc: 'data:image/png;base64,originalData' }
        }
    };

    ctx.openPdpAssetHostingModal();
    assert.ok(!elements.pdpAssetHostingModal.classList.contains('hidden'));

    // User switches targets and tests connection, but closes modal without clicking apply
    ctx.switchStorageTarget('r2');
    ctx.closePdpAssetHostingModal();

    assert.ok(elements.pdpAssetHostingModal.classList.contains('hidden'));
    assert.strictEqual(ctx.globalGenContext.tasks.m1.imageSrc, 'data:image/png;base64,originalData');
    assert.strictEqual(ctx.globalGenContext.tasks.m1.remoteImageUrl, undefined);
});

test('getStorageApiUrl normalizes various API_BASE formats consistently', () => {
    const { ctx } = createAssetHostingTestContext();
    ctx.API_BASE = 'http://localhost:9503';
    assert.strictEqual(ctx.getStorageApiUrl('storage/test'), 'http://localhost:9503/api/storage/test');
    assert.strictEqual(ctx.getStorageApiUrl('/storage/configs'), 'http://localhost:9503/api/storage/configs');

    ctx.API_BASE = 'http://127.0.0.1:9503/api';
    assert.strictEqual(ctx.getStorageApiUrl('storage/test'), 'http://127.0.0.1:9503/api/storage/test');

    ctx.API_BASE = 'http://127.0.0.1:9503/api/';
    assert.strictEqual(ctx.getStorageApiUrl('storage/test'), 'http://127.0.0.1:9503/api/storage/test');

    ctx.API_BASE = '';
    assert.strictEqual(ctx.getStorageApiUrl('storage/test'), '/api/storage/test');
});

test('testStorageConnectionFromModal succeeds when API_BASE has no /api suffix (production default)', async () => {
    let requestedUrl = '';
    const { ctx, elements, getLastToast } = createAssetHostingTestContext({
        mockFetch: async (url) => {
            requestedUrl = url;
            return {
                ok: true,
                status: 200,
                json: async () => ({ success: true, message: 'WordPress REST API 连接成功！已识别用户: TestBeforeBuy' })
            };
        }
    });

    ctx.API_BASE = 'http://localhost:9503';
    ctx.switchStorageTarget('wordpress');
    elements.storageWpUrl.value = 'https://testbeforebuy.com';
    elements.storageWpUsername.value = 'chengpeng6686@gmail.com';
    elements.storageWpAppPassword.value = 'xfAj 6Ub3 C5c7 1aoA 4RkP DDA1';

    await ctx.testStorageConnectionFromModal();

    assert.strictEqual(requestedUrl, 'http://localhost:9503/api/storage/test');
    assert.ok(elements.pdpStorageTestFeedback.innerHTML.includes('TestBeforeBuy'));
    assert.strictEqual(getLastToast()?.type, 'success');
});

test('switching storage targets dynamically updates item upload status and metrics based on target destination', async () => {
    const mockConfigs = [
        { id: 1, storage_type: 'wordpress', name: 'WP 1', wp_url: 'https://wp.example.com', is_default: true },
        { id: 2, storage_type: 'shopify', name: 'Shopify 1', shopify_shop_domain: 'shop.myshopify.com', is_default: true },
        { storage_type: 'r2', enabled: true, r2_public_url: 'https://r2.example.com' }
    ];

    const { ctx, elements } = createAssetHostingTestContext({
        mockFetch: async (url, opts) => {
            if (url.includes('/api/storage/configs')) {
                return { ok: true, json: async () => mockConfigs };
            }
            if (url.includes('/api/storage/upload-image')) {
                const payload = JSON.parse(opts.body);
                const prefix = payload.storage_type === 'wordpress' ? 'https://wp.example.com/uploads' : (payload.storage_type === 'shopify' ? 'https://cdn.shopify.com' : 'https://r2.example.com');
                return {
                    ok: true,
                    json: async () => ({
                        success: true,
                        remote_url: `${prefix}/${payload.filename}`
                    })
                };
            }
            return { ok: true, json: async () => ({}) };
        }
    });

    await ctx.loadStorageConfigsToModal();

    ctx.globalGenContext = {
        config: { productName: 'Ergo Pillow' },
        longImageOrder: ['m1', 'm2'],
        tasks: {
            m1: { id: 'm1', title: 'Feature', imageSrc: 'data:image/png;base64,m1data' },
            m2: { id: 'm2', title: 'Specs', imageSrc: 'data:image/png;base64,m2data' }
        }
    };

    ctx.buildPdpAssetQueue();
    ctx.renderPdpAssetHostingQueue();
    const queue = ctx.getPdpAssetQueue();

    // 1. Initially on WordPress: both items are pending
    assert.strictEqual(queue[0].status, 'pending');
    assert.strictEqual(queue[1].status, 'pending');
    assert.strictEqual(elements.pdpAssetPendingCount.textContent, '2');
    assert.strictEqual(elements.pdpAssetSuccessCount.textContent, '0');

    // 2. Upload m1 to WordPress
    await ctx.uploadSinglePdpAssetItem(0);
    assert.strictEqual(queue[0].status, 'success');
    assert.ok(queue[0].remoteUrl.includes('wp.example.com'));
    assert.strictEqual(queue[1].status, 'pending');
    assert.strictEqual(elements.pdpAssetSuccessCount.textContent, '1');
    assert.strictEqual(elements.pdpAssetPendingCount.textContent, '1');

    // 3. Switch to Shopify: m1 should NOT show as uploaded on Shopify!
    ctx.switchStorageTarget('shopify');
    assert.strictEqual(queue[0].status, 'pending', 'm1 should be pending on Shopify');
    assert.strictEqual(queue[0].remoteUrl, '', 'm1 remoteUrl should be empty for Shopify');
    assert.strictEqual(queue[1].status, 'pending', 'm2 should be pending on Shopify');
    assert.strictEqual(elements.pdpAssetSuccessCount.textContent, '0', 'Shopify success count should be 0');
    assert.strictEqual(elements.pdpAssetPendingCount.textContent, '2', 'Shopify pending count should be 2');

    // 4. Upload m1 to Shopify
    await ctx.uploadSinglePdpAssetItem(0);
    assert.strictEqual(queue[0].status, 'success');
    assert.ok(queue[0].remoteUrl.includes('cdn.shopify.com'));
    assert.strictEqual(elements.pdpAssetSuccessCount.textContent, '1');

    // 5. Switch back to WordPress: m1 should show WordPress URL and uploaded status
    ctx.switchStorageTarget('wordpress');
    assert.strictEqual(queue[0].status, 'success');
    assert.ok(queue[0].remoteUrl.includes('wp.example.com'));
    assert.strictEqual(elements.pdpAssetSuccessCount.textContent, '1');

    // 6. Switch to Cloudflare R2: both should be pending
    ctx.switchStorageTarget('r2');
    assert.strictEqual(queue[0].status, 'pending', 'm1 should be pending on R2');
    assert.strictEqual(queue[1].status, 'pending', 'm2 should be pending on R2');
    assert.strictEqual(elements.pdpAssetSuccessCount.textContent, '0');
    assert.strictEqual(elements.pdpAssetPendingCount.textContent, '2');
});

test('switching between WordPress sites isolates upload status per site', async () => {
    const mockConfigs = [
        { id: 10, storage_type: 'wordpress', name: 'Site Alpha', wp_url: 'https://alpha.com', is_default: true },
        { id: 20, storage_type: 'wordpress', name: 'Site Beta', wp_url: 'https://beta.com', is_default: false }
    ];

    const { ctx, elements } = createAssetHostingTestContext({
        mockFetch: async (url, opts) => {
            if (url.includes('/api/storage/configs')) {
                return { ok: true, json: async () => mockConfigs };
            }
            if (url.includes('/api/storage/upload-image')) {
                const payload = JSON.parse(opts.body);
                const host = payload.config_id === 20 ? 'https://beta.com' : 'https://alpha.com';
                return {
                    ok: true,
                    json: async () => ({
                        success: true,
                        remote_url: `${host}/uploads/${payload.filename}`
                    })
                };
            }
            return { ok: true, json: async () => ({}) };
        }
    });

    await ctx.loadStorageConfigsToModal();

    ctx.globalGenContext = {
        config: { productName: 'Ergo Pillow' },
        longImageOrder: ['m1'],
        tasks: {
            m1: { id: 'm1', title: 'Feature', imageSrc: 'data:image/png;base64,data' }
        }
    };

    ctx.buildPdpAssetQueue();
    const queue = ctx.getPdpAssetQueue();

    // Upload to Site Alpha (id 10)
    await ctx.uploadSinglePdpAssetItem(0);
    assert.strictEqual(queue[0].status, 'success');
    assert.ok(queue[0].remoteUrl.includes('alpha.com'));

    // Switch to Site Beta (id 20)
    ctx.onWpSiteSelectChange('20');
    assert.strictEqual(queue[0].status, 'pending', 'Item should be pending on Site Beta');
    assert.strictEqual(queue[0].remoteUrl, '');
    assert.strictEqual(elements.pdpAssetSuccessCount.textContent, '0');

    // Switch back to Site Alpha (id 10)
    ctx.onWpSiteSelectChange('10');
    assert.strictEqual(queue[0].status, 'success', 'Item should be restored to success on Site Alpha');
    assert.ok(queue[0].remoteUrl.includes('alpha.com'));
    assert.strictEqual(elements.pdpAssetSuccessCount.textContent, '1');

    // Switch to new unsaved site ('0')
    ctx.onWpSiteSelectChange('0');
    assert.strictEqual(queue[0].status, 'pending', 'Item should be pending on new unsaved site');
    assert.strictEqual(queue[0].remoteUrl, '');
});

test('switching storage targets or sites is prevented while upload is in progress', () => {
    const { ctx, elements, getLastToast } = createAssetHostingTestContext();
    ctx.switchStorageTarget('wordpress');

    // Simulate upload in progress
    ctx.isPdpAssetUploading = true;

    ctx.switchStorageTarget('shopify');
    assert.ok(!elements.pdpWpConfigArea.classList.contains('hidden'), 'WP area should remain visible');
    assert.ok(elements.pdpShopifyConfigArea.classList.contains('hidden'), 'Shopify area should remain hidden');
    assert.strictEqual(getLastToast()?.type, 'warning');
    assert.ok(getLastToast()?.msg.includes('正在批量上传'));

    ctx.onWpSiteSelectChange('99');
    assert.strictEqual(getLastToast()?.type, 'warning');

    ctx.onShopifyStoreSelectChange('88');
    assert.strictEqual(getLastToast()?.type, 'warning');
});

test('applyRemoteUrlsToPdpHtml records multi-target remoteImageUrls and activeStorageTarget into snapshot', () => {
    const { ctx } = createAssetHostingTestContext();
    ctx.renderDtcHybridPreview = () => {};
    ctx.saveDetailProjectToHistory = () => {};

    ctx.globalGenContext = {
        config: { productName: 'Smart Chair' },
        tasks: {
            m1: { id: 'm1', title: 'Main', imageSrc: 'data:image/png;base64,local123' }
        },
        longImageOrder: ['m1']
    };

    ctx.buildPdpAssetQueue();
    const queue = ctx.getPdpAssetQueue();

    // Mark uploaded on WordPress
    ctx.switchStorageTarget('wordpress');
    queue[0].status = 'success';
    queue[0].remoteUrl = 'https://my-wp.com/uploads/chair.png';
    ctx.applyRemoteUrlsToPdpHtml();

    assert.strictEqual(ctx.globalGenContext.tasks.m1.remoteImageUrl, 'https://my-wp.com/uploads/chair.png');
    assert.ok(ctx.globalGenContext.tasks.m1.activeStorageTarget.startsWith('wordpress'));
    assert.strictEqual(ctx.globalGenContext.tasks.m1.remoteImageUrls[ctx.globalGenContext.tasks.m1.activeStorageTarget], 'https://my-wp.com/uploads/chair.png');

    // Collect snapshot and verify it preserves remoteImageUrls
    const snapshot = ctx.collectCurrentRenderProject();
    assert.ok(snapshot);
    assert.strictEqual(snapshot.modules[0].remoteImageUrl, 'https://my-wp.com/uploads/chair.png');
    assert.ok(snapshot.modules[0].activeStorageTarget.startsWith('wordpress'));
    assert.strictEqual(snapshot.modules[0].remoteImageUrls[snapshot.modules[0].activeStorageTarget], 'https://my-wp.com/uploads/chair.png');
});

test('switching between Shopify stores isolates upload status per store and updates badge', async () => {
    const mockConfigs = [
        { id: 101, storage_type: 'shopify', name: 'US Flagship', shopify_shop_domain: 'us.myshopify.com', is_default: true },
        { id: 102, storage_type: 'shopify', name: 'EU Branch', shopify_shop_domain: 'eu.myshopify.com', is_default: false }
    ];

    const { ctx, elements } = createAssetHostingTestContext({
        mockFetch: async (url, opts) => {
            if (url.includes('/api/storage/configs')) {
                return { ok: true, json: async () => mockConfigs };
            }
            if (url.includes('/api/storage/upload-image')) {
                const payload = JSON.parse(opts.body);
                const host = payload.config_id === 102 ? 'https://cdn.shopify.com/eu' : 'https://cdn.shopify.com/us';
                return {
                    ok: true,
                    json: async () => ({
                        success: true,
                        remote_url: `${host}/${payload.filename}`
                    })
                };
            }
            return { ok: true, json: async () => ({}) };
        }
    });

    await ctx.loadStorageConfigsToModal();
    ctx.switchStorageTarget('shopify');

    ctx.globalGenContext = {
        config: { productName: 'Ergo Pillow' },
        longImageOrder: ['m1'],
        tasks: {
            m1: { id: 'm1', title: 'Feature', imageSrc: 'data:image/png;base64,data' }
        }
    };

    ctx.buildPdpAssetQueue();
    const queue = ctx.getPdpAssetQueue();

    // Upload to Store US (id 101)
    await ctx.uploadSinglePdpAssetItem(0);
    assert.strictEqual(queue[0].status, 'success');
    assert.ok(queue[0].remoteUrl.includes('cdn.shopify.com/us'));
    assert.ok(elements.pdpAssetHostingModeBadge.textContent.includes('US Flagship'));

    // Switch to Store EU (id 102)
    ctx.onShopifyStoreSelectChange('102');
    assert.strictEqual(queue[0].status, 'pending', 'Item should be pending on Store EU');
    assert.strictEqual(queue[0].remoteUrl, '');
    assert.strictEqual(elements.pdpAssetSuccessCount.textContent, '0');
    assert.ok(elements.pdpAssetHostingModeBadge.textContent.includes('EU Branch'));

    // Switch back to Store US (id 101)
    ctx.onShopifyStoreSelectChange('101');
    assert.strictEqual(queue[0].status, 'success', 'Item should be restored to success on Store US');
    assert.ok(queue[0].remoteUrl.includes('cdn.shopify.com/us'));
    assert.strictEqual(elements.pdpAssetSuccessCount.textContent, '1');

    // Switch to new unsaved store ('0')
    ctx.onShopifyStoreSelectChange('0');
    assert.strictEqual(queue[0].status, 'pending', 'Item should be pending on new unsaved store');
    assert.strictEqual(queue[0].remoteUrl, '');
    assert.ok(elements.pdpAssetHostingModeBadge.textContent.includes('新增店铺'));
});
