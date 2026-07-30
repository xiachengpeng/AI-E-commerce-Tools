const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'frontend/js/ads.js'), 'utf8');

test('Pinterest PIN is a checked peer ad type', () => {
    const inputTags = html.match(/<input\b[^>]*>/g) || [];
    const pinterestInput = inputTags.find(tag => /\bvalue="pinterest"/.test(tag));

    assert.ok(pinterestInput, 'Pinterest checkbox should exist');
    assert.match(pinterestInput, /class="[^"]*\bads-platform-checkbox\b[^"]*"/);
    assert.match(pinterestInput, /(?:^|\s)checked(?:\s|>)/);
    assert.match(html, /Pinterest PIN/);
});

test('ads form exposes an optional bounded product name hint', () => {
    assert.match(html, /id="adsProductNameInput"/);
    assert.match(html, /maxlength="200"/);
    assert.match(html, /产品名称/);
    assert.match(html, /选填，填写后将结合图片识别/);
});

test('ads results expose an accessible sticky filter shell', () => {
    assert.match(html, /id="adsResultsScroll"/);
    assert.match(html, /id="adsFilters"/);
    assert.match(html, /id="adsPlatformFilters"/);
    assert.match(html, /id="adsStyleFilter"/);
    assert.match(html, /aria-label="创意角度筛选"/);
    assert.match(html, /广告平台/);
    assert.match(html, /创意角度/);
});

function loadAds(overrides = {}) {
    const clipboardWrites = [];
    const context = {
        console,
        setTimeout,
        URL,
        Blob,
        FileReader: class {},
        navigator: {
            clipboard: {
                writeText: async text => clipboardWrites.push(text),
            },
        },
        document: {
            querySelectorAll: () => [],
            getElementById: () => null,
            createElement: () => ({
                className: '',
                innerHTML: '',
                addEventListener() {},
            }),
            body: { appendChild() {}, removeChild() {} },
        },
        window: {},
        showToast() {},
        escapeHtml: value => String(value ?? ''),
        ...overrides,
    };
    vm.createContext(context);
    vm.runInContext(source, context);
    return { context, clipboardWrites };
}

test('availableAdsPlatforms returns only present platforms in canonical order', () => {
    const { context } = loadAds();
    const result = Array.from(context.availableAdsPlatforms({
        styles: [
            { id: 'first', pinterest: {}, google: {} },
            { id: 'second', facebook: {} },
        ],
    }));
    assert.deepEqual(result, ['facebook', 'google', 'pinterest']);
    assert.deepEqual(
        Array.from(context.availableAdsPlatforms({ styles: [] })),
        []
    );
});

test('adsStyleKey uses id, styleId, then stable index fallback', () => {
    const { context } = loadAds();
    assert.equal(context.adsStyleKey({ id: 'problem_solution' }, 0), 'problem_solution');
    assert.equal(context.adsStyleKey({ styleId: 'emotional' }, 1), 'emotional');
    assert.equal(context.adsStyleKey({}, 2), 'style-index-2');
});

function escapeTestHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function fakeElement(tracker = null) {
    const children = [];
    const attributes = new Map();
    const listeners = new Map();
    let html = '';
    let text = '';
    return {
        className: '',
        children,
        dataset: {},
        classList: { add() {}, remove() {} },
        addEventListener(type, callback) {
            listeners.set(type, callback);
        },
        click() {
            listeners.get('click')?.({ target: this });
        },
        setAttribute(name, value) {
            attributes.set(name, String(value));
        },
        getAttribute(name) {
            return attributes.get(name) || null;
        },
        replaceChildren(...nodes) {
            children.length = 0;
            html = '';
            text = '';
            nodes.forEach(node => this.appendChild(node));
        },
        appendChild(node) {
            children.push(node);
            return node;
        },
        append(...nodes) {
            nodes.forEach(node => this.appendChild(node));
        },
        set innerHTML(value) {
            html = String(value ?? '');
            text = html.replace(/<[^>]*>/g, '');
            tracker?.innerHTMLAssignments.push(html);
        },
        get innerHTML() {
            return `${html}${escapeTestHtml(text)}${children.map(child => child.innerHTML).join('')}`;
        },
        set textContent(value) {
            text = String(value ?? '');
            children.length = 0;
            html = '';
            tracker?.textContentAssignments.push(text);
        },
        get textContent() { return text; },
    };
}

