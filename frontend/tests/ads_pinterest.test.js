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
    let html = '';
    let text = '';
    return {
        className: '',
        children,
        classList: { add() {}, remove() {} },
        addEventListener() {},
        appendChild(node) {
            children.push(node);
            return node;
        },
        append(...nodes) {
            nodes.forEach(node => this.appendChild(node));
        },
        set innerHTML(value) {
            html = String(value ?? '');
            tracker?.innerHTMLAssignments.push(html);
        },
        get innerHTML() {
            return `${html}${escapeTestHtml(text)}${children.map(child => child.innerHTML).join('')}`;
        },
        set textContent(value) {
            text = String(value ?? '');
            tracker?.textContentAssignments.push(text);
        },
        get textContent() { return text; },
    };
}

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
