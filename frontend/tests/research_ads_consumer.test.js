const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('ads generation consumes handed-off facts and preserves manual edits and draft restoration', async () => {
    const nodes = {
        adsProductNameInput: { value: 'Merchant name', dispatchEvent() {} },
        adsSellingPoints: { value: 'Existing fact', dispatchEvent() {} },
        btnGenerateAds: { innerHTML: '', disabled: false }
    };
    for (const id of ['adsRegionSelect', 'adsLanguageSelect', 'adsMarketingThemeSelect']) nodes[id] = { value: 'US', options: [{ value: 'US', text: 'US' }], selectedIndex: 0 };
    const storage = new Map(); let sent;
    const ctx = { document: { getElementById: id => nodes[id] }, Event, console,
        localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        showToast() {} };
    vm.runInNewContext(fs.readFileSync(require.resolve('../js/ads.js'), 'utf8'), ctx);
    vm.runInNewContext(fs.readFileSync(require.resolve('../js/research.js'), 'utf8'), ctx);
    vm.runInNewContext(`selectedAdsPlatforms = () => ['facebook']; renderAdsData = () => {}; postAdsApi = async p => { captured = p; return {}; };`, ctx);
    ctx.ResearchPanel.applyDraft({ fields: [{ key: 'material', target: 'productFactsText', value: '材质: Cotton' }] }, ['material'], 'ads');
    await ctx.generateAdsCopy(); sent = ctx.captured;
    assert.equal(sent.selling_points, 'Existing fact\n材质: Cotton');
    ctx.saveAdsDraft(); nodes.adsSellingPoints.value = ''; ctx.restoreAdsDraft();
    assert.equal(nodes.adsSellingPoints.value, 'Existing fact\n材质: Cotton');
    ctx.clearAdsDraft(); nodes.adsProductNameInput.value = 'Next product'; await ctx.generateAdsCopy();
    assert.equal(ctx.captured.selling_points, undefined);
});
