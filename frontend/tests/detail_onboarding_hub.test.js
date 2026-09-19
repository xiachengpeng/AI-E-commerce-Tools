const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const htmlPath = path.join(__dirname, '..', 'index.html');
const configPath = path.join(__dirname, '..', 'js', 'config.js');
const detailsPath = path.join(__dirname, '..', 'js', 'details.js');

test('index.html contains high-conversion Onboarding Hub in showcaseArea', () => {
    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.ok(html.includes('id="showcaseArea"'), 'showcaseArea should exist');
    assert.ok(html.includes('id="onboardingHub"'), 'onboardingHub should be present in showcaseArea');
    assert.ok(html.includes('applyModulePreset(\'amazon_seven\')'), 'Should have quick action for Amazon 7 preset');
    assert.ok(html.includes('applyModulePreset(\'shopify_dtc\')'), 'Should have quick action for Shopify DTC preset');
    assert.ok(html.includes('applyModulePreset(\'tiktok_viral\')'), 'Should have quick action for TikTok viral preset');
    assert.ok(html.includes('applyModulePreset(\'bundle_suite\')'), 'Should have quick action for bundle suite preset');
    assert.ok(html.includes('applyModulePreset(\'tech_hardware\')'), 'Should have quick action for tech hardware preset');
    assert.ok(html.includes('applyModulePreset(\'social_ugc\')'), 'Should have quick action for social ugc preset');
});

test('dtcHybridContainer empty state provides quick preset actions', () => {
    const detailsCode = fs.readFileSync(detailsPath, 'utf8');
    // renderDtcHybridPreview should render friendly onboarding with action buttons when tasks are empty
    assert.ok(detailsCode.includes('applyModulePreset'), 'details.js should reference applyModulePreset');
    assert.ok(
        detailsCode.includes('applyModulePreset(\'amazon_seven\')') ||
        detailsCode.includes('applyModulePreset(\\\'amazon_seven\\\')') ||
        detailsCode.includes('applyModulePreset("amazon_seven")'),
        'dtcHybridContainer empty state should offer quick preset button'
    );
});
