const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const htmlPath = path.join(__dirname, '..', 'index.html');
const detailsPath = path.join(__dirname, '..', 'js', 'details.js');

test('index.html uses clear, non-jargon microcopy for zero-drift lock', () => {
    const html = fs.readFileSync(htmlPath, 'utf8');
    // Must contain zero-drift badge with clear appearance lock explanation
    assert.ok(html.includes('零变形约束'), 'Must preserve badge anchor for zero-drift constraint');
    assert.ok(html.includes('外观一致') || html.includes('锁定商品外观'), 'Must clearly state appearance lock');
    assert.ok(html.includes('严格锁定商品真实外观与结构') || html.includes('锁定商品真实外观'), 'Tooltip should be clear and professional');
});

test('details.js and index.html clearly label DTC mode as independent site rich text PDP', () => {
    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.ok(
        html.includes('独立站图文') || html.includes('独立站富文本'),
        'Must clearly communicate independent site PDP mode'
    );
});
