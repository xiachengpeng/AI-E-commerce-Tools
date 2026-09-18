const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");

const analysisSource = fs.readFileSync(path.join(__dirname, "../js/analysis.js"), "utf8");

function createAnalysisContext(domElements = {}, overrides = {}) {
    const elements = { ...domElements };
    const context = {
        console,
        setTimeout,
        clearTimeout,
        window: {},
        document: {
            getElementById: (id) => elements[id] || null,
            querySelector: (sel) => elements[sel] || null,
            querySelectorAll: () => [],
            createElement: (tag) => ({
                tag,
                value: "",
                style: {},
                classList: { add() {}, remove() {} },
                appendChild() {},
                focus() {},
                select() {}
            }),
            body: {
                appendChild() {},
                removeChild() {}
            },
            execCommand: () => true
        },
        localStorage: overrides.localStorage || {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {}
        },
        navigator: {
            clipboard: {
                writeText: async (text) => {
                    context.__lastCopied = text;
                }
            }
        },
        API_BASE: "http://localhost:9503",
        Event: class Event {
            constructor(type, opts) {
                this.type = type;
                this.opts = opts;
            }
        },
        switchMainTab: (tab) => {
            context.__switchedTab = tab;
        },
        showToast: (msg, type) => {
            context.__lastToast = { msg, type };
        }
    };
    vm.createContext(context);
    vm.runInContext(analysisSource, context);
    return context;
}

test("xp_parseAdAngle correctly parses structured, legacy, and string formats", () => {
    const ctx = createAnalysisContext();
    const parse = ctx.window.xp_parseAdAngle;

    // 1. Structured object
    const structured = {
        angle: "痛点反差 ||| Pain Point Contrast",
        hook: "开箱翻车？别再买廉价款了！ ||| Unboxing disaster? Stop buying cheap versions!",
        script: "镜头1: 展示断裂；镜头2: 换用本品抗摔测试",
        cta_hashtags: "点击左下角购买 #TikTokMadeMeBuyIt"
    };
    const res1 = parse(structured);
    assert.equal(res1.angle, "痛点反差 ||| Pain Point Contrast");
    assert.equal(res1.hook, "开箱翻车？别再买廉价款了！ ||| Unboxing disaster? Stop buying cheap versions!");
    assert.equal(res1.script, "镜头1: 展示断裂；镜头2: 换用本品抗摔测试");
    assert.equal(res1.cta_hashtags, "点击左下角购买 #TikTokMadeMeBuyIt");

    // 2. Legacy object
    const legacy = {
        angle: "手绘回忆 ||| Hand-painted Memories",
        detail: "每一口咖啡都是浪漫"
    };
    const res2 = parse(legacy);
    assert.equal(res2.angle, "手绘回忆 ||| Hand-painted Memories");
    assert.equal(res2.script, "每一口咖啡都是浪漫");
    assert.equal(res2.hook, "");
    assert.equal(res2.cta_hashtags, "");

    // 3. Simple text string
    const res3 = parse("高能测评切入点");
    assert.equal(res3.angle, "高能测评切入点");
    assert.equal(res3.hook, "");
    assert.equal(res3.script, "");

    // 4. Null / undefined
    const res4 = parse(null);
    assert.equal(res4.angle, "");
    assert.equal(res4.hook, "");
});

test("xp_detectRegion maps target countries to system region options", () => {
    const ctx = createAnalysisContext();
    const detect = ctx.window.xp_detectRegion;

    assert.equal(detect(["日本", "韩国"]), "Japan Market");
    assert.equal(detect(["United Kingdom", "London"]), "UK Market");
    assert.equal(detect(["泰国", "东南亚"]), "Southeast Asia Market");
    assert.equal(detect(["德国", "法国", "欧洲"]), "European Market");
    assert.equal(detect(["美国"]), "US Market");
    assert.equal(detect(["Australia"]), "Australian Market");
    assert.equal(detect([]), "US Market");
});

test("xp_renderSingleTldr renders decision traffic light, fatal pitfall, and opportunity", () => {
    let tldrHtml = "";
    let tldrClasses = ["xp-tldr-card", "xp-hidden"];

    const tldrCardEl = {
        classList: {
            remove: (cls) => {
                tldrClasses = tldrClasses.filter((c) => c !== cls);
            }
        },
        set innerHTML(val) {
            tldrHtml = val;
        },
        get innerHTML() {
            return tldrHtml;
        }
    };

    const ctx = createAnalysisContext({
        "xp-singleTldrCard": tldrCardEl
    });

    const sampleProduct = {
        product_name: "智能控温保温杯 ||| Smart Thermal Mug",
        weaknesses: [
            { risk: "杯盖密封圈异味", detail: "硅胶圈初期有轻微塑胶味，差评率 4%" }
        ],
        differentiation_opportunities: [
            { opportunity: "采用食品级陶瓷内胆与无异味铂金硅胶圈" }
        ],
        entry_recommendation: "重点主打母婴级材质与 24h 智能恒温"
    };

    const sampleScore = {
        opportunity_score: 88,
        difficulty_score: 35,
        final_decision: "优先进入 ||| Priority Entry",
        decision_details: {
            reason: "市场需求旺盛，差异化切入空间大"
        }
    };

    ctx.window.xp_renderSingleTldr(sampleProduct, sampleScore);

    // Verify card is made visible
    assert.equal(tldrClasses.includes("xp-hidden"), false);

    // Verify decision badge (success for '优先进入')
    assert.match(tldrHtml, /xp-tldr-badge-success/);
    assert.match(tldrHtml, /优先进入/);
    assert.match(tldrHtml, /88/);
    assert.match(tldrHtml, /35/);

    // Verify fatal pitfall rendered
    assert.match(tldrHtml, /核心避坑雷区/);
    assert.match(tldrHtml, /杯盖密封圈异味/);

    // Verify breakthrough opportunity rendered
    assert.match(tldrHtml, /最优破局机会/);
    assert.match(tldrHtml, /食品级陶瓷内胆/);
});

