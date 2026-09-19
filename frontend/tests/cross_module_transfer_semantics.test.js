const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('analysis.js xp_transferToListing extracts pure product search keywords, not audience/scenarios', () => {
    const analysisCode = fs.readFileSync(path.join(__dirname, '../js/analysis.js'), 'utf8');
    const startIdx = analysisCode.indexOf('function xp_transferToListing(');
    const endIdx = analysisCode.indexOf('function xp_transferToAds(');
    assert.ok(startIdx !== -1 && endIdx !== -1, 'xp_transferToListing must exist');
    const transferListingFn = analysisCode.substring(startIdx, endIdx);

    // Verify audience and scenarios are NOT looped into listingKeywords
    assert.ok(
        !transferListingFn.includes('(d.target_audience || []).forEach(a => {'),
        'listingKeywords must not be populated by looping over target_audience'
    );
    assert.ok(
        !transferListingFn.includes('(d.use_scenarios || []).forEach(s => {'),
        'listingKeywords must not be populated by looping over use_scenarios'
    );

    // Verify it extracts from category and product_name
    assert.ok(
        transferListingFn.includes('category') || transferListingFn.includes('product_name'),
        'listingKeywords should extract keywords from category / product name'
    );
});

test('analysis.js xp_transferToAds calls receiveAdsTransferData with selling points', () => {
    const analysisCode = fs.readFileSync(path.join(__dirname, '../js/analysis.js'), 'utf8');
    const startIdx = analysisCode.indexOf('function xp_transferToAds(');
    const endIdx = analysisCode.indexOf('function xp_transferToDetails(');
    assert.ok(startIdx !== -1 && endIdx !== -1, 'xp_transferToAds must exist');
    const transferAdsFn = analysisCode.substring(startIdx, endIdx);

    assert.ok(
        transferAdsFn.includes('receiveAdsTransferData'),
        'xp_transferToAds should use receiveAdsTransferData to propagate selling points and context'
    );
});

test('listing.js transferListingToAds propagates selling points and image to ads', () => {
    const listingCode = fs.readFileSync(path.join(__dirname, '../js/listing.js'), 'utf8');
    const startIdx = listingCode.indexOf('function transferListingToAds(');
    const endIdx = listingCode.indexOf('function toggleListingCopyDropdown(');
    assert.ok(startIdx !== -1 && endIdx !== -1, 'transferListingToAds must exist');
    const transferFn = listingCode.substring(startIdx, endIdx);

    assert.ok(
        transferFn.includes('receiveAdsTransferData'),
        'transferListingToAds should call receiveAdsTransferData to propagate data'
    );
});
