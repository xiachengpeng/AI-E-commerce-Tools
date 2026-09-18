/**
 * 全局产品与品牌营销画像底座 (Brand & Product Context Hub)
 * 沉淀商品与品牌上下文（ICP、核心痛点、差异化卖点、VoC 关键词、品牌调性与竞品针对劣势）
 * 供 Listing、广告文案、详情页和竞品分析跨模块复用
 */

(function () {
    'use strict';

    const STORAGE_KEY = 'ai_ecommerce_brand_profiles';
    const ACTIVE_ID_KEY = 'ai_ecommerce_active_brand_profile_id';

    const DEFAULT_PROFILES = [
        {
            id: 'sample_ergonomic_chair',
            name: '自适应动态腰托人体工学椅',
            brandName: 'ErgoPro',
            category: '办公家具 / 人体工学',
            icp: '每天在电脑前伏案 8 小时以上的开发者、远程办公人群及慢性腰肌劳损患者',
            painPoints: '传统椅子腰部缺乏自适应支撑导致腰椎悬空酸痛、夏日背部闷热不透气、调节旋钮繁杂且易损松动',
            differentiators: '双轴仿生自适应动态追腰机构、航天级高弹抗撕裂透气网布、3秒单手联动4D无级调节扶手、135度午休无感后仰',
            vocKeywords: '腰不酸了, 久坐不累, 透气清爽, 支撑力强, 结实耐用, 60秒快装, 终身质保',
            tone: 'professional',
            competitorNotes: '竞品腰托为固定硬塑料且网布6个月塌陷；差评集中在滚轮卡头发和升降气杆异响',
            updatedAt: Date.now()
        }
    ];

    // ─── 存储与读取 ─────────────────────────────────────────────────────────────

    function getBrandProfiles() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_PROFILES));
                return DEFAULT_PROFILES;
            }
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_PROFILES;
        } catch (e) {
            console.error('Failed to parse brand profiles from localStorage', e);
            return DEFAULT_PROFILES;
        }
    }

    function syncBrandProfilesToBackend(profiles) {
        if (typeof fetch !== 'function') return Promise.resolve(null);
        const list = profiles || getBrandProfiles();
        const apiBase = (typeof API_BASE !== 'undefined' && API_BASE) ? API_BASE : 'http://localhost:9503';
        return fetch(`${apiBase}/api/brand-profiles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profiles: list })
        }).then(r => r.json()).catch(e => {
            console.warn('Sync brand profiles to backend failed:', e);
            return null;
        });
    }

    async function syncBrandProfilesFromBackend() {
        if (typeof fetch !== 'function') return getBrandProfiles();
        try {
            const apiBase = (typeof API_BASE !== 'undefined' && API_BASE) ? API_BASE : 'http://localhost:9503';
            const res = await fetch(`${apiBase}/api/brand-profiles`);
            if (res.ok) {
                const json = await res.json();
                const list = json?.data || json?.profiles;
                if (json.status === 'success' && Array.isArray(list) && list.length > 0) {
                    if (typeof localStorage !== 'undefined') {
                        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
                    }
                    updateInlineBrandProfileSelectors();
                    return list;
                }
            }
        } catch (e) {
            console.warn('Load brand profiles from backend failed, using local storage:', e);
        }
        return getBrandProfiles();
    }

    function saveBrandProfilesToStorage(profiles) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
            updateInlineBrandProfileSelectors();
            syncBrandProfilesToBackend(profiles);
        } catch (e) {
            console.error('Failed to save brand profiles', e);
        }
    }

    function getActiveBrandProfileId() {
        return localStorage.getItem(ACTIVE_ID_KEY) || (getBrandProfiles()[0]?.id || '');
    }

    function setActiveBrandProfileId(id) {
        localStorage.setItem(ACTIVE_ID_KEY, id);
        updateInlineBrandProfileSelectors();
    }

    function getActiveBrandProfile() {
        const profiles = getBrandProfiles();
        const activeId = getActiveBrandProfileId();
        return profiles.find(p => p.id === activeId) || profiles[0] || null;
    }

    function saveOrUpdateProfile(profileData) {
        const profiles = getBrandProfiles();
        const now = Date.now();
        const id = profileData.id || `profile_${now}_${Math.random().toString(36).substring(2, 6)}`;

        const profile = {
            id,
            name: (profileData.name || '').trim() || '未命名商品画像',
            brandName: (profileData.brandName || '').trim(),
            category: (profileData.category || '').trim(),
            icp: (profileData.icp || '').trim(),
            painPoints: (profileData.painPoints || '').trim(),
            differentiators: (profileData.differentiators || '').trim(),
            vocKeywords: (profileData.vocKeywords || '').trim(),
            tone: profileData.tone || 'professional',
            competitorNotes: (profileData.competitorNotes || '').trim(),
            brandColor: (profileData.brandColor || '').trim(),
            brandFont: (profileData.brandFont || '').trim(),
            updatedAt: now
        };

        const existingIdx = profiles.findIndex(p => p.id === id);
        if (existingIdx >= 0) {
            profiles[existingIdx] = profile;
        } else {
            profiles.unshift(profile);
        }

        saveBrandProfilesToStorage(profiles);
        setActiveBrandProfileId(id);
        return profile;
    }

    function deleteBrandProfileById(id) {
        let profiles = getBrandProfiles();
        profiles = profiles.filter(p => p.id !== id);
        if (profiles.length === 0) {
            profiles = DEFAULT_PROFILES;
        }
        saveBrandProfilesToStorage(profiles);
        setActiveBrandProfileId(profiles[0].id);
        renderBrandHubUI();
    }

    // ─── 跨模块表单双向数据同步 ────────────────────────────────────────────────

    function detectActiveModuleTab() {
        const tabs = ['analysis', 'generate', 'listing', 'ads'];
        for (const tab of tabs) {
            const viewEl = document.getElementById(`view-${tab}`);
            if (viewEl && !viewEl.classList.contains('hidden')) {
                return tab;
            }
        }
        return 'listing';
    }

    function applyProfileToModule(profileOrModule, maybeProfile) {
        let profile = profileOrModule;
        let targetModule = maybeProfile;
        if (typeof profileOrModule === 'string' && typeof maybeProfile === 'object') {
            profile = maybeProfile;
            targetModule = profileOrModule;
        }
        if (!profile) return;
        targetModule = targetModule || detectActiveModuleTab();

        if (targetModule === 'listing') {
            const nameEl = document.getElementById('listingName');
            const pointsEl = document.getElementById('listingPoints');
            const kwEl = document.getElementById('listingKeywords');
            const themeEl = document.getElementById('listingMarketingThemeSelect');

            if (nameEl) nameEl.value = profile.brandName ? `${profile.brandName} ${profile.name}` : profile.name;
            if (pointsEl) {
                const combinedPoints = [profile.differentiators, profile.painPoints ? `痛点针对: ${profile.painPoints}` : '']
                    .filter(Boolean).join('\n');
                pointsEl.value = combinedPoints;
            }
            if (kwEl) kwEl.value = profile.vocKeywords;
            if (themeEl && profile.tone) {
                const opt = Array.from(themeEl.options).find(o => o.value.toLowerCase() === profile.tone.toLowerCase());
                if (opt) themeEl.value = opt.value;
            }
            if (typeof showToast === 'function') showToast(`已将【${profile.name}】档案载入 Listing 编撰！`, 'success');
        } else if (targetModule === 'ads') {
            const nameEl = document.getElementById('adsProductNameInput') || document.getElementById('adProductName');
            const pointsEl = document.getElementById('adSellingPoints');
            const audienceEl = document.getElementById('adTargetAudience');
            const toneEl = document.getElementById('adsMarketingThemeSelect') || document.getElementById('adTone');

            if (nameEl) nameEl.value = profile.brandName ? `${profile.brandName} ${profile.name}` : profile.name;
            if (pointsEl) pointsEl.value = profile.differentiators;
            if (audienceEl) audienceEl.value = profile.icp;
            if (toneEl && profile.tone) {
                const opt = Array.from(toneEl.options).find(o => o.value.toLowerCase() === profile.tone.toLowerCase());
                if (opt) toneEl.value = opt.value;
            }
            if (typeof showToast === 'function') showToast(`已将【${profile.name}】档案载入广告文案！`, 'success');
        } else if (targetModule === 'generate' || targetModule === 'detail' || targetModule === 'details') {
            const nameEl = document.getElementById('productNameInput') || document.getElementById('detailProductName');
            const pointsEl = document.getElementById('sellingPointsText') || document.getElementById('detailSellingPoints');
            const factsEl = document.getElementById('productFactsText');

            if (nameEl) nameEl.value = profile.brandName ? `${profile.brandName} ${profile.name}` : profile.name;
            if (pointsEl) {
                const combined = [profile.differentiators, profile.painPoints ? `痛点针对: ${profile.painPoints}` : '']
                    .filter(Boolean).join('\n');
                pointsEl.value = combined;
            }
            if (factsEl && profile.vocKeywords) {
                factsEl.value = `关键词/规格: ${profile.vocKeywords}`;
            }
            if (profile.brandColor) {
                const setColor = typeof setDtcCustomBrandColor === 'function' ? setDtcCustomBrandColor : (typeof window !== 'undefined' ? window.setDtcCustomBrandColor : null);
                if (typeof setColor === 'function') {
                    try { setColor(profile.brandColor); } catch (_) {}
                }
            }
            if (profile.brandFont) {
                const applyTypo = typeof applyDtcTypographyConfig === 'function' ? applyDtcTypographyConfig : (typeof window !== 'undefined' ? window.applyDtcTypographyConfig : null);
                if (typeof applyTypo === 'function') {
                    try {
                        const currentTypo = (typeof window !== 'undefined' && typeof window.currentDtcTypography !== 'undefined') ? window.currentDtcTypography : {};
                        applyTypo({
                            ...currentTypo,
                            fontFamily: profile.brandFont,
                            titleFont: profile.brandFont
                        });
                    } catch (_) {}
                }
            }
            if (typeof showToast === 'function') showToast(`已将【${profile.name}】档案载入详情页！`, 'success');
        }
    }

    function extractFromAnalysisDraft() {
        if (typeof window !== 'undefined' && typeof window.xp_extractProfileFromAnalysis === 'function') {
            const draft = window.xp_extractProfileFromAnalysis();
            if (draft) return draft;
        }
        if (typeof showToast === 'function') {
            showToast('未检测到已生成的竞品分析结果，请先在竞品分析页面完成一次分析', 'error');
        }
        return null;
    }

    function extractCurrentModuleToProfileDraft(explicitModule) {
        const activeMod = explicitModule || detectActiveModuleTab();
        let draft = {
            name: '',
            brandName: '',
            category: '',
            icp: '',
            painPoints: '',
            differentiators: '',
            vocKeywords: '',
            tone: 'professional',
            competitorNotes: ''
        };

        if (activeMod === 'analysis') {
            if (typeof window !== 'undefined' && typeof window.xp_extractProfileFromAnalysis === 'function') {
                const analysisDraft = window.xp_extractProfileFromAnalysis();
                if (analysisDraft) return analysisDraft;
            }
        } else if (activeMod === 'listing') {
            draft.name = document.getElementById('listingName')?.value?.trim() || '';
            draft.differentiators = document.getElementById('listingPoints')?.value?.trim() || '';
            draft.vocKeywords = document.getElementById('listingKeywords')?.value?.trim() || '';
            draft.tone = document.getElementById('listingMarketingThemeSelect')?.value || 'professional';
        } else if (activeMod === 'ads') {
            draft.name = document.getElementById('adsProductNameInput')?.value?.trim() || document.getElementById('adProductName')?.value?.trim() || '';
            draft.differentiators = document.getElementById('adSellingPoints')?.value?.trim() || '';
            draft.icp = document.getElementById('adTargetAudience')?.value?.trim() || '';
            draft.tone = document.getElementById('adsMarketingThemeSelect')?.value || document.getElementById('adTone')?.value || 'professional';
        } else if (activeMod === 'generate') {
            draft.name = document.getElementById('productNameInput')?.value?.trim() || document.getElementById('detailProductName')?.value?.trim() || '';
            draft.differentiators = document.getElementById('sellingPointsText')?.value?.trim() || document.getElementById('detailSellingPoints')?.value?.trim() || '';
            draft.vocKeywords = document.getElementById('productFactsText')?.value?.trim() || '';
        }

        if (!draft.category && draft.name) {
            draft.category = inferCategoryFromText(`${draft.name} ${draft.differentiators || ''}`);
        }

        return draft;
    }

    function inferCategoryFromText(text = '') {
        if (typeof window !== 'undefined' && typeof window.xp_inferCategoryFromText === 'function') {
            const cat = window.xp_inferCategoryFromText(text);
            if (cat) return cat;
        }
        const s = String(text || '').toLowerCase();
        if (!s) return '';
        if (s.includes('chair') || s.includes('椅') || s.includes('desk') || s.includes('桌') || s.includes('腰') || s.includes('ergo') || s.includes('工学')) return '办公家具 / 人体工学';
        if (s.includes('tent') || s.includes('帐篷') || s.includes('camp') || s.includes('露营') || s.includes('outdoor') || s.includes('户外') || s.includes('hike') || s.includes('徒步') || s.includes('睡袋')) return '户外运动 / 露营装备';
        if (s.includes('earphone') || s.includes('earbud') || s.includes('headphone') || s.includes('耳机') || s.includes('speaker') || s.includes('音箱') || s.includes('audio') || s.includes('声卡') || s.includes('mic') || s.includes('麦克风')) return '3C数码 / 智能音频';
        if (s.includes('charger') || s.includes('充电') || s.includes('cable') || s.includes('power bank') || s.includes('电池') || s.includes('线缆') || s.includes('magnetic') || s.includes('磁吸')) return '3C数码 / 充电与配件';
        if (s.includes('sleep') || s.includes('睡眠') || s.includes('massag') || s.includes('按摩') || s.includes('earplug') || s.includes('耳塞') || s.includes('oral') || s.includes('牙刷') || s.includes('shaver') || s.includes('剃须')) return '个人护理 / 健康个护';
        if (s.includes('pet') || s.includes('宠物') || s.includes('cat') || s.includes('猫') || s.includes('dog') || s.includes('狗') || s.includes('leash') || s.includes('牵引') || s.includes('litter') || s.includes('猫砂')) return '宠物用品 / 萌宠生活';
        if (s.includes('pot') || s.includes('pan') || s.includes('锅') || s.includes('kitchen') || s.includes('厨房') || s.includes('cup') || s.includes('杯') || s.includes('bottle') || s.includes('水壶') || s.includes('knife') || s.includes('刀') || s.includes('cookware') || s.includes('炊具')) return '家居生活 / 厨房餐具';
        if (s.includes('storage') || s.includes('收纳') || s.includes('organizer') || s.includes('clean') || s.includes('清洁') || s.includes('lamp') || s.includes('灯') || s.includes('towel') || s.includes('毛巾') || s.includes('vacuum') || s.includes('吸尘')) return '家居日用 / 居家生活';
        if (s.includes('toy') || s.includes('玩具') || s.includes('baby') || s.includes('母婴') || s.includes('child') || s.includes('儿童') || s.includes('stroller') || s.includes('推车') || s.includes('puzzle') || s.includes('积木')) return '母婴玩具 / 儿童成长';
        if (s.includes('bag') || s.includes('包') || s.includes('backpack') || s.includes('背包') || s.includes('wallet') || s.includes('钱包') || s.includes('luggage') || s.includes('行李箱')) return '箱包皮具 / 出行箱包';
        if (s.includes('shoe') || s.includes('鞋') || s.includes('shirt') || s.includes('衣服') || s.includes('jacket') || s.includes('夹克') || s.includes('dress') || s.includes('裙') || s.includes('pants') || s.includes('裤')) return '服饰鞋履 / 时尚穿搭';
        if (s.includes('beauty') || s.includes('美妆') || s.includes('skin') || s.includes('护肤') || s.includes('serum') || s.includes('精华') || s.includes('cream') || s.includes('面霜') || s.includes('lotion') || s.includes('乳液')) return '美妆护肤 / 个人美妆';
        if (s.includes('car') || s.includes('车载') || s.includes('dash cam') || s.includes('行车记录') || s.includes('auto') || s.includes('汽车')) return '汽车用品 / 车载周边';
        return '';
    }

    async function aiInferCategoryFromModal() {
        const nameEl = document.getElementById('brandHubName');
        const diffEl = document.getElementById('brandHubDifferentiators');
        const painEl = document.getElementById('brandHubPainPoints');
        const catEl = document.getElementById('brandHubCategory');
        const btnEl = document.getElementById('btnBrandHubAiInferCat');

        const name = nameEl?.value?.trim() || '';
        const diff = diffEl?.value?.trim() || '';
        const pain = painEl?.value?.trim() || '';

        if (!name && !diff) {
            if (typeof showToast === 'function') showToast('请先输入商品名称或核心卖点', 'info');
            nameEl?.focus();
            return;
        }

        const origBtnHtml = btnEl ? btnEl.innerHTML : '';
        if (btnEl) {
            btnEl.disabled = true;
            btnEl.innerHTML = '<i class="ph-bold ph-spinner animate-spin"></i> <span>识别中...</span>';
        }

        try {
            if (typeof callAI === 'function') {
                const prompt = `你是一名资深跨境电商类目与选品专家。请根据以下商品信息，推断并输出其最规范的标准跨境电商分类（格式为：一级大类 / 二级细分类目），例如："办公家具 / 人体工学椅"、"户外运动 / 露营装备"、"3C数码 / 智能音频"、"家居生活 / 厨房餐具"等。

商品名称：${name}
核心卖点：${diff}
用户痛点：${pain}

要求：严格只输出类目名称，不要任何多余文字、标点、解释或引号，字数控制在 15 字以内。`;
                const payload = {
                    prompt,
                    contents: [{ role: 'user', parts: [{ text: prompt }] }]
                };
                const res = await callAI('text', payload);
                const rawText = res?.candidates?.[0]?.content?.parts?.[0]?.text || res?.text || '';
                const recognized = rawText.trim().replace(/^["'`]|["'`]$/g, '').replace(/^[#*\-—\s]+/, '');
                if (recognized && catEl) {
                    catEl.value = recognized;
                    if (typeof showToast === 'function') showToast(`AI 识别商品类目成功：【${recognized}】`, 'success');
                    return;
                }
            }
            // 本地启发式智能推断降级
            const localCat = inferCategoryFromText(`${name} ${diff} ${pain}`);
            if (localCat && catEl) {
                catEl.value = localCat;
                if (typeof showToast === 'function') showToast(`已识别商品类目：【${localCat}】`, 'success');
            } else if (catEl) {
                catEl.value = '通用商品 / 跨境精选';
                if (typeof showToast === 'function') showToast('已填入通用商品类目', 'info');
            }
        } catch (e) {
            console.warn('AI infer category failed, fallback to local heuristic:', e);
            const localCat = inferCategoryFromText(`${name} ${diff}`);
            if (localCat && catEl) {
                catEl.value = localCat;
                if (typeof showToast === 'function') showToast(`已自动匹配类目：【${localCat}】`, 'success');
            }
        } finally {
            if (btnEl) {
                btnEl.disabled = false;
                btnEl.innerHTML = origBtnHtml;
            }
        }
    }

    // ─── 模态框与 UI 交互 ──────────────────────────────────────────────────────

    function openBrandHubModal(initialDraft = null) {
        const modal = document.getElementById('brandContextModal');
        if (!modal) return;
        modal.classList.remove('hidden');
        modal.classList.add('flex');

        if (initialDraft && initialDraft.name && !initialDraft.category) {
            initialDraft.category = inferCategoryFromText(`${initialDraft.name} ${initialDraft.differentiators || ''}`);
        }

        renderBrandHubUI(initialDraft);
    }

    function closeBrandHubModal() {
        const modal = document.getElementById('brandContextModal');
        if (!modal) return;
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }

    function renderBrandHubUI(draftData = null) {
        const profiles = getBrandProfiles();
        const activeId = draftData?.id || getActiveBrandProfileId();
        const profileToEdit = draftData || profiles.find(p => p.id === activeId) || profiles[0] || {};

        const listContainer = document.getElementById('brandHubProfileList');
        if (listContainer) {
            listContainer.innerHTML = profiles.map(p => {
                const isActive = p.id === profileToEdit.id;
                return `
                    <div class="p-3 rounded-xl cursor-pointer transition-all border ${isActive ? 'bg-indigo-50/80 border-indigo-300 text-indigo-950 font-bold shadow-2xs' : 'bg-white border-gray-200/80 text-gray-700 hover:border-indigo-200 hover:bg-slate-50'}" onclick="window.brandContextHub.selectProfile('${p.id}')">
                        <div class="flex items-center justify-between text-xs mb-1">
                            <span class="truncate max-w-[140px]">${p.brandName ? `<span class="opacity-75 font-normal">[${p.brandName}]</span> ` : ''}${p.name}</span>
                            ${isActive ? '<span class="w-2 h-2 rounded-full bg-indigo-600"></span>' : ''}
                        </div>
                        <div class="text-[11px] text-gray-400 font-normal truncate">${p.category || '通用商品'} · ${new Date(p.updatedAt || Date.now()).toLocaleDateString()}</div>
                    </div>`;
            }).join('');
        }

        // 填充表单
        const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.value = val || '';
        };

        setVal('brandHubId', profileToEdit.id || '');
        setVal('brandHubName', profileToEdit.name || '');
        setVal('brandHubBrandName', profileToEdit.brandName || '');
        setVal('brandHubCategory', profileToEdit.category || '');
        setVal('brandHubIcp', profileToEdit.icp || '');
        setVal('brandHubPainPoints', profileToEdit.painPoints || '');
        setVal('brandHubDifferentiators', profileToEdit.differentiators || '');
        setVal('brandHubVocKeywords', profileToEdit.vocKeywords || '');
        setVal('brandHubCompetitorNotes', profileToEdit.competitorNotes || '');
        setVal('brandHubTone', profileToEdit.tone || 'professional');
    }

    function handleSaveCurrentProfileFromModal() {
        const getVal = (id) => document.getElementById(id)?.value?.trim() || '';
        const name = getVal('brandHubName');
        if (!name) {
            if (typeof showToast === 'function') showToast('请填写商品或项目名称', 'error');
            return;
        }

        const data = {
            id: getVal('brandHubId'),
            name,
            brandName: getVal('brandHubBrandName'),
            category: getVal('brandHubCategory'),
            icp: getVal('brandHubIcp'),
            painPoints: getVal('brandHubPainPoints'),
            differentiators: getVal('brandHubDifferentiators'),
            vocKeywords: getVal('brandHubVocKeywords'),
            competitorNotes: getVal('brandHubCompetitorNotes'),
            tone: document.getElementById('brandHubTone')?.value || 'professional'
        };

        const saved = saveOrUpdateProfile(data);
        if (typeof showToast === 'function') showToast(`商品档案【${saved.name}】已成功保存！`, 'success');
        renderBrandHubUI();
    }

    function handleNewProfile() {
        const draft = {
            id: '',
            name: '新商品营销档案',
            brandName: '',
            category: '',
            icp: '',
            painPoints: '',
            differentiators: '',
            vocKeywords: '',
            tone: 'professional',
            competitorNotes: ''
        };
        renderBrandHubUI(draft);
    }

    function handleDeleteProfile() {
        const id = document.getElementById('brandHubId')?.value;
        if (!id) return;
        if (confirm('确定要删除此商品营销档案吗？')) {
            deleteBrandProfileById(id);
            if (typeof showToast === 'function') showToast('档案已删除', 'info');
        }
    }

    function handleApplyProfileFromModal() {
        const profile = getActiveBrandProfile();
        if (!profile) return;
        applyProfileToModule(profile);
        closeBrandHubModal();
    }

    // ─── 顶部/面板内快捷下拉组件渲染 ──────────────────────────────────────────

    function updateInlineBrandProfileSelectors() {
        if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
        const selectors = document.querySelectorAll('.brand-profile-quick-select');
        if (!selectors || !selectors.length) return;

        const profiles = getBrandProfiles();
        const activeId = getActiveBrandProfileId();

        selectors.forEach(sel => {
            sel.innerHTML = `
                <option value="" disabled selected>⚡ 载入营销画像档案 ▾</option>
                ${profiles.map(p => `<option value="${p.id}" ${p.id === activeId ? 'data-active="true"' : ''}>${p.brandName ? `[${p.brandName}] ` : ''}${p.name}</option>`).join('')}
                <option value="__open_hub__">⚙️ 管理/新建档案库...</option>
            `;

            if (!sel.dataset.listenerBound) {
                sel.addEventListener('change', (e) => {
                    const val = e.target.value;
                    if (val === '__open_hub__') {
                        openBrandHubModal();
                        e.target.value = '';
                        return;
                    }
                    const selected = profiles.find(p => p.id === val);
                    if (selected) {
                        setActiveBrandProfileId(val);
                        const moduleTarget = sel.dataset.moduleTarget || detectActiveModuleTab();
                        applyProfileToModule(selected, moduleTarget);
                    }
                    e.target.value = '';
                });
                sel.dataset.listenerBound = 'true';
            }
        });
    }

    function exportProfilesToJson() {
        const profiles = getBrandProfiles();
        const blob = new Blob([JSON.stringify(profiles, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `Brand_Profiles_Export_${Date.now()}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    function importProfilesFromJson() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const parsed = JSON.parse(event.target.result);
                    if (!Array.isArray(parsed)) throw new Error('Format must be an array of profiles');
                    saveBrandProfilesToStorage(parsed);
                    if (parsed[0]?.id) setActiveBrandProfileId(parsed[0].id);
                    renderBrandHubUI();
                    if (typeof showToast === 'function') showToast(`成功导入 ${parsed.length} 条营销档案！`, 'success');
                } catch (err) {
                    if (typeof showToast === 'function') showToast('导入失败：JSON 格式不正确', 'error');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    // ─── 工业级品牌视觉规则与光影映射 (Prompt-as-Code) ──────────────────────────

    /**
     * 根据当前激活（或传入）的品牌档案提取工业级视觉指示与红线规则（Prompt-as-Code）
     * 参考 awesome-gpt-image-2 的 tpl-brand / tpl-product 体系
     */
    function getVisualBrandDirectives(customProfile = null) {
        const profile = customProfile || getActiveBrandProfile();
        if (!profile) return '';

        const tone = (profile.tone || 'professional').toLowerCase();
        const brandName = profile.brandName ? `Brand: ${profile.brandName}` : '';
        const category = profile.category ? `Category: ${profile.category}` : '';

        // 1. 光影与场景调性映射
        let lightingMood = 'Balanced commercial studio softbox lighting with directional fill and natural contact shadows.';
        let colorGuidance = 'Clean neutral studio tones, subtle background contrast, no color bleeding onto the product.';

        if (tone.includes('luxury') || tone.includes('高端') || tone.includes('奢华') || tone.includes('black_gold')) {
            lightingMood = 'Sophisticated directional chiaroscuro lighting, subtle rim light highlighting refined edges, restrained reflections.';
            colorGuidance = 'Deep subtle tones (slate, subtle charcoal, warm champagne accents), rich texture contrast, restrained elegance.';
        } else if (tone.includes('tech') || tone.includes('科技') || tone.includes('cyber')) {
            lightingMood = 'Crisp daylight studio lighting, clean rim light separating product silhouettes, high-precision neutral gradients.';
            colorGuidance = 'Futuristic clean aesthetic, metallic and polymer contrast, cool neutral background with minimal subtle neon accents.';
        } else if (tone.includes('natural') || tone.includes('自然') || tone.includes('warm') || tone.includes('cozy') || tone.includes('organic')) {
            lightingMood = 'Soft diffused warm natural daylight, organic ambient illumination, gentle soft-edged shadows.';
            colorGuidance = 'Earthy tones, warm off-white, light wood and organic textures, welcoming lifestyle feel.';
        } else if (tone.includes('energetic') || tone.includes('playful') || tone.includes('viral') || tone.includes('tiktok') || tone.includes('bold')) {
            lightingMood = 'Bright, punchy high-key lighting, vibrant dynamic contrast, sharp crisp details.';
            colorGuidance = 'Energetic contemporary palette, eye-catching focal points, clean punchy backdrop.';
        }

        const lines = [
            brandName,
            category,
            `- Lighting Mood: ${lightingMood}`,
            `- Color Discipline: ${colorGuidance}`,
            `- Brand Invariants: 1) Product geometry and materials must be 100% faithful to uploaded reference; 2) The hero product commands 50%-70% of visual focus; 3) Zero exaggerated claims or decorative clutter.`
        ].filter(Boolean);

        return lines.join('\n');
    }

    // ─── 挂载全局接口 ──────────────────────────────────────────────────────────

    const api = {
        getProfiles: getBrandProfiles,
        getActiveProfile: getActiveBrandProfile,
        getVisualBrandDirectives: getVisualBrandDirectives,
        selectProfile: (id) => {
            setActiveBrandProfileId(id);
            renderBrandHubUI();
        },
        saveProfile: saveOrUpdateProfile,
        deleteProfile: deleteBrandProfileById,
        applyProfile: applyProfileToModule,
        open: openBrandHubModal,
        close: closeBrandHubModal,
        openWithDraft: (draft) => {
            openBrandHubModal(draft);
        },
        saveFromModal: handleSaveCurrentProfileFromModal,
        newProfile: handleNewProfile,
        deleteFromModal: handleDeleteProfile,
        applyFromModal: handleApplyProfileFromModal,
        exportJson: exportProfilesToJson,
        importJson: importProfilesFromJson,
        extractFromCurrentModule: extractCurrentModuleToProfileDraft,
        extractCurrentModuleToProfileDraft: extractCurrentModuleToProfileDraft,
        extractFromAnalysis: extractFromAnalysisDraft,
        aiInferCategory: aiInferCategoryFromModal,
        inferCategoryQuick: inferCategoryFromText,
        initSelectors: updateInlineBrandProfileSelectors,
        syncFromBackend: syncBrandProfilesFromBackend
    };

    if (typeof window !== 'undefined') {
        window.brandContextHub = api;
    }
    if (typeof globalThis !== 'undefined') {
        globalThis.brandContextHub = api;
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                updateInlineBrandProfileSelectors();
                syncBrandProfilesFromBackend();
            });
        } else {
            updateInlineBrandProfileSelectors();
            syncBrandProfilesFromBackend();
        }
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            getBrandProfiles,
            saveOrUpdateProfile,
            deleteBrandProfileById,
            getActiveBrandProfile,
            getVisualBrandDirectives,
            applyProfileToModule,
            extractCurrentModuleToProfileDraft,
            extractFromAnalysisDraft,
            inferCategoryFromText,
            aiInferCategoryFromModal,
            exportProfilesToJson,
            importProfilesFromJson,
            saveBrandProfilesToStorage,
            syncBrandProfilesToBackend,
            syncBrandProfilesFromBackend,
            DEFAULT_PROFILES
        };
    }
})();
