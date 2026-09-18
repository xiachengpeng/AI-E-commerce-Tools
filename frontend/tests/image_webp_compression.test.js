const test = require('node:test');
const assert = require('node:assert/strict');
const { formatBytes, estimateBase64Bytes, compressImageToWebp } = require('../js/utils.js');

test('utils.js: formatBytes formats byte counts correctly', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1024), '1 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(1024 * 1024 * 2.5), '2.5 MB');
});

test('utils.js: estimateBase64Bytes computes binary sizes from data URLs', () => {
    assert.equal(estimateBase64Bytes(''), 0);
    // 4 chars base64 is ~3 bytes
    const sample = 'data:image/png;base64,AAAA';
    assert.equal(estimateBase64Bytes(sample), 3);
});

test('utils.js: compressImageToWebp falls back gracefully when source is empty', async () => {
    const res = await compressImageToWebp('');
    assert.equal(res.changed, false);
    assert.equal(res.dataUrl, '');
});

test('utils.js: compressImageToWebp calls backend API if canvas unavailable', async () => {
    // Mock global fetch for backend API fallback
    const originalFetch = global.fetch;
    const fakeWebp = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
    global.fetch = async (url, opts) => {
        assert.ok(url.includes('/api/image/compress-webp'));
        const body = JSON.parse(opts.body);
        assert.ok(body.image_data);
        assert.equal(body.quality, 90);
        return {
            ok: true,
            json: async () => ({
                status: 'success',
                webp_data: fakeWebp,
                stats: {
                    original_size: 1000,
                    compressed_size: 200,
                    savings_percent: 80.0
                }
            })
        };
    };

    try {
        const inputPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        const res = await compressImageToWebp(inputPng, { quality: 0.90 });
        assert.equal(res.changed, true);
        assert.equal(res.mimeType, 'image/webp');
        assert.equal(res.dataUrl, fakeWebp);
        assert.equal(res.savingsPercent, 80);
    } finally {
        global.fetch = originalFetch;
    }
});

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createDetailsTestContext() {
    const root = path.join(__dirname, '..');
    let lastToast = null;
    const elements = {
        btnBatchCompressWebp: { disabled: false, innerHTML: '转 WebP 压缩' },
        exportQualitySelect: { value: 'webp' },
        btnDownloadLong: { disabled: false, innerHTML: '下载' },
        longImageCanvas: { style: {} },
        'content-task-1': { querySelector: () => ({ src: '' }) },
        'content-task-2': { querySelector: () => ({ src: '' }) }
    };

    const doc = {
        getElementById: (id) => elements[id] || null,
        querySelector: (sel) => elements[sel] || null,
        querySelectorAll: () => [],
        createElement: (tag) => {
            return {
                tagName: tag,
                download: '',
                href: '',
                click: function() { this.clicked = true; }
            };
        },
        body: { appendChild: () => {}, removeChild: () => {} }
    };

    const ctx = {
        console,
        document: doc,
        setTimeout,
        clearTimeout,
        Date,
        Promise,
        showToast: (msg, type) => { lastToast = { msg, type }; },
        saveToHistory: () => {},
        collectCurrentRenderProject: () => ({}),
        renderExportChecklist: () => {},
        formatBytes,
        estimateBase64Bytes
    };

    ctx.window = ctx;
    ctx.globalThis = ctx;

    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'config.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'details.js'), 'utf8'), ctx);

    return { ctx, elements, getLastToast: () => lastToast };
}

test('details.js: compressAllCurrentModuleImages compresses all module images in globalGenContext', async () => {
    const { ctx, elements, getLastToast } = createDetailsTestContext();

    const fakeWebp = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
    ctx.compressImageToWebp = async (source) => {
        return {
            changed: true,
            mimeType: 'image/webp',
            dataUrl: fakeWebp,
            originalSize: 10000,
            compressedSize: 2500,
            savingsBytes: 7500,
            savingsPercent: 75
        };
    };

    // Test with no tasks
    ctx.globalGenContext = { tasks: [] };
    await ctx.compressAllCurrentModuleImages();
    assert.match(getLastToast().msg, /没有已生成的模块图片/);

    // Test with tasks
    ctx.globalGenContext = {
        tasks: [
            { id: 'task-1', uniqueId: 'task-1', imageSrc: 'data:image/png;base64,original1' },
            { id: 'task-2', uniqueId: 'task-2', imageSrc: 'data:image/png;base64,original2' }
        ]
    };

    await ctx.compressAllCurrentModuleImages();

    assert.equal(ctx.globalGenContext.tasks[0].imageSrc, fakeWebp);
    assert.equal(ctx.globalGenContext.tasks[1].imageSrc, fakeWebp);
    assert.equal(ctx.globalGenContext.tasks[0].compressedStats.savingsPercent, 75);
    assert.match(getLastToast().msg, /已成功将 2 张图片压缩为 WebP/);
    assert.equal(getLastToast().type, 'success');
});

