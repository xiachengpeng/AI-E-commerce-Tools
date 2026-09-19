const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const htmlPath = path.join(__dirname, '..', 'index.html');
const historyManagerPath = path.join(__dirname, '..', 'js', 'history_manager.js');
const detailsPath = path.join(__dirname, '..', 'js', 'details.js');

test('history_manager.js empty state renders friendly onboarding card', () => {
    const historyCode = fs.readFileSync(historyManagerPath, 'utf8');
    // Ensure it no longer contains bare <div class="text-center py-20 text-gray-400 text-sm">暂无记录</div>
    assert.ok(
        !historyCode.includes('<div class="text-center py-20 text-gray-400 text-sm">暂无记录</div>'),
        'history_manager.js should not use bare cold "暂无记录"'
    );
    assert.ok(
        historyCode.includes('暂无历史快照') || historyCode.includes('暂无生成记录'),
        'history_manager.js should render informative onboarding card'
    );
});

test('listingEmpty in index.html renders structured onboarding guidance', () => {
    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.ok(html.includes('id="listingEmpty"'), 'listingEmpty should exist');
    // Should contain clear guidance steps or action hints
    assert.ok(
        html.includes('Listing 创作台') || html.includes('高转化 Listing') || html.includes('目标市场'),
        'listingEmpty should provide helpful guidance'
    );
    assert.ok(
        html.includes('核心卖点') || html.includes('生成方案'),
        'listingEmpty should include action instructions'
    );
});

test('details.js module category empty state provides preset shortcut guidance', () => {
    const detailsCode = fs.readFileSync(detailsPath, 'utf8');
    assert.ok(
        detailsCode.includes('setModuleCategoryFilter(\'all\')') || detailsCode.includes('setModuleCategoryFilter("all")'),
        'details.js category filter should provide view all'
    );
    assert.ok(
        detailsCode.includes('applyModulePreset'),
        'details.js category empty state should guide to apply presets'
    );
});