test("xp_transferToListing fills listing inputs and switches tab", () => {
    const listingNameEl = { value: "" };
    const listingPointsEl = { value: "" };
    const listingKeywordsEl = { value: "" };
    let dispatchedEvents = [];
    const listingRegionSelectEl = {
        value: "",
        dispatchEvent: (e) => dispatchedEvents.push(e)
    };

    const ctx = createAnalysisContext({
        listingName: listingNameEl,
        listingPoints: listingPointsEl,
        listingKeywords: listingKeywordsEl,
        listingRegionSelect: listingRegionSelectEl
    });

    const sampleProduct = {
        product_name: "户外露营折叠椅 ||| Camping Folding Chair",
        core_selling_points: [
            { point: "航空级铝合金支架，承重 150kg" },
            { point: "3秒快速折叠收纳" }
        ],
        differentiation_opportunities: [
            { opportunity: "附带侧边保温杯袋与多功能挂扣" }
        ],
        user_pain_points: [
            { pain: "竞品布料接缝处容易开裂" }
        ],
        target_audience: ["露营爱好者", "钓鱼人群"],
        use_scenarios: ["户外露营", "自驾游", "野餐"],
        target_countries: ["美国", "加拿大"]
    };

    ctx.window.xp_transferToListing(sampleProduct);

    // Check name
    assert.equal(listingNameEl.value, "户外露营折叠椅");

    // Check points text structure
    assert.match(listingPointsEl.value, /【核心卖点与功能】/);
    assert.match(listingPointsEl.value, /航空级铝合金支架/);
    assert.match(listingPointsEl.value, /【差异化改良突破点】/);
    assert.match(listingPointsEl.value, /附带侧边保温杯袋/);
    assert.match(listingPointsEl.value, /【竞品痛点针对性优化】/);
    assert.match(listingPointsEl.value, /针对原痛点改进: 竞品布料接缝处容易开裂/);
    assert.match(listingPointsEl.value, /【适用人群与场景】/);
    assert.match(listingPointsEl.value, /露营爱好者/);

    // Check keywords
    assert.match(listingKeywordsEl.value, /户外露营/);

    // Check region
    assert.equal(listingRegionSelectEl.value, "US Market");
    assert.equal(dispatchedEvents.length >= 1, true);

    // Check tab switch
    assert.equal(ctx.__switchedTab, "listing");
    assert.equal(ctx.__lastToast?.type, "success");
});

test("xp_transferToAds fills ads inputs and switches tab", () => {
    const adsProductNameInput = { value: "" };
    let dispatchedEvents = [];
    const adsRegionSelect = {
        value: "",
        dispatchEvent: (e) => dispatchedEvents.push(e)
    };

    const ctx = createAnalysisContext({
        adsProductNameInput,
        adsRegionSelect
    });

    const sampleProduct = {
        product_name: "超轻日式便携茶具套装 ||| Portable Japanese Tea Set",
        target_countries: ["日本", "东亚"]
    };

    ctx.window.xp_transferToAds(sampleProduct);

    assert.equal(adsProductNameInput.value, "超轻日式便携茶具套装");
    assert.equal(adsRegionSelect.value, "Japan Market");
    assert.equal(ctx.__switchedTab, "ads");
    assert.equal(ctx.__lastToast?.type, "success");
});

