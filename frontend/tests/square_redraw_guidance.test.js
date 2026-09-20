const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const htmlPath = path.resolve(__dirname, '..', 'index.html');
const htmlContent = fs.readFileSync(htmlPath, 'utf8');

test('index.html replaces developer jargon "重跑失败" with "重试失败项"', () => {
    const retryBtnMatch = htmlContent.match(/id="squareRedrawRetryBtn"[\s\S]*?<\/button>/);
    assert.ok(retryBtnMatch, 'squareRedrawRetryBtn must exist in index.html');
    assert.doesNotMatch(retryBtnMatch[0], /重跑失败/, 'Button should not contain developer jargon 重跑失败');
    assert.match(retryBtnMatch[0], /重试失败项/, 'Button should contain 重试失败项');
});

test('squareRedrawAspectSelect contains e-commerce platform guidance labels', () => {
    const selectMatch = htmlContent.match(/id="squareRedrawAspectSelect"[\s\S]*?<\/select>/);
    assert.ok(selectMatch, 'squareRedrawAspectSelect must exist in index.html');
    const selectHtml = selectMatch[0];

    assert.match(selectHtml, /1:1[\s\S]*?Amazon/i, '1:1 ratio should label Amazon or square image');
    assert.match(selectHtml, /4:5[\s\S]*?Shopify|Instagram/i, '4:5 ratio should label Shopify or Instagram');
    assert.match(selectHtml, /9:16[\s\S]*?TikTok/i, '9:16 ratio should label TikTok or Reels');
});

test('square_redraw.js error preview text avoids jargon and advises retrying or checking AI settings', () => {
    const squareRedrawJs = fs.readFileSync(path.resolve(__dirname, '..', 'js', 'square_redraw.js'), 'utf8');
    assert.doesNotMatch(squareRedrawJs, /请重跑失败项/, 'square_redraw.js should not suggest 请重跑失败项');
    assert.match(squareRedrawJs, /重试失败项|检查 AI 设置/, 'square_redraw.js should suggest 重试失败项 or 检查 AI 设置');
});

test('sendSquareRedrawToTranslate transfers completed image to translate queue', () => {
    const squareRedrawJs = fs.readFileSync(path.resolve(__dirname, '..', 'js', 'square_redraw.js'), 'utf8');

    let switchedTab = '';
    let toastMessage = '';
    let toastType = '';

    const context = {
        window: {},
        document: {
            addEventListener: () => {},
            getElementById: () => null
        },
        transImages: [],
        switchMainTab: (tab) => { switchedTab = tab; },
        showToast: (msg, type) => {
            toastMessage = msg;
            toastType = type;
        },
        renderTransCards: () => {},
        updateTransStartBtn: () => {},
        squareRedrawImages: [
            {
                id: 'sr_1',
                filename: 'product_1.jpg',
                source_url: 'data:image/jpeg;base64,123',
                output_url: '/static/output_1.png',
                status: 'done'
            },
            {
                id: 'sr_2',
                filename: 'product_2.jpg',
                source_url: 'data:image/jpeg;base64,456',
                output_url: '',
                status: 'failed'
            }
        ]
    };

    const vm = require('node:vm');
    vm.createContext(context);
    vm.runInContext(squareRedrawJs, context);

    assert.equal(typeof context.sendSquareRedrawToTranslate, 'function', 'sendSquareRedrawToTranslate must be defined');

    // Populate images using helper
    context.window.setSquareRedrawImages([
        {
            id: 'sr_1',
            filename: 'product_1.jpg',
            source_url: 'data:image/jpeg;base64,123',
            output_url: '/static/output_1.png',
            status: 'done'
        },
        {
            id: 'sr_2',
            filename: 'product_2.jpg',
            source_url: 'data:image/jpeg;base64,456',
            output_url: '',
            status: 'failed'
        }
    ]);

    // Test transferring completed item
    context.sendSquareRedrawToTranslate('sr_1');
    assert.equal(context.transImages.length, 1, 'transImages should have 1 item added');
    assert.equal(context.transImages[0].name, 'product_1.jpg');
    assert.equal(context.transImages[0].base64, '/static/output_1.png');
    assert.equal(switchedTab, 'translate', 'Should switch to translate tab');
    assert.equal(toastType, 'success');

    // Test transferring failed item
    context.sendSquareRedrawToTranslate('sr_2');
    assert.equal(context.transImages.length, 1, 'transImages should not add failed items');
    assert.match(toastMessage, /尚未生成|无法流转|失败/, 'Should warn that item is not completed');
});