test('details.js: executeLongImageDownload exports WebP when exportQualitySelect is webp', async () => {
    const { ctx, elements, getLastToast } = createDetailsTestContext();

    const dataUrlCalls = [];
    let clickedLink = null;

    ctx.html2canvas = async (el, opts) => {
        return {
            toDataURL: (mime, quality) => {
                dataUrlCalls.push({ mime, quality });
                return 'data:image/webp;base64,renderedWebpLongImage';
            }
        };
    };

    // Override createElement to capture downloaded link
    const origCreateElement = ctx.document.createElement;
    ctx.document.createElement = (tag) => {
        const el = origCreateElement(tag);
        if (tag === 'a') clickedLink = el;
        return el;
    };

    ctx.globalGenContext = {
        longImageOrder: ['task-1'],
        tasks: [{ id: 'task-1', imageSrc: 'data:image/webp;base64,test' }],
        config: { imageStyle: 'default' }
    };

    elements.exportQualitySelect.value = 'webp';
    await ctx.executeLongImageDownload();

    assert.equal(dataUrlCalls[0].mime, 'image/webp');
    assert.equal(dataUrlCalls[0].quality, 0.90);
    assert.ok(clickedLink);
    assert.ok(clickedLink.download.endsWith('.webp'), `Expected .webp download name, got: ${clickedLink.download}`);
    assert.equal(getLastToast().type, 'success');
    assert.match(getLastToast().msg, /WEBP/);
});

test('details.js: compressAllCurrentModuleImages handles already optimal images', async () => {
    const { ctx, elements, getLastToast } = createDetailsTestContext();

    ctx.compressImageToWebp = async (source) => {
        return {
            changed: false,
            mimeType: 'image/webp',
            dataUrl: source,
            originalSize: 2500,
            compressedSize: 2500,
            savingsBytes: 0,
            savingsPercent: 0
        };
    };

    ctx.globalGenContext = {
        tasks: [
            { id: 'task-1', uniqueId: 'task-1', imageSrc: 'data:image/webp;base64,alreadyOptimized' }
        ]
    };

    await ctx.compressAllCurrentModuleImages();

    assert.match(getLastToast().msg, /已处于最优 WebP 压缩状态/);
    assert.equal(getLastToast().type, 'info');
});

test('details.js: executeLongImageDownload exports PNG when selected', async () => {
    const { ctx, elements, getLastToast } = createDetailsTestContext();

    const dataUrlCalls = [];
    let clickedLink = null;

    ctx.html2canvas = async (el, opts) => {
        return {
            toDataURL: (mime, quality) => {
                dataUrlCalls.push({ mime, quality });
                return 'data:image/png;base64,pngOutput';
            }
        };
    };

    const origCreateElement = ctx.document.createElement;
    ctx.document.createElement = (tag) => {
        const el = origCreateElement(tag);
        if (tag === 'a') clickedLink = el;
        return el;
    };

    ctx.globalGenContext = {
        longImageOrder: ['task-1'],
        tasks: [{ id: 'task-1', imageSrc: 'data:image/png;base64,test' }],
        config: { imageStyle: 'default' }
    };

    elements.exportQualitySelect.value = 'png';
    await ctx.executeLongImageDownload();

    assert.equal(dataUrlCalls[0].mime, 'image/png');
    assert.ok(clickedLink.download.endsWith('.png'));
    assert.equal(getLastToast().type, 'success');
    assert.match(getLastToast().msg, /PNG/);
});
