const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const {
    exportFullLaunchKit,
    getStandalonePdpHtmlString
} = require('../js/details.js');

test('index.html contains Launch Kit export button in DTC actions toolbar', () => {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.match(html, /id="btnExportLaunchKit"/);
    assert.match(html, /onclick="exportFullLaunchKit\(\)"/);
    assert.match(html, /一键上架物料包/);
});

test('getStandalonePdpHtmlString generates valid HTML document from globalGenContext and DOM', () => {
    global.document = {
        getElementById(id) {
            if (id === 'dtcHybridContainer') {
                return { innerHTML: '<section class="pdp-section"><h2>Premium Ergonomic Chair</h2></section>' };
            }
            if (id === 'productNameInput') {
                return { value: 'Ergonomic Office Chair' };
            }
            return null;
        }
    };
    global.globalGenContext = {
        config: { productName: 'Ergonomic Office Chair', language: 'en' },
        tasks: {}
    };
    global.currentDtcBrandColor = 'indigo';
    global.currentDtcTypography = { fontFamily: 'Inter' };

    const html = getStandalonePdpHtmlString();
    assert.match(html, /<!DOCTYPE html>/i);
    assert.match(html, /<title>Ergonomic Office Chair - Product Details<\/title>/);
    assert.match(html, /Premium Ergonomic Chair/);
});

test('exportFullLaunchKit aggregates listing, ads, html, and images and triggers POST to backend', async () => {
    let requestedUrl = null;
    let requestedBody = null;
    let clickedLink = null;
    let toastMessage = null;

    global.document = {
        body: {
            appendChild(el) { el._attached = true; },
            removeChild(el) { el._attached = false; }
        },
        getElementById(id) {
            if (id === 'productNameInput') return { value: 'Noise Cancelling Earbuds' };
            if (id === 'dtcHybridContainer') return { innerHTML: '<div>Sound perfection.</div>' };
            if (id === 'btnExportLaunchKit') return { disabled: false, innerHTML: '' };
            return null;
        },
        createElement(tag) {
            if (tag === 'a') {
                return {
                    href: '',
                    download: '',
                    click() { clickedLink = { href: this.href, download: this.download }; }
                };
            }
            return {};
        }
    };

    global.globalGenContext = {
        config: { productName: 'Noise Cancelling Earbuds' },
        tasks: {
            t1: { id: 't1', displayTitle: 'Main Feature', imageSrc: 'data:image/png;base64,abc1234', status: 'done' },
            t2: { id: 't2', displayTitle: 'Noise Blocking', imageSrc: '/static/outputs/test.jpg', status: 'done' }
        }
    };

    global.getCurrentListingData = () => ({
        title: { target: 'Wireless Earbuds with Active Noise Cancellation' },
        bullets: [{ target: '40hr playtime' }],
        searchTerms: { target: 'earbuds bluetooth wireless' }
    });

    global.getCurrentAdsData = () => [
        { platform: 'facebook', headline: 'Silence the Noise', primary_text: 'Block out distractions.' }
    ];

    global.showToast = (msg, type) => { toastMessage = { msg, type }; };

    global.fetch = async (url, opts) => {
        requestedUrl = url;
        requestedBody = JSON.parse(opts.body);
        return {
            ok: true,
            json: async () => ({
                status: 'success',
                kit_id: 'test_kit_123',
                filename: 'Noise_Cancelling_Earbuds_Launch_Kit_test_kit_123.zip',
                download_url: '/api/export/launch-kit/test_kit_123/download'
            })
        };
    };

    const result = await exportFullLaunchKit();

    assert.equal(result.status, 'success');
    assert.match(requestedUrl, /\/api\/export\/launch-kit/);
    assert.equal(requestedBody.product_name, 'Noise Cancelling Earbuds');
    assert.ok(requestedBody.listing);
    assert.equal(requestedBody.listing.title.target, 'Wireless Earbuds with Active Noise Cancellation');
    assert.ok(Array.isArray(requestedBody.ads));
    assert.equal(requestedBody.ads.length, 1);
    assert.equal(requestedBody.image_items.length, 2);
    assert.match(clickedLink.href, /\/api\/export\/launch-kit\/test_kit_123\/download/);
    assert.equal(clickedLink.download, 'Noise_Cancelling_Earbuds_Launch_Kit_test_kit_123.zip');
    assert.equal(toastMessage?.type, 'success');
});
