const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const htmlPath = path.resolve(__dirname, '..', 'index.html');
const htmlContent = fs.readFileSync(htmlPath, 'utf8');

test('index.html contains button to load official demo profile', () => {
    assert.match(
        htmlContent,
        /loadOfficialDemoProfile/,
        'index.html should have a trigger for loadOfficialDemoProfile'
    );
});

test('brandContextHub.loadOfficialDemoProfile loads standardized demo profile into form', () => {
    const brandContextJs = fs.readFileSync(path.resolve(__dirname, '..', 'js', 'brand_context.js'), 'utf8');

    const elements = {};
    const getEl = (id) => {
        if (!elements[id]) {
            elements[id] = {
                value: '',
                textContent: '',
                innerHTML: '',
                classList: {
                    add: () => {},
                    remove: () => {},
                    toggle: () => {}
                }
            };
        }
        return elements[id];
    };

    let toastMsg = '';
    let toastType = '';

    const context = {
        window: {},
        document: {
            addEventListener: () => {},
            getElementById: (id) => getEl(id),
            querySelectorAll: () => []
        },
        localStorage: {
            getItem: () => null,
            setItem: () => {}
        },
        showToast: (msg, type) => {
            toastMsg = msg;
            toastType = type;
        }
    };

    const vm = require('node:vm');
    vm.createContext(context);
    vm.runInContext(brandContextJs, context);

    const hub = context.window.brandContextHub;
    assert.ok(hub, 'brandContextHub must be defined on window');
    assert.equal(typeof hub.loadOfficialDemoProfile, 'function', 'loadOfficialDemoProfile must be defined on brandContextHub');

    hub.loadOfficialDemoProfile();

    assert.match(getEl('brandHubName').value, /人体工学/, 'Should load demo product name');
    assert.equal(getEl('brandHubBrandName').value, 'ErgoPro', 'Should load demo brand name');
    assert.match(getEl('brandHubIcp').value, /程序员|久坐/, 'Should load demo ICP');
    assert.match(getEl('brandHubPainPoints').value, /支撑|酸痛/, 'Should load demo pain points');
    assert.match(getEl('brandHubDifferentiators').value, /双轴|仿生|网布/, 'Should load demo differentiators');
    assert.equal(toastType, 'success');
});