function loadAdsFilterHarness() {
    const tracker = {
        innerHTMLAssignments: [],
        textContentAssignments: [],
    };
    const filterControls = {
        adsFilters: fakeElement(tracker),
        adsPlatformFilters: fakeElement(tracker),
        adsStyleFilter: {
            ...fakeElement(tracker),
            value: 'all',
            options: [],
            addEventListener() {},
        },
        adsResultsScroll: { scrollTop: 240 },
    };
    const adsResults = fakeElement(tracker);
    const fetchCalls = [];
    const { context, clipboardWrites } = loadAds({
        fetch: (...args) => {
            fetchCalls.push(args);
            return Promise.reject(new Error('filtering must not fetch'));
        },
        document: {
            querySelectorAll: () => [],
            getElementById: id => ({
                ...filterControls,
                adsEmpty: { classList: { add() {} } },
                adsResults,
            })[id] || null,
            createElement: () => fakeElement(tracker),
            body: { appendChild() {}, removeChild() {} },
        },
    });
    const sampleData = {
        product: {
            name: { target: 'Desk lamp', zh: '台灯' },
            summary: { target: 'Warm reading light', zh: '温暖阅读光' },
        },
        styles: [
            {
                id: 'problem_solution',
                name: { target: 'Problem Solution', zh: '痛点解决' },
                facebook: { headline: { target: 'Less glare' } },
                pinterest: { title: { target: 'Save this glow' } },
            },
            {
                id: 'feature_benefit',
                name: { target: 'Feature Benefit', zh: '功能利益' },
                google: { headlines: [{ target: 'Soft light' }] },
            },
        ],
    };
    return {
        context,
        clipboardWrites,
        fetchCalls,
        results: adsResults,
        tracker,
        sampleData,
        scrollPane: filterControls.adsResultsScroll,
        filters: () => ({
            platform: vm.runInContext('currentAdsPlatformFilter', context),
            style: vm.runInContext('currentAdsStyleFilter', context),
        }),
        platformButtons: () => filterControls.adsPlatformFilters.children,
        styleOptions: () => filterControls.adsStyleFilter.children,
        styleCards: () => adsResults.children.slice(1)
            .filter(card => card.className.includes('shadow-sm')),
    };
}

function sampleAllPlatformStyle() {
    return {
        name: { target: 'Problem/Solution', zh: '痛点解决' },
        logic: { target: 'Solve morning clutter', zh: '解决晨间杂乱' },
        facebook: {
            primaryText: { target: 'Facebook primary' },
            headline: { target: 'Facebook headline' },
            description: { target: 'Facebook description' },
            cta: { target: 'Shop now' },
            creativeDirection: { target: 'Clean desk photo' },
        },
        google: {
            headlines: [{ target: 'Google headline' }],
            descriptions: [{ target: 'Google description' }],
            keywords: [{ target: 'Google keyword' }],
            sitelinks: [{ target: 'Google sitelink' }],
        },
        pinterest: {
            title: { target: 'Pinterest title', zh: '灵感标题' },
            description: { target: 'Pinterest description', zh: '灵感描述' },
            tags: [{ target: '#Tag1' }, { target: '#Tag2' }],
            altText: { target: 'Pinterest alt text', zh: '灵感替代文本' },
        },
    };
}

