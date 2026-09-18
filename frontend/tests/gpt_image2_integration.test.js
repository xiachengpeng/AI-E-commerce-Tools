const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function createTestEnv() {
    const storageMap = {};
    const elements = {};

    const doc = {
        getElementById: (id) => elements[id] || null,
        querySelector: (selector) => elements[selector] || null,
        querySelectorAll: () => [],
        createElement: (tag) => ({
            tagName: tag.toUpperCase(),
            value: '',
            textContent: '',
            className: '',
            classList: {
                add: () => {},
                remove: () => {},
                toggle: () => {},
                contains: () => false
            },
            appendChild: () => {},
            removeChild: () => {},
            click: () => {},
            select: () => {}
        }),
        body: {
            appendChild: () => {},
            removeChild: () => {}
        }
    };

    const ctx = {
        console,
        document: doc,
        window: null,
        globalThis: null,
        showToast: () => {},
        remoteLog: () => {},
        localStorage: {
            getItem: (k) => storageMap[k] || null,
            setItem: (k, v) => { storageMap[k] = String(v); },
            removeItem: (k) => { delete storageMap[k]; }
        },
        API_BASE: 'http://127.0.0.1:9503/api',
        fetch: async () => ({ ok: true, json: async () => ({}) })
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;

    vm.createContext(ctx);

    const configCode = fs.readFileSync(path.join(root, 'js', 'config.js'), 'utf8');
    vm.runInContext(configCode, ctx);

    // Initialize modules from MODULES_CONFIG like app.js
    const appInitCode = `const modules = MODULES_CONFIG.map(m => ({ ...m })); globalThis.modules = modules;`;
    vm.runInContext(appInitCode, ctx);

    const brandCode = fs.readFileSync(path.join(root, 'js', 'brand_context.js'), 'utf8');
    vm.runInContext(brandCode, ctx);

    const detailsCode = fs.readFileSync(path.join(root, 'js', 'details.js'), 'utf8');
    vm.runInContext(detailsCode, ctx);

    return ctx;
}

test('MODULES_CONFIG contains m17 (Exploded View) and m18 (UGC Social Proof)', () => {
    const ctx = createTestEnv();
    const m17 = ctx.MODULES_CONFIG.find(m => m.id === 'm17');
    const m18 = ctx.MODULES_CONFIG.find(m => m.id === 'm18');

    assert.ok(m17, 'm17 module must exist in MODULES_CONFIG');
    assert.strictEqual(m17.title, '爆炸拆解/精密构造');
    assert.strictEqual(m17.promptTitle, 'Exploded View / Precision Engineering');
    assert.ok(m17.prompt.includes('exploded view') || m17.prompt.includes('deconstructed'));
    assert.strictEqual(m17.active, false);
    assert.strictEqual(m17.includeText, true);

    assert.ok(m18, 'm18 module must exist in MODULES_CONFIG');
    assert.strictEqual(m18.title, 'UGC买家秀/社交背书');
    assert.strictEqual(m18.promptTitle, 'UGC Social Proof / Unboxing Card');
    assert.ok(m18.prompt.includes('UGC') || m18.prompt.includes('unboxing'));
    assert.strictEqual(m18.active, false);
    assert.strictEqual(m18.includeText, true);
});

test('MODULE_PRESETS contains tech_hardware and social_ugc presets with correct module IDs', () => {
    const ctx = createTestEnv();
    const presets = ctx.MODULE_PRESETS;

    assert.ok(presets.tech_hardware, 'tech_hardware preset must exist');
    assert.strictEqual(presets.tech_hardware.label, '3C硬核工匠流');
    assert.ok(presets.tech_hardware.ids.includes('m17'), 'tech_hardware must include m17');
    assert.ok(presets.tech_hardware.ids.includes('m1'), 'tech_hardware must include m1');
    assert.ok(presets.tech_hardware.ids.includes('m6'), 'tech_hardware must include m6');

    assert.ok(presets.social_ugc, 'social_ugc preset must exist');
    assert.strictEqual(presets.social_ugc.label, '社交种草爆款流');
    assert.ok(presets.social_ugc.ids.includes('m18'), 'social_ugc must include m18');
    assert.ok(presets.social_ugc.ids.includes('m3'), 'social_ugc must include m3');
});

test('IMAGE_STYLE_OPTIONS contains newly added e-commerce commercial styles', () => {
    const ctx = createTestEnv();
    const styleValues = ctx.IMAGE_STYLE_OPTIONS.map(s => s.value);
    const styleLabels = ctx.IMAGE_STYLE_OPTIONS.map(s => s.label);

    assert.ok(styleLabels.includes('C4D 3D 商用超写实'), 'Must include C4D 3D 商用超写实');
    assert.ok(styleLabels.includes('Apple Keynote 极简发布会风'), 'Must include Apple Keynote 极简发布会风');
    assert.ok(styleLabels.includes('微缩景观创意风'), 'Must include 微缩景观创意风');
    assert.ok(styleLabels.includes('奢华精工机械透视风'), 'Must include 奢华精工机械透视风');
    assert.ok(styleLabels.includes('复古编辑杂志画册风'), 'Must include 复古编辑杂志画册风');

    const c4d = ctx.IMAGE_STYLE_OPTIONS.find(s => s.label === 'C4D 3D 商用超写实');
    assert.ok(c4d.value.includes('C4D') || c4d.value.includes('cinema4d'));
    assert.ok(c4d.value.includes('softbox') || c4d.value.includes('rim lighting'));
});

test('MODULE_PLATFORM_TAGS defines tags for m17 and m18', () => {
    const ctx = createTestEnv();
    const tags = ctx.MODULE_PLATFORM_TAGS;

    assert.ok(tags.m17, 'm17 platform tag must exist');
    assert.strictEqual(tags.m17.label, '3C/工业');

    assert.ok(tags.m18, 'm18 platform tag must exist');
    assert.strictEqual(tags.m18.label, '社交/UGC');
});

test('brandContextHub.getVisualBrandDirectives derives lighting mood, color guidance, and invariants', () => {
    const ctx = createTestEnv();
    assert.ok(typeof ctx.brandContextHub.getVisualBrandDirectives === 'function');

    // Test luxury tone
    const luxuryProfile = {
        brandName: 'Aura Luxury',
        category: 'Watch & Jewelry',
        tone: 'luxury'
    };
    const luxuryDirectives = ctx.brandContextHub.getVisualBrandDirectives(luxuryProfile);
    assert.ok(luxuryDirectives.includes('Brand: Aura Luxury'));
    assert.ok(luxuryDirectives.includes('Category: Watch & Jewelry'));
    assert.ok(luxuryDirectives.includes('chiaroscuro') || luxuryDirectives.includes('refined edges'));
    assert.ok(luxuryDirectives.includes('Brand Invariants'));
    assert.ok(luxuryDirectives.includes('100% faithful to uploaded reference'));

    // Test tech tone
    const techProfile = {
        brandName: 'CyberMech',
        category: '3C Electronics',
        tone: 'tech'
    };
    const techDirectives = ctx.brandContextHub.getVisualBrandDirectives(techProfile);
    assert.ok(techDirectives.includes('daylight studio') || techDirectives.includes('rim light'));
    assert.ok(techDirectives.includes('Futuristic clean aesthetic') || techDirectives.includes('metallic'));

    // Test natural tone
    const naturalProfile = {
        brandName: 'EcoHome',
        category: 'Home & Kitchen',
        tone: 'natural'
    };
    const naturalDirectives = ctx.brandContextHub.getVisualBrandDirectives(naturalProfile);
    assert.ok(naturalDirectives.includes('natural daylight') || naturalDirectives.includes('organic'));
});

test('buildProductLockPrompt outputs Prompt-as-Code physical lighting and micro-texture fidelity', () => {
    const ctx = createTestEnv();
    const singleLock = ctx.buildProductLockPrompt({ productType: 'single' });
    assert.ok(singleLock.includes('Physical Lighting Protocol'), 'Must contain Physical Lighting Protocol');
    assert.ok(singleLock.includes('softbox'), 'Must mention softbox');
    assert.ok(singleLock.includes('rim lighting'), 'Must mention rim lighting');
    assert.ok(singleLock.includes('contact shadows'), 'Must mention contact shadows to prevent floating');
    assert.ok(singleLock.includes('Material Micro-Texture Fidelity'), 'Must mention Material Micro-Texture Fidelity');

    const bundleLock = ctx.buildProductLockPrompt({ productType: 'bundle' });
    assert.ok(bundleLock.includes('KIT COHESION LOCK'), 'Must contain kit cohesion lock');
    assert.ok(bundleLock.includes('Physical Lighting Protocol'), 'Bundle lock must also enforce physical lighting');
});

test('buildModuleTextPolicy formats visible text rules for m17 and m18 and handles includeText: false', () => {
    const ctx = createTestEnv();

    const m17Text = ctx.buildModuleTextPolicy({ id: 'm17', includeText: true }, { language: 'English' });
    assert.ok(m17Text.includes('VISIBLE TEXT'));
    assert.ok(m17Text.includes('technical component callouts') || m17Text.includes('Brushless Motor'));

    const m18Text = ctx.buildModuleTextPolicy({ id: 'm18', includeText: true }, { language: 'English' });
    assert.ok(m18Text.includes('VISIBLE TEXT'));
    assert.ok(m18Text.includes('customer quote') || m18Text.includes('5-star rating'));

    const m17NoText = ctx.buildModuleTextPolicy({ id: 'm17', includeText: false });
    assert.ok(m17NoText.includes('NO ADDED TEXT'));
    assert.ok(m17NoText.includes('No headlines, subheadlines'));
});

test('buildModuleExecutionBrief generates distinct compositions for m17 and m18', () => {
    const ctx = createTestEnv();

    const m17Brief = ctx.buildModuleExecutionBrief({ id: 'm17', includeText: true });
    assert.ok(m17Brief.includes('exploded view') || m17Brief.includes('deconstructed'));

    const m18Brief = ctx.buildModuleExecutionBrief({ id: 'm18', includeText: true });
    assert.ok(m18Brief.includes('lifestyle unboxing') || m18Brief.includes('customer review quote card'));

    const m17VisualOnly = ctx.buildModuleExecutionBrief({ id: 'm17', includeText: false });
    assert.ok(m17VisualOnly.includes('exploded view') || m17VisualOnly.includes('immaculate alignment'));
});

test('buildModuleGenerationPrompt injects Brand Profile Hub visual directives when available', () => {
    const ctx = createTestEnv();

    // Set an active brand profile
    ctx.brandContextHub.saveProfile({
        name: 'Aerolite Running Shoes',
        brandName: 'Aerolite',
        category: 'Footwear / Running',
        tone: 'tech',
        differentiators: 'Carbon fiber plate, ultra-light foam'
    });

    const prompt = ctx.buildModuleGenerationPrompt(
        { id: 'm1', title: '首屏认知', promptTitle: 'Hero Product Understanding', active: true, count: 1, includeText: true, prompt: 'Create hero section' },
        'Aerolite Carbon fiber plate running shoe',
        { platform: 'Shopify', region: 'US Market', aspectRatio: '1:1', imageStyle: 'C4D 3D commercial hyper-realistic style' }
    );

    assert.ok(prompt.includes('BRAND VISUAL GUIDELINES'), 'Prompt should include BRAND VISUAL GUIDELINES');
    assert.ok(prompt.includes('Brand: Aerolite'), 'Prompt should include active brand name');
    assert.ok(prompt.includes('Physical Lighting Protocol'), 'Prompt should include physical lighting');
});

test('detectCurrentModulePreset correctly identifies tech_hardware and social_ugc', () => {
    const ctx = createTestEnv();

    // Activate tech_hardware modules
    const techIds = ['m1', 'm2', 'm17', 'm6', 'm8', 'm10', 'm11'];
    ctx.modules.forEach(m => {
        m.active = techIds.includes(m.id);
    });
    assert.strictEqual(ctx.detectCurrentModulePreset(), 'tech_hardware');

    // Activate social_ugc modules
    const socialIds = ['m1', 'm3', 'm18', 'm2', 'm9', 'm11'];
    ctx.modules.forEach(m => {
        m.active = socialIds.includes(m.id);
    });
    assert.strictEqual(ctx.detectCurrentModulePreset(), 'social_ugc');
});
