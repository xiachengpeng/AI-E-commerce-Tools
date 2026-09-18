const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

// Helper to create a rich DOM/Browser mock context
function createMarketingTestContext(initialHtml = '', domOverrides = {}) {
    const storage = new Map();
    const localStorageMock = {
        getItem: (k) => storage.get(k) || null,
        setItem: (k, v) => storage.set(k, String(v)),
        removeItem: (k) => storage.delete(k),
        clear: () => storage.clear()
    };

    const elements = { ...domOverrides };

    function makeElement(tagName = 'div', id = '') {
        const classListSet = new Set();
        let _innerHTML = '';
        let _textContent = '';
        return {
            tagName: tagName.toUpperCase(),
            id: id || '',
            value: '',
            get textContent() {
                if (_textContent) return _textContent;
                const childTexts = (this.children || []).map(c => c.textContent || '').join(' ');
                const innerText = _innerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
                return [innerText, childTexts].filter(Boolean).join(' ');
            },
            set textContent(val) {
                _textContent = String(val ?? '');
            },
            get innerHTML() {
                return _innerHTML;
            },
            set innerHTML(val) {
                _innerHTML = String(val ?? '');
            },
            className: '',
            disabled: false,
            options: [],
            selectedIndex: 0,
            children: [],
            dataset: {},
            classList: {
                add: (...cls) => cls.forEach(c => classListSet.add(c)),
                remove: (...cls) => cls.forEach(c => classListSet.delete(c)),
                toggle: (c, force) => {
                    if (force === true) classListSet.add(c);
                    else if (force === false) classListSet.delete(c);
                    else if (classListSet.has(c)) classListSet.delete(c);
                    else classListSet.add(c);
                },
                contains: (c) => classListSet.has(c)
            },
            append: function(...items) {
                items.forEach(it => this.appendChild(it));
            },
            appendChild: function(child) {
                this.children.push(child);
                return child;
            },
            removeChild: function(child) {
                const idx = this.children.indexOf(child);
                if (idx >= 0) this.children.splice(idx, 1);
                return child;
            },
            addEventListener: function(event, handler) {
                if (!this._listeners) this._listeners = {};
                if (!this._listeners[event]) this._listeners[event] = [];
                this._listeners[event].push(handler);
            },
            dispatchEvent: function(event) {
                const type = event.type || event;
                (this._listeners?.[type] || []).forEach(h => h(event));
            },
            click: function() {
                this.dispatchEvent({ type: 'click' });
            },
            focus: () => {}
        };
    }

    const doc = {
        getElementById: (id) => {
            if (elements[id]) return elements[id];
            elements[id] = makeElement('div', id);
            return elements[id];
        },
        querySelector: (sel) => {
            if (sel.startsWith('#')) return doc.getElementById(sel.slice(1));
            return elements[sel] || null;
        },
        querySelectorAll: (sel) => {
            if (sel === '.brand-profile-quick-select') {
                return [elements.brandProfileSelect || doc.getElementById('mockBrandProfileSelect')];
            }
            return [];
        },
        createElement: (tag) => makeElement(tag),
        body: makeElement('body')
    };

    let toastHistory = [];

    const ctx = {
        console,
        setTimeout,
        clearTimeout,
        URL,
        Blob,
        document: doc,
        localStorage: localStorageMock,
        showToast: (msg, type) => {
            toastHistory.push({ msg, type });
        },
        escapeHtml: (str) => String(str ?? ''),
        MARKET_TONE_MAP: { 'US Market': 'direct but compliant' },
        API_BASE: 'http://127.0.0.1:9503/api',
        fetch: async () => ({ ok: true, json: async () => ({}) })
    };

    ctx.window = ctx;
    ctx.globalThis = ctx;

    vm.createContext(ctx);

    return {
        ctx,
        elements,
        storage,
        getToastHistory: () => toastHistory,
        getLastToast: () => toastHistory[toastHistory.length - 1] || null
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Brand & Product Context Hub (brand_context.js) Tests
// ─────────────────────────────────────────────────────────────────────────────

test('brand_context.js: initializes default profile when storage is empty', () => {
    const { ctx } = createMarketingTestContext();
    const brandJs = fs.readFileSync(path.join(root, 'js', 'brand_context.js'), 'utf8');
    vm.runInContext(brandJs, ctx);

    const hub = ctx.window.brandContextHub;
    assert.ok(hub, 'brandContextHub should be exported to window');

    const profiles = hub.getProfiles();
    assert.ok(Array.isArray(profiles), 'getProfiles returns array');
    assert.ok(profiles.length >= 1, 'Should have at least 1 default profile');
    assert.equal(profiles[0].id, 'sample_ergonomic_chair');
    assert.match(profiles[0].name, /人体工学椅/);

    const active = hub.getActiveProfile();
    assert.ok(active, 'Active profile should be retrieved');
    assert.equal(active.id, 'sample_ergonomic_chair');
});

test('brand_context.js: saveProfile creates new and updates existing profiles', () => {
    const { ctx } = createMarketingTestContext();
    const brandJs = fs.readFileSync(path.join(root, 'js', 'brand_context.js'), 'utf8');
    vm.runInContext(brandJs, ctx);
    const hub = ctx.window.brandContextHub;

    // Create new profile
    const created = hub.saveProfile({
        name: '钛合金轻量露营钛锅',
        brandName: 'TitanWild',
        category: '户外装备 / 露营厨具',
        icp: '超轻徒步旅行者 (Ultralight Backpackers)',
        painPoints: '传统铝锅易产生重金属溶出，不锈钢锅过于沉重',
        differentiators: '99.9% 航天纯钛，净重仅 118g，折叠防烫双把手',
        vocKeywords: '极度轻便, 导热极快, 耐腐蚀, 终身不坏',
        tone: 'bold'
    });

    assert.ok(created.id, 'New profile has generated ID');
    assert.equal(created.name, '钛合金轻量露营钛锅');
    assert.equal(created.brandName, 'TitanWild');

    // Active profile should now be the newly created profile
    assert.equal(hub.getActiveProfile().id, created.id);

    // Update the profile
    hub.saveProfile({
        id: created.id,
        name: '升级款钛合金露营钛锅 Pro',
        brandName: 'TitanWild Pro',
        icp: '超轻徒步旅行者及野外生存玩家'
    });

    const updated = hub.getActiveProfile();
    assert.equal(updated.id, created.id);
    assert.equal(updated.name, '升级款钛合金露营钛锅 Pro');
    assert.equal(updated.brandName, 'TitanWild Pro');
    assert.match(updated.icp, /野外生存玩家/);
});

test('brand_context.js: deleteProfile removes profile and handles default fallback', () => {
    const { ctx } = createMarketingTestContext();
    const brandJs = fs.readFileSync(path.join(root, 'js', 'brand_context.js'), 'utf8');
    vm.runInContext(brandJs, ctx);
    const hub = ctx.window.brandContextHub;

    const p1 = hub.saveProfile({ name: '测试商品 A' });
    const p2 = hub.saveProfile({ name: '测试商品 B' });

    assert.ok(hub.getProfiles().length >= 3);

    // Delete p2
    hub.deleteProfile(p2.id);
    const profilesAfterDelete = hub.getProfiles();
    assert.equal(profilesAfterDelete.some(p => p.id === p2.id), false);

    // If deleting all profiles, fallback to default
    profilesAfterDelete.forEach(p => hub.deleteProfile(p.id));
    const finalProfiles = hub.getProfiles();
    assert.ok(finalProfiles.length >= 1, 'Should restore default profile when all deleted');
});

test('brand_context.js: applyProfile populates Listing, Ads, and Details inputs', () => {
    const { ctx, elements } = createMarketingTestContext();
    const brandJs = fs.readFileSync(path.join(root, 'js', 'brand_context.js'), 'utf8');
    vm.runInContext(brandJs, ctx);
    const hub = ctx.window.brandContextHub;

    const profile = {
        id: 'test_p',
        name: '智能降噪睡眠耳塞',
        brandName: 'QuietRest',
        category: '个人护理 / 睡眠健康',
        icp: '浅睡眠者、被伴侣打鼾困扰的人群',
        painPoints: '传统泡沫耳塞胀耳发痛，隔音效果不佳易脱落',
        differentiators: '医用级液态硅胶，-35dB物理主动双重降噪，人体工程侧睡无感设计',
        vocKeywords: '整夜不痛, 一觉到天亮, 侧睡不压耳, 深度睡眠',
        tone: 'empathetic'
    };

    // Test Listing module populate
    hub.applyProfile(profile, 'listing');
    assert.equal(elements.listingName.value, `${profile.brandName} ${profile.name}`);
    assert.match(elements.listingPoints.value, /医用级液态硅胶/);
    assert.match(elements.listingKeywords.value, /整夜不痛/);

    // Test Ads module populate
    hub.applyProfile(profile, 'ads');
    assert.equal(elements.adsProductNameInput.value, `${profile.brandName} ${profile.name}`);

    // Test Detail module populate
    hub.applyProfile(profile, 'detail');
    assert.equal(elements.productNameInput.value, `${profile.brandName} ${profile.name}`);
    assert.match(elements.sellingPointsText.value, /医用级液态硅胶/);
    assert.match(elements.productFactsText.value, /整夜不痛/);
});

test('brand_context.js: extractCurrentModuleToProfileDraft harvests inputs from active module', () => {
    const { ctx } = createMarketingTestContext();
    const brandJs = fs.readFileSync(path.join(root, 'js', 'brand_context.js'), 'utf8');
    vm.runInContext(brandJs, ctx);
    const hub = ctx.window.brandContextHub;

    // Populate listing inputs
    ctx.document.getElementById('listingName').value = '超薄磁吸无线充电宝';
    ctx.document.getElementById('listingPoints').value = '5000mAh大容量\n强磁吸附不易脱落\n仅8.9mm超薄';
    ctx.document.getElementById('listingKeywords').value = '磁吸充电宝, 超薄便携, 快充';

    const draftFromListing = hub.extractFromCurrentModule('listing');
    assert.equal(draftFromListing.name, '超薄磁吸无线充电宝');
    assert.match(draftFromListing.differentiators, /5000mAh大容量/);
    assert.match(draftFromListing.vocKeywords, /磁吸充电宝/);
});

test('brand_context.js: extractFromAnalysis retrieves competitor analysis insights', () => {
    const { ctx } = createMarketingTestContext();
    const brandJs = fs.readFileSync(path.join(root, 'js', 'brand_context.js'), 'utf8');
    const analysisJs = fs.readFileSync(path.join(root, 'js', 'analysis.js'), 'utf8');
    vm.runInContext(brandJs, ctx);
    vm.runInContext(analysisJs, ctx);
    const hub = ctx.window.brandContextHub;

    ctx.window.xp_currentResponse = {
        template_type: 'single',
        data: {
            single_data: {
                product_name: '降噪无线耳机',
                brand_positioning: { brand_name: 'SoundPeak' },
                user_pain_points: [{ pain: '地铁嘈杂听不清' }],
                core_selling_points: [{ point: '45dB深度混合主动降噪' }],
                target_audience: ['通勤白领']
            }
        }
    };

    const draft = hub.extractFromAnalysis();
    assert.ok(draft);
    assert.match(draft.name, /降噪无线耳机/);
    assert.match(draft.painPoints, /地铁嘈杂听不清/);
    assert.match(draft.differentiators, /45dB深度混合主动降噪/);
    assert.match(draft.icp, /通勤白领/);

    const draftFromMod = hub.extractCurrentModuleToProfileDraft('analysis');
    assert.ok(draftFromMod);
    assert.match(draftFromMod.name, /降噪无线耳机/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Ads Golden Hooks & Creative Brief (ads.js) Tests
// ─────────────────────────────────────────────────────────────────────────────

test('ads.js: renderAdsGoldenHooks renders 5 psychology hook cards and copy actions', () => {
    const { ctx } = createMarketingTestContext();
    const adsJs = fs.readFileSync(path.join(root, 'js', 'ads.js'), 'utf8');
    vm.runInContext(adsJs, ctx);

    const mockContainer = ctx.document.createElement('div');

    const sampleGoldenHooks = [
        {
            type: 'pattern_interrupt',
            typeLabel: { zh: '打破认知', target: 'Pattern Interrupt' },
            target: 'Stop buying expensive ergonomic chairs that do nothing for your lower back.',
            zh: '别再花几千块买那些根本托不住腰的普通工学椅了！'
        },
        {
            type: 'pain_callout',
            typeLabel: { zh: '痛点点名', target: 'Pain Callout' },
            target: 'Working 8+ hours sitting down? Your lower back is silently screaming.',
            zh: '每天久坐 8 小时？你的腰椎正在无声抗议。'
        },
        {
            type: 'contrast',
            typeLabel: { zh: '前后对比', target: 'Before vs After' },
            target: 'Old chair: stiff backache by 3 PM. ErgoPro: full energy even after 10 hours.',
            zh: '普通椅子：下午三点腰酸背痛；ErgoPro：久坐一天依旧轻松挺拔。'
        },
        {
            type: 'curiosity',
            typeLabel: { zh: '好奇诱饵', target: 'Curiosity Loop' },
            target: 'The secret aerospace mesh tech that makes back pain disappear instantly.',
            zh: '为什么这款航天级追腰黑科技能让久坐酸痛瞬间消失？'
        },
        {
            type: 'social_proof',
            typeLabel: { zh: '从众背书', target: 'Social Proof' },
            target: 'Over 50,000 developers and designers switched to ErgoPro this year alone.',
            zh: '今年已有超 50,000 名程序员和设计师换上了 ErgoPro。'
        }
    ];

    ctx.renderAdsGoldenHooks(mockContainer, sampleGoldenHooks);

    assert.equal(mockContainer.children.length, 1, 'Should append golden hooks block');
    const block = mockContainer.children[0];
    assert.match(block.className, /border-amber-200/);

    // Look at inner structure
    const list = block.children[1];
    assert.equal(list.children.length, 5, 'Should render 5 hook cards');

    // First hook card check
    const hook0 = list.children[0];
    const content = hook0.children[0];
    assert.equal(content.children[0].textContent, '打破认知 (Pattern Interrupt)');
    assert.equal(content.children[1].textContent, sampleGoldenHooks[0].target);
    assert.equal(content.children[2].textContent, sampleGoldenHooks[0].zh);
});

test('ads.js: renderAdsCreativeBrief renders 3-part storyboard with scenes and creator notes', () => {
    const { ctx } = createMarketingTestContext();
    const adsJs = fs.readFileSync(path.join(root, 'js', 'ads.js'), 'utf8');
    vm.runInContext(adsJs, ctx);

    const mockContainer = ctx.document.createElement('div');

    const sampleBrief = {
        hookScene: {
            target: '0-3s Hook Scene: Creator rubs lower back in visible pain at office desk, sighs deeply. Voiceover: Still dealing with crippling back pain at 3 PM?',
            zh: '0-3秒 抓人画面：创作者在办公桌前痛苦揉腰，配音：每天下午3点还在忍受腰痛？'
        },
        bodyScene: {
            target: '3-15s Body Demonstration: Dynamic lumbar support adapting automatically as user reclines. Voiceover: Dual-axis mechanism tracks curve.',
            zh: '4-15秒 功能演示：双轴仿生机构自动贴合脊柱'
        },
        ctaScene: {
            target: '15-30s Urgency & Guarantee CTA: User happily typing, unboxing 30-day risk-free badge overlay. Voiceover: Try it risk-free for 30 days.',
            zh: '结尾 促单行动号召：30天无忧退换标志，号召立即下单'
        }
    };

    ctx.renderAdsCreativeBrief(mockContainer, sampleBrief);

    assert.equal(mockContainer.children.length, 1, 'Should append creative brief block');
    const block = mockContainer.children[0];
    assert.match(block.className, /border-indigo-200/);

    // Should contain scenes and notes
    const grid = block.children[1];
    assert.equal(grid.children.length, 3, 'Should render 3 storyboard scenes');

    const hookCard = grid.children[0];
    assert.match(hookCard.textContent, /0-3s 抓人画面/);
    assert.match(hookCard.textContent, /Creator rubs lower back/);
    assert.match(hookCard.textContent, /痛苦揉腰/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. DTC PDP CRO Sections & Google JSON-LD Schema (details.js) Tests
// ─────────────────────────────────────────────────────────────────────────────

test('details.js: renderDtcOfferStackSection generates 3-tier offer stack in both languages and styles', () => {
    const { ctx } = createMarketingTestContext();
    const detailsJs = fs.readFileSync(path.join(root, 'js', 'details.js'), 'utf8');
    vm.runInContext(detailsJs, ctx);

    // Chinese Editorial
    const zhHtml = ctx.renderDtcOfferStackSection(true, 'editorial');
    assert.match(zhHtml, /限时超值组合包/);
    assert.match(zhHtml, /全套开箱包装清单与专属加赠/);
    assert.match(zhHtml, /旗舰主机与标准核心组件/);
    assert.match(zhHtml, /赠品 1: 定制保护收纳套件/);
    assert.match(zhHtml, /总感知价值/);

    // English Minimalist
    const enHtml = ctx.renderDtcOfferStackSection(false, 'minimalist');
    assert.match(enHtml, /LIMITED-TIME BUNDLE VALUE/);
    assert.match(enHtml, /What's In The Box & Free Bonuses/);
    assert.match(enHtml, /Main Flagship Hardware Unit/);
    assert.match(enHtml, /Bonus #1: Custom Protective Kit/);
    assert.match(enHtml, /Total Perceived Value/);
});

test('details.js: renderDtcRiskReversalSection generates 30-day money-back guarantee in both languages', () => {
    const { ctx } = createMarketingTestContext();
    const detailsJs = fs.readFileSync(path.join(root, 'js', 'details.js'), 'utf8');
    vm.runInContext(detailsJs, ctx);

    // Chinese
    const zhHtml = ctx.renderDtcRiskReversalSection(true, 'editorial');
    assert.match(zhHtml, /100% 零风险试用保障：30天不满意全额退款/);
    assert.match(zhHtml, /我们对产品品质有绝对信心/);
    assert.match(zhHtml, /所有风险由我们承担/);

    // English
    const enHtml = ctx.renderDtcRiskReversalSection(false, 'editorial');
    assert.match(enHtml, /100% Risk-Free 30-Day Money Back Guarantee/);
    assert.match(enHtml, /Try it for 30 full days/);
    assert.match(enHtml, /No hassles, no questions asked/);
});

test('details.js: buildDtcJsonLdSchema produces valid Google Rich Snippets schema for arrays and objects', () => {
    const { ctx } = createMarketingTestContext();
    const detailsJs = fs.readFileSync(path.join(root, 'js', 'details.js'), 'utf8');
    vm.runInContext(detailsJs, ctx);

    // Case 1: tasks is an Array
    const projectDataArray = {
        productName: 'ErgoPro Dynamic Lumbar Chair',
        productSummary: 'Engineered for all-day comfort with auto-adaptive lumbar mechanism.',
        brandName: 'ErgoPro',
        tasks: [
            {
                type: 'faq',
                dtcCopy: {
                    faqs: [
                        { q: 'What is the trial period?', a: 'We provide a 30-day risk-free in-home trial.' },
                        { q: 'Does it support tall individuals?', a: 'Yes, it comfortably accommodates heights up to 6ft 5in.' }
                    ]
                }
            }
        ]
    };

    const scriptHtmlArray = ctx.buildDtcJsonLdSchema(projectDataArray);
    assert.match(scriptHtmlArray, /<script type="application\/ld\+json">/);
    assert.match(scriptHtmlArray, /<\/script>/);

    const jsonStringArray = scriptHtmlArray.replace(/<script[^>]*>/, '').replace(/<\/script>/, '').trim();
    const schemaObjArray = JSON.parse(jsonStringArray);

    assert.equal(schemaObjArray['@context'], 'https://schema.org');
    assert.ok(Array.isArray(schemaObjArray['@graph']));
    assert.equal(schemaObjArray['@graph'].length, 2, 'Should have Product and FAQPage');

    const productNode = schemaObjArray['@graph'].find(n => n['@type'] === 'Product');
    assert.ok(productNode);
    assert.equal(productNode.name, 'ErgoPro Dynamic Lumbar Chair');
    assert.equal(productNode.brand.name, 'ErgoPro');

    const faqNode = schemaObjArray['@graph'].find(n => n['@type'] === 'FAQPage');
    assert.ok(faqNode);
    assert.equal(faqNode.mainEntity.length, 2);
    assert.equal(faqNode.mainEntity[0].name, 'What is the trial period?');
    assert.equal(faqNode.mainEntity[0].acceptedAnswer.text, 'We provide a 30-day risk-free in-home trial.');

    // Case 2: tasks is an Object map (as stored in globalGenContext)
    const projectDataObject = {
        productName: 'ErgoPro Object Test',
        productSummary: 'Object map test',
        brandName: 'ErgoPro',
        tasks: {
            'task_faq_1': {
                type: 'faq',
                dtcCopy: {
                    faqs: [
                        { q: 'Is assembly required?', a: 'Minimal assembly takes under 10 minutes.' }
                    ]
                }
            }
        }
    };

    const scriptHtmlObj = ctx.buildDtcJsonLdSchema(projectDataObject);
    const jsonStringObj = scriptHtmlObj.replace(/<script[^>]*>/, '').replace(/<\/script>/, '').trim();
    const schemaObj = JSON.parse(jsonStringObj);

    const faqNodeFromMap = schemaObj['@graph'].find(n => n['@type'] === 'FAQPage');
    assert.ok(faqNodeFromMap, 'FAQPage should be found from object map tasks');
    assert.equal(faqNodeFromMap.mainEntity[0].name, 'Is assembly required?');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Competitor Battle Card (analysis.js) Tests
// ─────────────────────────────────────────────────────────────────────────────

test('analysis.js: xp_renderMatrixStrategySection renders Battle Card with why_switch, anti_persona, and counter-attacks', () => {
    const { ctx } = createMarketingTestContext();
    const analysisJs = fs.readFileSync(path.join(root, 'js', 'analysis.js'), 'utf8');
    vm.runInContext(analysisJs, ctx);

    const mockSection = ctx.document.getElementById('xp-matrixStrategySection');
    const mockContainer = ctx.document.getElementById('xp-matrixStrategyContainer');

    const sampleAnalysisData = {
        strategic_insights: {
            battle_card: {
                why_switch: [
                    {
                        trigger: '竞品腰部支撑固定不可调，久坐2小时腰椎下坠酸痛',
                        our_counter: '独家双轴仿生追腰机构，360°自适应贴合脊椎'
                    }
                ],
                who_it_is_for: '每天伏案8小时以上的程序员、设计师及远程工作者',
                who_it_is_not_for: '体重超过 150kg 或需要硬木直立坐姿的人群',
                tactical_counter_attacks: [
                    {
                        angle: '针对差评攻击',
                        action: '在详情页突出视频展示透气网布耐磨拉伸测试，击碎竞品塌陷差评担忧'
                    },
                    {
                        angle: '定价锚定拦截',
                        action: '对比竞品 $800+ 标价，打出 $299 顶级性价比与终身保修'
                    },
                    {
                        angle: '退货保障突围',
                        action: '提供 60 天免费上门退取件，消除大件家具网购退换货焦虑'
                    }
                ]
            }
        }
    };

    ctx.window.xp_renderMatrixStrategySection(sampleAnalysisData);

    assert.equal(mockSection.classList.contains('xp-hidden'), false, 'Section should not be hidden');
    assert.match(mockContainer.innerHTML, /⚔️ 竞争对战卡/);
    assert.match(mockContainer.innerHTML, /为什么从竞品转移/);
    assert.match(mockContainer.innerHTML, /竞品腰部支撑固定不可调/);
    assert.match(mockContainer.innerHTML, /独家双轴仿生追腰机构/);
    assert.match(mockContainer.innerHTML, /适合核心人群/);
    assert.match(mockContainer.innerHTML, /每天伏案8小时以上的程序员/);
    assert.match(mockContainer.innerHTML, /明确不适合人群/);
    assert.match(mockContainer.innerHTML, /体重超过 150kg/);
    assert.match(mockContainer.innerHTML, /3大实战拦截打法/);
    assert.match(mockContainer.innerHTML, /战术 1/);
    assert.match(mockContainer.innerHTML, /针对差评攻击/);
    assert.match(mockContainer.innerHTML, /转存为营销画像/);
});

test('analysis.js: xp_saveBattleCardToBrandProfile packages insights and transfers to Brand Profile Hub', () => {
    const { ctx } = createMarketingTestContext();
    const brandJs = fs.readFileSync(path.join(root, 'js', 'brand_context.js'), 'utf8');
    const analysisJs = fs.readFileSync(path.join(root, 'js', 'analysis.js'), 'utf8');
    vm.runInContext(brandJs, ctx);
    vm.runInContext(analysisJs, ctx);

    // Setup global current response
    ctx.window.xp_currentResponse = {
        winner_product: 'ErgoMaster Pro',
        strategic_insights: {
            battle_card: {
                why_switch: [{ trigger: '竞品易晃动', our_counter: '一体铸铝底盘' }],
                who_it_is_for: '高频电脑工作者',
                who_it_is_not_for: '临时访客短坐',
                tactical_counter_attacks: [{ angle: '稳定性对比', action: '放水杯震动对比视频' }]
            },
            winner_analysis: {
                key_advantages: '品牌知名度高',
                fatal_vulnerability: '网布易松弛'
            },
            breakthrough_strategy: {
                product_innovation: '双轴仿生追腰',
                marketing_playbook: '对标 Herman Miller 顶级用料但 1/3 价格'
            }
        }
    };

    let openedDraft = null;
    ctx.window.brandContextHub.openWithDraft = (draft) => {
        openedDraft = draft;
    };

    ctx.window.xp_saveBattleCardToBrandProfile();

    assert.ok(openedDraft, 'Should have called openWithDraft with formatted profile data');
    assert.equal(openedDraft.name, 'ErgoMaster Pro');
    assert.equal(openedDraft.category, '办公家具 / 人体工学');
    assert.equal(openedDraft.icp, '高频电脑工作者');
    assert.match(openedDraft.painPoints, /网布易松弛/);
    assert.match(openedDraft.differentiators, /双轴仿生追腰/);
    assert.match(openedDraft.vocKeywords, /顶级用料/);
    assert.match(openedDraft.competitorNotes, /【劝退人群】临时访客短坐/);
    assert.match(openedDraft.competitorNotes, /【拦截打法】\[稳定性对比\] 放水杯震动对比视频/);
});

test('brand_context.js: inferCategoryQuick heuristics accurately identifies cross-border e-commerce categories', () => {
    const { ctx } = createMarketingTestContext();
    const brandJs = fs.readFileSync(path.join(root, 'js', 'brand_context.js'), 'utf8');
    vm.runInContext(brandJs, ctx);

    const hub = ctx.window.brandContextHub;
    assert.equal(hub.inferCategoryQuick('超轻量三季户外露营双人帐篷'), '户外运动 / 露营装备');
    assert.equal(hub.inferCategoryQuick('无线降噪蓝牙头戴式耳机'), '3C数码 / 智能音频');
    assert.equal(hub.inferCategoryQuick('快充 GaN 65W 氮化镓充电器与磁吸线'), '3C数码 / 充电与配件');
    assert.equal(hub.inferCategoryQuick('不锈钢不粘炒锅厨房烹饪器具'), '家居生活 / 厨房餐具');
    assert.equal(hub.inferCategoryQuick('天然豆腐猫砂吸水除臭宠物猫用品'), '宠物用品 / 萌宠生活');
    assert.equal(hub.inferCategoryQuick('玻尿酸补水保湿面霜精华护肤'), '美妆护肤 / 个人美妆');
    assert.equal(hub.inferCategoryQuick('自适应动态腰托人体工学椅'), '办公家具 / 人体工学');
    assert.equal(hub.inferCategoryQuick('电动声波牙刷智能洁齿'), '个人护理 / 健康个护');
    assert.equal(hub.inferCategoryQuick('4K超清夜视行车记录仪车载摄像'), '汽车用品 / 车载周边');
});

test('brand_context.js: aiInferCategory calls callAI and writes recognized category to #brandHubCategory', async () => {
    const { ctx, elements, getToastHistory } = createMarketingTestContext();
    const brandJs = fs.readFileSync(path.join(root, 'js', 'brand_context.js'), 'utf8');
    vm.runInContext(brandJs, ctx);

    // Setup input elements
    elements.brandHubName = { value: 'Smart Thermal Water Bottle', focus: () => {} };
    elements.brandHubDifferentiators = { value: 'LED real-time temp display, 24h vacuum insulation' };
    elements.brandHubPainPoints = { value: 'Traditional mugs burn tongue or lose heat quickly' };
    elements.brandHubCategory = { value: '' };
    elements.btnBrandHubAiInferCat = { disabled: false, innerHTML: '<span>AI 识别</span>' };

    let calledCapability = null;
    let receivedPrompt = '';
    ctx.callAI = async (cap, payload) => {
        calledCapability = cap;
        receivedPrompt = payload.prompt;
        return { text: '家居生活 / 智能水杯' };
    };

    await ctx.window.brandContextHub.aiInferCategory();

    assert.equal(calledCapability, 'text');
    assert.match(receivedPrompt, /Smart Thermal Water Bottle/);
    assert.equal(elements.brandHubCategory.value, '家居生活 / 智能水杯');
    assert.equal(elements.btnBrandHubAiInferCat.disabled, false);
    const toasts = getToastHistory();
    assert.ok(toasts.some(t => t.msg.includes('AI 识别商品类目成功') && t.type === 'success'));
});

test('brand_context.js: aiInferCategory falls back to heuristic inference if callAI fails', async () => {
    const { ctx, elements, getToastHistory } = createMarketingTestContext();
    const brandJs = fs.readFileSync(path.join(root, 'js', 'brand_context.js'), 'utf8');
    vm.runInContext(brandJs, ctx);

    elements.brandHubName = { value: '超轻双人防风露营帐篷', focus: () => {} };
    elements.brandHubDifferentiators = { value: '15D防撕裂涂硅面料，铝合金压杆支架' };
    elements.brandHubPainPoints = { value: '传统帐篷笨重难搭，大雨易漏水' };
    elements.brandHubCategory = { value: '' };
    elements.btnBrandHubAiInferCat = { disabled: false, innerHTML: '<span>AI 识别</span>' };

    ctx.callAI = async () => {
        throw new Error('Network timeout or AI provider down');
    };

    await ctx.window.brandContextHub.aiInferCategory();

    assert.equal(elements.brandHubCategory.value, '户外运动 / 露营装备');
    assert.equal(elements.btnBrandHubAiInferCat.disabled, false);
    const toasts = getToastHistory();
    assert.ok(toasts.some(t => t.msg.includes('已自动匹配类目') && t.type === 'success'));
});
