const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../js/settings.js'), 'utf8');

function fixture(result, previous = 'error') {
    const elements = Object.fromEntries([
        'settingsFirecrawlApiKey', 'settingsFirecrawlApiUrl', 'settingsCrawlerTestMsg',
        'settingsCrawlerStatusBadge', 'settingsKpiCrawlerVal', 'settingsKpiCrawlerDot'
    ].map(id => [id, { value: '', textContent: '', innerHTML: '', className: '' }]));
    elements.settingsFirecrawlApiUrl.value = 'https://api.firecrawl.dev/v1/scrape';
    const requests = [], toasts = [];
    const context = vm.createContext({
        window: {}, document: { getElementById: id => elements[id] || null },
        API_BASE: 'http://127.0.0.1:9503',
        fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => result }; },
        showToast: (text, type) => toasts.push({ text, type }),
        button: { disabled: false, setAttribute() {} }
    });
    vm.runInContext(source, context);
    vm.runInContext(`settingsState.crawler = { has_api_key: true, last_test_status: '${previous}' }; updateSettingsOverviewKpis();`, context);
    return { elements, requests, toasts, run: () => vm.runInContext('testCrawlerConnection(button)', context), context };
}

test('Firecrawl status success makes message, card badge and overview agree without an ok field', async () => {
    const f = fixture({ status: 'success', duration_ms: 1122, message: '连接成功' });
    await f.run();
    assert.match(f.elements.settingsCrawlerTestMsg.textContent, /^✓ 连接成功/);
    assert.equal(f.elements.settingsCrawlerTestMsg.className, 'settings-crawler-test-msg is-success');
    assert.match(f.elements.settingsCrawlerStatusBadge.innerHTML, /已就绪/);
    assert.equal(f.elements.settingsKpiCrawlerVal.textContent, '服务正常');
    assert.equal(f.elements.settingsKpiCrawlerDot.className, 'settings-overview-status is-active');
    assert.equal(f.toasts.at(-1).type, 'success');
    assert.equal(f.requests.length, 1);
    assert.equal(JSON.parse(f.requests[0].options.body).api_key, null);
    assert.equal(f.context.button.disabled, false);
});

test('Firecrawl status error remains failed even if an unrelated ok field is truthy', async () => {
    const f = fixture({ status: 'error', ok: true, duration_ms: 20, message: '授权失败（401）' }, 'success');
    await f.run();
    assert.match(f.elements.settingsCrawlerTestMsg.textContent, /^✗ 授权失败/);
    assert.equal(f.elements.settingsCrawlerTestMsg.className, 'settings-crawler-test-msg is-error');
    assert.match(f.elements.settingsCrawlerStatusBadge.innerHTML, /连接异常/);
    assert.equal(f.elements.settingsKpiCrawlerVal.textContent, '连接异常');
    assert.equal(f.elements.settingsKpiCrawlerDot.className, 'settings-overview-status is-error');
    assert.equal(f.toasts.at(-1).type, 'error');
    assert.equal(f.context.button.disabled, false);
});
