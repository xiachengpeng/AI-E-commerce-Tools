const test = require('node:test');
const assert = require('node:assert/strict');
const utils = require('../js/utils.js');
const listing = require('../js/listing.js');

test('extractImageFilesFromClipboard extracts image files from clipboardData items and files', () => {
    // 1. From clipboardData.items
    const dummyImageFile = { name: 'test.png', type: 'image/png', size: 1024 };
    const dummyTextItem = { kind: 'string', type: 'text/plain', getAsFile: () => null };
    const dummyImageItem = { kind: 'file', type: 'image/png', getAsFile: () => dummyImageFile };

    const eventWithItems = {
        clipboardData: {
            items: [dummyTextItem, dummyImageItem]
        }
    };
    const extractedFromItems = utils.extractImageFilesFromClipboard(eventWithItems);
    assert.equal(extractedFromItems.length, 1);
    assert.equal(extractedFromItems[0].name, 'test.png');

    // 2. From clipboardData.files fallback
    const eventWithFiles = {
        clipboardData: {
            items: [],
            files: [
                { name: 'photo.jpg', type: 'image/jpeg', size: 2048 },
                { name: 'document.pdf', type: 'application/pdf', size: 4096 }
            ]
        }
    };
    const extractedFromFiles = utils.extractImageFilesFromClipboard(eventWithFiles);
    assert.equal(extractedFromFiles.length, 1);
    assert.equal(extractedFromFiles[0].name, 'photo.jpg');

    // 3. Empty clipboard
    assert.deepEqual(utils.extractImageFilesFromClipboard({}), []);
    assert.deepEqual(utils.extractImageFilesFromClipboard(null), []);
});

test('shouldIgnoreImagePaste protects text inputs when pasting text, but permits image paste', () => {
    // User in a text input pasting plain text -> should be IGNORED by image paste handler
    const textEvent = {
        target: {
            tagName: 'INPUT',
            type: 'text',
            isContentEditable: false,
            closest: () => null
        },
        clipboardData: {
            getData: (type) => type === 'text/plain' ? 'Hello World' : ''
        }
    };
    assert.equal(utils.shouldIgnoreImagePaste(textEvent), true);

    // User in a textarea pasting text -> should be IGNORED
    const textareaEvent = {
        target: {
            tagName: 'TEXTAREA',
            isContentEditable: false,
            closest: () => null
        },
        clipboardData: {
            getData: (type) => type === 'text/plain' ? 'Some prompt' : ''
        }
    };
    assert.equal(utils.shouldIgnoreImagePaste(textareaEvent), true);

    // User in text input but clipboard has NO text (only screenshot/image) -> should NOT be ignored
    const imageInInputEvent = {
        target: {
            tagName: 'INPUT',
            type: 'text',
            isContentEditable: false,
            closest: () => null
        },
        clipboardData: {
            getData: () => ''
        }
    };
    assert.equal(utils.shouldIgnoreImagePaste(imageInInputEvent), false);

    // Target inside upload zone -> NEVER ignore
    const uploadZoneEvent = {
        target: {
            tagName: 'DIV',
            closest: (sel) => sel.includes('imagePreviewContainer') ? {} : null
        },
        clipboardData: {
            getData: () => 'some text'
        }
    };
    assert.equal(utils.shouldIgnoreImagePaste(uploadZoneEvent), false);

    // Normal body target -> should NOT be ignored
    const bodyEvent = {
        target: {
            tagName: 'BODY',
            isContentEditable: false,
            closest: () => null
        },
        clipboardData: {
            getData: () => ''
        }
    };
    assert.equal(utils.shouldIgnoreImagePaste(bodyEvent), false);
});

test('resolveImagePasteTarget identifies upload target by closest container and active tab', () => {
    // 1. Closest match
    const makeTarget = (matchingSelector) => ({
        target: {
            closest: (sel) => sel.includes(matchingSelector) ? {} : null
        }
    });

    assert.equal(utils.resolveImagePasteTarget(makeTarget('view-generate')), 'generate');
    assert.equal(utils.resolveImagePasteTarget(makeTarget('imagePreviewContainer')), 'generate');
    assert.equal(utils.resolveImagePasteTarget(makeTarget('listingImagePreviewContainer')), 'listing');
    assert.equal(utils.resolveImagePasteTarget(makeTarget('adsImagePreviewContainer')), 'ads');
    assert.equal(utils.resolveImagePasteTarget(makeTarget('squareRedrawEmptyState')), 'square-redraw');
    assert.equal(utils.resolveImagePasteTarget(makeTarget('transDropZone')), 'translate');
    assert.equal(utils.resolveImagePasteTarget(makeTarget('watermarkRemovalUpload')), 'watermark-removal');

    // 2. Fallback to activeMainTab from localStorage
    global.localStorage = {
        getItem: (k) => k === 'activeMainTab' ? 'square-redraw' : null
    };
    global.document = {
        querySelector: () => null
    };
    const eventWithoutSpecificTarget = {
        target: {
            closest: () => null
        }
    };
    assert.equal(utils.resolveImagePasteTarget(eventWithoutSpecificTarget), 'square-redraw');
});

test('dispatchImagePaste routes image files to the correct module handler', () => {
    let calledDetails = false;
    let calledListing = false;
    let calledAds = false;
    let calledSquareRedraw = false;
    let calledTranslate = false;
    let calledWatermark = false;

    global.handleDetailImagePaste = () => { calledDetails = true; };
    global.handleListingImagePaste = () => { calledListing = true; };
    global.handleAdsImagePaste = () => { calledAds = true; };
    global.handleSquareRedrawImagePaste = () => { calledSquareRedraw = true; };
    global.handleTranslateImagePaste = () => { calledTranslate = true; };
    global.handleWatermarkImagePaste = () => { calledWatermark = true; };

    const dummyFile = { name: 'sample.png', type: 'image/png' };

    utils.dispatchImagePaste([dummyFile], 'generate');
    assert.equal(calledDetails, true);

    utils.dispatchImagePaste([dummyFile], 'listing');
    assert.equal(calledListing, true);

    utils.dispatchImagePaste([dummyFile], 'ads');
    assert.equal(calledAds, true);

    utils.dispatchImagePaste([dummyFile], 'square-redraw');
    assert.equal(calledSquareRedraw, true);

    utils.dispatchImagePaste([dummyFile], 'translate');
    assert.equal(calledTranslate, true);

    utils.dispatchImagePaste([dummyFile], 'watermark-removal');
    assert.equal(calledWatermark, true);
});

test('listing.js exports and functions ingestListingImageFile and handleListingImagePaste', () => {
    assert.equal(typeof listing.ingestListingImageFile, 'function');
    assert.equal(typeof listing.handleListingImagePaste, 'function');

    // Non-image file rejected
    global.showToast = () => {};
    const invalidFile = { name: 'test.txt', type: 'text/plain', size: 100 };
    assert.equal(listing.ingestListingImageFile(invalidFile), false);

    // Oversized file rejected (> 6MB)
    const oversizedFile = { name: 'huge.png', type: 'image/png', size: 7 * 1024 * 1024 };
    assert.equal(listing.ingestListingImageFile(oversizedFile), false);
});
