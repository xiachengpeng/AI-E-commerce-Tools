const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const moduleUrl = pathToFileURL(path.join(__dirname, '../infinite-image-canvas/web/src/integration/note-nodes.mjs')).href;

test('Markdown import selects the linked text and refuses ambiguous or empty inputs', async () => {
    const { selectMarkdownSource } = await import(moduleUrl);
    const text = {type:'text',id:'t1',metadata:{content:'# Product\n- feature'}};
    assert.deepEqual(selectMarkdownSource([text]), {text:'# Product\n- feature'});
    assert.match(selectMarkdownSource([]).error, /文本/);
    assert.match(selectMarkdownSource([text,{...text,id:'t2'}]).error, /一条/);
    assert.match(selectMarkdownSource([{...text,metadata:{content:' '}}]).error, /文本/);
});

test('sticky note accepts only valid color values', async () => {
    const { safeStickyColor } = await import(moduleUrl);
    assert.equal(safeStickyColor('#ff33aa'),'#ff33aa');
    assert.equal(safeStickyColor('url(https://example.com)'), '#fde68a');
});
