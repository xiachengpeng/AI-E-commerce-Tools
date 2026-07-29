const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'frontend/js/ads.js'), 'utf8');

test('Pinterest PIN is a checked peer ad type', () => {
    assert.match(
        html,
        /class="ads-platform-checkbox[^"]*" value="pinterest"[\s\S]*?checked/
    );
    assert.match(html, /Pinterest PIN/);
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

function fakeElement() {
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
        set innerHTML(value) { html = value; },
        get innerHTML() {
            return `${html}${text}${children.map(child => child.innerHTML).join('')}`;
        },
        set textContent(value) { text = String(value ?? ''); },
        get textContent() { return text; },
    };
}

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
    const labels = ['[Pinterest PIN]', 'Title', 'Description', 'Tags', 'Alt Text'];
    labels.reduce((previous, label) => {
        const position = copied.indexOf(label);
        assert.ok(position > previous, `${label} should follow the previous section`);
        return position;
    }, -1);
    assert.match(copied, /#HomeDecor #CalmHome/);
    assert.match(copied, /#家居装饰 #宁静之家/);
});

test('renderAdsData includes the four Pinterest fields', () => {
    const children = [];
    const results = fakeElement();
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
            createElement: fakeElement,
            body: { appendChild() {}, removeChild() {} },
        },
    });

    context.renderAdsData({
        styles: [{
            styleId: 'emotional',
            name: { target: 'Emotional', zh: '情感共鸣' },
            pinterest: {
                title: { target: 'A quiet corner worth saving', zh: '值得收藏的静谧角落' },
                description: { target: 'Style a calmer home one detail at a time', zh: '从一个细节开始，打造更宁静的家' },
                tags: [{ target: '#HomeDecor', zh: '#家居装饰' }],
                altText: { target: 'Walnut chair beside a sunlit window', zh: '阳光窗边的胡桃木座椅' },
            },
        }],
    });

    assert.equal(children.length, 2);
    assert.match(children[1].innerHTML, /Pinterest PIN/);
    assert.match(children[1].innerHTML, /Title/);
    assert.match(children[1].innerHTML, /Description/);
    assert.match(children[1].innerHTML, /Tags/);
    assert.match(children[1].innerHTML, /Alt Text/);
    assert.match(children[1].innerHTML, /A quiet corner worth saving/);
    assert.match(children[1].innerHTML, /值得收藏的静谧角落/);
    assert.match(children[1].innerHTML, /Style a calmer home one detail at a time/);
    assert.match(children[1].innerHTML, /从一个细节开始，打造更宁静的家/);
    assert.match(children[1].innerHTML, /#HomeDecor/);
    assert.match(children[1].innerHTML, /#家居装饰/);
    assert.match(children[1].innerHTML, /Walnut chair beside a sunlit window/);
    assert.match(children[1].innerHTML, /阳光窗边的胡桃木座椅/);
});
