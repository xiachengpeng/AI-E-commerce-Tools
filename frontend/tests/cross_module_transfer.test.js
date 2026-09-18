const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const {
    transferListingToDetails,
    transferListingToAds,
    setCurrentListingData,
    getCurrentListingData
} = require('../js/listing.js');

const {
    getBrandProfiles,
    saveOrUpdateProfile,
    saveBrandProfilesToStorage,
    syncBrandProfilesToBackend,
    syncBrandProfilesFromBackend,
    applyProfileToModule
} = require('../js/brand_context.js');

function createMockElement(id = '', initialValue = '') {
    return {
        id,
        value: initialValue,
        textContent: '',
        style: {},
        classList: {
            classes: new Set(),
            add(cls) { this.classes.add(cls); },
            remove(cls) { this.classes.delete(cls); },
            contains(cls) { return this.classes.has(cls); }
        }
    };
}

test('index.html contains Listing transfer buttons and Analysis progress elements', () => {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

    // Transfer buttons in listing export bar
    assert.match(html, /id="btnTransferListingToDetails"/);
    assert.match(html, /id="btnTransferListingToAds"/);
    assert.match(html, /onclick="transferListingToDetails\(\)"/);
    assert.match(html, /onclick="transferListingToAds\(\)"/);

    // Staged progress in analysis
    assert.match(html, /id="xp-loadingStageLabel"/);
    assert.match(html, /id="xp-progressBar"/);
    assert.match(html, /id="xp-elapsedTimer"/);
});

test('transferListingToDetails transfers title, bullets, description, and keywords to Details inputs', () => {
    const productNameInput = createMockElement('productNameInput', '');
    const sellingPointsText = createMockElement('sellingPointsText', '');
    const productFactsText = createMockElement('productFactsText', '');

    let switchedTab = null;
    let toastMessage = null;

    global.document = {
        getElementById(id) {
            if (id === 'productNameInput') return productNameInput;
            if (id === 'sellingPointsText') return sellingPointsText;
            if (id === 'productFactsText') return productFactsText;
            return null;
        }
    };
    global.switchMainTab = (tab) => { switchedTab = tab; };
    global.showToast = (msg, type) => { toastMessage = { msg, type }; };

    // Set mock listing data
    setCurrentListingData({
        title: { target: 'Ergonomic Office Chair with Lumbar Support', zh: '人体工学电脑办公椅带可调节腰托' },
        bullets: [
            { target: 'Breathable mesh backrest', zh: '高弹透气网布靠背，久坐不闷热' },
            { target: '3D adjustable armrests', zh: '3D多维调节扶手，自由匹配手臂高度' }
        ],
        description: { target: 'High durability steel base with smooth casters', zh: '高强度防爆钢制底盘与静音滑轮' },
        searchTerms: { target: 'office chair ergonomic lumbar support desk chair', zh: '' },
        keywords: ['mesh chair', 'computer chair', 'desk chair']
    });

    transferListingToDetails();

    assert.equal(switchedTab, 'generate');
    assert.equal(productNameInput.value, '人体工学电脑办公椅带可调节腰托');
    assert.match(sellingPointsText.value, /【核心卖点】/);
    assert.match(sellingPointsText.value, /高弹透气网布靠背/);
    assert.match(sellingPointsText.value, /3D多维调节扶手/);
    assert.match(sellingPointsText.value, /【详细规格与功能说明】/);
    assert.match(sellingPointsText.value, /高强度防爆钢制底盘/);
    assert.match(productFactsText.value, /核心搜索词: office chair ergonomic lumbar support desk chair/);
    assert.match(productFactsText.value, /关键词库: mesh chair, computer chair, desk chair/);
    assert.equal(toastMessage?.type, 'success');
});

test('transferListingToDetails guards against clobbering existing user inputs without confirmation', () => {
    const productNameInput = createMockElement('productNameInput', 'Existing Custom Product');
    const sellingPointsText = createMockElement('sellingPointsText', 'Existing points');
    const productFactsText = createMockElement('productFactsText', '');

    let switchedTab = null;
    global.document = {
        getElementById(id) {
            if (id === 'productNameInput') return productNameInput;
            if (id === 'sellingPointsText') return sellingPointsText;
            if (id === 'productFactsText') return productFactsText;
            return null;
        }
    };
    global.switchMainTab = (tab) => { switchedTab = tab; };

    // User rejects overwrite
    global.confirm = () => false;

    setCurrentListingData({
        title: { target: 'New Chair', zh: '新椅子' },
        bullets: [{ target: 'Bullet 1', zh: '卖点 1' }],
        description: { target: 'Desc', zh: '描述' }
    });

    transferListingToDetails();

    assert.equal(productNameInput.value, 'Existing Custom Product');
    assert.equal(sellingPointsText.value, 'Existing points');
    assert.equal(switchedTab, null);

    // User accepts overwrite
    global.confirm = () => true;
    transferListingToDetails();

    assert.equal(productNameInput.value, '新椅子');
    assert.match(sellingPointsText.value, /卖点 1/);
    assert.equal(switchedTab, 'generate');
});