test('new ads data builds only available platforms and defaults to the first', () => {
    const harness = loadAdsFilterHarness();
    harness.context.renderAdsData({
        product: {},
        styles: [{
            id: 'problem_solution',
            name: { target: 'Problem/Solution', zh: '痛点解决型' },
            google: {},
            pinterest: {},
        }],
    });

    assert.deepEqual(harness.filters(), { platform: 'google', style: 'all' });
    assert.deepEqual(
        harness.platformButtons().map(button => button.textContent),
        ['全部平台', 'Google', 'Pinterest PIN']
    );
    assert.equal(
        harness.platformButtons().find(button => button.textContent === 'Google')
            .getAttribute('aria-pressed'),
        'true'
    );
    assert.match(
        harness.platformButtons().find(button => button.textContent === 'Google')
            .className,
        /bg-emerald-600/
    );
    assert.deepEqual(
        harness.styleOptions().map(option => option.textContent),
        ['全部创意角度', '痛点解决型']
    );
});

test('ads style filter binds its change listener once', () => {
    const listeners = [];
    const styleFilter = {
        dataset: {},
        addEventListener(type, callback) {
            listeners.push({ type, callback });
        },
    };
    const { context } = loadAds({
        document: {
            querySelectorAll: () => [],
            getElementById: id => id === 'adsStyleFilter' ? styleFilter : null,
            createElement: fakeElement,
            body: { appendChild() {}, removeChild() {} },
        },
    });

    context.initAdsControls();
    context.initAdsControls();

    assert.equal(listeners.length, 1);
    assert.equal(listeners[0].type, 'change');
});

test('platform and style filters combine without issuing fetch', () => {
    const harness = loadAdsFilterHarness();
    harness.context.renderAdsData(harness.sampleData);
    harness.context.setAdsPlatformFilter('google');
    harness.context.setAdsStyleFilter('feature_benefit');

    const cards = harness.styleCards();
    assert.equal(cards.length, 1);
    assert.match(cards[0].innerHTML, /Feature Benefit/);
    assert.match(cards[0].innerHTML, /Google Ads/);
    assert.doesNotMatch(cards[0].innerHTML, /Facebook Ads/);
    assert.doesNotMatch(cards[0].innerHTML, /Pinterest PIN/);
    assert.equal(harness.fetchCalls.length, 0);
});

test('all platform filter restores all present platform sections', () => {
    const harness = loadAdsFilterHarness();
    harness.context.renderAdsData(harness.sampleData);
    harness.context.setAdsPlatformFilter('all');

    const html = harness.styleCards().map(card => card.innerHTML).join('');
    assert.match(html, /Facebook Ads/);
    assert.match(html, /Google Ads/);
    assert.match(html, /Pinterest PIN/);
});

test('copy includes only the selected visible platform', async () => {
    const { context, clipboardWrites } = loadAds();
    await context.copyAdsStyleText(sampleAllPlatformStyle(), 'google');

    const copied = clipboardWrites[0];
    assert.match(copied, /\[Google\]/);
    assert.doesNotMatch(copied, /\[Facebook\]/);
    assert.doesNotMatch(copied, /\[Pinterest PIN\]/);
    assert.match(copied, /Problem\/Solution/);
    assert.match(copied, /Logic:/);
});

