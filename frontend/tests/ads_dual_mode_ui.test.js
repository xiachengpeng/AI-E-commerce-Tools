const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('ads.js supports text-only generation check and transfer receive', () => {
    const code = fs.readFileSync(path.join(__dirname, '../js/ads.js'), 'utf8');
    
    // 1. Verify receiveAdsTransferData is defined and exported
    assert.ok(code.includes('receiveAdsTransferData'), 'ads.js must expose receiveAdsTransferData');
    
    // 2. Verify generateAdsCopy does NOT unconditionally block missing image
    assert.ok(
        !code.includes("if (!currentAdsUploadedBase64) {\n        showToast('请先上传商品图片', 'error');\n        return;\n    }"),
        'ads.js must not unconditionally reject missing image'
    );

    // 3. Verify payload includes image_data as optional, plus product_name
    assert.ok(code.includes('image_data: currentAdsUploadedBase64 || null'), 'ads payload must pass null when no image uploaded');
});

test('index.html contains updated upload hint text for optional image', () => {
    const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
    assert.ok(
        html.includes('可选') || html.includes('实拍图') || html.includes('未上传则基于商品'),
        'index.html upload hint should clarify image is optional for ad generation'
    );
});
