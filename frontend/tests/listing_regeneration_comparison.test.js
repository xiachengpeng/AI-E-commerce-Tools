const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const listingPath = path.join(__dirname, '..', 'js', 'listing.js');

function setupListingContext() {
    const code = fs.readFileSync(listingPath, 'utf8');
    const elements = new Map();
    const doc = {
        getElementById: (id) => {
            if (!elements.has(id)) {
                elements.set(id, {
                    id,
                    value: '',
                    textContent: '',
                    innerHTML: '',
                    className: '',
                    classList: {
                        add: () => {},
                        remove: () => {},
                        toggle: () => {},
                        contains: () => false
                    },
                    style: {},
                    appendChild: (c) => {},
                    addEventListener: () => {}
                });
            }
            return elements.get(id);
        },
        createElement: (tag) => {
            const el = {
                tagName: tag.toUpperCase(),
                className: '',
                textContent: '',
                innerHTML: '',
                title: '',
                children: [],
                appendChild: function(c) {
                    this.children.push(c);
                    return c;
                },
                append: function(...args) {
                    this.children.push(...args);
                },
                addEventListener: () => {}
            };
            return el;
        }
    };

    const sandbox = {
        console,
        window: {},
        globalThis: {},
        document: doc,
        showToast: () => {},
        postListingApi: async () => ({ success: true }),
        setTimeout: (fn) => fn(),
        fetch: async () => ({ ok: true, json: async () => ({}) })
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return { sandbox, elements };
}

test('Listing regeneration supports staging and version comparison', () => {
    const { sandbox, elements } = setupListingContext();

    assert.strictEqual(typeof sandbox.stageRegeneratedSection, 'function', 'stageRegeneratedSection should be defined');
    assert.strictEqual(typeof sandbox.acceptRegeneratedSection, 'function', 'acceptRegeneratedSection should be defined');
    assert.strictEqual(typeof sandbox.dismissRegeneratedSection, 'function', 'dismissRegeneratedSection should be defined');
    assert.strictEqual(typeof sandbox.getPendingRegeneratedSection, 'function', 'getPendingRegeneratedSection should be defined');

    // Setup initial listing data
    sandbox.setCurrentListingData({
        title: { target: 'Original Title', zh: '原标题' },
        bullets: [
            { target: 'Original Bullet 1', zh: '原五点1' },
            { target: 'Original Bullet 2', zh: '原五点2' }
        ]
    });

    const newBulletData = {
        bullet: { target: 'Polished High-Converting Bullet 1', zh: '精修高转化五点1' }
    };

    // Stage regeneration
    sandbox.stageRegeneratedSection('bullet', 0, newBulletData);

    // Verify it did NOT overwrite currentListingDataText yet
    assert.strictEqual(
        sandbox.getCurrentListingData().bullets[0].target,
        'Original Bullet 1',
        'Staging must not clobber original bullet before approval'
    );

    // Verify pending candidate exists
    const pending = sandbox.getPendingRegeneratedSection('bullet', 0);
    assert.ok(pending, 'Pending candidate should be recorded');
    assert.strictEqual(pending.proposed.bullet.target, 'Polished High-Converting Bullet 1');

    // Dismiss test
    sandbox.dismissRegeneratedSection('bullet', 0);
    assert.strictEqual(sandbox.getPendingRegeneratedSection('bullet', 0), null, 'Candidate should be cleared on dismiss');
    assert.strictEqual(
        sandbox.getCurrentListingData().bullets[0].target,
        'Original Bullet 1',
        'Original bullet remains after dismiss'
    );

    // Stage again and accept test
    sandbox.stageRegeneratedSection('bullet', 0, newBulletData);
    sandbox.acceptRegeneratedSection('bullet', 0);
    assert.strictEqual(sandbox.getPendingRegeneratedSection('bullet', 0), null, 'Candidate should be cleared on accept');
    assert.strictEqual(
        sandbox.getCurrentListingData().bullets[0].target,
        'Polished High-Converting Bullet 1',
        'Bullet should be updated after accepting proposed version'
    );
});

test('Title regeneration supports comparison and staging', () => {
    const { sandbox } = setupListingContext();

    sandbox.setCurrentListingData({
        title: { target: 'Original Title', zh: '原标题' },
        bullets: []
    });

    const newTitleData = {
        title: { target: 'High CTR Compelling Title', zh: '高转化吸引力标题' }
    };

    sandbox.stageRegeneratedSection('title', null, newTitleData);

    assert.strictEqual(
        sandbox.getCurrentListingData().title.target,
        'Original Title',
        'Staging must not clobber original title before approval'
    );

    const pending = sandbox.getPendingRegeneratedSection('title');
    assert.ok(pending, 'Pending title candidate should be recorded');
    assert.strictEqual(pending.proposed.title.target, 'High CTR Compelling Title');

    sandbox.acceptRegeneratedSection('title');
    assert.strictEqual(sandbox.getPendingRegeneratedSection('title'), null);
    assert.strictEqual(
        sandbox.getCurrentListingData().title.target,
        'High CTR Compelling Title',
        'Title should be updated after accepting proposed version'
    );
});