test('copy all includes every present platform', async () => {
    const { context, clipboardWrites } = loadAds();
    await context.copyAdsStyleText(sampleAllPlatformStyle(), 'all');

    const copied = clipboardWrites[0];
    assert.match(copied, /\[Facebook\]/);
    assert.match(copied, /\[Google\]/);
    assert.match(copied, /\[Pinterest PIN\]/);
    assert.match(copied, /Description: Pinterest description#Tag1#Tag2/);
});

test('empty filtered combinations show a reset action without fetch', () => {
    const harness = loadAdsFilterHarness();
    harness.context.renderAdsData(harness.sampleData);
    harness.context.setAdsPlatformFilter('facebook');
    harness.context.setAdsStyleFilter('feature_benefit');

    assert.equal(harness.styleCards().length, 0);
    assert.match(harness.results.innerHTML, /当前筛选条件下没有结果/);
    const reset = findElement(
        harness.results,
        element => element.textContent === '重置筛选'
    );
    assert.ok(reset);
    reset.click();
    assert.deepEqual(harness.filters(), { platform: 'facebook', style: 'all' });
    assert.equal(harness.fetchCalls.length, 0);
});

test('rendered copy button captures the platform used for that repaint', async () => {
    const harness = loadAdsFilterHarness();
    harness.context.renderAdsData(harness.sampleData);
    harness.context.setAdsPlatformFilter('pinterest');
    const copyButton = findElement(
        harness.styleCards()[0],
        element => element.textContent === '复制'
    );
    assert.ok(copyButton);
    copyButton.click();
    await Promise.resolve();
    assert.match(harness.clipboardWrites[0], /\[Pinterest PIN\]/);
    assert.doesNotMatch(harness.clipboardWrites[0], /\[Facebook\]|\[Google\]/);
});

test('filter rendering tolerates missing styles and missing platform blocks', () => {
    const harness = loadAdsFilterHarness();
    assert.doesNotThrow(() => harness.context.renderAdsData({ product: {}, styles: null }));
    assert.equal(harness.filters().platform, 'all');
    assert.doesNotThrow(() => harness.context.renderAdsData({
        product: {},
        styles: [{ name: { target: '<img onerror=alert(1)>', zh: '安全文本' } }],
    }));
    assert.ok(harness.tracker.textContentAssignments.includes('<img onerror=alert(1)>'));
});

test('filter repaint preserves scroll and new data resets stale filters', () => {
    const harness = loadAdsFilterHarness();
    harness.context.renderAdsData(harness.sampleData);
    harness.scrollPane.scrollTop = 240;
    harness.context.setAdsStyleFilter('feature_benefit');
    assert.equal(harness.scrollPane.scrollTop, 240);

    harness.context.renderAdsData({
        product: {},
        styles: [{
            id: 'new_style',
            name: { target: 'New Style', zh: '新角度' },
            pinterest: {},
        }],
    });
    assert.deepEqual(harness.filters(), { platform: 'pinterest', style: 'all' });
});

function renderPinterest(pinterest, tracker = null) {
    const children = [];
    const results = fakeElement(tracker);
    results.appendChild = node => {
        children.push(node);
        return node;
    };
    const { context } = loadAds({
        document: {
            querySelectorAll: () => [],
            getElementById: id => {
                if (id === 'adsResults') return results;
                if (id === 'adsEmpty') return { classList: { add() {} } };
                return null;
            },
            createElement: () => fakeElement(tracker),
            body: { appendChild() {}, removeChild() {} },
        },
    });

    context.renderAdsData({
        styles: [{
            styleId: 'emotional',
            name: { target: 'Emotional', zh: '情感共鸣' },
            pinterest,
        }],
    });

    assert.equal(children.length, 2);
    return children[1];
}

function findElement(root, predicate) {
    if (predicate(root)) return root;
    for (const child of root.children || []) {
        const match = findElement(child, predicate);
        if (match) return match;
    }
    return null;
}

test('selectedAdsPlatforms includes the checked Pinterest value', () => {
    const selectors = [];
    const { context } = loadAds({
        document: {
            querySelectorAll: selector => {
                selectors.push(selector);
                return [
                    { value: 'facebook' },
                    { value: 'google' },
                    { value: 'pinterest' },
                ];
            },
            getElementById: () => null,
            createElement: fakeElement,
            body: { appendChild() {}, removeChild() {} },
        },
    });

    assert.deepEqual(Array.from(context.selectedAdsPlatforms()), [
        'facebook',
        'google',
        'pinterest',
    ]);
    assert.deepEqual(selectors, ['.ads-platform-checkbox:checked']);
});

test('generateAdsCopy includes Pinterest in the generated request payload', async () => {
    const requests = [];
    const results = fakeElement();
    const controls = {
        adsEmpty: { classList: { add() {} } },
        adsResults: results,
        adsRegionSelect: {
            selectedIndex: 0,
            options: [{ value: 'US Market' }],
        },
        adsLanguageSelect: {
            selectedIndex: 0,
            options: [{ value: 'English' }],
        },
        adsMarketingThemeSelect: {
            selectedIndex: 0,
            value: 'evergreen',
            options: [{ text: 'Evergreen' }],
        },
        adsProductNameInput: { value: '  Padel racket  ' },
        btnGenerateAds: {
            innerHTML: 'Generate',
            disabled: false,
        },
    };
    const { context } = loadAds({
        API_BASE: 'http://localhost:8000',
        fetch: async (url, options) => {
            requests.push({ url, options });
            return {
                json: async () => ({
                    status: 'success',
                    data: { product: {}, styles: [] },
                }),
            };
        },
        document: {
            querySelectorAll: selector => {
                assert.equal(selector, '.ads-platform-checkbox:checked');
                return [
                    { value: 'facebook' },
                    { value: 'google' },
                    { value: 'pinterest' },
                ];
            },
            getElementById: id => controls[id] || null,
            createElement: fakeElement,
            body: { appendChild() {}, removeChild() {} },
        },
    });
    vm.runInContext(
        "currentAdsUploadedBase64 = 'data:image/png;base64,cGludGVyZXN0'",
        context
    );

    await context.generateAdsCopy();

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'http://localhost:8000/api/ads/generate');
    const payload = JSON.parse(requests[0].options.body);
    assert.deepEqual(payload.platforms, ['facebook', 'google', 'pinterest']);
    assert.equal(payload.image_data, 'data:image/png;base64,cGludGVyZXN0');
    assert.equal(payload.product_name, 'Padel racket');
});

