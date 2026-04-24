async function aiFillListingInputs() {
    if (!currentListingUploadedBase64) {
        showToast('请先上传产品参考图，AI 才能进行视觉解析', 'error'); return;
    }
    const btn = document.getElementById('aiListingExtractBtn');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="loader w-3 h-3 border-2 border-indigo-500 border-t-transparent mr-1"></span> 提取中...';
    btn.disabled = true;

    const prompt = `你是一个专业的电商选品与视觉分析专家。

请基于输入图片，识别产品并提取关键信息。

任务要求：
1. 提取产品名称（简洁、通用，不要品牌词）
2. 提取3-4个核心卖点（每条简短，适合用于电商图片文案）
3. 卖点必须强调“用户价值”，避免空话（如：high quality、best等）

输出要求（必须严格遵守）：
- 仅返回JSON
- 不要任何解释或多余文本
- 字段必须完整

JSON格式如下：
{
  "name": "产品名称",
  "points": "卖点1\\n卖点2\\n卖点3\\n卖点4"
}`;

    try {
        const mimeType = currentListingUploadedBase64.split(';')[0].split(':')[1];
        const base64Data = currentListingUploadedBase64.split(',')[1];
        const payload = {
            contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: base64Data } }] }],
            generationConfig: { responseMimeType: "application/json" }
        };
        const res = await callAI(TEXT_MODEL, payload);
        const text = res.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
            const data = JSON.parse(text);
            document.getElementById('listingName').value = data.name || '';
            document.getElementById('listingPoints').value = data.points || '';
            showToast('产品特征视觉提取成功', 'success');
        }
    } catch (err) { showToast('智能提取失败，请重试', 'error'); }
    finally { btn.innerHTML = origHtml; btn.disabled = false; }
}

function renderListingData(data) {
    document.getElementById('listingEmpty').classList.add('hidden');
    const resArea = document.getElementById('listingResults');
    resArea.classList.remove('hidden'); resArea.classList.add('flex');
    document.getElementById('btnRiskCheck').classList.remove('hidden');

    const getVal = (obj) => {
        if (typeof obj === 'string') return { target: obj, zh: '' };
        return { target: obj?.target || obj?.English || '', zh: obj?.zh || obj?.Chinese || '' };
    };

    // 渲染常规区块
    const tData = getVal(data.title);
    document.getElementById('resListingTitle').innerHTML = `<div class="target-text text-gray-800 text-lg mb-2">${tData.target}</div> <div class="zh-text text-sm text-gray-400 pt-2 border-t border-gray-100 font-normal">${tData.zh}</div>`;

    const dData = getVal(data.description);
    document.getElementById('resListingDesc').innerHTML = `<div class="target-text text-gray-700 whitespace-pre-wrap">${dData.target}</div> <div class="zh-text text-sm text-gray-400 mt-4 pt-4 border-t border-gray-100 whitespace-pre-wrap">${dData.zh}</div>`;

    const makeBulletLi = arr => (arr || []).map(b => {
        const v = getVal(b);
        return `<li class="mb-4 bg-gray-50/80 p-3.5 rounded-xl border border-gray-100"><div class="target-text font-bold text-gray-700 text-sm">${v.target}</div><div class="zh-text text-xs text-gray-400 mt-2 border-t border-gray-200/60 pt-2">${v.zh}</div></li>`;
    }).join('');
    document.getElementById('resListingBullets').innerHTML = makeBulletLi(data.bullets);

    const makeKwLi = arr => (arr || []).map(k => {
        const v = getVal(k);
        return `<li><span class="target-text">${v.target}</span> <span class="text-gray-400 text-[10px] ml-1">(<span class="zh-text">${v.zh}</span>)</span></li>`;
    }).join('');

    const k = data.keywords || {};
    document.getElementById('resKwCore').innerHTML = makeKwLi(k.core);
    document.getElementById('resKwTail').innerHTML = makeKwLi(k.longTail || k.long_tail);
    document.getElementById('resKwAds').innerHTML = makeKwLi(k.ads || k.ppc);

    // 渲染 QA
    const makeQALi = arr => (arr || []).map(item => {
        const q = getVal(item.q);
        const a = getVal(item.a);
        return `<div class="bg-indigo-50/50 p-4 rounded-xl border border-indigo-50 shadow-sm">
            <div class="mb-2"><span class="font-bold text-indigo-700 mr-2">Q:</span><span class="text-gray-800 font-medium target-text text-sm">${q.target}</span><div class="text-xs text-gray-400 mt-1 ml-6 zh-text">${q.zh}</div></div>
            <div><span class="font-bold text-emerald-600 mr-2">A:</span><span class="text-gray-600 target-text text-sm">${a.target}</span><div class="text-xs text-gray-400 mt-1 ml-6 zh-text">${a.zh}</div></div>
        </div>`;
    }).join('');
    document.getElementById('resListingQA').innerHTML = makeQALi(data.qa);

    // 渲染社媒
    const sData = getVal(data.socialMedia || data.social_script || data.social);
    document.getElementById('resListingSocial').innerHTML = `<div class="target-text text-gray-700 whitespace-pre-wrap">${sData.target}</div> <div class="zh-text text-sm text-gray-400 mt-4 pt-4 border-t border-gray-200 whitespace-pre-wrap">${sData.zh}</div>`;
}

