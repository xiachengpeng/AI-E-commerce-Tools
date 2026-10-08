const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function createTestContext() {
    const ctx = {
        console,
        document: {
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => []
        },
        setTimeout,
        clearTimeout,
        AbortController
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'config.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'utils.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'details.js'), 'utf8'), ctx);
    return ctx;
}

const TINY_JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAEAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z';
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAADklEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const TINY_WEBP_B64 = 'UklGRjoAAABXRUJQVlA4IC4AAACyAgCdASoEAAQAAVw2JZQAA3AA/v798AAAP7//AAAA/v//AAAA/v//AAAAAAA=';

test('detectMimeTypeFromBase64 identifies true format from magic prefix', () => {
    const ctx = createTestContext();
    assert.strictEqual(typeof ctx.detectMimeTypeFromBase64, 'function');
    assert.strictEqual(ctx.detectMimeTypeFromBase64(TINY_JPEG_B64), 'image/jpeg');
    assert.strictEqual(ctx.detectMimeTypeFromBase64(TINY_PNG_B64), 'image/png');
    assert.strictEqual(ctx.detectMimeTypeFromBase64(TINY_WEBP_B64), 'image/webp');
});

test('parseImageDataUrl auto-corrects mismatched declared MIME type', () => {
    const ctx = createTestContext();
    // User uploaded a JPEG file named image.png, browser generated data:image/png;base64,...
    const mismatchedDataUrl = `data:image/png;base64,${TINY_JPEG_B64}`;
    const parsed = ctx.parseImageDataUrl(mismatchedDataUrl);
    assert.ok(parsed);
    assert.strictEqual(parsed.mimeType, 'image/jpeg', 'Should be auto-corrected to image/jpeg based on content');
    assert.strictEqual(parsed.data, TINY_JPEG_B64);
});

test('ensureInlineImageData corrects mismatched mimeType field', async () => {
    const ctx = createTestContext();
    const image = {
        id: 'img_test_1',
        mimeType: 'image/png', // Incorrect declared MIME
        data: TINY_JPEG_B64
    };

    const inlined = await ctx.ensureInlineImageData(image);
    assert.ok(inlined);
    assert.strictEqual(inlined.mimeType, 'image/jpeg', 'ensureInlineImageData should auto-correct mimeType');
});