test('generateAdsCopy omits blank product name hints from the request payload', async () => {
    const requests = [];
    const controls = {
        adsEmpty: { classList: { add() {} } },
        adsResults: fakeElement(),
        adsRegionSelect: { selectedIndex: 0, options: [{ value: 'US Market' }] },
        adsLanguageSelect: { selectedIndex: 0, options: [{ value: 'English' }] },
        adsMarketingThemeSelect: {
            selectedIndex: 0,
            value: 'evergreen',
            options: [{ text: 'Evergreen' }],
        },
        adsProductNameInput: { value: '   ' },
        btnGenerateAds: { innerHTML: 'Generate', disabled: false },
    };
    const { context } = loadAds({
        API_BASE: 'http://localhost:8000',
        fetch: async (url, options) => {
            requests.push({ url, options });
            return { json: async () => ({ status: 'success', data: { product: {}, styles: [] } }) };
        },
        document: {
            querySelectorAll: () => [{ value: 'pinterest' }],
            getElementById: id => controls[id] || null,
            createElement: fakeElement,
            body: { appendChild() {}, removeChild() {} },
        },
    });
    vm.runInContext("currentAdsUploadedBase64 = 'data:image/png;base64,cGludGVyZXN0'", context);

    await context.generateAdsCopy();

    const payload = JSON.parse(requests[0].options.body);
    assert.equal(Object.hasOwn(payload, 'product_name'), false);
});

test('Pinterest descriptions append same-language tags without spaces', () => {
    const { context } = loadAds();
    assert.deepEqual(
        { ...context.pinterestDescriptionWithTags({
            description: { target: 'Play with control.', zh: '精准控球。' },
            tags: [
                { target: '#PadelRacket', zh: '#板式网球拍' },
                { target: '#PadelLife', zh: '#板式网球生活' },
                { target: '', zh: '#运动装备' },
            ],
        }) },
        {
            target: 'Play with control.#PadelRacket#PadelLife',
            zh: '精准控球。#板式网球拍#板式网球生活#运动装备',
        }
    );
});

test('Pinterest description composition tolerates missing and partial tags', () => {
    const { context } = loadAds();
    const result = { ...context.pinterestDescriptionWithTags({
        description: null,
        tags: [
            { target: '#OnlyTarget', zh: '' },
            { target: '', zh: '#仅中文' },
        ],
    }) };
    assert.deepEqual(result, {
        target: '#OnlyTarget',
        zh: '#仅中文',
    });
});