test("xp_copyTldrSummary and xp_copyAdAngleScript copy formatted text to clipboard", async () => {
    const ctx = createAnalysisContext();

    const sampleProduct = {
        product_name: "便携浓缩咖啡机",
        price: "$49.99",
        reviews_count: "1,200",
        core_selling_points: [{ point: "15Bar 恒压萃取" }],
        weaknesses: [{ risk: "水箱容量偏小", detail: "仅能冲泡单份" }],
        differentiation_opportunities: [{ opportunity: "双份加量水箱配件" }],
        ad_angles: [
            {
                angle: "早八人自救",
                hook: "别再去便利店排队买冷萃了！",
                script: "镜头1: 展示拥挤排队；镜头2: 办公桌30秒现萃香浓意式",
                cta_hashtags: "点击链接立享特惠 #EspressoAtHome"
            }
        ]
    };

    const sampleScore = {
        final_decision: "建议进入",
        opportunity_score: 85,
        difficulty_score: 40
    };

    // Test copy TL;DR
    await ctx.window.xp_copyTldrSummary(sampleProduct, sampleScore);
    assert.match(ctx.__lastCopied, /【选品分析决策速览 \(TL;DR\)】/);
    assert.match(ctx.__lastCopied, /便携浓缩咖啡机/);
    assert.match(ctx.__lastCopied, /核心避坑雷区/);
    assert.match(ctx.__lastCopied, /水箱容量偏小/);

    // Test copy ad script
    await ctx.window.xp_copyAdAngleScript(0, sampleProduct);
    assert.match(ctx.__lastCopied, /【短视频广告分镜头脚本 #01】/);
    assert.match(ctx.__lastCopied, /早八人自救/);
    assert.match(ctx.__lastCopied, /别再去便利店排队买冷萃了！/);
    assert.match(ctx.__lastCopied, /办公桌30秒现萃香浓意式/);
    assert.match(ctx.__lastCopied, /#EspressoAtHome/);
});

test("xp_generateWhitePaperReport generates light executive theme with consistent single product data", () => {
    const ctx = createAnalysisContext();
    const generate = ctx.window.xp_generateWhitePaperReport;

    const sampleResponse = {
        success: true,
        data: {
            single_data: {
                product_name: "超轻便携式折叠椅 ||| Ultralight Folding Chair",
                price: "$39.99",
                rating: "4.7",
                reviews_count: "2,450",
                core_selling_points: [
                    { point: "航空级7075铝合金支架" },
                    { point: "透气防撕裂600D牛津布" }
                ],
                target_audience: ["自驾露营族", "周末野餐家庭"],
                use_scenarios: ["户外露营", "山地徒步", "海滩烧烤"],
                user_pain_points: [
                    { pain: "市面普通折叠椅支撑杆易弯曲", detail: "超过80kg易变形" }
                ],
                strengths: [
                    { strength: "超轻自重仅900g" }
                ],
                weaknesses: [
                    { risk: "收纳袋拉链偶有卡顿", detail: "拉链齿较紧" }
                ],
                differentiation_opportunities: [
                    { opportunity: "配置侧边水杯网兜与手机插袋" }
                ],
                marketing_channels: ["TikTok", "Instagram Reels"],
                ad_angles: [
                    {
                        angle: "承重测试硬核反差 ||| Extreme Stress Test",
                        hook: "两只壮汉坐上去，真的不会塌吗？ ||| Can it really hold two grown men?",
                        script: "镜头1: 故意猛压竞品塑料椅瞬间断裂；镜头2: 换用本品，双人站立依然稳如磐石",
                        cta_hashtags: "点击下方链接立省20% #CampingHacks"
                    }
                ],
                entry_recommendation: "第一阶段：主打轻量化与硬核承重；第二阶段：拓展家庭双人套装",
                voc_analysis: {
                    sentiment: 88,
                    pros: ["真的很轻便于携带"],
                    cons: ["拉链比较紧"]
                }
            },
            scores: [
                {
                    product_name: "超轻便携式折叠椅",
                    opportunity_score: 86,
                    difficulty_score: 32,
                    final_decision: "优先进入",
                    decision_details: {
                        reason: "户外消费升级，轻量化赛道增长显著"
                    },
                    evaluation_details: [
                        { dimension: "市场需求与搜索增速", score: 90, note: "年复合增速35%" },
                        { dimension: "供应链与成本可控度", score: 85, note: "成熟产业带" }
                    ]
                }
            ]
        }
    };

    const html = generate(sampleResponse);

    // 1. Must use light executive theme (NO dark black background)
    assert.equal(html.includes("#0b0f19"), false, "Must not contain dark background #0b0f19");
    assert.match(html, /--bg:\s*#f8fafc/i, "Must define clean slate/white base background variable");
    assert.match(html, /background-color:\s*var\(--bg\)/i, "Must use background-color: var(--bg)");
    assert.match(html, /--text-primary:\s*#0f172a/i, "Must define high-contrast dark text variable");
    assert.match(html, /@media\s+print/i, "Must include print stylesheet");

    // 2. Must render 5-second TL;DR board
    assert.match(html, /极速选品决策看板/, "Should contain TL;DR header");
    assert.match(html, /优先进入/, "Should contain decision pill");
    assert.match(html, /核心避坑雷区/, "Should contain fatal pitfall header");
    assert.match(html, /收纳袋拉链偶有卡顿/, "Should contain risk content");
    assert.match(html, /最优破局机会/, "Should contain opportunity header");
    assert.match(html, /配置侧边水杯网兜/, "Should contain breakthrough content");

    // 3. Must render Quantitative Scoring & Evaluation Details
    assert.match(html, /86/, "Should contain opportunity score");
    assert.match(html, /32/, "Should contain difficulty score");
    assert.match(html, /户外消费升级，轻量化赛道增长显著/, "Should contain decision reason");
    assert.match(html, /市场需求与搜索增速/, "Should contain evaluation dimension");
    assert.match(html, /供应链与成本可控度/, "Should contain evaluation dimension 2");

    // 4. Must render Product Hero, Selling Points & Persona
    assert.match(html, /超轻便携式折叠椅/, "Should contain product title");
    assert.match(html, /\$39\.99/, "Should contain price");
    assert.match(html, /航空级7075铝合金支架/, "Should contain selling point");
    assert.match(html, /自驾露营族/, "Should contain persona tag");
    assert.match(html, /山地徒步/, "Should contain scenario tag");

    // 5. Must render structured Ad Script Hook
    assert.match(html, /承重测试硬核反差/, "Should contain ad angle name");
    assert.match(html, /两只壮汉坐上去，真的不会塌吗？/, "Should contain hook");
    assert.match(html, /故意猛压竞品塑料椅瞬间断裂/, "Should contain script");
    assert.match(html, /#CampingHacks/, "Should contain cta/hashtags");

    // 6. Must render numbered Entry Strategy steps
    assert.match(html, /第一阶段：主打轻量化与硬核承重/, "Should contain strategy step");

    // 7. Must render VOC Sentiment Analysis
    assert.match(html, /88%/, "Should contain positive sentiment percentage");
    assert.match(html, /真的很轻便于携带/, "Should contain top praise");
});

test("xp_generateWhitePaperReport generates comparison matrix with winner highlights", () => {
    const ctx = createAnalysisContext();
    const generate = ctx.window.xp_generateWhitePaperReport;

    const sampleMatrixResponse = {
        success: true,
        template_type: "matrix",
        data: {
            products: [
                {
                    product_name: "竞品A (现有爆款)",
                    price: "$19.99",
                    reviews_count: "5,000",
                    core_selling_points: ["价格低廉但易坏"],
                    weaknesses: [{ risk: "易生锈、塑料感强" }]
                },
                {
                    product_name: "竞品B (新晋黑马)",
                    price: "$35.99",
                    reviews_count: "320",
                    core_selling_points: ["航空铝合金耐用"],
                    weaknesses: [{ risk: "包装简陋" }]
                }
            ],
            comparison: {
                winner_product: "竞品B (新晋黑马)",
                competition_level: "中等竞争",
                market_position: "高性价比中端市场"
            },
            scores: [
                {
                    product: "竞品A",
                    opportunity_score: 62,
                    difficulty_score: 55,
                    final_decision: "谨慎观望"
                },
                {
                    product: "竞品B",
                    opportunity_score: 89,
                    difficulty_score: 30,
                    final_decision: "优先进入"
                }
            ],
            comprehensive_evaluation: [
                {
                    dimension: "品质与溢价空间",
                    detail: "竞品B在耐用性与品质上有明显溢价空间"
                }
            ],
            recommendation_list: [
                "聚焦 $30-40 价格带提供更优品质",
                "避开竞品A的低价劣质红海缠斗"
            ]
        }
    };

    const html = generate(sampleMatrixResponse);

    // 1. Light theme
    assert.equal(html.includes("#0b0f19"), false);
    assert.match(html, /--bg:\s*#f8fafc/i);

    // 2. Matrix header & winner banner
    assert.match(html, /市场竞争态势与赢家研判/);
    assert.match(html, /最具投资价值赢家产品/);
    assert.match(html, /竞品B/);

    // 3. Matrix table with Winner column highlight
    assert.match(html, /竞品横向深度对比矩阵/);
    assert.match(html, /👑 Winner/);
    assert.match(html, /航空铝合金耐用/);

    // 4. Actionable recommendations
    assert.match(html, /综合机会评估与操盘建议/);
    assert.match(html, /聚焦.*价格带/);
    assert.match(html, /避开竞品A的低价劣质红海缠斗/);
});

test("xp_renderBrandPositioning correctly renders tagline, angle badge, and trust proof chips", () => {
    const sectionClasses = new Set(["xp-hidden"]);
    const section = {
        classList: {
            add: (c) => sectionClasses.add(c),
            remove: (c) => sectionClasses.delete(c),
            contains: (c) => sectionClasses.has(c)
        }
    };
    const target = { innerHTML: "" };

    const ctx = createAnalysisContext({
        "xp-singleBrandPosSection": section,
        "xp-singleBrandPositioning": target
    });

    const render = ctx.window.xp_renderBrandPositioning;

    // 1. With complete brand positioning data
    render({
        brand_positioning: {
            tagline: "重新定义便携动力 ||| Redefining Portable Power",
            positioning_angle: "专业硬核 ||| Hardcore Pro",
            trust_triggers: ["德国红点设计大奖", "军规防摔认证", "10,000+ 极客用户好评"]
        }
    });

    assert.equal(sectionClasses.has("xp-hidden"), false);
    assert.match(target.innerHTML, /重新定义便携动力/);
    assert.match(target.innerHTML, /专业硬核/);
    assert.match(target.innerHTML, /德国红点设计大奖/);
    assert.match(target.innerHTML, /军规防摔认证/);

    // 2. Empty data hides the section
    render({});
    assert.equal(sectionClasses.has("xp-hidden"), true);
    assert.equal(target.innerHTML, "");
});

test("xp_renderBattleCard correctly renders 4-column battle card grid", () => {
    const sectionClasses = new Set(["xp-hidden"]);
    const section = {
        classList: {
            add: (c) => sectionClasses.add(c),
            remove: (c) => sectionClasses.delete(c),
            contains: (c) => sectionClasses.has(c)
        }
    };
    const target = { innerHTML: "" };

    const ctx = createAnalysisContext({
        "xp-singleBattleSection": section,
        "xp-singleBattleCard": target
    });

    const render = ctx.window.xp_renderBattleCard;

    // 1. Complete battle card
    render({
        battle_card: {
            competitor_moat: ["线下渠道先发优势", "核心专利壁垒"],
            attack_vector: ["续航发热严重 (痛点集中区)", "售后响应迟缓"],
            whitespace_opportunities: ["户外极寒场景适配", "环保生物基外壳"],
            threat_radar: ["竞品或降价20%发起价格战", "渠道排他协议压制"]
        }
    });

    assert.equal(sectionClasses.has("xp-hidden"), false);
    assert.match(target.innerHTML, /竞品防守强区/);
    assert.match(target.innerHTML, /线下渠道先发优势/);
    assert.match(target.innerHTML, /我方主攻破局点/);
    assert.match(target.innerHTML, /续航发热严重/);
    assert.match(target.innerHTML, /蓝海生态空白/);
    assert.match(target.innerHTML, /户外极寒场景适配/);
    assert.match(target.innerHTML, /潜在反扑威胁/);
    assert.match(target.innerHTML, /竞品或降价20%/);

    // 2. Battle card with backend prompt key aliases (competitor_strengths, attack_angles, potential_threats)
    render({
        battle_card: {
            competitor_strengths: ["手工感强但易碎"],
            attack_angles: ["免烧陶泥配方升级"],
            whitespace_opportunities: ["亲子伴创陶艺盒"],
            potential_threats: ["低价倾销仿冒"]
        }
    });

    assert.equal(sectionClasses.has("xp-hidden"), false);
    assert.match(target.innerHTML, /竞品防守强区/);
    assert.match(target.innerHTML, /手工感强但易碎/);
    assert.match(target.innerHTML, /我方主攻破局点/);
    assert.match(target.innerHTML, /免烧陶泥配方升级/);
    assert.match(target.innerHTML, /蓝海生态空白/);
    assert.match(target.innerHTML, /亲子伴创陶艺盒/);
    assert.match(target.innerHTML, /潜在反扑威胁/);
    assert.match(target.innerHTML, /低价倾销仿冒/);

    // 3. Empty data hides the section
    render({});
    assert.equal(sectionClasses.has("xp-hidden"), true);
    assert.equal(target.innerHTML, "");
});

test("xp_generatePositioningMapSvg outputs crisp SVG with quadrants and nodes for single and matrix", () => {
    const ctx = createAnalysisContext();
    const gen = ctx.window.xp_generatePositioningMapSvg;

    // 1. Single product mode
    const singleSvg = gen(
        { x: 65, y: 70, label: "旗舰竞品X", recommended_attack: { x: 38, y: 85, label: "我方破局切入点" } },
        false,
        { product_name: "旗舰竞品X" },
        "zh"
    );

    assert.match(singleSvg, /<svg viewBox="0 0 640 400"/);
    assert.match(singleSvg, /质价比破局区/);
    assert.match(singleSvg, /旗舰高端区/);
    assert.match(singleSvg, /大众基础区/);
    assert.match(singleSvg, /品牌溢价区/);
    assert.match(singleSvg, /旗舰竞品X/);
    assert.match(singleSvg, /我方破局切入点/);
    assert.match(singleSvg, /#ef4444/); // competitor node color
    assert.match(singleSvg, /#10b981/); // whitespace star color

    // 2. Matrix multi-product mode
    const matrixSvg = gen(
        {
            positions: [
                { x: 25, y: 35, label: "竞品A" },
                { x: 75, y: 80, label: "竞品B" }
            ],
            recommended_attack: { x: 40, y: 88, label: "蓝海高价值点" }
        },
        true,
        {
            products: [
                { product_name: "竞品A" },
                { product_name: "竞品B" }
            ],
            comparison: {
                winner_product: "竞品B"
            }
        },
        "zh"
    );

    assert.match(matrixSvg, /<svg viewBox="0 0 640 400"/);
    assert.match(matrixSvg, /竞品A/);
    assert.match(matrixSvg, /竞品B/);
    assert.match(matrixSvg, /👑/); // winner crown
    assert.match(matrixSvg, /蓝海高价值点/);
});

test("xp_generateWhitePaperReport embeds Brand Positioning, 2D Positioning Map, and Battle Card", () => {
    const ctx = createAnalysisContext();
    const generate = ctx.window.xp_generateWhitePaperReport;

    const singleResponse = {
        template_type: "single",
        data: {
            single_data: {
                product_name: "智能降噪耳机 Pro",
                price: "$129.99",
                brand_positioning: {
                    tagline: "极致降噪，私享静谧",
                    positioning_angle: "专业旗舰",
                    trust_triggers: ["Hi-Res 金标认证", "红点设计奖"]
                },
                quadrant_position: {
                    x: 70,
                    y: 75,
                    label: "竞品Pro"
                },
                battle_card: {
                    competitor_moat: ["降噪芯片深度自研"],
                    attack_vector: ["耳罩透气性差，长时间佩戴压耳"],
                    whitespace_opportunities: ["轻量化记忆海绵设计"],
                    threat_radar: ["大促直接腰斩破价促销"]
                },
                core_selling_points: ["45dB 深度降噪"],
                differentiation_opportunities: ["更透气的织物耳罩材质"],
                entry_recommendation: "主打长途商旅佩戴舒适性"
            },
            scores: [
                {
                    opportunity_score: 86,
                    difficulty_score: 42,
                    final_decision: "优先进入"
                }
            ]
        }
    };

    const html = generate(singleResponse);

    // Verify Brand Positioning is embedded
    assert.match(html, /品牌心智与价值主张/);
    assert.match(html, /极致降噪，私享静谧/);
    assert.match(html, /Hi-Res 金标认证/);

    // Verify 2D Positioning Map SVG is embedded
    assert.match(html, /2D 市场定位象限/);
    assert.match(html, /<svg viewBox="0 0 640 400"/);
    assert.match(html, /质价比破局区/);

    // Verify Battle Card is embedded
    assert.match(html, /跨境攻防对抗战术盘/);
    assert.match(html, /降噪芯片深度自研/);
    assert.match(html, /耳罩透气性差/);
    assert.match(html, /轻量化记忆海绵设计/);
    assert.match(html, /大促直接腰斩破价促销/);
});

test("xp_renderObjections renders cards with Q&A and proof points and handles empty gracefully", () => {
    const sectionClasses = new Set(["xp-hidden"]);
    const section = {
        classList: {
            add: (c) => sectionClasses.add(c),
            remove: (c) => sectionClasses.delete(c),
            contains: (c) => sectionClasses.has(c)
        }
    };
    const list = { innerHTML: "" };

    const ctx = createAnalysisContext({
        "xp-singleObjectionsSection": section,
        "xp-singleObjectionsList": list
    });

    const render = ctx.window.xp_renderObjections;

    // 1. With complete customer objections data
    render({
        customer_objections: [
            {
                objection: "为什么你们家比竞品贵 $10？ ||| Why is yours $10 more expensive than competitors?",
                response: "我们采用日本进口航空级铝合金机身，使用寿命是普通塑料款的 3 倍以上。 ||| We use imported aviation-grade aluminum, offering 3x durability over plastic.",
                proof_point: "通过 MIL-STD-810H 军规耐用认证，提供 3 年免费以旧换新质保。 ||| MIL-STD-810H certified with a 3-year warranty."
            },
            {
                objection: "很多类似产品评论说发热严重，你们的会吗？ ||| Do these overheat like other brands?",
                response: "我们搭载双涡轮主动导热系统，连续满载工作表面温升不超过 5℃。 ||| Dual-turbine active cooling keeps temperature below 5C above ambient.",
                proof_point: "第三方实验室 72 小时压力温控测试报告。 ||| 72-hour continuous thermal test report."
            }
        ]
    });

    assert.equal(sectionClasses.has("xp-hidden"), false);
    assert.match(list.innerHTML, /为什么你们家比竞品贵.*10/);
    assert.match(list.innerHTML, /采用日本进口航空级铝合金机身/);
    assert.match(list.innerHTML, /MIL-STD-810H 军规耐用认证/);
    assert.match(list.innerHTML, /发热严重/);
    assert.match(list.innerHTML, /双涡轮主动导热系统/);
    assert.match(list.innerHTML, /第三方实验室 72 小时压力温控测试报告/);

    // 2. Empty data hides the section
    render({});
    assert.equal(sectionClasses.has("xp-hidden"), true);
    assert.equal(list.innerHTML, "");
});

test("xp_copyObjection and xp_copyAllObjections correctly copy objection Q&A to clipboard", async () => {
    const ctx = createAnalysisContext({
        "xp-copyAllObjectionsBtn": {
            innerHTML: "<span>复制全部攻防话术</span>",
            classList: { add() {}, remove() {} }
        }
    });

    const sampleData = {
        product_name: "旗舰降噪耳机 Pro",
        customer_objections: [
            {
                objection: "材质是否环保亲肤？ ||| Is the material skin-friendly?",
                response: "采用医用级液态硅胶耳罩，抗过敏耐汗蚀。 ||| Medical grade liquid silicone.",
                proof_point: "SGS 环保无毒生物相容性认证。 ||| SGS certified."
            },
            {
                objection: "电池寿命如何？ ||| How is battery lifespan?",
                response: "支持 500 次循环充放电衰减低于 10%。 ||| Over 500 cycles with <10% degradation.",
                proof_point: "提供 2 年电池衰减免费换新保修。 ||| 2-year battery warranty."
            }
        ]
    };

    // 1. Copy single objection
    await ctx.window.xp_copyObjection(0, sampleData);
    assert.match(ctx.__lastCopied, /买家疑虑 #01/);
    assert.match(ctx.__lastCopied, /材质是否环保亲肤/);
    assert.match(ctx.__lastCopied, /医用级液态硅胶耳罩/);
    assert.match(ctx.__lastCopied, /SGS 环保无毒生物相容性认证/);

    // 2. Copy all objections
    await ctx.window.xp_copyAllObjections(sampleData);
    assert.match(ctx.__lastCopied, /旗舰降噪耳机 Pro · 买家异议预判与客服攻防库/);
    assert.match(ctx.__lastCopied, /买家疑虑 #01/);
    assert.match(ctx.__lastCopied, /买家疑虑 #02/);
    assert.match(ctx.__lastCopied, /电池寿命如何/);
});

test("xp_generateWhitePaperReport embeds Customer Objection Defense section when present", () => {
    const ctx = createAnalysisContext();
    const generate = ctx.window.xp_generateWhitePaperReport;

    const response = {
        template_type: "single",
        data: {
            single_data: {
                product_name: "智能筋膜枪",
                customer_objections: [
                    {
                        objection: "推力够大吗？是否适合深层肌群放松？",
                        response: "搭载无刷强磁电机，拥有 14kg 强劲推力，可直击 12mm 深层筋膜组织。",
                        proof_point: "国家级运动员康复训练中心实测推荐。"
                    }
                ],
                entry_recommendation: "主打专业健身人群"
            }
        }
    };

    const html = generate(response);

    assert.match(html, /买家常见异议预判与客服攻防话术库/);
    assert.match(html, /推力够大吗？是否适合深层肌群放松？/);
    assert.match(html, /搭载无刷强磁电机，拥有 14kg 强劲推力/);
    assert.match(html, /国家级运动员康复训练中心实测推荐/);
});

test("xp_renderMatrixStrategySection correctly renders Winner breakdown, breakthrough strategy, and market landscape", () => {
    const sectionClasses = new Set(["xp-hidden"]);
    const container = { innerHTML: "" };

    const ctx = createAnalysisContext({
        "xp-matrixStrategySection": {
            classList: {
                add: (cls) => sectionClasses.add(cls),
                remove: (cls) => sectionClasses.delete(cls),
                contains: (cls) => sectionClasses.has(cls)
            }
        },
        "xp-matrixStrategyContainer": container
    });

    const render = ctx.window.xp_renderMatrixStrategySection;

    // 1. Valid strategic data
    render({
        strategic_insights: {
            winner_analysis: {
                key_advantages: "头部低价规模效应 ||| Low price volume",
                fatal_vulnerability: "塑料外壳发热易熔断 ||| Plastic body melts under high heat"
            },
            breakthrough_strategy: {
                product_innovation: "铝合金双风道主动散热降温 ||| Dual-channel aluminum cooling",
                pricing_entry: "主打 $34.99 质价比黄金段 ||| Target $34.99 sweet spot",
                marketing_playbook: "竞品发热痛点对决反差视频 ||| Contrast video against competitor overheating"
            },
            market_landscape: "两极分化严重，存在质价比真空带 ||| Polarized market with whitespace",
            pricing_tier_analysis: "低端 $15-$25 极度卷，中高端 $45+ 溢价高 ||| Low tier very competitive"
        }
    });

    assert.equal(sectionClasses.has("xp-hidden"), false);
    assert.match(container.innerHTML, /胜出竞品深度解剖与突破死穴/);
    assert.match(container.innerHTML, /头部低价规模效应/);
    assert.match(container.innerHTML, /塑料外壳发热易熔断/);
    assert.match(container.innerHTML, /我方差异化突围实战作战打法/);
    assert.match(container.innerHTML, /铝合金双风道主动散热降温/);
    assert.match(container.innerHTML, /两极分化严重，存在质价比真空带/);

    // 2. Empty data hides section
    render({});
    assert.equal(sectionClasses.has("xp-hidden"), true);
    assert.equal(container.innerHTML, "");
});

test("xp_renderTable renders 8+ dimensions including Brand Positioning, Moat, Attack Vector, and Objections", () => {
    const header = { innerHTML: "" };
    const body = { innerHTML: "" };

    const ctx = createAnalysisContext();
    const renderTable = ctx.window.xp_renderTable;

    const sampleProducts = [
        {
            product_name: "竞品 A",
            price: "$19.99",
            reviews_count: "1500",
            brand_positioning: {
                tagline: "极简科技，为快而生",
                positioning_angle: "极致性价比"
            },
            core_selling_points: ["30分钟快充", "轻量化便携"],
            target_audience: ["商务白领", "大学生"],
            use_scenarios: ["差旅出差", "办公室午休"],
            battle_card: {
                competitor_moat: ["百元内极速充电算法专利"],
                attack_vector: ["外壳易划痕，散热差"]
            },
            voc_analysis: {
                pros: ["充电确实快"],
                cons: ["发热烫手"]
            },
            customer_objections: [
                {
                    objection: "会不会损伤手机电池？",
                    response: "搭载智能温控芯片，涓流保护不伤机。"
                }
            ]
        },
        {
            product_name: "竞品 B",
            price: "$39.99",
            reviews_count: "450",
            brand_positioning: {
                tagline: "军规级坚固耐用",
                positioning_angle: "专业硬核"
            },
            core_selling_points: ["全金属防护", "IP68防水防尘"],
            target_audience: ["户外探险者"],
            use_scenarios: ["野外露营", "徒步登山"],
            battle_card: {
                competitor_moat: ["MIL-STD-810H 军规防护"],
                attack_vector: ["机身笨重，便携性差"]
            },
            voc_analysis: {
                pros: ["非常结实耐摔"],
                cons: ["太重了不好装口袋"]
            },
            customer_objections: [
                {
                    objection: "带着登山累赘吗？",
                    response: "附赠专业登山挂扣，外挂背包零负重感。"
                }
            ]
        }
    ];

    renderTable(sampleProducts, header, body);

    assert.match(header.innerHTML, /竞品 A/);
    assert.match(header.innerHTML, /竞品 B/);
    assert.match(body.innerHTML, /品牌心智与定位/);
    assert.match(body.innerHTML, /极简科技，为快而生/);
    assert.match(body.innerHTML, /军规级坚固耐用/);
    assert.match(body.innerHTML, /核心优势\/壁垒/);
    assert.match(body.innerHTML, /百元内极速充电算法专利/);
    assert.match(body.innerHTML, /致命软肋\/破局痛点/);
    assert.match(body.innerHTML, /外壳易划痕，散热差/);
    assert.match(body.innerHTML, /机身笨重，便携性差/);
    assert.match(body.innerHTML, /买家疑虑与对策/);
    assert.match(body.innerHTML, /会不会损伤手机电池/);
    assert.match(body.innerHTML, /带着登山累赘吗/);
});

test("xp_renderMatrixCompetitorDrilldown renders product tabs, highlights winner, and renders deep assets", () => {
    const sectionClasses = new Set(["xp-hidden"]);
    const tabsContainer = {
        innerHTML: "",
        querySelectorAll: () => []
    };
    const contentContainer = { innerHTML: "" };

    const ctx = createAnalysisContext({
        "xp-matrixDetailSection": {
            classList: {
                add: (cls) => sectionClasses.add(cls),
                remove: (cls) => sectionClasses.delete(cls),
                contains: (cls) => sectionClasses.has(cls)
            }
        },
        "xp-matrixProductTabs": tabsContainer,
        "xp-matrixProductDetailContent": contentContainer
    });

    const drilldown = ctx.window.xp_renderMatrixCompetitorDrilldown;

    const sampleProducts = [
        {
            product_name: "超音波清洗机 Mini",
            price: "$29.99",
            brand_positioning: {
                tagline: "45000Hz 强劲微气泡清洗",
                positioning_angle: "母婴健康",
                trust_triggers: ["FDA 接触级认证"]
            },
            battle_card: {
                competitor_moat: ["母婴级抑菌材质内胆"],
                attack_vector: ["容量偏小，洗不了大墨镜"],
                whitespace_opportunities: ["大容量折叠便携款"],
                threat_radar: ["竞品降价促销"]
            },
            customer_objections: [
                {
                    objection: "洗眼镜会震坏镜片镀膜吗？",
                    response: "采用精密恒频微振动，绝不损伤任何光学镀膜。",
                    proof_point: "蔡司镜片兼容测试报告。"
                }
            ],
            ad_angles: [
                {
                    angle: "前后对比反差评测",
                    hook: "你以为洗干净的眼镜，放进去居然喷出黑水？！",
                    script: "戴了半年的眼镜直接放入超音波清洗机，5秒肉眼可见污渍被震出...",
                    cta_hashtags: "#生活好物 #眼镜清洁"
                }
            ]
        }
    ];

    drilldown(sampleProducts, 0);

    assert.equal(sectionClasses.has("xp-hidden"), false);
    assert.match(tabsContainer.innerHTML, /👑/);
    assert.match(tabsContainer.innerHTML, /超音波清洗机 Mini/);
    assert.match(contentContainer.innerHTML, /45000Hz 强劲微气泡清洗/);
    assert.match(contentContainer.innerHTML, /母婴级抑菌材质内胆/);
    assert.match(contentContainer.innerHTML, /洗眼镜会震坏镜片镀膜吗/);
    assert.match(contentContainer.innerHTML, /前后对比反差评测/);
    assert.match(contentContainer.innerHTML, /你以为洗干净的眼镜/);
});

test("xp_generateWhitePaperReport embeds Strategic Blueprint and per-competitor intelligence in matrix mode", () => {
    const ctx = createAnalysisContext();
    const generate = ctx.window.xp_generateWhitePaperReport;

    const response = {
        template_type: "matrix",
        data: {
            comparison: {
                winner_product: "智能音箱 Pro",
                competition_level: "中",
                market_position: "音质质价比高地"
            },
            strategic_insights: {
                winner_analysis: {
                    key_advantages: "低音浑厚下潜深，调音出色",
                    fatal_vulnerability: "蓝牙连接距离短，穿墙易断连"
                },
                breakthrough_strategy: {
                    product_innovation: "搭载双天线蓝牙5.3，稳定穿透两堵墙",
                    pricing_entry: "比头部低 $5，主攻学生宿舍场景",
                    marketing_playbook: "穿墙隔空不断连挑战视频"
                },
                market_landscape: "传统大牌定价虚高，新品牌靠蓝牙连接稳定性破局",
                pricing_tier_analysis: "市场两极化：$20入门与 $80旗舰"
            },
            products: [
                {
                    product_name: "智能音箱 Pro",
                    price: "$49.99",
                    reviews_count: "2000",
                    brand_positioning: {
                        tagline: "Hi-Res 金标无损音质"
                    },
                    battle_card: {
                        competitor_moat: ["Hi-Res 金标认证与重低音振膜"],
                        attack_vector: ["蓝牙偶尔卡顿，APP体验差"]
                    },
                    customer_objections: [
                        {
                            objection: "看视频有延迟吗？",
                            response: "开启游戏低延迟模式，音画同步延迟低至 40ms。"
                        }
                    ],
                    ad_angles: [
                        {
                            angle: "重低音盲测挑战",
                            hook: "蒙上双眼，你分得清这是 300 还是 3000 的音箱吗？"
                        }
                    ]
                }
            ],
            scores: [
                {
                    product: "智能音箱 Pro",
                    opportunity_score: 85,
                    difficulty_score: 35,
                    final_decision: "强烈建议进入",
                    decision_details: { reason: "音质与价格优势明显" }
                }
            ]
        }
    };

    const html = generate(response);

    assert.match(html, /战略博弈格局与我方突围蓝图/);
    assert.match(html, /低音浑厚下潜深/);
    assert.match(html, /蓝牙连接距离短，穿墙易断连/);
    assert.match(html, /搭载双天线蓝牙5\.3/);
    assert.match(html, /竞品横向深度对比矩阵/);
    assert.match(html, /Hi-Res 金标无损音质/);
    assert.match(html, /各竞品单品深度透视与战术情报库/);
    assert.match(html, /看视频有延迟吗/);
    assert.match(html, /重低音盲测挑战/);
});

test("xp_extractProfileFromAnalysis formats single product insights correctly", () => {
    const ctx = createAnalysisContext();
    const extract = ctx.window.xp_extractProfileFromAnalysis;

    const sample = {
        product_name: "自适应动态腰托工学椅 ||| Adaptive Ergonomic Chair",
        brand_positioning: {
            brand_name: "ErgoPro",
            category: "办公家具 / 人体工学",
            tone: "professional"
        },
        target_audience: ["长期伏案程序员", "腰椎不适人群"],
        user_pain_points: [
            { pain: "腰部悬空酸痛" },
            { pain: "夏日闷热不透气" }
        ],
        differentiation_opportunities: [
            { opportunity: "双轴仿生追腰机构" }
        ],
        core_selling_points: [
            { point: "航天级高弹网布" }
        ],
        use_scenarios: ["居家办公", "写字楼办公"],
        battle_card: {
            who_it_is_not_for: "体重超过 160kg",
            tactical_counter_attacks: [
                { angle: "支撑力对比", action: "高强度慢镜头测试" }
            ]
        }
    };

    const profile = extract(sample);
    assert.ok(profile);
    assert.match(profile.name, /自适应动态腰托工学椅/);
    assert.equal(profile.brandName, "ErgoPro");
    assert.equal(profile.category, "办公家具 / 人体工学");
    assert.match(profile.icp, /长期伏案程序员/);
    assert.match(profile.painPoints, /腰部悬空酸痛/);
    assert.match(profile.differentiators, /双轴仿生追腰机构/);
    assert.match(profile.vocKeywords, /居家办公/);
    assert.match(profile.competitorNotes, /【劝退人群】体重超过 160kg/);
    assert.match(profile.competitorNotes, /【实战拦截打法】/);
});

test("xp_transferToBrandProfile invokes brandContextHub.openWithDraft", () => {
    const ctx = createAnalysisContext();
    let openedDraft = null;
    ctx.window.brandContextHub = {
        openWithDraft: (draft) => {
            openedDraft = draft;
        }
    };

    const sample = {
        product_name: "轻量化户外野营帐篷",
        user_pain_points: [{ pain: "防雨指数低，容易渗水" }],
        differentiation_opportunities: [{ opportunity: "全贴胶防水压条技术" }],
        target_audience: ["徒步爱好者"]
    };

    ctx.window.xp_transferToBrandProfile(sample);
    assert.ok(openedDraft);
    assert.match(openedDraft.name, /轻量化户外野营帐篷/);
    assert.match(openedDraft.painPoints, /容易渗水/);
    assert.match(openedDraft.differentiators, /全贴胶防水压条技术/);
});

test("xp_transferMatrixToDetails and matrix actions route winner product", () => {
    const productNameEl = { value: "" };
    const listingNameEl = { value: "" };
    const adsNameEl = { value: "" };
    const ctx = createAnalysisContext({
        productNameInput: productNameEl,
        listingName: listingNameEl,
        adsProductNameInput: adsNameEl
    });

    const products = [
        { product_name: "普通露营椅" },
        { product_name: "旗舰赢家露营椅", core_selling_points: [{ point: "超轻钛合金" }] }
    ];

    // Simulate matrix state
    ctx.window.xp_matrixCurrentProducts = products;
    ctx.window.xp_winnerIndex = 1;

    ctx.window.xp_transferMatrixToDetails();
    assert.equal(productNameEl.value, "旗舰赢家露营椅");

    ctx.window.xp_transferMatrixToListing();
    assert.equal(listingNameEl.value, "旗舰赢家露营椅");

    ctx.window.xp_transferMatrixToAds();
    assert.equal(adsNameEl.value, "旗舰赢家露营椅");
});

test("xp_resetAnalysisSession clears state, localStorage, and resets DOM elements", () => {
    let removedKeys = [];
    const mockLocalStorage = {
        getItem: () => null,
        setItem: () => {},
        removeItem: (key) => removedKeys.push(key)
    };
    const tagsListEl = {
        querySelectorAll: () => [
            { remove: () => {} }
        ]
    };
    const urlInputEl = { value: "https://amazon.com/dp/B012345", disabled: true };
    const resultSectionEl = {
        classList: {
            classes: new Set(),
            add(c) { this.classes.add(c); },
            remove(c) { this.classes.delete(c); },
            contains(c) { return this.classes.has(c); }
        }
    };
    const singleTplEl = {
        classList: {
            classes: new Set(),
            add(c) { this.classes.add(c); },
            remove(c) { this.classes.delete(c); },
            contains(c) { return this.classes.has(c); }
        }
    };
    const matrixTplEl = {
        classList: {
            classes: new Set(),
            add(c) { this.classes.add(c); },
            remove(c) { this.classes.delete(c); },
            contains(c) { return this.classes.has(c); }
        }
    };
    const loadingEl = {
        classList: {
            classes: new Set(),
            add(c) { this.classes.add(c); },
            remove(c) { this.classes.delete(c); },
            contains(c) { return this.classes.has(c); }
        }
    };
    const errorEl = {
        textContent: "Error",
        classList: {
            classes: new Set(),
            add(c) { this.classes.add(c); },
            remove(c) { this.classes.delete(c); },
            contains(c) { return this.classes.has(c); }
        }
    };

    const ctx = createAnalysisContext({
        "xp-tagsList": tagsListEl,
        "xp-urlInputField": urlInputEl,
        "xp-resultSection": resultSectionEl,
        "xp-single-template": singleTplEl,
        "xp-matrix-template": matrixTplEl,
        "xp-loadingSection": loadingEl,
        "xp-errorMsg": errorEl
    }, {
        localStorage: mockLocalStorage
    });

    ctx.window.xp_resetAnalysisSession();

    assert.equal(urlInputEl.value, "");
    assert.equal(urlInputEl.disabled, false);
    assert.ok(resultSectionEl.classList.contains("xp-hidden"));
    assert.ok(singleTplEl.classList.contains("xp-hidden"));
    assert.ok(matrixTplEl.classList.contains("xp-hidden"));
    assert.ok(loadingEl.classList.contains("xp-hidden"));
    assert.ok(errorEl.classList.contains("xp-hidden"));
    assert.equal(errorEl.textContent, "");
    assert.ok(removedKeys.includes("xuanpin_last_result_v27"));
    assert.ok(removedKeys.includes("xuanpin_last_urls_v27"));
    assert.ok(ctx.__lastToast);
    assert.match(ctx.__lastToast.msg, /恢复干净初始状态/);
});

test("index.html contains mode explanation card and analysis.js syncs selection between buttons and explanation rows", () => {
    const rootDir = path.resolve(__dirname, "..");
    const indexHtml = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");

    // 1. Verify index.html contains mode description card and explanation elements
    assert.match(indexHtml, /id="xp-modeDescCard"/);
    assert.match(indexHtml, /id="xp-modeRowQuick"/);
    assert.match(indexHtml, /id="xp-modeRowDeep"/);
    assert.match(indexHtml, /极速快照/);
    assert.match(indexHtml, /深度解构/);
    assert.match(indexHtml, /快速提炼卖点/);
    assert.match(indexHtml, /全量商业情报/);

    // 2. Test analysis.js mode toggle interaction
    function makeEl(id) {
        const classes = new Set();
        const listeners = {};
        return {
            id,
            classList: {
                add: (c) => classes.add(c),
                remove: (c) => classes.delete(c),
                contains: (c) => classes.has(c)
            },
            addEventListener: (evt, fn) => { listeners[evt] = fn; },
            click: () => { listeners["click"]?.(); }
        };
    }

    const quickBtn = makeEl("xp-modeQuick");
    const deepBtn = makeEl("xp-modeDeep");
    deepBtn.classList.add("active");
    const quickRow = makeEl("xp-modeRowQuick");
    const deepRow = makeEl("xp-modeRowDeep");
    deepRow.classList.add("active");

    const dummyEl = {
        addEventListener() {},
        classList: { add() {}, remove() {}, contains() { return false; } },
        focus() {},
        select() {},
        innerHTML: "",
        value: ""
    };

    const ctx = createAnalysisContext({
        "xp-modeQuick": quickBtn,
        "xp-modeDeep": deepBtn,
        "xp-modeRowQuick": quickRow,
        "xp-modeRowDeep": deepRow,
        "xp-urlsInputContainer": dummyEl,
        "xp-urlInputField": dummyEl,
        "xp-urlCounter": dummyEl,
        "xp-analyzeBtn": dummyEl,
        "xp-tagsList": dummyEl,
        "xp-errorMsg": dummyEl,
        "xp-loadingSection": dummyEl,
        "xp-single-template": dummyEl,
        "xp-matrix-template": dummyEl,
        "xp-resultSection": dummyEl,
        "xp-langToggle": dummyEl,
        "xp-exportBtn": dummyEl,
        "xp-appTitle": dummyEl,
        "xp-copyAllBtn": dummyEl,
        "xp-clearAllBtn": dummyEl
    });

    vm.runInContext(analysisSource, ctx);
    ctx.window.xp_init();

    // Switch to quick via clicking quick row
    quickRow.click();
    assert.ok(quickBtn.classList.contains("active"));
    assert.ok(!deepBtn.classList.contains("active"));
    assert.ok(quickRow.classList.contains("active"));
    assert.ok(!deepRow.classList.contains("active"));

    // Switch to deep via clicking deep button
    deepBtn.click();
    assert.ok(deepBtn.classList.contains("active"));
    assert.ok(!quickBtn.classList.contains("active"));
    assert.ok(deepRow.classList.contains("active"));
    assert.ok(!quickRow.classList.contains("active"));
});