async function generateListing() {
    const name = document.getElementById('listingName').value.trim();
    const points = document.getElementById('listingPoints').value.trim();
    const keywords = document.getElementById('listingKeywords').value.trim();

    const styleOpt = document.getElementById('listingStyleSelect');
    const style = styleOpt.options[styleOpt.selectedIndex].text;

    const regionOpt = document.getElementById('listingRegionSelect');
    const region = regionOpt.options[regionOpt.selectedIndex].value;
    
    const MARKET_TONE_MAP = {
        "North America": "American English, Direct, Benefit-focused, slightly energetic.",
        "Europe": "Professional, Polished, Fact-oriented, clear value proposition.",
        "Japan": "Extremely Polite (Keigo-style hints), Detail-obsessed, Sincere, trustworthy.",
        "Global Market": "Standard International English, Clear, universally understood."
    };
    const toneOfVoice = MARKET_TONE_MAP[region] || MARKET_TONE_MAP["Global Market"];

    const themeOpt = document.getElementById('listingMarketingThemeSelect');
    const themeVal = themeOpt.value;
    const themeLabel = themeOpt.options[themeOpt.selectedIndex].text;
    const themePrompt = themeVal !== 'none' ? `\n【附加营销指令】当前处于"${themeLabel}"营销节点，请在文案(尤其是标题和首要卖点中)巧妙融入相应的节日送礼、促销紧迫感或场景联想。` : '';

    if (!name || !points) { showToast('请填写必填项：产品名称与核心卖点', 'error'); return; }

    const btn = document.getElementById('btnGenerateListing');
    const origBtnHtml = btn.innerHTML;
    btn.innerHTML = `<span class="loader w-4 h-4 mr-2 border-2 border-white border-t-transparent"></span> 语境适配演算中...`;
    btn.disabled = true;

    const prompt = `你是一个资深跨境电商运营与超本地化营销专家。请根据以下信息撰写高转化率的商品Listing：
产品名称: ${name}
卖点/特色: ${points}
长尾参考关键词: ${keywords || '无特定限制'}
目标平台规则与调性: ${style}
【核心指令】目标市场与本土化语境(Tone of Voice): ${toneOfVoice} - 绝对遵守此语境偏好调整用词风格。${themePrompt}

输出要求：
1. 必须完全贴合选择的平台调性与市场文化。
2. 必须提供【目标语言】与【中文】的双语对照。
3. 包含所有规定的JSON字段，不要遗漏。

请严格返回如下 JSON 格式字符串，绝对不要输出 Markdown 代码块，直接返回纯净 JSON 数据：
{
  "title": {"target": "外文标题", "zh": "中文标题"},
  "bullets": [
    {"target": "卖点1外文", "zh": "卖点1中文"},
    {"target": "卖点2外文", "zh": "卖点2中文"},
    {"target": "卖点3外文", "zh": "卖点3中文"},
    {"target": "卖点4外文", "zh": "卖点4中文"},
    {"target": "卖点5外文", "zh": "卖点5中文"}
  ],
  "description": {"target": "长段落描述（可包含换行符\\n）", "zh": "对应的中文段落"},
  "keywords": {
    "core": [{"target": "核心词1", "zh": "中文"}, {"target": "核心词2", "zh": "中文"}],
    "longTail": [{"target": "长尾词1", "zh": "中文"}, {"target": "长尾词2", "zh": "中文"}],
    "ads": [{"target": "PPC词1", "zh": "中文"}, {"target": "PPC词2", "zh": "中文"}]
  },
  "qa": [
    {"q": {"target": "Q1外文", "zh": "Q1中文"}, "a": {"target": "A1外文", "zh": "A1中文"}},
    {"q": {"target": "Q2外文", "zh": "Q2中文"}, "a": {"target": "A2外文", "zh": "A2中文"}}
  ],
  "socialMedia": {"target": "种草脚本外文", "zh": "种草脚本中文"}
}`;

    try {
        const res = await callAI(TEXT_MODEL, {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        });

        const text = res.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error("AI 返回内容为空");

        const data = JSON.parse(text);
        currentListingDataText = data;
        renderListingData(data);

        saveToHistory('listing', {
            name: name,
            platform: style,
            result: data
        });

    } catch (err) {
        console.error(err);
        showToast('Listing 生成失败: ' + err.message, 'error');
    } finally {
        btn.innerHTML = origBtnHtml;
        btn.disabled = false;
    }
}

async function checkListingCompliance() {
    if (!currentListingDataText) return;
    const btn = document.getElementById('btnRiskCheck');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="loader w-3 h-3 border-2 border-red-500 border-t-transparent mr-1"></span> 审查中...';
    btn.disabled = true;

    try {
        const prompt = `你是一个专业的电商合规专家。请对以下 Listing 内容进行风险审查：
        ${JSON.stringify(currentListingDataText)}
        请指出潜在的品牌侵权、虚假宣传、平台禁词风险，并给出修改建议。输出为中文。`;

        const res = await callAI(TEXT_MODEL, { contents: [{ role: "user", parts: [{ text: prompt }] }] });
        const text = res.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
            document.getElementById('riskCheckContent').innerHTML = text.replace(/\n/g, '<br>');
            document.getElementById('riskCheckModal').classList.remove('hidden');
        }
    } catch (e) {
        showToast('审查失败', 'error');
    } finally {
        btn.innerHTML = origHtml;
        btn.disabled = false;
    }
}

function closeRiskCheckModal() {
    document.getElementById('riskCheckModal').classList.add('hidden');
}

function handleListingImageUpload(event) {
    const file = event.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = e => {
            currentListingUploadedBase64 = e.target.result;
            document.getElementById('listingUploadedImagePreview').src = currentListingUploadedBase64;
            document.getElementById('listingImagePreviewContainer').classList.remove('hidden');
        }
        reader.readAsDataURL(file);
    }
}

function removeListingImage() {
    currentListingUploadedBase64 = null;
    document.getElementById('listingImageUpload').value = '';
    document.getElementById('listingImagePreviewContainer').classList.add('hidden');
}
