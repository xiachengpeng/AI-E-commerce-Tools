const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const moduleUrl = pathToFileURL(path.join(__dirname, '../infinite-image-canvas/web/src/integration/seo-node.mjs')).href;

test('SEO source requires exactly one saved connected image and validates its identity', async () => {
    const { selectSeoImage, sameSeoSource } = await import(moduleUrl);
    const image = { id:'image-1', type:'image', metadata:{ content:'http://localhost/image', storageKey:'image:project:asset' } };
    assert.equal(selectSeoImage([]).error, '请连接一张已保存的图片');
    assert.equal(selectSeoImage([image, {...image, id:'image-2'}]).error, '请只连接一张图片');
    const selected = selectSeoImage([image]);
    assert.equal(selected.source.id, 'image-1');
    assert.equal(sameSeoSource(selected.source, [image]), true);
    assert.equal(sameSeoSource(selected.source, [{...image, metadata:{...image.metadata, storageKey:'image:project:new'}}]), false);
});

test('SEO metadata stays bound to the image and stores upload results per destination', async () => {
    const { makeSeoResult, recordSeoUpload } = await import(moduleUrl);
    const source = {id:'image-1', storageKey:'image:project:asset'};
    const seo = makeSeoResult(source, {title:'Blue vase', altText:'Blue vase on table', slug:'blue_vase'}, 'en');
    assert.equal(seo.sourceKey, source.storageKey);
    const first = recordSeoUpload(seo, {storageType:'r2',configId:1}, 'https://example.com/a.webp');
    const second = recordSeoUpload(first, {storageType:'wordpress',configId:2}, 'https://example.org/a.webp');
    assert.equal(second.uploads['r2:1'], 'https://example.com/a.webp');
    assert.equal(second.uploads['wordpress:2'], 'https://example.org/a.webp');
    assert.deepEqual(seo.uploads, {});
});