test('transferListingToAds transfers product name to ads input and switches tab', () => {
    const adsProductNameInput = createMockElement('adsProductNameInput', '');

    let switchedTab = null;
    let toastMessage = null;

    global.document = {
        getElementById(id) {
            if (id === 'adsProductNameInput') return adsProductNameInput;
            return null;
        }
    };
    global.switchMainTab = (tab) => { switchedTab = tab; };
    global.showToast = (msg, type) => { toastMessage = { msg, type }; };

    setCurrentListingData({
        title: { target: 'Ultra Quiet Portable Blender', zh: '超静音便携果汁机' },
        bullets: []
    });

    transferListingToAds();

    assert.equal(switchedTab, 'ads');
    assert.equal(adsProductNameInput.value, '超静音便携果汁机');
    assert.equal(toastMessage?.type, 'success');
});

test('brandContextHub synchronizes profiles with backend /api/brand-profiles and updates tokens', async () => {
    let storageVal = null;
    global.localStorage = {
        getItem: (k) => storageVal,
        setItem: (k, v) => { storageVal = String(v); },
        removeItem: (k) => { storageVal = null; }
    };

    let postUrl = null;
    let postBody = null;
    global.fetch = async (url, opts) => {
        if (opts?.method === 'POST') {
            postUrl = url;
            postBody = JSON.parse(opts.body);
            return {
                ok: true,
                json: async () => ({ status: 'success', count: postBody.profiles.length })
            };
        }
        return {
            ok: true,
            json: async () => ({ status: 'success', profiles: [{ id: 'backend-prof-1', name: 'Server Brand' }] })
        };
    };

    // Test sync to backend
    const testProfiles = [
        { id: 'prof-test-1', name: 'Test Brand', brandColor: '#2563eb', brandFont: 'Inter' }
    ];
    saveBrandProfilesToStorage(testProfiles);

    const syncResult = await syncBrandProfilesToBackend();
    assert.ok(syncResult);
    assert.match(postUrl, /\/api\/brand-profiles/);
    assert.equal(postBody.profiles.length, 1);
    assert.equal(postBody.profiles[0].id, 'prof-test-1');

    // Test sync from backend
    const loadedProfiles = await syncBrandProfilesFromBackend();
    assert.equal(loadedProfiles.length, 1);
    assert.equal(loadedProfiles[0].id, 'backend-prof-1');
});

test('applyProfileToModule synchronizes brandColor and brandFont design tokens to Details', () => {
    let customColorSet = null;
    let typoConfigApplied = null;

    global.setDtcCustomBrandColor = (hex) => { customColorSet = hex; };
    global.applyDtcTypographyConfig = (cfg) => { typoConfigApplied = cfg; };
    global.dtcTypographyConfig = { fontFamily: 'System' };
    global.currentDtcStyle = 'editorial';

    const testProfile = {
        id: 'prof-design-token',
        name: 'Design Brand',
        brandColor: '#ff6600',
        brandFont: 'Poppins',
        painPoints: 'Slow setup',
        differentiators: 'Instant launch'
    };

    // Mock DOM elements for details
    const sellingPointsText = createMockElement('sellingPointsText', '');
    global.document = {
        getElementById(id) {
            if (id === 'sellingPointsText') return sellingPointsText;
            return null;
        },
        querySelectorAll() { return []; }
    };

    applyProfileToModule('details', testProfile);

    assert.equal(customColorSet, '#ff6600');
    assert.equal(typoConfigApplied?.fontFamily, 'Poppins');
});

test('xp_resetAnalysisSession resets progress bar and elapsed timer', () => {
    const analysisScript = fs.readFileSync(path.join(root, 'js/analysis.js'), 'utf8');
    const vm = require('node:vm');

    const loadingSection = createMockElement('xp-loadingSection');
    const stageLabel = createMockElement('xp-loadingStageLabel');
    stageLabel.textContent = '阶段 3/3: 竞争攻防策略与战力卡生成中...';
    const progressBar = createMockElement('xp-progressBar');
    progressBar.style.width = '85%';
    const timerLabel = createMockElement('xp-elapsedTimer');
    timerLabel.textContent = '已耗时: 22s';
    const urlInput = createMockElement('xp-urlInputField');
    const resultSection = createMockElement('xp-resultSection');
    const singleTpl = createMockElement('xp-single-template');
    const matrixTpl = createMockElement('xp-matrix-template');
    const errorMsg = createMockElement('xp-errorMsg');

    const sandbox = {
        document: {
            getElementById(id) {
                if (id === 'xp-loadingSection') return loadingSection;
                if (id === 'xp-loadingStageLabel') return stageLabel;
                if (id === 'xp-progressBar') return progressBar;
                if (id === 'xp-elapsedTimer') return timerLabel;
                if (id === 'xp-urlInputField') return urlInput;
                if (id === 'xp-resultSection') return resultSection;
                if (id === 'xp-single-template') return singleTpl;
                if (id === 'xp-matrix-template') return matrixTpl;
                if (id === 'xp-errorMsg') return errorMsg;
                return null;
            }
        },
        localStorage: {
            removeItem() {},
            getItem() { return null; },
            setItem() {}
        },
        showToast() {},
        console
    };
    sandbox.window = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(analysisScript, sandbox);

    assert.equal(typeof sandbox.xp_resetAnalysisSession, 'function');
    sandbox.xp_resetAnalysisSession();

    assert.equal(progressBar.style.width, '0%');
    assert.equal(timerLabel.textContent, '已耗时: 0s');
    assert.match(stageLabel.textContent, /阶段 1\/3/);
});