test('copyAdsStyleText copies Pinterest fields in the required order', async () => {
    const { context, clipboardWrites } = loadAds();
    await context.copyAdsStyleText({
        name: { target: 'Emotional', zh: '情感共鸣' },
        pinterest: {
            title: { target: 'Title', zh: '标题' },
            description: { target: 'Description', zh: '描述' },
            tags: [
                { target: '#HomeDecor', zh: '#家居装饰' },
                { target: '#CalmHome', zh: '#宁静之家' },
            ],
            altText: { target: 'Chair by window', zh: '窗边座椅' },
        },
    });

    const copied = clipboardWrites[0];
    assert.equal(copied, [
        'Emotional / 情感共鸣',
        '',
        '[Pinterest PIN]',
        'Title: Title',
        '标题: 标题',
        'Description: Description#HomeDecor#CalmHome',
        '描述: 描述#家居装饰#宁静之家',
        'Alt Text: Chair by window',
        '替代文本: 窗边座椅',
    ].join('\n'));
});

test('renderAdsData renders Pinterest descriptions with inline same-language tags', () => {
    const card = renderPinterest({
        title: { target: 'A quiet corner worth saving', zh: '值得收藏的静谧角落' },
        description: { target: 'Style a calmer home one detail at a time', zh: '从一个细节开始，打造更宁静的家' },
        tags: [{ target: '#HomeDecor', zh: '#家居装饰' }],
        altText: { target: 'Walnut chair beside a sunlit window', zh: '阳光窗边的胡桃木座椅' },
    });

    assert.match(card.innerHTML, /Pinterest PIN/);
    assert.match(card.innerHTML, /Title/);
    assert.match(card.innerHTML, /Description/);
    assert.match(card.innerHTML, /Alt Text/);
    assert.match(card.innerHTML, /A quiet corner worth saving/);
    assert.match(card.innerHTML, /值得收藏的静谧角落/);
    assert.match(card.innerHTML, /Style a calmer home one detail at a time#HomeDecor/);
    assert.match(card.innerHTML, /从一个细节开始，打造更宁静的家#家居装饰/);
    assert.equal(
        findElement(card, element => element.textContent === 'Tags'),
        null,
        'Pinterest must not render a standalone Tags card'
    );
    assert.match(card.innerHTML, /#HomeDecor/);
    assert.match(card.innerHTML, /#家居装饰/);
    assert.match(card.innerHTML, /Walnut chair beside a sunlit window/);
    assert.match(card.innerHTML, /阳光窗边的胡桃木座椅/);
});

test('renderAdsData inserts hostile Pinterest model text only as inert text', () => {
    const tracker = {
        innerHTMLAssignments: [],
        textContentAssignments: [],
    };
    const hostileValues = [
        '<img src=x onerror=alert("title")>',
        '<svg onload=alert("标题")>',
        '</div><script>alert("description")</script>',
        '<iframe srcdoc="<script>alert(描述)</script>">',
        '<a href=javascript:alert("tag")>#Tag</a>',
        '<math href=javascript:alert("标签")>#标签</math>',
        '<input autofocus onfocus=alert("alt")>',
        '<object data=javascript:alert("替代文本")>',
    ];
    const card = renderPinterest({
        title: { target: hostileValues[0], zh: hostileValues[1] },
        description: { target: hostileValues[2], zh: hostileValues[3] },
        tags: [{ target: hostileValues[4], zh: hostileValues[5] }],
        altText: { target: hostileValues[6], zh: hostileValues[7] },
    }, tracker);

    for (const value of hostileValues) {
        assert.ok(
            tracker.textContentAssignments.some(text => text.includes(value)),
            `expected textContent insertion for ${value}`
        );
        assert.ok(
            tracker.innerHTMLAssignments.every(htmlValue => !htmlValue.includes(value)),
            `must not insert model text through innerHTML: ${value}`
        );
        assert.doesNotMatch(card.innerHTML, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(card.innerHTML, new RegExp(escapeTestHtml(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
});
