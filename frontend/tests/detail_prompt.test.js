const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function loadFrontendContext() {
    const context = {
        console,
        document: { getElementById: () => null },
        showToast: () => {},
        MARKET_TONE_MAP: { 'US Market': 'direct but compliant' }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'config.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(root, 'js', 'details.js'), 'utf8'), context);
    return context;
}

const context = loadFrontendContext();

assert.strictEqual(typeof context.buildDetailPageBrief, 'function');
assert.strictEqual(typeof context.buildModuleGenerationPrompt, 'function');
assert.strictEqual(typeof context.getModuleContentRole, 'function');

const config = {
    platform: 'Independent Website',
    platformLabel: '独立站',
    region: 'US Market',
    marketTone: 'direct but compliant',
    language: 'English',
    languageLabel: '英文',
    aspectRatio: '3:4',
    imageStyle: 'High-end minimalist, clean, premium, sophisticated',
    imageStyleLabel: '高端极简',
    marketingTheme: 'none'
};

const sellingPoints = [
    '2-in-1 Walking Pad with vibration mode',
    'Designed for under-desk walking and easy home storage',
    'App synced progress and remote control',
    'Quiet motor, non-slip belt, compact profile'
].join('\n');

const brief = context.buildDetailPageBrief(sellingPoints, config);
assert.match(brief, /one clear conversion job/i);
assert.match(brief, /Do not invent/i);
assert.match(brief, /Avoid medical/i);
assert.match(brief, /maximum 3 bullets/i);

const firstBenefit = {
    id: 'm2',
    title: '核心卖点图',
    subtitle: '突出卖点优势',
    prompt: 'benefits',
    variant: 0,
    totalVariants: 3
};
const secondBenefit = { ...firstBenefit, variant: 1 };

const firstPrompt = context.buildModuleGenerationPrompt(firstBenefit, sellingPoints, config);
const secondPrompt = context.buildModuleGenerationPrompt(secondBenefit, sellingPoints, config);

assert.match(firstPrompt, /Module role:/);
assert.match(firstPrompt, /Do NOT repeat the same angle/i);
assert.match(firstPrompt, /Text density/i);
assert.match(firstPrompt, /Forbidden claims/i);
assert.notStrictEqual(firstPrompt, secondPrompt);
assert.match(firstPrompt, /under-desk|core daily-use/i);
assert.match(secondPrompt, /vibration|secondary function/i);

const specPrompt = context.buildModuleGenerationPrompt({
    id: 'm10',
    title: '详细规格表',
    subtitle: '展示详细参数',
    prompt: 'specs',
    variant: 0,
    totalVariants: 1
}, sellingPoints, config);
assert.match(specPrompt, /Use only facts from the supplied selling points/i);
assert.doesNotMatch(specPrompt, /burn fat|transform your body|medical recovery/i);

const activeDefaults = context.MODULES_CONFIG
    .filter(mod => mod.active)
    .map(mod => mod.id);
assert.strictEqual(JSON.stringify(activeDefaults), JSON.stringify(['m1', 'm2', 'm3', 'm9', 'm10', 'm11']));

console.log('detail prompt tests passed');
