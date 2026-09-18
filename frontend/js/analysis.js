/**
 * 竞品分析模块 - 嵌入模式
 * 所有变量和函数使用 XP_ 前缀命名空间，避免与主程序冲突
 */
(function () {
    'use strict';

    // ─── 常量 ────────────────────────────────────────────────────────────────
    const XP_API_URL = typeof API_BASE !== 'undefined' ? `${API_BASE}/compare` : 'http://localhost:9503/compare';
    const XP_STORAGE_KEY = 'xuanpin_last_result_v27';
    const XP_STORAGE_URLS_KEY = 'xuanpin_last_urls_v27';
    const XP_MAX_URLS = 5;

    // ─── 状态 ────────────────────────────────────────────────────────────────
    let xp_urlsArray = [];
    let xp_currentLang = 'zh';
    let xp_currentMode = 'deep';
    let xp_currentResponse = null;
    let xp_winnerIndex = -1;
    let xp_currentSingleData = null;
    let xp_currentScoreObj = null;
    let xp_matrixCurrentProducts = [];
    let xp_currentMatrixSelectedProductIdx = 0;

    // ─── DOM 引用 ─────────────────────────────────────────────────────────────
    function xp_getEl(id) { return document.getElementById(id); }

    // ─── 初始化入口（标签页激活时调用）────────────────────────────────────────
    window.xp_init = function () {
        if (window._xp_is_init) return; // 防止重复初始化导致事件堆叠
        window._xp_is_init = true;

        const urlsInputContainer = xp_getEl('xp-urlsInputContainer');
        const urlInputField = xp_getEl('xp-urlInputField');
        const tagsList = xp_getEl('xp-tagsList');
        const urlCounter = xp_getEl('xp-urlCounter');
        const analyzeBtn = xp_getEl('xp-analyzeBtn');
        const errorMsg = xp_getEl('xp-errorMsg');
        const loadingSection = xp_getEl('xp-loadingSection');
        const resultSection = xp_getEl('xp-resultSection');
        const langToggle = xp_getEl('xp-langToggle');
        const exportBtn = xp_getEl('xp-exportBtn');
        const appTitle = xp_getEl('xp-appTitle');
        const copyAllBtn = xp_getEl('xp-copyAllBtn');
        const clearAllBtn = xp_getEl('xp-clearAllBtn');

        if (!analyzeBtn) return; // 防止重复初始化

        // 标题不绑定破坏性重置，防止误触导致数据清空

        // 复制所有链接
        copyAllBtn.addEventListener('click', () => {
            if (xp_urlsArray.length === 0) return;
            navigator.clipboard.writeText(xp_urlsArray.join('\n')).then(() => {
                copyAllBtn.classList.add('xp-success');
                setTimeout(() => {
                    copyAllBtn.classList.remove('xp-success');
                }, 1400);
            });
        });

        // 清空所有链接并重置当前分析结果（恢复干净状态）
        clearAllBtn.addEventListener('click', () => {
            xp_resetAnalysisSession();
        });

        // 语言切换
        langToggle.addEventListener('click', () => {
            xp_currentLang = xp_currentLang === 'zh' ? 'en' : 'zh';
            langToggle.innerHTML = xp_currentLang === 'zh' ? '🌐 English' : '🌐 中文';
            xp_updateStaticI18n();
            if (xp_currentResponse) xp_renderResults(xp_currentResponse);
        });

        // 模式切换 (极速快照 vs 深度解构)
        const modeQuickBtn = xp_getEl('xp-modeQuick');
        const modeDeepBtn = xp_getEl('xp-modeDeep');
        const modeRowQuick = xp_getEl('xp-modeRowQuick');
        const modeRowDeep = xp_getEl('xp-modeRowDeep');

        function setAnalysisMode(mode) {
            xp_currentMode = mode;
            if (mode === 'quick') {
                modeQuickBtn?.classList.add('active');
                modeDeepBtn?.classList.remove('active');
                modeRowQuick?.classList.add('active');
                modeRowDeep?.classList.remove('active');
            } else {
                xp_currentMode = 'deep';
                modeDeepBtn?.classList.add('active');
                modeQuickBtn?.classList.remove('active');
                modeRowDeep?.classList.add('active');
                modeRowQuick?.classList.remove('active');
            }
        }

        if (modeQuickBtn && modeDeepBtn) {
            modeQuickBtn.addEventListener('click', () => setAnalysisMode('quick'));
            modeDeepBtn.addEventListener('click', () => setAnalysisMode('deep'));
        }
        if (modeRowQuick && modeRowDeep) {
            modeRowQuick.addEventListener('click', () => setAnalysisMode('quick'));
            modeRowDeep.addEventListener('click', () => setAnalysisMode('deep'));
        }

        // URL输入容器点击
        urlsInputContainer.addEventListener('click', () => urlInputField.focus());

        // 键盘输入
        urlInputField.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                xp_addUrlTag(urlInputField.value, tagsList, urlInputField, urlCounter);
                urlInputField.value = '';
            } else if (e.key === 'Backspace' && urlInputField.value === '' && xp_urlsArray.length > 0) {
                xp_urlsArray.pop();
                const prevTag = urlInputField.previousElementSibling;
                if (prevTag && prevTag.classList.contains('xp-url-tag')) tagsList.removeChild(prevTag);
                xp_updateCounter(urlCounter, urlInputField);
            }
        });

        // 批量粘贴
        urlInputField.addEventListener('paste', (e) => {
            e.preventDefault();
            const pasteData = (e.clipboardData || window.clipboardData).getData('text');
            const urls = pasteData.split(/[\n\r\s,]+/).map(u => u.trim()).filter(u => u);
            urls.forEach(url => xp_addUrlTag(url, tagsList, urlInputField, urlCounter));
        });

        // 分析按钮
        analyzeBtn.addEventListener('click', () => xp_handleAnalyze(analyzeBtn, urlInputField, tagsList, urlCounter, errorMsg, loadingSection, resultSection));

        // 导出按钮
        exportBtn.addEventListener('click', function () {
            if (!xp_currentResponse) {
                alert('没有可导出的报告内容');
                return;
            }
            if (this.disabled) return;
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '_');
            const filename = `AI竞品分析报告_${timestamp}.html`;
            const originalHtml = this.innerHTML;
            this.disabled = true;
            this.textContent = '⏳ 正在导出...';
            setTimeout(() => {
                try {
                    const fullHtml = xp_generateWhitePaperReport(xp_currentResponse);
                    const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    a.style.display = 'none';
                    document.body.appendChild(a);
                    a.click();
                    setTimeout(() => {
                        document.body.removeChild(a);
                        URL.revokeObjectURL(url);
                        exportBtn.disabled = false;
                        exportBtn.innerHTML = originalHtml;
                    }, 100);
                } catch (err) {
                    console.error('Export Error:', err);
                    alert('导出失败: ' + err.message);
                    exportBtn.disabled = false;
                    exportBtn.innerHTML = originalHtml;
                }
            }, 50);
        });

        // 跨模块流转与速览复制按钮 (P0)
        const btnTransferBrandProfile = xp_getEl('xp-btnTransferBrandProfile');
        if (btnTransferBrandProfile) {
            btnTransferBrandProfile.addEventListener('click', () => xp_transferToBrandProfile());
        }
        const quickSaveBrandHubBtn = xp_getEl('xp-quickSaveBrandHubBtn');
        if (quickSaveBrandHubBtn) {
            quickSaveBrandHubBtn.addEventListener('click', () => xp_transferToBrandProfile());
        }
        const btnTransferDetails = xp_getEl('xp-btnTransferDetails');
        if (btnTransferDetails) {
            btnTransferDetails.addEventListener('click', () => xp_transferToDetails());
        }
        const btnTransferListing = xp_getEl('xp-btnTransferListing');
        if (btnTransferListing) {
            btnTransferListing.addEventListener('click', () => xp_transferToListing());
        }
        const btnTransferAds = xp_getEl('xp-btnTransferAds');
        if (btnTransferAds) {
            btnTransferAds.addEventListener('click', () => xp_transferToAds());
        }
        const btnCopyTldr = xp_getEl('xp-btnCopyTldr');
        if (btnCopyTldr) {
            btnCopyTldr.addEventListener('click', () => xp_copyTldrSummary());
        }
        const btnMatrixTransferBrandProfile = xp_getEl('xp-btnMatrixTransferBrandProfile');
        if (btnMatrixTransferBrandProfile) {
            btnMatrixTransferBrandProfile.addEventListener('click', () => xp_transferToBrandProfile());
        }
        const btnMatrixTransferDetails = xp_getEl('xp-btnMatrixTransferDetails');
        if (btnMatrixTransferDetails) {
            btnMatrixTransferDetails.addEventListener('click', () => xp_transferMatrixToDetails());
        }
        const btnMatrixTransferListing = xp_getEl('xp-btnMatrixTransferListing');
        if (btnMatrixTransferListing) {
            btnMatrixTransferListing.addEventListener('click', () => xp_transferMatrixToListing());
        }
        const btnMatrixTransferAds = xp_getEl('xp-btnMatrixTransferAds');
        if (btnMatrixTransferAds) {
            btnMatrixTransferAds.addEventListener('click', () => xp_transferMatrixToAds());
        }

        // 恢复会话
        xp_restoreSession();
    };

    // ─── 工具函数 ─────────────────────────────────────────────────────────────
    function xp_updateCounter(urlCounter, urlInputField) {
        const count = xp_urlsArray.length;
        urlCounter.textContent = `已添加 ${count}/${XP_MAX_URLS} 个竞品链接`;
        if (count >= XP_MAX_URLS) {
            urlCounter.classList.add('xp-at-limit');
            if (urlInputField) {
                urlInputField.disabled = true;
                urlInputField.placeholder = '已达最多 5 个链接上限';
            }
        } else {
            urlCounter.classList.remove('xp-at-limit');
            if (urlInputField) {
                urlInputField.disabled = false;
                urlInputField.placeholder = '输入URL回车添加，支持批量粘贴';
            }
        }
    }

    function xp_clearAllUrls(tagsList, urlInputField, urlCounter) {
        xp_urlsArray = [];
        if (urlInputField) urlInputField.value = '';
        if (tagsList) {
            tagsList.querySelectorAll('.xp-url-tag').forEach(tag => tag.remove());
        }
        xp_updateCounter(urlCounter, urlInputField);
        if (urlInputField) urlInputField.focus();
    }

    function xp_resetAnalysisSession() {
        xp_urlsArray = [];
        xp_currentResponse = null;
        try {
            localStorage.removeItem(XP_STORAGE_KEY);
            localStorage.removeItem(XP_STORAGE_URLS_KEY);
        } catch (e) {}

        const tagsList = xp_getEl('xp-tagsList');
        const urlInputField = xp_getEl('xp-urlInputField');
        const urlCounter = xp_getEl('xp-urlCounter');
        if (tagsList) {
            tagsList.querySelectorAll('.xp-url-tag').forEach(tag => tag.remove());
        }
        if (urlInputField) {
            urlInputField.value = '';
            urlInputField.disabled = false;
            urlInputField.placeholder = '输入URL回车添加，支持批量粘贴';
        }
        if (urlCounter) xp_updateCounter(urlCounter, urlInputField);

        const resultSection = xp_getEl('xp-resultSection');
        if (resultSection) resultSection.classList.add('xp-hidden');

        const singleTpl = xp_getEl('xp-single-template');
        if (singleTpl) singleTpl.classList.add('xp-hidden');

        const matrixTpl = xp_getEl('xp-matrix-template');
        if (matrixTpl) matrixTpl.classList.add('xp-hidden');

        const loadingSection = xp_getEl('xp-loadingSection');
        if (loadingSection) loadingSection.classList.add('xp-hidden');

        const stageLabel = xp_getEl('xp-loadingStageLabel');
        if (stageLabel) stageLabel.textContent = '阶段 1/3: 网页深度抓取与 DOM 解析中...';
        const progressBar = xp_getEl('xp-progressBar');
        if (progressBar && progressBar.style) progressBar.style.width = '0%';
        const timerLabel = xp_getEl('xp-elapsedTimer');
        if (timerLabel) timerLabel.textContent = '已耗时: 0s';

        const errorMsg = xp_getEl('xp-errorMsg');
        if (errorMsg) {
            errorMsg.classList.add('xp-hidden');
            errorMsg.textContent = '';
        }

        if (typeof showToast === 'function') {
            showToast('已清空当前分析会话，恢复干净初始状态', 'info');
        }
    }

    function xp_truncateUrl(url) {
        try {
            const urlObj = new URL(url);
            let display = urlObj.hostname.replace('www.', '');
            if (urlObj.pathname && urlObj.pathname.length > 1) {
                const paths = urlObj.pathname.split('/').filter(p => p);
                if (paths.length > 0) display += '/.../' + paths[paths.length - 1];
            }
            return display.length > 40 ? display.substring(0, 40) + '...' : display;
        } catch (e) {
            return url.length > 40 ? url.substring(0, 40) + '...' : url;
        }
    }

    function xp_normalizeUrl(url) {
        url = (url || '').trim();
        if (!url) return '';
        if (/^https?:\/\//i.test(url)) return url;
        if (/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s]*)?$/i.test(url)) {
            return `https://${url}`;
        }
        return url;
    }

    function xp_addUrlTag(url, tagsList, urlInputField, urlCounter) {
        url = xp_normalizeUrl(url);
        if (!url || xp_urlsArray.includes(url) || xp_urlsArray.length >= XP_MAX_URLS) return;
        xp_urlsArray.push(url);
        const tag = document.createElement('div');
        tag.className = 'xp-url-tag';
        tag.title = url;
        const text = document.createElement('span');
        text.textContent = xp_truncateUrl(url);
        tag.appendChild(text);
        const closeBtn = document.createElement('button');
        closeBtn.className = 'xp-url-tag-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.onclick = (e) => {
            e.stopPropagation();
            xp_urlsArray = xp_urlsArray.filter(u => u !== url);
            tag.remove();
            xp_updateCounter(urlCounter, urlInputField);
            urlInputField.focus();
        };
        tag.appendChild(closeBtn);
        tagsList.insertBefore(tag, urlInputField);
        xp_updateCounter(urlCounter, urlInputField);
    }

    function xp_updateStaticI18n() {
        const panel = xp_getEl('view-analysis');
        if (!panel) return;
        panel.querySelectorAll('.xp-i18n-text').forEach(el => {
            if (el.dataset[xp_currentLang]) el.textContent = el.dataset[xp_currentLang];
        });
    }

    function xp_getI18nText(text) {
        if (!text) return '';
        if (typeof text === 'object') {
            if (xp_currentLang === 'zh') return text.zh || text.en || '';
            return text.en || text.zh || '';
        }
        if (typeof text !== 'string') return String(text);
        const separator = '|||';
        if (text.includes(separator)) {
            const parts = text.split(separator).map(s => s.trim());
            return xp_currentLang === 'zh' ? parts[0] : (parts[1] || parts[0]);
        }
        return text;
    }

    function xp_parseBold(text) {
        let html = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/(\$\d+(\.\d+)?|\d+(\.\d+)?\s*[€¥元])/g, '<strong>$1</strong>');
        return html;
    }

    function xp_parseConfidenceBadge(text) {
        return text
            .replace(/（?置信度[:：]\s*高）?|\(Confidence:\s*High\)/gi, '<span class="xp-badge xp-badge-success">高置信度</span>')
            .replace(/（?置信度[:：]\s*中）?|\(Confidence:\s*Medium\)/gi, '<span class="xp-badge xp-badge-warning">中置信度</span>')
            .replace(/（?置信度[:：]\s*低）?|\(Confidence:\s*Low\)/gi, '<span class="xp-badge xp-badge-danger">低置信度</span>');
    }

    function xp_processText(text) {
        if (typeof text !== 'string') return String(text || '');
        return xp_parseConfidenceBadge(xp_parseBold(xp_getI18nText(text)));
    }

    function xp_extractAdAngleText(a) {
        if (!a) return '';
        if (typeof a === 'string') return a;
        if (typeof a === 'object') {
            if (a.angle && !a.detail && !a.description) return a.angle;
            if (a.title && !a.detail && !a.description) return a.title;
            if (a.hook && !a.detail && !a.description && !a.angle) return a.hook;
            if (a.text) return a.text;
            if (a.content) return a.content;

            const head = a.angle || a.title || a.hook || '';
            const body = a.detail || a.description || a.content || '';
            if (head && body) {
                if (head.includes('|||') && body.includes('|||')) {
                    const headParts = head.split('|||').map(s => s.trim());
                    const bodyParts = body.split('|||').map(s => s.trim());
                    const zhText = `${headParts[0]}：${bodyParts[0]}`;
                    const enText = `${headParts[1] || headParts[0]}: ${bodyParts[1] || bodyParts[0]}`;
                    return `${zhText} ||| ${enText}`;
                }
                return `${head}：${body}`;
            }
            if (head) return head;
            if (body) return body;

            const stringValues = Object.values(a).filter(v => typeof v === 'string');
            if (stringValues.length > 0) return stringValues.join('：');
        }
        return String(a);
    }
    if (typeof window !== 'undefined') {
        window.xp_extractAdAngleText = xp_extractAdAngleText;
    }

    function xp_fallbackCopyText(text) {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text);
        }
        return new Promise((resolve, reject) => {
            try {
                if (typeof document === 'undefined') {
                    return resolve();
                }
                const textArea = document.createElement('textarea');
                textArea.value = text;
                textArea.style.position = 'fixed';
                textArea.style.left = '-9999px';
                textArea.style.top = '0';
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                const successful = document.execCommand('copy');
                document.body.removeChild(textArea);
                if (successful) resolve();
                else reject(new Error('execCommand copy failed'));
            } catch (err) {
                reject(err);
            }
        });
    }

    function xp_parseAdAngle(a) {
        if (!a) {
            return { angle: '', hook: '', script: '', cta_hashtags: '' };
        }
        if (typeof a === 'string') {
            return {
                angle: a,
                hook: '',
                script: '',
                cta_hashtags: ''
            };
        }
        if (typeof a === 'object') {
            const angle = a.angle || a.title || a.name || '';
            const hook = a.hook || a.hook_script || '';
            const script = a.script || a.detail || a.description || a.content || '';
            const cta_hashtags = a.cta_hashtags || a.cta || a.hashtags || a.call_to_action || '';

            if (!angle && !hook && !script && !cta_hashtags) {
                const text = a.text || a.item || a.point || '';
                if (text) {
                    return { angle: String(text), hook: '', script: '', cta_hashtags: '' };
                }
                const stringValues = Object.values(a).filter(v => typeof v === 'string');
                return {
                    angle: stringValues[0] || '',
                    hook: '',
                    script: stringValues.slice(1).join('；'),
                    cta_hashtags: ''
                };
            }

            return {
                angle: String(angle),
                hook: String(hook),
                script: String(script),
                cta_hashtags: String(cta_hashtags)
            };
        }
        return { angle: String(a), hook: '', script: '', cta_hashtags: '' };
    }

    function xp_detectRegion(targetCountries) {
        if (!targetCountries || (Array.isArray(targetCountries) && targetCountries.length === 0)) return 'US Market';
        const str = (Array.isArray(targetCountries) ? targetCountries.join(' ') : String(targetCountries)).toLowerCase();
        if (str.includes('日本') || str.includes('japan') || str.includes('jp')) return 'Japan Market';
        if (str.includes('英国') || str.includes('uk') || str.includes('united kingdom') || str.includes('britain')) return 'UK Market';
        if (str.includes('东南亚') || str.includes('thai') || str.includes('泰国') || str.includes('sea') || str.includes('vietnam') || str.includes('singapore')) return 'Southeast Asia Market';
        if (str.includes('欧洲') || str.includes('germany') || str.includes('france') || str.includes('europe') || str.includes('德国') || str.includes('法国')) return 'European Market';
        if (str.includes('中东') || str.includes('uae') || str.includes('dubai') || str.includes('saudi')) return 'Middle East Market';
        if (str.includes('澳大利亚') || str.includes('australia') || str.includes('aus')) return 'Australian Market';
        return 'US Market';
    }

    function xp_setSelectValue(selectEl, value) {
        if (!selectEl) return;
        selectEl.value = value;
        try {
            const event = new Event('change', { bubbles: true });
            selectEl.dispatchEvent(event);
        } catch (e) {
            // Ignore in environments without Event constructor
        }
    }

    function xp_renderSingleTldr(d, scoreObj = null) {
        const tldrCard = xp_getEl('xp-singleTldrCard');
        if (!tldrCard || !d) return;

        // 1. 投资决策红绿灯徽章
        const decisionRaw = scoreObj ? (scoreObj.final_decision || '') : '';
        const decisionText = xp_getI18nText(decisionRaw);
        let badgeType = 'warning';
        let badgeLabel = decisionText || (xp_currentLang === 'zh' ? '综合评估' : 'Evaluation');

        const lower = decisionText.toLowerCase();
        if (lower.includes('强烈建议') || lower.includes('优先') || lower.includes('建议进入') || (lower.includes('recommend') && !lower.includes('not recommend'))) {
            badgeType = 'success';
        } else if (lower.includes('不建议') || lower.includes('放弃') || lower.includes('高危') || lower.includes('not recommend') || lower.includes('reject')) {
            badgeType = 'danger';
        } else {
            badgeType = 'warning';
        }

        const oScore = scoreObj ? (scoreObj.opportunity_score ?? 0) : null;
        const dScore = scoreObj ? (scoreObj.difficulty_score ?? 0) : null;
        const scoresSub = (oScore !== null && dScore !== null)
            ? `<span class="xp-tldr-scores">（${xp_currentLang === 'zh' ? '机会' : 'Opp'} ${oScore} / ${xp_currentLang === 'zh' ? '难度' : 'Diff'} ${dScore}）</span>`
            : '';

        // 操盘定调
        const decisionReason = scoreObj?.decision_details?.reason
            ? xp_processText(scoreObj.decision_details.reason)
            : (d.entry_recommendation ? xp_processText(d.entry_recommendation) : (xp_currentLang === 'zh' ? '结合自身供应链优势与资金周转评估进入节奏' : 'Evaluate entry based on supply chain and budget.'));

        // 2. 最大避坑雷区 (Fatal Pitfall)
        let pitfallText = '';
        if (d.weaknesses && d.weaknesses.length > 0) {
            const w = d.weaknesses[0];
            const r = xp_getI18nText(w.risk || '');
            const det = xp_getI18nText(w.detail || '');
            pitfallText = r ? `${r}：${det}` : det;
        } else if (d.voc_analysis && d.voc_analysis.cons && d.voc_analysis.cons.length > 0) {
            pitfallText = xp_getI18nText(d.voc_analysis.cons[0]);
        } else if (scoreObj && scoreObj.decision_details && scoreObj.decision_details.reason) {
            pitfallText = xp_getI18nText(scoreObj.decision_details.reason);
        } else {
            pitfallText = xp_currentLang === 'zh' ? '暂未识别出致命缺陷，需严格监控品控及售后率' : 'No fatal flaws detected, monitor quality control.';
        }

        // 3. 最优破局机会 (Breakthrough Opportunity)
        let oppText = '';
        if (d.differentiation_opportunities && d.differentiation_opportunities.length > 0) {
            const o = d.differentiation_opportunities[0];
            oppText = xp_getI18nText(typeof o === 'object' ? (o.opportunity || o.point || '') : String(o));
        } else if (d.entry_recommendation) {
            oppText = xp_getI18nText(d.entry_recommendation);
        } else if (d.strengths && d.strengths.length > 0) {
            const s = d.strengths[0];
            const p = xp_getI18nText(s.point || '');
            const det = xp_getI18nText(s.detail || '');
            oppText = p ? `${p}：${det}` : det;
        } else {
            oppText = xp_currentLang === 'zh' ? '主打视觉传达升级与精准场景化痛点营销' : 'Focus on visual upgrades and scenario marketing.';
        }

        tldrCard.innerHTML = `
            <div class="xp-tldr-header">
                <div class="xp-tldr-header-left">
                    <div class="xp-tldr-tag">
                        <i class="ph-fill ph-gauge text-indigo-600"></i>
                        <span>${xp_currentLang === 'zh' ? '极速选品决策看板 (TL;DR)' : 'Product Decision TL;DR'}</span>
                    </div>
                    <div class="xp-tldr-sub">
                        <span>${xp_currentLang === 'zh' ? '5秒快速拍板：决策红绿灯 · 避坑雷区 · 破局点' : '5-Sec Decision: Traffic Light · Fatal Pitfall · Opportunity'}</span>
                    </div>
                </div>
                <div class="xp-tldr-decision-pill xp-tldr-badge-${badgeType}">
                    <span class="xp-tldr-dot"></span>
                    <span style="font-weight:800;">${badgeLabel}</span>
                    ${scoresSub}
                </div>
            </div>
            <div class="xp-tldr-grid">
                <div class="xp-tldr-col xp-tldr-col-conclusion">
                    <div class="xp-tldr-col-title">
                        <i class="ph-fill ph-lightbulb text-indigo-500"></i>
                        <span>${xp_currentLang === 'zh' ? '操盘定调' : 'Executive Conclusion'}</span>
                    </div>
                    <div class="xp-tldr-col-desc">${decisionReason}</div>
                </div>
                <div class="xp-tldr-col xp-tldr-col-pitfall">
                    <div class="xp-tldr-col-title">
                        <i class="ph-fill ph-warning-circle text-rose-500"></i>
                        <span>${xp_currentLang === 'zh' ? '核心避坑雷区' : 'Fatal Pitfall'}</span>
                    </div>
                    <div class="xp-tldr-col-desc">${xp_processText(pitfallText)}</div>
                </div>
                <div class="xp-tldr-col xp-tldr-col-breakthrough">
                    <div class="xp-tldr-col-title">
                        <i class="ph-fill ph-trend-up text-emerald-500"></i>
                        <span>${xp_currentLang === 'zh' ? '最优破局机会' : 'Breakthrough Point'}</span>
                    </div>
                    <div class="xp-tldr-col-desc">${xp_processText(oppText)}</div>
                </div>
            </div>
        `;
        tldrCard.classList.remove('xp-hidden');
    }

    function xp_transferToListing(dataOverride = null) {
        const d = dataOverride || xp_currentSingleData;
        if (!d) {
            if (typeof alert === 'function') {
                alert(xp_currentLang === 'zh' ? '暂无可用的竞品分析数据' : 'No analysis data available');
            }
            return;
        }

        // 1. 产品名称
        const nameEl = xp_getEl('listingName');
        if (nameEl) {
            nameEl.value = xp_getI18nText(d.product_name || '').trim();
        }

        // 2. 核心卖点与痛点化解
        const pointsEl = xp_getEl('listingPoints');
        if (pointsEl) {
            const sections = [];

            // 核心卖点
            const sps = (d.core_selling_points || []).map(sp => {
                const text = typeof sp === 'object' ? (sp.point || '') : String(sp);
                const clean = xp_getI18nText(text).trim();
                return clean ? `- ${clean}` : '';
            }).filter(Boolean);
            if (sps.length > 0) {
                sections.push(`【核心卖点与功能】\n${sps.join('\n')}`);
            }

            // 差异化机会
            const diffs = (d.differentiation_opportunities || []).map(opp => {
                const text = typeof opp === 'object' ? (opp.opportunity || opp.point || '') : String(opp);
                const clean = xp_getI18nText(text).trim();
                return clean ? `- ${clean}` : '';
            }).filter(Boolean);
            if (diffs.length > 0) {
                sections.push(`【差异化改良突破点】\n${diffs.join('\n')}`);
            }

            // 痛点化解
            const pains = (d.user_pain_points || []).map(pp => {
                const text = typeof pp === 'object' ? (pp.pain || '') : String(pp);
                const clean = xp_getI18nText(text).trim();
                return clean ? `- 针对原痛点改进: ${clean}` : '';
            }).filter(Boolean);
            if (pains.length > 0) {
                sections.push(`【竞品痛点针对性优化】\n${pains.join('\n')}`);
            }

            // 适用人群与场景
            const audiences = (d.target_audience || []).map(t => {
                const text = typeof t === 'object' ? (t.audience || t.item || '') : String(t);
                return xp_getI18nText(text).trim();
            }).filter(Boolean).join('、');
            const scenarios = (d.use_scenarios || []).map(s => {
                const text = typeof s === 'object' ? (s.scenario || s.item || '') : String(s);
                return xp_getI18nText(text).trim();
            }).filter(Boolean).join('、');

            if (audiences || scenarios) {
                const contextLines = [];
                if (audiences) contextLines.push(`- 目标人群: ${audiences}`);
                if (scenarios) contextLines.push(`- 核心场景: ${scenarios}`);
                sections.push(`【适用人群与场景】\n${contextLines.join('\n')}`);
            }

            pointsEl.value = sections.join('\n\n');
        }

        // 3. 主打关键词
        const kwEl = xp_getEl('listingKeywords');
        if (kwEl) {
            const kwList = [];
            (d.use_scenarios || []).forEach(s => {
                const text = typeof s === 'object' ? (s.scenario || s.item || '') : String(s);
                const t = xp_getI18nText(text).trim();
                if (t && !kwList.includes(t)) kwList.push(t);
            });
            (d.target_audience || []).forEach(a => {
                const text = typeof a === 'object' ? (a.audience || a.item || '') : String(a);
                const t = xp_getI18nText(text).trim();
                if (t && !kwList.includes(t)) kwList.push(t);
            });
            kwEl.value = kwList.slice(0, 5).join(', ');
        }

        // 4. 目标市场
        const regionSelect = xp_getEl('listingRegionSelect');
        if (regionSelect) {
            const region = xp_detectRegion(d.target_countries);
            xp_setSelectValue(regionSelect, region);
        }

        // 5. 切换标签页
        if (typeof switchMainTab === 'function') {
            switchMainTab('listing');
        }
        if (typeof showToast === 'function') {
            showToast(xp_currentLang === 'zh' ? '已将竞品分析数据带入 Listing 模块' : 'Transferred product data to Listing module', 'success');
        }
    }

    function xp_transferToAds(dataOverride = null) {
        const d = dataOverride || xp_currentSingleData;
        if (!d) {
            if (typeof alert === 'function') {
                alert(xp_currentLang === 'zh' ? '暂无可用的竞品分析数据' : 'No analysis data available');
            }
            return;
        }

        // 1. 产品名称
        const nameEl = xp_getEl('adsProductNameInput');
        if (nameEl) {
            nameEl.value = xp_getI18nText(d.product_name || '').trim().substring(0, 200);
        }

        // 2. 目标市场
        const adsRegionSelect = xp_getEl('adsRegionSelect');
        if (adsRegionSelect) {
            const region = xp_detectRegion(d.target_countries);
            xp_setSelectValue(adsRegionSelect, region);
        }

        // 3. 切换标签页
        if (typeof switchMainTab === 'function') {
            switchMainTab('ads');
        }
        if (typeof showToast === 'function') {
            showToast(xp_currentLang === 'zh' ? '已将竞品信息带入广告文案模块' : 'Transferred product data to Ads module', 'success');
        }
    }

    function xp_transferToDetails(dataOverride = null) {
        const d = dataOverride || xp_currentSingleData;
        if (!d) {
            if (typeof alert === 'function') {
                alert(xp_currentLang === 'zh' ? '暂无可用的竞品分析数据' : 'No analysis data available');
            }
            return;
        }

        // 1. 产品名称
        const nameEl = xp_getEl('productNameInput');
        if (nameEl) {
            nameEl.value = xp_getI18nText(d.product_name || '').trim().substring(0, 160);
        }

        // 2. 核心卖点与痛点突破
        const pointsEl = xp_getEl('sellingPointsText');
        if (pointsEl) {
            const sections = [];
            if (d.brand_positioning?.tagline) {
                sections.push(`【品牌主张】${xp_getI18nText(d.brand_positioning.tagline)}`);
            }
            const sps = (d.core_selling_points || []).map(sp => {
                const text = typeof sp === 'object' ? (sp.point || '') : String(sp);
                const clean = xp_getI18nText(text).trim();
                return clean ? `- ${clean}` : '';
            }).filter(Boolean);
            if (sps.length > 0) {
                sections.push(`【核心卖点与功能】\n${sps.join('\n')}`);
            }
            const diffs = (d.differentiation_opportunities || []).map(opp => {
                const text = typeof opp === 'object' ? (opp.opportunity || opp.point || '') : String(opp);
                const clean = xp_getI18nText(text).trim();
                return clean ? `- ${clean}` : '';
            }).filter(Boolean);
            if (diffs.length > 0) {
                sections.push(`【差异化改良突破点】\n${diffs.join('\n')}`);
            }
            pointsEl.value = sections.join('\n\n');
        }

        // 3. 产品事实 / 参数
        const factsEl = xp_getEl('productFactsText');
        if (factsEl) {
            const facts = [];
            if (d.price) facts.push(`市场参考价: $${xp_getI18nText(d.price)}`);
            if (d.battle_card?.pricing_tier) facts.push(`价格定位: ${xp_getI18nText(d.battle_card.pricing_tier)}`);
            if (d.specs && typeof d.specs === 'object') {
                Object.entries(d.specs).forEach(([k, v]) => {
                    facts.push(`${xp_getI18nText(k)}: ${xp_getI18nText(v)}`);
                });
            }
            if (facts.length) factsEl.value = facts.join('\n');
        }

        // 4. 禁用词 / 规避竞品致命漏洞
        const forbiddenEl = xp_getEl('forbiddenClaimsText');
        if (forbiddenEl) {
            const forbiddens = [];
            if (d.battle_card?.fatal_vulnerabilities && Array.isArray(d.battle_card.fatal_vulnerabilities)) {
                d.battle_card.fatal_vulnerabilities.forEach(v => {
                    const clean = xp_getI18nText(v).trim();
                    if (clean) forbiddens.push(`规避竞品缺陷: ${clean}`);
                });
            }
            if (forbiddens.length) forbiddenEl.value = forbiddens.join('\n');
        }

        // 5. 保存客诉抗拒点防御话术，供 DTC FAQ 自动组合
        if (d.customer_objections && Array.isArray(d.customer_objections)) {
            window.xp_transferredObjections = d.customer_objections;
        }

        // 6. 切换标签页
        if (typeof switchMainTab === 'function') {
            switchMainTab('generate');
        }
        if (typeof showToast === 'function') {
            showToast(xp_currentLang === 'zh' ? '已将竞品信息带入详情页生成模块' : 'Transferred product data to Detail Page module', 'success');
        }
    }

    function xp_inferCategoryFromText(text = '') {
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

    function xp_extractProfileFromAnalysis(dataOverride = null) {
        const resp = xp_currentResponse || (typeof window !== 'undefined' && window.xp_currentResponse) || null;

        // 1. 确定是否指定了单品数据或全局存在单品数据
        let singleProduct = null;
        if (dataOverride && (dataOverride.product_name || dataOverride.core_selling_points || dataOverride.differentiation_opportunities)) {
            singleProduct = dataOverride;
        } else if (dataOverride && dataOverride.data && dataOverride.data.single_data) {
            singleProduct = dataOverride.data.single_data;
        } else if (xp_currentSingleData) {
            singleProduct = xp_currentSingleData;
        } else if (resp && resp.data && resp.data.single_data) {
            singleProduct = resp.data.single_data;
        }

        // 2. 检查多品战略蓝图洞察 (Strategic Blueprint / Battle Card)
        const strat = (dataOverride && (dataOverride.strategic_insights || dataOverride.comparison)) ||
                      (resp && (resp.strategic_insights || (resp.data && (resp.data.strategic_insights || resp.data.comparison)))) || null;

        // 若未指定特定单品，且存在矩阵战略蓝图洞察，则基于全局赢家与对战卡提取
        if (!singleProduct && strat) {
            const rawData = (dataOverride && dataOverride.data) ? dataOverride.data : (dataOverride || (resp && resp.data ? resp.data : resp));
            const battleCard = strat.battle_card || {};
            const winner = strat.winner_analysis || {};
            const breakthrough = strat.breakthrough_strategy || {};

            const whySwitchText = (battleCard.why_switch || []).map(i => `${i.trigger} -> ${i.our_counter}`).join('; ');
            const tacticalText = (battleCard.tactical_counter_attacks || []).map(i => `[${i.angle}] ${i.action}`).join('\n');

            const winnerProduct = rawData.winner_product || (rawData.products && rawData.products[0]?.product_name) || '竞品对标改良款';
            const inferredCat = strat.category || rawData.category || xp_inferCategoryFromText(`${winnerProduct} ${breakthrough.product_innovation || ''}`);

            return {
                name: xp_processText(winnerProduct),
                brandName: '',
                category: xp_processText(inferredCat || ''),
                icp: xp_processText(battleCard.who_it_is_for || ''),
                painPoints: xp_processText(winner.fatal_vulnerability || whySwitchText || ''),
                differentiators: xp_processText(breakthrough.product_innovation || winner.key_advantages || ''),
                vocKeywords: xp_processText(breakthrough.marketing_playbook || ''),
                tone: 'professional',
                competitorNotes: xp_processText(`【劝退人群】${battleCard.who_it_is_not_for || ''}\n【拦截打法】${tacticalText}`)
            };
        }

        // 3. 基于单品深度透视提取
        if (singleProduct) {
            const d = singleProduct;
            const isZh = xp_currentLang === 'zh';
            const rawName = xp_getI18nText(d.product_name || '').trim();
            const brandName = xp_getI18nText(d.brand_positioning?.brand_name || d.brand || '').trim();
            let category = xp_getI18nText(d.category || d.brand_positioning?.category || '').trim();
            if (!category) {
                const searchCorpus = `${rawName} ${(d.core_selling_points || []).map(p => typeof p === 'object' ? (p.point || '') : String(p)).join(' ')} ${(d.use_scenarios || []).map(s => typeof s === 'object' ? (s.scenario || '') : String(s)).join(' ')}`;
                category = xp_inferCategoryFromText(searchCorpus);
            }

            // ICP 核心目标人群
            let icp = '';
            if (d.battle_card?.who_it_is_for) {
                icp = xp_getI18nText(d.battle_card.who_it_is_for).trim();
            } else if (Array.isArray(d.target_audience) && d.target_audience.length > 0) {
                icp = d.target_audience.map(t => {
                    const text = typeof t === 'object' ? (t.audience || t.item || '') : String(t);
                    return xp_getI18nText(text).trim();
                }).filter(Boolean).join('、');
            }

            // 痛点与致命漏洞
            const painList = [];
            if (Array.isArray(d.user_pain_points)) {
                d.user_pain_points.forEach(pp => {
                    const text = typeof pp === 'object' ? (pp.pain || pp.item || '') : String(pp);
                    const clean = xp_getI18nText(text).trim();
                    if (clean && !painList.includes(clean)) painList.push(clean);
                });
            }
            if (d.weaknesses && Array.isArray(d.weaknesses)) {
                d.weaknesses.forEach(w => {
                    const r = xp_getI18nText(w.risk || '').trim();
                    const det = xp_getI18nText(w.detail || '').trim();
                    const clean = r ? `${r}：${det}` : det;
                    if (clean && !painList.includes(clean)) painList.push(clean);
                });
            }
            if (d.battle_card?.fatal_vulnerabilities && Array.isArray(d.battle_card.fatal_vulnerabilities)) {
                d.battle_card.fatal_vulnerabilities.forEach(v => {
                    const clean = xp_getI18nText(v).trim();
                    if (clean && !painList.includes(clean)) painList.push(clean);
                });
            }
            const painPoints = painList.slice(0, 5).join('；\n');

            // 核心卖点与差异化破局点
            const diffList = [];
            if (Array.isArray(d.differentiation_opportunities)) {
                d.differentiation_opportunities.forEach(opp => {
                    const text = typeof opp === 'object' ? (opp.opportunity || opp.point || '') : String(opp);
                    const clean = xp_getI18nText(text).trim();
                    if (clean && !diffList.includes(clean)) diffList.push(clean);
                });
            }
            if (Array.isArray(d.core_selling_points)) {
                d.core_selling_points.forEach(sp => {
                    const text = typeof sp === 'object' ? (sp.point || sp.item || '') : String(sp);
                    const clean = xp_getI18nText(text).trim();
                    if (clean && !diffList.includes(clean)) diffList.push(clean);
                });
            }
            const differentiators = diffList.slice(0, 5).join('；\n');

            // VoC 原声词汇与场景关键词
            const vocList = [];
            if (Array.isArray(d.use_scenarios)) {
                d.use_scenarios.forEach(s => {
                    const text = typeof s === 'object' ? (s.scenario || s.item || '') : String(s);
                    const clean = xp_getI18nText(text).trim();
                    if (clean && !vocList.includes(clean)) vocList.push(clean);
                });
            }
            if (Array.isArray(d.target_audience)) {
                d.target_audience.forEach(a => {
                    const text = typeof a === 'object' ? (a.audience || a.item || '') : String(a);
                    const clean = xp_getI18nText(text).trim();
                    if (clean && !vocList.includes(clean)) vocList.push(clean);
                });
            }
            if (d.voc_insights?.keywords && Array.isArray(d.voc_insights.keywords)) {
                d.voc_insights.keywords.forEach(k => {
                    const clean = xp_getI18nText(k).trim();
                    if (clean && !vocList.includes(clean)) vocList.push(clean);
                });
            }
            if (d.voc_analysis?.keywords && Array.isArray(d.voc_analysis.keywords)) {
                d.voc_analysis.keywords.forEach(k => {
                    const clean = xp_getI18nText(k).trim();
                    if (clean && !vocList.includes(clean)) vocList.push(clean);
                });
            }
            const vocKeywords = vocList.slice(0, 8).join(', ');

            // 品牌调性推断
            let tone = 'professional';
            const bpTone = (d.brand_positioning?.brand_tone || d.brand_positioning?.tone || '').toLowerCase();
            if (bpTone.includes('luxury') || bpTone.includes('奢')) tone = 'luxury';
            else if (bpTone.includes('tech') || bpTone.includes('科技') || bpTone.includes('硬核')) tone = 'tech';
            else if (bpTone.includes('energetic') || bpTone.includes('活力') || bpTone.includes('亲和')) tone = 'energetic';
            else if (bpTone.includes('minimal') || bpTone.includes('极简')) tone = 'minimal';

            // 竞品针对劣势与拦截策略
            const compNotes = [];
            if (d.battle_card?.who_it_is_not_for) {
                compNotes.push(`【劝退人群】${xp_getI18nText(d.battle_card.who_it_is_not_for)}`);
            }
            if (d.battle_card?.tactical_counter_attacks && Array.isArray(d.battle_card.tactical_counter_attacks)) {
                const tacts = d.battle_card.tactical_counter_attacks.map(t => `[${xp_getI18nText(t.angle)}] ${xp_getI18nText(t.action)}`).join('\n');
                compNotes.push(`【实战拦截打法】\n${tacts}`);
            }
            if (d.customer_objections && Array.isArray(d.customer_objections) && d.customer_objections.length > 0) {
                const objs = d.customer_objections.slice(0, 3).map(o => `· ${xp_getI18nText(o.objection || o.question || '')} -> ${xp_getI18nText(o.rebuttal || o.counter_script || '')}`).join('\n');
                compNotes.push(`【常见买家抗拒与防御】\n${objs}`);
            }
            if (compNotes.length === 0 && d.weaknesses && Array.isArray(d.weaknesses)) {
                const wList = d.weaknesses.map(w => `${xp_getI18nText(w.risk)}: ${xp_getI18nText(w.detail)}`).join('；');
                compNotes.push(`【竞品劣势/差评点】${wList}`);
            }

            return {
                name: rawName ? (rawName.length > 40 ? `${rawName.substring(0, 40)}... (改良款)` : `${rawName} (改良款)`) : (isZh ? '对标改良新品' : 'Benchmark Improved Product'),
                brandName: brandName || '',
                category: category || '',
                icp: icp || '',
                painPoints: painPoints || '',
                differentiators: differentiators || '',
                vocKeywords: vocKeywords || '',
                tone: tone,
                competitorNotes: compNotes.join('\n\n')
            };
        }

        return null;
    }

    function xp_transferToBrandProfile(dataOverride = null) {
        const profileData = xp_extractProfileFromAnalysis(dataOverride);
        if (!profileData) {
            const msg = xp_currentLang === 'zh' ? '暂无可用的竞品分析数据，请先输入链接进行分析' : 'No analysis data available to save';
            if (typeof showToast === 'function') {
                showToast(msg, 'error');
            } else if (typeof alert === 'function') {
                alert(msg);
            }
            return;
        }

        if (window.brandContextHub && typeof window.brandContextHub.openWithDraft === 'function') {
            window.brandContextHub.openWithDraft(profileData);
            if (typeof showToast === 'function') {
                showToast(xp_currentLang === 'zh' ? '已提取竞品分析洞察为营销画像草稿，请在档案库中确认保存！' : 'Transferred insights to Brand Hub draft!', 'success');
            }
        } else if (typeof showToast === 'function') {
            showToast('正在打开营销档案库...', 'info');
        }
    }

    function xp_getWinnerProduct() {
        const prods = (xp_matrixCurrentProducts && xp_matrixCurrentProducts.length > 0)
            ? xp_matrixCurrentProducts
            : (typeof window !== 'undefined' && window.xp_matrixCurrentProducts && window.xp_matrixCurrentProducts.length > 0
                ? window.xp_matrixCurrentProducts
                : null);
        const winnerIdx = (typeof xp_winnerIndex === 'number' && xp_winnerIndex >= 0)
            ? xp_winnerIndex
            : (typeof window !== 'undefined' && typeof window.xp_winnerIndex === 'number' && window.xp_winnerIndex >= 0
                ? window.xp_winnerIndex
                : -1);
        if (prods && prods.length > 0) {
            if (winnerIdx >= 0 && prods[winnerIdx]) {
                return prods[winnerIdx];
            }
            return prods[0];
        }
        return null;
    }

    function xp_transferMatrixToDetails() {
        const winner = xp_getWinnerProduct();
        if (winner) {
            xp_transferToDetails(winner);
        } else if (typeof showToast === 'function') {
            showToast(xp_currentLang === 'zh' ? '暂无赢家产品数据' : 'No winner product data', 'error');
        }
    }

    function xp_transferMatrixToListing() {
        const winner = xp_getWinnerProduct();
        if (winner) {
            xp_transferToListing(winner);
        } else if (typeof showToast === 'function') {
            showToast(xp_currentLang === 'zh' ? '暂无赢家产品数据' : 'No winner product data', 'error');
        }
    }

    function xp_transferMatrixToAds() {
        const winner = xp_getWinnerProduct();
        if (winner) {
            xp_transferToAds(winner);
        } else if (typeof showToast === 'function') {
            showToast(xp_currentLang === 'zh' ? '暂无赢家产品数据' : 'No winner product data', 'error');
        }
    }

    function xp_copyTldrSummary(dataOverride = null, scoreOverride = null) {
        const d = dataOverride || xp_currentSingleData;
        const scoreObj = scoreOverride || xp_currentScoreObj;
        if (!d) {
            if (typeof alert === 'function') {
                alert(xp_currentLang === 'zh' ? '暂无可复制的分析数据' : 'No analysis data to copy');
            }
            return;
        }

        const isZh = xp_currentLang === 'zh';
        const name = xp_getI18nText(d.product_name || (isZh ? '未知产品' : 'Unknown Product'));
        const price = xp_getI18nText(d.price || '-');
        const reviews = xp_getI18nText(d.reviews_count || '0');
        const decision = scoreObj ? xp_getI18nText(scoreObj.final_decision || '-') : '-';
        const oppScore = scoreObj ? (scoreObj.opportunity_score ?? '-') : '-';
        const diffScore = scoreObj ? (scoreObj.difficulty_score ?? '-') : '-';

        // 核心避坑雷区
        let pitfall = '';
        if (d.weaknesses && d.weaknesses.length > 0) {
            const w = d.weaknesses[0];
            const r = xp_getI18nText(w.risk || '');
            const det = xp_getI18nText(w.detail || '');
            pitfall = r ? `${r}：${det}` : det;
        } else if (d.voc_analysis && d.voc_analysis.cons && d.voc_analysis.cons.length > 0) {
            pitfall = xp_getI18nText(d.voc_analysis.cons[0]);
        } else if (scoreObj && scoreObj.decision_details && scoreObj.decision_details.reason) {
            pitfall = xp_getI18nText(scoreObj.decision_details.reason);
        }

        // 最优破局策略
        let opp = '';
        if (d.differentiation_opportunities && d.differentiation_opportunities.length > 0) {
            const o = d.differentiation_opportunities[0];
            opp = xp_getI18nText(typeof o === 'object' ? (o.opportunity || o.point || '') : String(o));
        } else if (d.entry_recommendation) {
            opp = xp_getI18nText(d.entry_recommendation);
        } else if (d.strengths && d.strengths.length > 0) {
            const s = d.strengths[0];
            const p = xp_getI18nText(s.point || '');
            const det = xp_getI18nText(s.detail || '');
            opp = p ? `${p}：${det}` : det;
        }

        const sps = (d.core_selling_points || []).map((p, i) => {
            const text = typeof p === 'object' ? (p.point || '') : String(p);
            return `${i + 1}. ${xp_getI18nText(text).trim()}`;
        }).slice(0, 3);

        const ads = (d.ad_angles || []).map((a, i) => {
            const parsed = xp_parseAdAngle(a);
            const angleText = xp_getI18nText(parsed.angle || '');
            const hookText = xp_getI18nText(parsed.hook || '');
            return `${i + 1}. ${angleText}${hookText ? ` (前3秒钩子: ${hookText})` : ''}`;
        }).slice(0, 3);

        const lines = isZh ? [
            `📊【选品分析决策速览 (TL;DR)】`,
            `📦 产品：${name}`,
            `💰 价格：${price} | 评价数：${reviews}`,
            `🚦 决策结论：${decision} (机会分: ${oppScore} / 难度分: ${diffScore})`,
            ``,
            `⚠️ 核心避坑雷区：`,
            `${pitfall || '暂未发现致命缺陷，需把控供应链质量'}`,
            ``,
            `💡 最优破局策略：`,
            `${opp || '场景化痛点营销突破'}`,
            ``,
            `🎯 核心卖点：`,
            sps.length > 0 ? sps.join('\n') : '- 暂无',
            ``,
            `🎬 广告切入点推荐：`,
            ads.length > 0 ? ads.join('\n') : '- 暂无'
        ] : [
            `📊 [Product Decision TL;DR]`,
            `📦 Product: ${name}`,
            `💰 Price: ${price} | Reviews: ${reviews}`,
            `🚦 Decision: ${decision} (Opp: ${oppScore} / Diff: ${diffScore})`,
            ``,
            `⚠️ Fatal Pitfall:`,
            `${pitfall || 'No fatal flaws detected'}`,
            ``,
            `💡 Breakthrough Opportunity:`,
            `${opp || 'Scenario marketing breakthrough'}`,
            ``,
            `🎯 Core Selling Points:`,
            sps.length > 0 ? sps.join('\n') : '- None',
            ``,
            `🎬 Recommended Ad Angles:`,
            ads.length > 0 ? ads.join('\n') : '- None'
        ];

        const text = lines.join('\n');
        return xp_fallbackCopyText(text).then(() => {
            const btn = xp_getEl('xp-btnCopyTldr');
            if (btn) {
                const orig = btn.innerHTML;
                btn.innerHTML = `<i class="ph ph-check"></i><span>${isZh ? '已复制速览' : 'Copied'}</span>`;
                btn.classList.add('xp-success');
                setTimeout(() => {
                    btn.innerHTML = orig;
                    btn.classList.remove('xp-success');
                }, 1500);
            }
            if (typeof showToast === 'function') {
                showToast(isZh ? '已复制选品速览 (TL;DR) 到剪贴板' : 'Copied TL;DR summary to clipboard', 'success');
            }
        }).catch(err => {
            console.error('Copy failed:', err);
            if (typeof alert === 'function') {
                alert(isZh ? '复制失败，请手动复制' : 'Copy failed');
            }
        });
    }

    function xp_copyAdAngleScript(index, dataOverride = null) {
        const d = dataOverride || xp_currentSingleData;
        if (!d || !d.ad_angles) return;
        const a = d.ad_angles[index];
        if (!a) return;
        const parsed = xp_parseAdAngle(a);
        const angle = xp_getI18nText(parsed.angle || '');
        const hook = xp_getI18nText(parsed.hook || '');
        const script = xp_getI18nText(parsed.script || '');
        const cta = xp_getI18nText(parsed.cta_hashtags || '');

        const numStr = String(index + 1).padStart(2, '0');
        const isZh = xp_currentLang === 'zh';

        const lines = isZh ? [
            `🎬【短视频广告分镜头脚本 #${numStr}】`,
            `💡 创意切入角度：${angle}`,
            hook ? `🎯 前3秒黄金钩子：${hook}` : '',
            script ? `📝 分镜头反差脚本：\n${script}` : '',
            cta ? `📣 行动号召与标签：${cta}` : ''
        ].filter(Boolean) : [
            `🎬 [Short Video Ad Script #${numStr}]`,
            `💡 Creative Angle: ${angle}`,
            hook ? `🎯 3-Sec Hook: ${hook}` : '',
            script ? `📝 Scene Breakdown / Script:\n${script}` : '',
            cta ? `📣 CTA & Hashtags: ${cta}` : ''
        ].filter(Boolean);

        const fullText = lines.join('\n\n');
        return xp_fallbackCopyText(fullText).then(() => {
            const btn = document.querySelector(`.xp-ad-copy-btn[data-index="${index}"]`);
            if (btn) {
                const orig = btn.innerHTML;
                btn.innerHTML = `<i class="ph ph-check"></i><span>${isZh ? '已复制' : 'Copied'}</span>`;
                btn.classList.add('xp-copied');
                setTimeout(() => {
                    btn.innerHTML = orig;
                    btn.classList.remove('xp-copied');
                }, 1500);
            }
            if (typeof showToast === 'function') {
                showToast(isZh ? `已复制分镜头脚本 #${numStr}` : `Copied Script #${numStr}`, 'success');
            }
        }).catch(err => {
            console.error('Copy script failed:', err);
        });
    }

    function xp_copyObjection(index, dataOverride = null) {
        const d = dataOverride || xp_currentSingleData;
        if (!d || !d.customer_objections) return;
        const item = d.customer_objections[index];
        if (!item) return;

        const isZh = xp_currentLang === 'zh';
        const q = xp_getI18nText(item.objection || '');
        const a = xp_getI18nText(item.response || '');
        const proof = xp_getI18nText(item.proof_point || '');
        const numStr = String(index + 1).padStart(2, '0');

        const lines = isZh ? [
            `❓【买家疑虑 #${numStr}】：${q}`,
            `💬【客服高转化说辞】：\n${a}`,
            proof ? `🔒【事实背书/质保】：${proof}` : ''
        ].filter(Boolean) : [
            `❓ [Buyer Objection #${numStr}]: ${q}`,
            `💬 [Sales Defense & Response]:\n${a}`,
            proof ? `🔒 [Proof Point & Warranty]: ${proof}` : ''
        ].filter(Boolean);

        const fullText = lines.join('\n\n');
        return xp_fallbackCopyText(fullText).then(() => {
            const btn = document.querySelector(`.xp-objection-copy-btn[data-index="${index}"]`);
            if (btn) {
                const orig = btn.innerHTML;
                btn.innerHTML = `<i class="ph ph-check"></i><span>${isZh ? '已复制' : 'Copied'}</span>`;
                if (typeof setTimeout === 'function') {
                    setTimeout(() => {
                        btn.innerHTML = orig;
                        btn.classList.remove('xp-copied');
                    }, 1500);
                } else {
                    btn.innerHTML = orig;
                    btn.classList.remove('xp-copied');
                }
            }
            if (typeof showToast === 'function') {
                showToast(isZh ? `已复制客服攻防话术 #${numStr}` : `Copied Objection Q&A #${numStr}`, 'success');
            }
        }).catch(err => {
            console.error('Copy objection failed:', err);
        });
    }

    function xp_copyAllObjections(dataOverride = null) {
        const d = dataOverride || xp_currentSingleData;
        if (!d || !d.customer_objections || d.customer_objections.length === 0) return;

        const isZh = xp_currentLang === 'zh';
        const blocks = d.customer_objections.map((item, idx) => {
            const q = xp_getI18nText(item.objection || '');
            const a = xp_getI18nText(item.response || '');
            const proof = xp_getI18nText(item.proof_point || '');
            const numStr = String(idx + 1).padStart(2, '0');

            const lines = isZh ? [
                `❓【买家疑虑 #${numStr}】：${q}`,
                `💬【客服高转化说辞】：\n${a}`,
                proof ? `🔒【事实背书/质保】：${proof}` : ''
            ].filter(Boolean) : [
                `❓ [Buyer Objection #${numStr}]: ${q}`,
                `💬 [Sales Defense & Response]:\n${a}`,
                proof ? `🔒 [Proof Point & Warranty]: ${proof}` : ''
            ].filter(Boolean);

            return lines.join('\n');
        });

        const header = isZh
            ? `🛡️【${d.product_name ? xp_getI18nText(d.product_name) : '单品'} · 买家异议预判与客服攻防库】\n`
            : `🛡️ [${d.product_name ? xp_getI18nText(d.product_name) : 'Product'} Customer Objection Defense Q&A]\n`;

        const fullText = header + '\n' + blocks.join('\n\n-------------------------\n\n');

        return xp_fallbackCopyText(fullText).then(() => {
            const btn = xp_getEl('xp-copyAllObjectionsBtn');
            if (btn) {
                const orig = btn.innerHTML;
                btn.innerHTML = `<i class="ph ph-check"></i><span>${isZh ? '全部已复制' : 'All Copied'}</span>`;
                if (typeof setTimeout === 'function') {
                    setTimeout(() => {
                        btn.innerHTML = orig;
                        btn.classList.remove('xp-copied');
                    }, 1500);
                } else {
                    btn.innerHTML = orig;
                    btn.classList.remove('xp-copied');
                }
            }
            if (typeof showToast === 'function') {
                showToast(isZh ? `已复制全部 ${d.customer_objections.length} 条客服攻防话术` : `Copied all ${d.customer_objections.length} objection Q&A items`, 'success');
            }
        }).catch(err => {
            console.error('Copy all objections failed:', err);
        });
    }

    if (typeof window !== 'undefined') {
        window.xp_extractAdAngleText = xp_extractAdAngleText;
        window.xp_parseAdAngle = xp_parseAdAngle;
        window.xp_detectRegion = xp_detectRegion;
        window.xp_renderSingleTldr = xp_renderSingleTldr;
        window.xp_transferToDetails = xp_transferToDetails;
        window.xp_transferToListing = xp_transferToListing;
        window.xp_transferToAds = xp_transferToAds;
        window.xp_extractProfileFromAnalysis = xp_extractProfileFromAnalysis;
        window.xp_inferCategoryFromText = xp_inferCategoryFromText;
        window.xp_transferToBrandProfile = xp_transferToBrandProfile;
        window.xp_transferMatrixToDetails = xp_transferMatrixToDetails;
        window.xp_transferMatrixToListing = xp_transferMatrixToListing;
        window.xp_transferMatrixToAds = xp_transferMatrixToAds;
        window.xp_copyTldrSummary = xp_copyTldrSummary;
        window.xp_copyAdAngleScript = xp_copyAdAngleScript;
        window.xp_copyObjection = xp_copyObjection;
        window.xp_copyAllObjections = xp_copyAllObjections;
    }

    function xp_isRecommendDecision(decision) {
        const text = String(decision || '').toLowerCase();
        if (text.includes('不建议') || text.includes('not recommend') || text.includes('not recommended')) return false;
        return text.includes('强烈建议') || text.includes('优先') || text.includes('建议进入') || text.includes('recommend');
    }

    function xp_investmentScore(scoreObj) {
        const opp = Number(scoreObj?.opportunity_score || 0);
        const diff = Number(scoreObj?.difficulty_score || 0);
        return opp + (100 - diff);
    }

    function xp_showError(errorMsg, message) {
        if (!errorMsg) return;
        const text = typeof message === 'string' ? xp_getI18nText(message) : String(message || '');
        const isCrawlerError = /firecrawl/i.test(text) || text.includes('抓取');
        if (isCrawlerError && typeof document !== 'undefined') {
            errorMsg.innerHTML = '';
            const textSpan = document.createElement('span');
            textSpan.textContent = text;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'xp-error-action-btn';
            btn.textContent = '👉 前往系统设置配置 Key';
            btn.setAttribute('onclick', 'xp_openCrawlerSettings()');
            btn.onclick = () => xp_openCrawlerSettings();
            errorMsg.appendChild(textSpan);
            errorMsg.appendChild(document.createTextNode(' '));
            errorMsg.appendChild(btn);
        } else {
            errorMsg.textContent = text;
        }
        errorMsg.classList.remove('xp-hidden');
    }

    function xp_openCrawlerSettings() {
        if (typeof switchMainTab === 'function') {
            switchMainTab('settings');
        }
        setTimeout(() => {
            if (typeof document === 'undefined') return;
            const card = document.getElementById('settingsCrawlerCard');
            if (card) {
                if (typeof card.scrollIntoView === 'function') {
                    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                card.classList.remove('settings-highlight-pulse');
                void card.offsetWidth; // force reflow
                card.classList.add('settings-highlight-pulse');
            }
            const keyInput = document.getElementById('settingsFirecrawlApiKey');
            if (keyInput && typeof keyInput.focus === 'function') {
                keyInput.focus();
            }
        }, 150);
    }

    if (typeof window !== 'undefined') {
        window.xp_resetAnalysisSession = xp_resetAnalysisSession;
        window.xp_openCrawlerSettings = xp_openCrawlerSettings;
    }

    function xp_hideError(errorMsg) {
        if (!errorMsg) return;
        errorMsg.classList.add('xp-hidden');
        errorMsg.textContent = '';
    }

    // ─── 恢复会话 ─────────────────────────────────────────────────────────────
    function xp_restoreSession() {
        try {
            const savedResponse = localStorage.getItem(XP_STORAGE_KEY);
            const savedUrls = localStorage.getItem(XP_STORAGE_URLS_KEY);
            if (savedResponse) {
                let parsed = JSON.parse(savedResponse);
                // 兼容旧版或直接存储的数据部
                if (parsed && !parsed.template_type && (parsed.products || parsed.single_data)) {
                    parsed = { status: 'success', template_type: parsed.single_data ? 'single' : 'matrix', data: parsed };
                }
                xp_currentResponse = parsed;

                const urlsInputContainer = xp_getEl('xp-urlsInputContainer');
                const urlInputField = xp_getEl('xp-urlInputField');
                const tagsList = xp_getEl('xp-tagsList');
                const urlCounter = xp_getEl('xp-urlCounter');

                if (savedUrls) {
                    try {
                        const urls = JSON.parse(savedUrls);
                        urls.forEach(u => xp_addUrlTag(u, tagsList, urlInputField, urlCounter));
                    } catch (e) { }
                }
                xp_renderResults(xp_currentResponse);
            }
        } catch (e) {
            console.warn('Failed to restore XP session:', e);
            localStorage.removeItem(XP_STORAGE_KEY);
            localStorage.removeItem(XP_STORAGE_URLS_KEY);
        }
    }

    // ─── 分析流程 ─────────────────────────────────────────────────────────────
    async function xp_handleAnalyze(analyzeBtn, urlInputField, tagsList, urlCounter, errorMsg, loadingSection, resultSection) {
        let rawUrls = [...xp_urlsArray];
        const pendingUrl = xp_normalizeUrl(urlInputField.value);
        if (pendingUrl && !rawUrls.includes(pendingUrl)) {
            rawUrls.push(pendingUrl);
            xp_addUrlTag(pendingUrl, tagsList, urlInputField, urlCounter);
            urlInputField.value = '';
        }
        if (rawUrls.length === 0) {
            xp_showError(errorMsg, '请输入至少一个有效链接。');
            return;
        }

        xp_hideError(errorMsg);
        const hasExistingResult = !!xp_currentResponse;
        if (!hasExistingResult) {
            resultSection.classList.add('xp-hidden');
        }
        xp_winnerIndex = -1;
        loadingSection.classList.remove('xp-hidden');
        analyzeBtn.disabled = true;
        analyzeBtn.innerHTML = hasExistingResult
            ? '正在刷新... <div class="xp-spinner" style="width:15px;height:15px;border-width:2px;display:inline-block;"></div>'
            : '正在解构中... <div class="xp-spinner" style="width:15px;height:15px;border-width:2px;display:inline-block;"></div>';

        let elapsedSeconds = 0;
        let timerInterval = null;
        const stageLabel = xp_getEl('xp-loadingStageLabel');
        const progressBar = xp_getEl('xp-progressBar');
        const timerLabel = xp_getEl('xp-elapsedTimer');

        const updateStageUI = (seconds) => {
            if (timerLabel) {
                timerLabel.textContent = `已耗时: ${seconds}s`;
            }
            if (stageLabel && progressBar) {
                if (seconds < 5) {
                    stageLabel.textContent = '阶段 1/3: 网页深度抓取与 DOM 解析中...';
                    if (progressBar.style) progressBar.style.width = '25%';
                } else if (seconds < 15) {
                    stageLabel.textContent = '阶段 2/3: 核心卖点、客诉痛点与规格提炼中...';
                    if (progressBar.style) progressBar.style.width = '60%';
                } else {
                    stageLabel.textContent = '阶段 3/3: 竞争攻防策略与战力卡生成中...';
                    if (progressBar.style) progressBar.style.width = '85%';
                }
            }
        };
        updateStageUI(0);
        if (typeof setInterval === 'function') {
            timerInterval = setInterval(() => {
                elapsedSeconds++;
                updateStageUI(elapsedSeconds);
            }, 1000);
        }

        try {
            const response = await fetch(XP_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ urls: rawUrls, force_refresh: true, mode: xp_currentMode })
            });
            const resData = await response.json();
            if (resData.status === 'success') {
                xp_currentResponse = resData;
                try {
                    localStorage.setItem(XP_STORAGE_KEY, JSON.stringify(xp_currentResponse));
                    localStorage.setItem(XP_STORAGE_URLS_KEY, JSON.stringify(rawUrls));
                } catch (e) { console.warn('localStorage save failed:', e); }
                xp_renderResults(xp_currentResponse);
            } else {
                xp_showError(errorMsg, resData.message || '分析过程中发生错误。');
            }
        } catch (error) {
            console.error('API Error:', error);
            xp_showError(errorMsg, '无法连接到服务器，请确保后端服务在 http://localhost:9503 运行。');
        } finally {
            if (timerInterval && typeof clearInterval === 'function') {
                clearInterval(timerInterval);
            }
            if (progressBar && progressBar.style) {
                progressBar.style.width = '100%';
            }
            loadingSection.classList.add('xp-hidden');
            analyzeBtn.disabled = false;
            analyzeBtn.innerHTML = '<span>分析对比</span> <span>→</span>';
        }
    }

    // ─── 渲染路由 ─────────────────────────────────────────────────────────────
    window.xp_renderResults = function (response) {
        xp_currentResponse = response; // 同步状态，使导出按钮生效
        const { template_type, data, message } = response;
        const resultSection = xp_getEl('xp-resultSection');
        const singleTemplate = xp_getEl('xp-single-template');
        const matrixTemplate = xp_getEl('xp-matrix-template');

        try {
            if (template_type === 'single') {
                singleTemplate.classList.remove('xp-hidden');
                matrixTemplate.classList.add('xp-hidden');
                xp_renderSingleTemplate(data.single_data, (data.scores && data.scores.length > 0) ? data.scores[0] : null);
            } else {
                matrixTemplate.classList.remove('xp-hidden');
                singleTemplate.classList.add('xp-hidden');
                xp_renderMatrixTemplate(data);
            }
        } catch (renderError) {
            console.error('Render error:', renderError);
        }

        resultSection.classList.remove('xp-hidden');
    }

    // ─── 品牌心智与价值主张渲染 (competitor-profiling) ──────────────────────────
    function xp_renderBrandPositioning(d) {
        const section = xp_getEl('xp-singleBrandPosSection');
        const target = xp_getEl('xp-singleBrandPositioning');
        if (!section || !target) return;

        const bp = d && d.brand_positioning;
        if (!bp || (!bp.tagline && !bp.positioning_angle && (!bp.trust_triggers || bp.trust_triggers.length === 0))) {
            section.classList.add('xp-hidden');
            target.innerHTML = '';
            return;
        }

        const isZh = xp_currentLang === 'zh';
        const tagline = bp.tagline ? xp_processText(xp_getI18nText(bp.tagline)) : '';
        const angle = bp.positioning_angle ? xp_getI18nText(bp.positioning_angle) : '';
        const triggers = Array.isArray(bp.trust_triggers) ? bp.trust_triggers : [];

        let trustChipsHtml = '';
        if (triggers.length > 0) {
            trustChipsHtml = triggers.map(t => {
                const text = xp_getI18nText(typeof t === 'string' ? t : (t.text || t.item || ''));
                return text ? `<span class="xp-trust-chip"><i class="ph-fill ph-seal-check"></i> ${xp_processText(text)}</span>` : '';
            }).filter(Boolean).join('');
        }

        const trustLabel = isZh ? '信任背书 / 权威背书' : 'Trust Triggers / Social Proof';

        target.innerHTML = `
            <div class="xp-brand-pos-header">
                <div class="xp-brand-tagline">“${tagline || (isZh ? '核心价值主张未明示' : 'Value proposition not stated')}”</div>
                ${angle ? `<span class="xp-brand-angle-badge"><i class="ph-fill ph-compass"></i> ${angle}</span>` : ''}
            </div>
            ${trustChipsHtml ? `
                <div class="xp-brand-trust-container">
                    <span class="xp-brand-trust-label">${trustLabel}:</span>
                    ${trustChipsHtml}
                </div>` : ''}
        `;
        section.classList.remove('xp-hidden');
    }

    // ─── 统一标准化攻防战术盘数据结构 (兼容 competitor_moat / competitor_strengths 等新旧别名) ─
    function xp_normalizeBattleCard(bc) {
        if (!bc || typeof bc !== 'object') return null;
        const toList = (v) => {
            if (!v) return [];
            if (Array.isArray(v)) return v;
            if (typeof v === 'string') return [v];
            return [];
        };

        const moat = toList(bc.competitor_moat?.length ? bc.competitor_moat : (bc.competitor_strengths?.length ? bc.competitor_strengths : (bc.moat || [])));
        const attack = toList(bc.attack_vector?.length ? bc.attack_vector : (bc.attack_angles?.length ? bc.attack_angles : (bc.attack_angle || [])));
        const whitespace = toList(bc.whitespace_opportunities?.length ? bc.whitespace_opportunities : (bc.whitespace || bc.opportunities || []));
        const threat = toList(bc.threat_radar?.length ? bc.threat_radar : (bc.potential_threats?.length ? bc.potential_threats : (bc.threats || [])));

        return {
            ...bc,
            competitor_moat: moat,
            attack_vector: attack,
            whitespace_opportunities: whitespace,
            threat_radar: threat,
            competitor_strengths: moat,
            attack_angles: attack,
            potential_threats: threat
        };
    }

    // ─── 跨境攻防对抗战术盘渲染 (competitor-profiling) ──────────────────────────
    function xp_renderBattleCard(d) {
        const section = xp_getEl('xp-singleBattleSection');
        const target = xp_getEl('xp-singleBattleCard');
        if (!section || !target) return;

        const bc = xp_normalizeBattleCard(d && d.battle_card);
        if (!bc || (!bc.competitor_moat?.length && !bc.attack_vector?.length && !bc.whitespace_opportunities?.length && !bc.threat_radar?.length)) {
            section.classList.add('xp-hidden');
            target.innerHTML = '';
            return;
        }

        const isZh = xp_currentLang === 'zh';
        const renderList = (items) => {
            if (!items || items.length === 0) return `<li style="opacity:0.6;">-</li>`;
            return items.map(item => {
                const text = xp_getI18nText(typeof item === 'string' ? item : (item.text || item.point || item.detail || ''));
                return `<li>${xp_processText(text)}</li>`;
            }).join('');
        };

        target.innerHTML = `
            <div class="xp-battle-col xp-battle-col-strong">
                <div class="xp-battle-col-header">
                    <div class="xp-battle-col-title">
                        <i class="ph-fill ph-shield-check"></i>
                        <span>${isZh ? '竞品防守强区 (壁垒)' : 'Competitor Moat'}</span>
                    </div>
                    <span class="xp-battle-subtag">${isZh ? '避其锋芒' : 'Avoid Head-on'}</span>
                </div>
                <ul class="xp-battle-list">${renderList(bc.competitor_moat)}</ul>
            </div>
            <div class="xp-battle-col xp-battle-col-attack">
                <div class="xp-battle-col-header">
                    <div class="xp-battle-col-title">
                        <i class="ph-fill ph-sword"></i>
                        <span>${isZh ? '我方主攻破局点 (打痛点)' : 'Attack Vector'}</span>
                    </div>
                    <span class="xp-battle-subtag">${isZh ? '痛点暴击' : 'High Impact'}</span>
                </div>
                <ul class="xp-battle-list">${renderList(bc.attack_vector)}</ul>
            </div>
            <div class="xp-battle-col xp-battle-col-whitespace">
                <div class="xp-battle-col-header">
                    <div class="xp-battle-col-title">
                        <i class="ph-fill ph-sparkle"></i>
                        <span>${isZh ? '蓝海生态空白 (机会)' : 'Whitespace Opportunities'}</span>
                    </div>
                    <span class="xp-battle-subtag">${isZh ? '未被满足' : 'Underserved'}</span>
                </div>
                <ul class="xp-battle-list">${renderList(bc.whitespace_opportunities)}</ul>
            </div>
            <div class="xp-battle-col xp-battle-col-threat">
                <div class="xp-battle-col-header">
                    <div class="xp-battle-col-title">
                        <i class="ph-fill ph-warning"></i>
                        <span>${isZh ? '潜在反扑威胁 (预警)' : 'Threat Radar'}</span>
                    </div>
                    <span class="xp-battle-subtag">${isZh ? '防备报复' : 'Retaliation'}</span>
                </div>
                <ul class="xp-battle-list">${renderList(bc.threat_radar)}</ul>
            </div>
        `;
        section.classList.remove('xp-hidden');
    }

    // ─── 买家异议预判与客服攻防库渲染 (competitor-profiling) ───────────────────
    function xp_renderObjections(d) {
        const section = xp_getEl('xp-singleObjectionsSection');
        const list = xp_getEl('xp-singleObjectionsList');
        if (!section || !list) return;

        const objections = d && d.customer_objections;
        if (!Array.isArray(objections) || objections.length === 0) {
            section.classList.add('xp-hidden');
            list.innerHTML = '';
            return;
        }

        const isZh = xp_currentLang === 'zh';
        const cardsHtml = objections.map((item, idx) => {
            const q = xp_processText(item.objection || '');
            const a = xp_processText(item.response || '');
            const proof = item.proof_point ? xp_processText(item.proof_point) : '';

            return `
                <div class="xp-objection-card">
                    <div class="xp-objection-header">
                        <div class="xp-objection-q">
                            <span class="xp-objection-tag-q">Q${idx + 1}</span>
                            <span>${q}</span>
                        </div>
                        <button class="xp-ad-copy-btn xp-objection-copy-btn" data-index="${idx}" onclick="xp_copyObjection(${idx})" title="${isZh ? '一键复制该问答话术' : 'Copy Q&A'}">
                            <i class="ph ph-copy"></i>
                            <span>${isZh ? '复制话术' : 'Copy'}</span>
                        </button>
                    </div>
                    <div class="xp-objection-a">
                        <div class="xp-objection-tag-a">
                            <i class="ph-fill ph-chat-circle-dots"></i>
                            <span>${isZh ? '客服高转化应对策略' : 'Sales & Defense Response'}</span>
                        </div>
                        <div style="white-space:pre-wrap;">${a}</div>
                    </div>
                    ${proof ? `
                        <div class="xp-objection-proof">
                            <i class="ph-fill ph-seal-check"></i>
                            <span><strong>${isZh ? '背书论据/质保承诺' : 'Proof Point / Warranty'}:</strong> ${proof}</span>
                        </div>` : ''}
                </div>
            `;
        }).join('');

        list.innerHTML = cardsHtml;
        section.classList.remove('xp-hidden');
    }

    // ─── 2D 市场定位象限图 SVG 生成器 (competitor-profiling) ────────────────────
    function xp_generatePositioningMapSvg(mapData, isMatrix, fullData, lang = 'zh') {
        const isZh = lang === 'zh';
        const esc = (str) => String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');

        const width = 640;
        const height = 400;
        const padLeft = 85;
        const padRight = 45;
        const padTop = 45;
        const padBottom = 55;
        const plotW = width - padLeft - padRight;
        const plotH = height - padTop - padBottom;
        const midX = padLeft + plotW / 2;
        const midY = padTop + plotH / 2;

        const mapX = (val) => {
            const num = Math.max(5, Math.min(95, typeof val === 'number' ? val : 50));
            return padLeft + (num / 100) * plotW;
        };
        const mapY = (val) => {
            const num = Math.max(5, Math.min(95, typeof val === 'number' ? val : 50));
            return padTop + plotH - (num / 100) * plotH;
        };

        const q1Title = isZh ? '质价比破局区' : 'Value Breakthrough';
        const q1Sub = isZh ? '高功能 · 亲民价' : 'High Pro · Value';
        const q2Title = isZh ? '旗舰高端区' : 'Premium Flagship';
        const q2Sub = isZh ? '高功能 · 高定价' : 'High Pro · High Price';
        const q3Title = isZh ? '大众基础区' : 'Mass Budget';
        const q3Sub = isZh ? '基础功能 · 低价' : 'Basic · Low Price';
        const q4Title = isZh ? '品牌溢价区' : 'Overpriced';
        const q4Sub = isZh ? '基础功能 · 高溢价' : 'Basic · Premium';

        let nodesSvg = '';
        let legendItems = [];

        if (!isMatrix) {
            const d = fullData || {};
            const pos = mapData || d.quadrant_position || {};
            const cX = typeof pos.x === 'number' ? pos.x : 55;
            const cY = typeof pos.y === 'number' ? pos.y : 55;
            const compRawName = pos.label || (typeof d.product_name === 'object' ? (d.product_name.zh || d.product_name.en) : d.product_name) || (isZh ? '当前竞品' : 'Competitor');
            const compName = esc(String(compRawName).length > 14 ? String(compRawName).slice(0, 12) + '…' : compRawName);

            const nodeCx = mapX(cX);
            const nodeCy = mapY(cY);

            nodesSvg += `
                <g class="xp-map-node">
                    <circle cx="${nodeCx}" cy="${nodeCy}" r="12" fill="#ef4444" stroke="#ffffff" stroke-width="3" filter="url(#shadow)" />
                    <circle cx="${nodeCx}" cy="${nodeCy}" r="5" fill="#ffffff" />
                    <rect x="${nodeCx - 60}" y="${nodeCy - 34}" width="120" height="22" rx="5" fill="#991b1b" opacity="0.92" />
                    <text x="${nodeCx}" y="${nodeCy - 19}" font-size="10" font-weight="700" fill="#ffffff" text-anchor="middle">${compName}</text>
                </g>
            `;

            const attack = pos.recommended_attack || {};
            const recX = typeof attack.x === 'number' ? attack.x : (cX >= 50 ? Math.max(25, cX - 35) : 38);
            const recY = typeof attack.y === 'number' ? attack.y : (cY >= 50 ? Math.min(88, cY + 12) : 80);
            const recLabel = esc(attack.label || (isZh ? '★ 我方建议破局点' : '★ Recommended Entry'));

            const recCx = mapX(recX);
            const recCy = mapY(recY);

            nodesSvg += `
                <path d="M ${nodeCx} ${nodeCy} Q ${(nodeCx + recCx) / 2} ${(nodeCy + recCy) / 2 - 24} ${recCx} ${recCy}"
                      fill="none" stroke="#10b981" stroke-width="2.5" stroke-dasharray="4 4" marker-end="url(#arrow)" opacity="0.85" />
                <g class="xp-map-node">
                    <circle cx="${recCx}" cy="${recCy}" r="14" fill="#10b981" stroke="#ffffff" stroke-width="3.5" filter="url(#shadow)" />
                    <text x="${recCx}" y="${recCy + 4}" font-size="14" font-weight="900" fill="#ffffff" text-anchor="middle">★</text>
                    <rect x="${recCx - 65}" y="${recCy - 34}" width="130" height="22" rx="5" fill="#047857" />
                    <text x="${recCx}" y="${recCy - 19}" font-size="10" font-weight="800" fill="#ffffff" text-anchor="middle">${recLabel}</text>
                </g>
            `;

            legendItems = [
                { color: '#ef4444', text: isZh ? '当前分析竞品' : 'Competitor' },
                { color: '#10b981', text: isZh ? '★ 建议切入破局高地' : '★ Recommended Whitespace Entry' }
            ];
        } else {
            const products = (fullData && fullData.products) || [];
            const comparison = (fullData && fullData.comparison) || {};
            const winnerProduct = comparison.winner_product || '';
            const matrixMap = mapData || (fullData && fullData.quadrant_map) || {};
            const positions = matrixMap.positions || [];
            const colors = ['#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4'];

            products.forEach((p, idx) => {
                const posItem = positions[idx] || p.quadrant_position || {};
                const defX = 30 + (idx * 25) % 60;
                const defY = 40 + (idx * 30) % 55;
                const posX = typeof posItem.x === 'number' ? posItem.x : defX;
                const posY = typeof posItem.y === 'number' ? posItem.y : defY;
                const pNameRaw = posItem.label || (typeof p.product_name === 'object' ? (p.product_name.zh || p.product_name.en) : p.product_name) || `竞品 #${idx + 1}`;
                const isWinner = winnerProduct && String(pNameRaw).toLowerCase().includes(String(winnerProduct).toLowerCase().slice(0, 8));

                const cx = mapX(posX);
                const cy = mapY(posY);
                const color = isWinner ? '#8b5cf6' : (colors[idx % colors.length]);
                const pName = esc(String(pNameRaw).length > 12 ? String(pNameRaw).slice(0, 10) + '…' : pNameRaw);

                nodesSvg += `
                    <g class="xp-map-node">
                        <circle cx="${cx}" cy="${cy}" r="${isWinner ? 13 : 9}" fill="${color}" stroke="#ffffff" stroke-width="${isWinner ? 3 : 2}" filter="url(#shadow)" />
                        ${isWinner ? `<text x="${cx}" y="${cy + 4}" font-size="10" fill="#ffffff" text-anchor="middle">👑</text>` : ''}
                        <rect x="${cx - 50}" y="${cy - 30}" width="100" height="20" rx="4" fill="#1e293b" opacity="0.88" />
                        <text x="${cx}" y="${cy - 16}" font-size="9" font-weight="700" fill="#ffffff" text-anchor="middle">${pName}</text>
                    </g>
                `;
            });

            const recAttack = matrixMap.recommended_attack || {};
            const recX = typeof recAttack.x === 'number' ? recAttack.x : 35;
            const recY = typeof recAttack.y === 'number' ? recAttack.y : 85;
            const rx = mapX(recX);
            const ry = mapY(recY);
            const rLabel = esc(recAttack.label || (isZh ? '★ 蓝海破局切入点' : '★ Whitespace Opportunity'));

            nodesSvg += `
                <g class="xp-map-node">
                    <circle cx="${rx}" cy="${ry}" r="14" fill="#10b981" stroke="#ffffff" stroke-width="3" filter="url(#shadow)" />
                    <text x="${rx}" y="${ry + 4}" font-size="14" font-weight="900" fill="#ffffff" text-anchor="middle">★</text>
                    <rect x="${rx - 65}" y="${ry - 32}" width="130" height="20" rx="4" fill="#047857" />
                    <text x="${rx}" y="${ry - 18}" font-size="10" font-weight="800" fill="#ffffff" text-anchor="middle">${rLabel}</text>
                </g>
            `;

            legendItems = [
                { color: '#8b5cf6', text: isZh ? '👑 优选赢家竞品' : '👑 Winner Competitor' },
                { color: '#3b82f6', text: isZh ? '参评竞品' : 'Competitors' },
                { color: '#10b981', text: isZh ? '★ 我方建议破局高地' : '★ Recommended Entry' }
            ];
        }

        const legendSvg = legendItems.map((item, idx) => {
            const itemX = padLeft + idx * 170;
            return `
                <circle cx="${itemX}" cy="${height - 15}" r="5" fill="${item.color}" />
                <text x="${itemX + 10}" y="${height - 11}" font-size="11" font-weight="600" fill="#475569">${esc(item.text)}</text>
            `;
        }).join('');

        return `
<svg viewBox="0 0 ${width} ${height}" class="xp-positioning-svg" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:${width}px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <defs>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#0f172a" flood-opacity="0.18" />
        </filter>
        <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#10b981" />
        </marker>
    </defs>

    <!-- 4 Quadrant Backgrounds -->
    <rect x="${padLeft}" y="${padTop}" width="${plotW / 2}" height="${plotH / 2}" fill="#f0fdf4" />
    <rect x="${midX}" y="${padTop}" width="${plotW / 2}" height="${plotH / 2}" fill="#eef2ff" />
    <rect x="${padLeft}" y="${midY}" width="${plotW / 2}" height="${plotH / 2}" fill="#f8fafc" />
    <rect x="${midX}" y="${midY}" width="${plotW / 2}" height="${plotH / 2}" fill="#fffbeb" />

    <!-- Quadrant Labels -->
    <text x="${padLeft + 14}" y="${padTop + 24}" font-size="11" font-weight="800" fill="#059669">${esc(q1Title)}</text>
    <text x="${padLeft + 14}" y="${padTop + 38}" font-size="9" font-weight="500" fill="#10b981">${esc(q1Sub)}</text>

    <text x="${width - padRight - 14}" y="${padTop + 24}" font-size="11" font-weight="800" fill="#4338ca" text-anchor="end">${esc(q2Title)}</text>
    <text x="${width - padRight - 14}" y="${padTop + 38}" font-size="9" font-weight="500" fill="#6366f1" text-anchor="end">${esc(q2Sub)}</text>

    <text x="${padLeft + 14}" y="${padTop + plotH - 26}" font-size="11" font-weight="800" fill="#64748b">${esc(q3Title)}</text>
    <text x="${padLeft + 14}" y="${padTop + plotH - 12}" font-size="9" font-weight="500" fill="#94a3b8">${esc(q3Sub)}</text>

    <text x="${width - padRight - 14}" y="${padTop + plotH - 26}" font-size="11" font-weight="800" fill="#b45309" text-anchor="end">${esc(q4Title)}</text>
    <text x="${width - padRight - 14}" y="${padTop + plotH - 12}" font-size="9" font-weight="500" fill="#d97706" text-anchor="end">${esc(q4Sub)}</text>

    <!-- Outer Border -->
    <rect x="${padLeft}" y="${padTop}" width="${plotW}" height="${plotH}" fill="none" stroke="#e2e8f0" stroke-width="1.5" rx="8" />

    <!-- Dashed Cross Axes -->
    <line x1="${padLeft}" y1="${midY}" x2="${padLeft + plotW}" y2="${midY}" stroke="#cbd5e1" stroke-width="1.5" stroke-dasharray="4 4" />
    <line x1="${midX}" y1="${padTop}" x2="${midX}" y2="${padTop + plotH}" stroke="#cbd5e1" stroke-width="1.5" stroke-dasharray="4 4" />

    <!-- Axis Labels -->
    <text x="${padLeft}" y="${padTop + plotH + 20}" font-size="10" font-weight="700" fill="#64748b" text-anchor="start">${isZh ? '亲民平价 (Budget)' : 'Budget'}</text>
    <text x="${midX}" y="${padTop + plotH + 20}" font-size="11" font-weight="800" fill="#334155" text-anchor="middle">${isZh ? '价格与溢价区间 (Price Positioning) ➔' : 'Price Positioning ➔'}</text>
    <text x="${padLeft + plotW}" y="${padTop + plotH + 20}" font-size="10" font-weight="700" fill="#64748b" text-anchor="end">${isZh ? '高端旗舰 (Premium)' : 'Premium'}</text>

    <text x="${padLeft - 10}" y="${padTop + 14}" font-size="10" font-weight="700" fill="#64748b" text-anchor="end">${isZh ? '专业旗舰 (Pro)' : 'Pro'}</text>
    <text x="${padLeft - 10}" y="${midY + 4}" font-size="10" font-weight="800" fill="#334155" text-anchor="end">${isZh ? '功能专业度 ➔' : 'Feature Pro ➔'}</text>
    <text x="${padLeft - 10}" y="${padTop + plotH - 6}" font-size="10" font-weight="700" fill="#64748b" text-anchor="end">${isZh ? '大众基础 (Basic)' : 'Basic'}</text>

    <!-- Plot Nodes & Attacks -->
    ${nodesSvg}

    <!-- Legend -->
    <g class="xp-map-legend-group">
        ${legendSvg}
    </g>
</svg>`.trim();
    }

    // ─── 2D 市场定位象限图 DOM 挂载 ───────────────────────────────────────────
    function xp_renderPositioningMap(containerId, mapData, isMatrix, fullData) {
        const target = xp_getEl(containerId);
        if (!target) return;
        const svg = xp_generatePositioningMapSvg(mapData, isMatrix, fullData, xp_currentLang);
        target.innerHTML = `<div class="xp-map-svg-wrap">${svg}</div>`;
        const parentSection = target.closest('.xp-positioning-map-section') || target.parentElement;
        if (parentSection) {
            parentSection.classList.remove('xp-hidden');
        }
    }

    // ─── 单品深度模板 ─────────────────────────────────────────────────────────
    function xp_renderSingleTemplate(d, scoreObj = null) {
        if (!d) return;

        xp_currentSingleData = d;
        xp_currentScoreObj = scoreObj;

        // 极速选品决策看板 TL;DR (P1)
        xp_renderSingleTldr(d, scoreObj);

        // 品牌心智与价值主张 (competitor-profiling)
        xp_renderBrandPositioning(d);

        // 2D 市场定位象限图 (competitor-profiling)
        xp_renderPositioningMap('xp-singlePositioningMap', d.quadrant_position, false, d);

        // 跨境攻防对抗战术盘 (competitor-profiling)
        xp_renderBattleCard(d);

        const singleScore = xp_getEl('xp-singleScore');
        const singleHero = xp_getEl('xp-singleHero');
        const singleAudience = xp_getEl('xp-singleAudience');
        const singleScenarios = xp_getEl('xp-singleScenarios');
        const singlePainPoints = xp_getEl('xp-singlePainPoints');
        const singleTraffic = xp_getEl('xp-singleTraffic');
        const singleAdAngles = xp_getEl('xp-singleAdAngles');
        const singleStrengths = xp_getEl('xp-singleStrengths');
        const singleWeaknesses = xp_getEl('xp-singleWeaknesses');
        const singleDiffOpps = xp_getEl('xp-singleDiffOpps');
        const singleRec = xp_getEl('xp-singleRec');
        const singleVoc = xp_getEl('xp-singleVoc');

        const conf = (c) => {
            if (!c) return '';
            const map = { high: 'xp-conf-high', medium: 'xp-conf-medium', low: 'xp-conf-low' };
            const labelZh = c === 'high' ? '高置信度' : c === 'low' ? '低置信度' : '中置信度';
            const labelEn = c.charAt(0).toUpperCase() + c.slice(1) + ' Confidence';
            return `<span class="xp-conf-badge ${map[c] || 'xp-conf-medium'}">${xp_currentLang === 'zh' ? labelZh : labelEn}</span>`;
        };

        // 投资评分卡
        try {
            if (singleScore && scoreObj && typeof scoreObj === 'object') {
                const dScore = scoreObj.difficulty_score || 0;
                const oScore = scoreObj.opportunity_score || 0;
                const diffClass = dScore >= 80 ? 'xp-diff-high' : (dScore >= 50 ? 'xp-diff-mid' : 'xp-diff-low');
                const diffLabel = xp_currentLang === 'zh' ? (dScore >= 80 ? '极高难度' : (dScore >= 50 ? '中等难度' : '低难度')) : (dScore >= 80 ? 'High' : (dScore >= 50 ? 'Medium' : 'Low'));
                const decision = xp_getI18nText(scoreObj.final_decision || '-');
                const isWinner = xp_isRecommendDecision(decision);
                const decisionClass = isWinner ? 'xp-decision-winner' : 'xp-decision-neutral';
                const decisionReason = xp_processText(scoreObj.decision_details ? (scoreObj.decision_details.reason || '') : '');

                let evalHtml = '';
                if (scoreObj.evaluation_details && scoreObj.evaluation_details.length > 0) {
                    evalHtml = `<div class="xp-score-eval-list">` +
                        scoreObj.evaluation_details.map(ed => `
                            <div class="xp-score-eval-item">
                                <div class="xp-score-eval-dim">${xp_getI18nText(ed.dimension)}</div>
                                <div class="xp-score-eval-detail">${xp_getI18nText(ed.detail)}</div>
                            </div>`).join('') + `</div>`;
                }

                singleScore.innerHTML = `
                    <div class="xp-card xp-score-card xp-single-score-card">
                        <div class="xp-score-main-flex">
                            <div class="xp-score-item-box">
                                <div class="xp-score-label-small">${xp_currentLang === 'zh' ? '机会分' : 'Opportunity'}</div>
                                <div class="xp-score-value-big xp-opp-text">${oScore}</div>
                            </div>
                            <div class="xp-score-divider"></div>
                            <div class="xp-score-item-box">
                                <div class="xp-score-label-small">${xp_currentLang === 'zh' ? '难度分' : 'Difficulty'}</div>
                                <div class="xp-score-value-big xp-diff-text">${dScore}</div>
                                <div class="xp-difficulty-indicator ${diffClass}">${diffLabel}</div>
                            </div>
                            <div class="xp-score-divider"></div>
                            <div class="xp-decision-container" style="flex:1;">
                                <div class="xp-decision-header">
                                    <div class="xp-score-label-small">${xp_currentLang === 'zh' ? '投资结论' : 'Decision'}</div>
                                    <div class="xp-decision-badge ${decisionClass}">${decision}</div>
                                </div>
                                <div class="xp-decision-reason">${decisionReason}</div>
                            </div>
                        </div>
                        ${evalHtml}
                    </div>`;
                singleScore.classList.remove('xp-hidden');
            } else if (singleScore) {
                singleScore.classList.add('xp-hidden');
            }
        } catch (err) { console.error('Single score render failed:', err); }

        // Hero
        const sellingPoints = (d.core_selling_points || []).map(sp => {
            const text = xp_processText(typeof sp === 'object' ? (sp.point || '') : String(sp));
            const badge = typeof sp === 'object' ? conf(sp.confidence) : '';
            return `<div class="xp-single-hero-point">${text} ${badge}</div>`;
        }).join('');

        singleHero.innerHTML = `
            <div class="xp-single-hero-name">${xp_getI18nText(d.product_name || '')}</div>
            <div class="xp-single-hero-price">
                <span>${xp_getI18nText(d.price || '')}</span>
                <span style="font-size:0.9rem;opacity:0.6;margin-left:1rem;">(${xp_currentLang === 'zh' ? '评价数' : 'Reviews'}: ${xp_getI18nText(d.reviews_count || '0')})</span>
            </div>
            <div class="xp-single-hero-points">${sellingPoints}</div>`;

        // 消费者画像
        let personaHtml = `<div class="xp-persona-info-list">`;
        personaHtml += `<div class="xp-persona-info-item"><strong>${xp_currentLang === 'zh' ? '年龄段：' : 'Age Range: '}</strong><span>${xp_getI18nText(d.age_range || '-')}</span></div>`;
        const countries = (d.target_countries || []).map(c => xp_getI18nText(c)).join(', ');
        personaHtml += `<div class="xp-persona-info-item"><strong>${xp_currentLang === 'zh' ? '适合投放的国家：' : 'Target Countries: '}</strong><span>${countries || '-'}</span></div>`;
        const audiences = (d.target_audience || []).map(t => {
            const text = typeof t === 'object' ? (t.audience || t.item || '') : String(t);
            return xp_getI18nText(text).trim();
        }).filter(t => t).join('、');
        personaHtml += `<div class="xp-persona-info-item"><strong>${xp_currentLang === 'zh' ? '用户群体：' : 'User Groups: '}</strong><span>${audiences || '-'}</span></div>`;
        personaHtml += `</div>`;
        singleAudience.innerHTML = personaHtml;

        // 使用场景
        singleScenarios.innerHTML = (d.use_scenarios || []).map(s => {
            const text = typeof s === 'object' ? (s.scenario || s.item || '') : String(s);
            const cleanText = xp_getI18nText(text).trim();
            return cleanText ? `<span class="xp-single-tag xp-scenario">${cleanText}</span>` : '';
        }).join('');

        // 痛点
        singlePainPoints.innerHTML = (d.user_pain_points || []).map(pp => {
            const text = xp_processText(typeof pp === 'object' ? (pp.pain || '') : String(pp));
            const badge = typeof pp === 'object' ? conf(pp.confidence) : '';
            return `<div class="xp-single-pain-card">${text} ${badge}</div>`;
        }).join('');

        // 流量策略
        const trafficItems = (d.traffic_strategy || []).map(t => {
            const channel = xp_getI18nText(t.channel);
            const detail = xp_processText(t.detail);
            return `<div class="xp-traffic-item"><div class="xp-traffic-channel">${channel}</div><div class="xp-traffic-detail">${detail}</div></div>`;
        }).join('');
        singleTraffic.innerHTML = `<h3>${xp_currentLang === 'zh' ? '主要流量渠道' : 'Main Traffic Channel'}</h3>${trafficItems || '<p>-</p>'}`;

        // 广告切入角度 (升级为分镜头结构化卡片展示，P1)
        const adAngles = d.ad_angles || [];
        let adCardsHtml = '';
        if (adAngles.length > 0) {
            adCardsHtml = `<div class="xp-ad-script-list">` + adAngles.map((a, idx) => {
                const parsed = xp_parseAdAngle(a);
                const angle = xp_processText(xp_getI18nText(parsed.angle || ''));
                const hook = xp_processText(xp_getI18nText(parsed.hook || ''));
                const script = xp_processText(xp_getI18nText(parsed.script || ''));
                const cta = xp_processText(xp_getI18nText(parsed.cta_hashtags || ''));
                const num = String(idx + 1).padStart(2, '0');

                let bodyHtml = '';
                if (hook) {
                    bodyHtml += `
                        <div class="xp-ad-section-box xp-ad-hook-box">
                            <div class="xp-ad-sublabel">
                                <i class="ph-fill ph-target text-amber-500"></i>
                                <span>${xp_currentLang === 'zh' ? '前 3 秒黄金视听钩子 (Hook)' : '3-Sec Hook'}</span>
                            </div>
                            <div class="xp-ad-text-content">${hook}</div>
                        </div>`;
                }
                if (script) {
                    bodyHtml += `
                        <div class="xp-ad-section-box xp-ad-script-box">
                            <div class="xp-ad-sublabel">
                                <i class="ph-fill ph-film-slate text-indigo-500"></i>
                                <span>${xp_currentLang === 'zh' ? '分镜头核心反差与台词 (Script)' : 'Scene Breakdown & Script'}</span>
                            </div>
                            <div class="xp-ad-text-content" style="white-space:pre-wrap;">${script}</div>
                        </div>`;
                }
                if (cta) {
                    bodyHtml += `
                        <div class="xp-ad-section-box xp-ad-cta-box">
                            <div class="xp-ad-sublabel">
                                <i class="ph-fill ph-megaphone-simple text-emerald-600"></i>
                                <span>${xp_currentLang === 'zh' ? '行动号召与话题标签 (CTA & Hashtags)' : 'CTA & Hashtags'}</span>
                            </div>
                            <div class="xp-ad-text-content xp-ad-cta-text">${cta}</div>
                        </div>`;
                }
                if (!hook && !script && !cta) {
                    bodyHtml += `
                        <div class="xp-ad-section-box xp-ad-script-box">
                            <div class="xp-ad-text-content">${angle}</div>
                        </div>`;
                }

                return `
                    <div class="xp-ad-script-card">
                        <div class="xp-ad-script-header">
                            <div class="xp-ad-script-badge">
                                <i class="ph-fill ph-video-camera"></i>
                                <span>脚本 #${num}${(hook || script) ? ` · ${angle}` : ''}</span>
                            </div>
                            <button class="xp-ad-copy-btn" data-index="${idx}" onclick="xp_copyAdAngleScript(${idx})" title="${xp_currentLang === 'zh' ? '一键复制该分镜头脚本' : 'Copy Script'}">
                                <i class="ph ph-copy"></i>
                                <span>${xp_currentLang === 'zh' ? '复制脚本' : 'Copy'}</span>
                            </button>
                        </div>
                        ${bodyHtml}
                    </div>`;
            }).join('') + `</div>`;
        } else {
            adCardsHtml = `<p style="opacity:0.6;">${xp_currentLang === 'zh' ? '暂无广告素材切入点' : 'No ad angles available'}</p>`;
        }
        singleAdAngles.innerHTML = `<h3>${xp_currentLang === 'zh' ? '🎬 分镜头短视频广告切入点' : '🎬 Ad Creative & Video Scripts'}</h3>${adCardsHtml}`;

        // 优势
        const strItems = (d.strengths || []).map(s => {
            const point = xp_getI18nText(s.point);
            const detail = xp_processText(s.detail);
            return `<div class="xp-strength-item"><div class="xp-strength-point">${point}</div><div class="xp-strength-detail">${detail}</div></div>`;
        }).join('');
        singleStrengths.innerHTML = `<h3>${xp_currentLang === 'zh' ? '核心优势' : 'Core Strengths'}</h3>${strItems || '<p>-</p>'}`;

        // 风险
        const weakItems = (d.weaknesses || []).map(w => {
            const risk = xp_getI18nText(w.risk);
            const detail = xp_processText(w.detail);
            return `<div class="xp-weakness-item"><div class="xp-weakness-risk">${risk}</div><div class="xp-weakness-detail">${detail}</div></div>`;
        }).join('');
        singleWeaknesses.innerHTML = `<h3>${xp_currentLang === 'zh' ? '核心风险' : 'Key Risks'}</h3>${weakItems || '<p>-</p>'}`;

        // 差异化机会
        singleDiffOpps.innerHTML = (d.differentiation_opportunities || []).map(opp => {
            const text = xp_processText(typeof opp === 'object' ? (opp.opportunity || '') : String(opp));
            const badge = typeof opp === 'object' ? conf(opp.confidence) : '';
            return `<div class="xp-eval-card"><div class="xp-eval-card-dim">${xp_currentLang === 'zh' ? '差异化机会' : 'Opportunity'}</div><div class="xp-eval-card-detail">${text.trim()} ${badge}</div></div>`;
        }).join('');

        // 操盘建议
        const recRaw = xp_processText(d.entry_recommendation || '');
        const steps = recRaw.split(/(?=\d+\.|①|②|③|第[一二三])/).filter(s => s.trim());
        let recContent;
        if (steps.length > 1) {
            recContent = `<div class="xp-rec-steps">` + steps.map((s, i) => `
                <div class="xp-rec-step">
                    <div class="xp-rec-step-num">${i + 1}</div>
                    <div>${s.replace(/^\d+\.\s*/, '').trim()}</div>
                </div>`).join('') + `</div>`;
        } else {
            recContent = `<p>${recRaw}</p>`;
        }
        singleRec.innerHTML = `<h3>${xp_currentLang === 'zh' ? '操盘建议' : 'Entry Strategy'}</h3>${recContent}`;

        // 买家异议预判与客服攻防库 (competitor-profiling)
        xp_renderObjections(d);

        // VOC
        if (d.voc_analysis) {
            const v = d.voc_analysis;
            const sentimentVal = parseInt(v.sentiment) || 80;
            singleVoc.innerHTML = `
                <div class="xp-sentiment-container">
                    <span class="xp-sentiment-label">${xp_currentLang === 'zh' ? '好评率/情绪值' : 'Sentiment Score'}</span>
                    <div class="xp-sentiment-bar-bg"><div class="xp-sentiment-bar-fill" style="width:${sentimentVal}%"></div></div>
                    <span class="xp-sentiment-value">${sentimentVal}%</span>
                </div>
                <div class="xp-voc-grid">
                    <div class="xp-voc-card xp-voc-pros">
                        <div class="xp-voc-card-title">✨ ${xp_currentLang === 'zh' ? '核心好评点' : 'Top Pros'}</div>
                        <ul class="xp-voc-list">${(v.pros || []).map(p => `<li class="xp-voc-item">${xp_processText(p)}</li>`).join('')}</ul>
                    </div>
                    <div class="xp-voc-card xp-voc-cons">
                        <div class="xp-voc-card-title">⚠️ ${xp_currentLang === 'zh' ? '核心痛点/差评' : 'Top Cons'}</div>
                        <ul class="xp-voc-list">${(v.cons || []).map(c => `<li class="xp-voc-item">${xp_processText(c)}</li>`).join('')}</ul>
                    </div>
                </div>`;
        } else {
            singleVoc.innerHTML = `<p style="opacity:0.5;">${xp_currentLang === 'zh' ? '暂无评价深度分析数据' : 'No VOC data available'}</p>`;
        }
    }

    // ─── 矩阵对比模板 ─────────────────────────────────────────────────────────
    function xp_renderMatrixStrategySection(data) {
        const section = xp_getEl('xp-matrixStrategySection');
        const container = xp_getEl('xp-matrixStrategyContainer');
        if (!section || !container) return;

        const strat = data.strategic_insights || data.comparison || {};
        const winner = strat.winner_analysis;
        const breakthrough = strat.breakthrough_strategy;
        const landscape = strat.market_landscape;
        const pricingTier = strat.pricing_tier_analysis;
        const battleCard = strat.battle_card;

        if (!winner && !breakthrough && !landscape && !pricingTier && !battleCard) {
            section.classList.add('xp-hidden');
            container.innerHTML = '';
            return;
        }

        const isZh = xp_currentLang === 'zh';
        section.classList.remove('xp-hidden');
        let cardsHtml = '';

        // 卡片 0: ⚔️ 竞争对战卡 (Competitive Battle Card)
        if (battleCard && (battleCard.why_switch?.length || battleCard.who_it_is_for || battleCard.tactical_counter_attacks?.length)) {
            const whyItems = (battleCard.why_switch || []).map(item => {
                const trig = xp_processText(item.trigger || '');
                const count = xp_processText(item.our_counter || '');
                return `
                    <div class="xp-strategy-item xp-battle-item-switch mb-2">
                        <strong class="text-amber-900">⚠️ ${isZh ? '竞品翻车/差评痛点：' : 'Competitor Pain Trigger:'} ${trig}</strong>
                        <div class="mt-1 text-emerald-800 font-medium">✨ <strong>${isZh ? '我方降维解决：' : 'Our Solution:'}</strong> ${count}</div>
                    </div>`;
            }).join('');

            const whoFor = battleCard.who_it_is_for ? xp_processText(battleCard.who_it_is_for) : '';
            const whoNotFor = battleCard.who_it_is_not_for ? xp_processText(battleCard.who_it_is_not_for) : '';

            const tacticalItems = (battleCard.tactical_counter_attacks || []).map((item, idx) => {
                const ang = xp_processText(item.angle || '');
                const act = xp_processText(item.action || '');
                return `
                    <div class="xp-strategy-item mb-1.5 bg-white border border-orange-200">
                        <strong class="text-orange-950 flex items-center gap-1.5"><span class="xp-battle-counter-badge">战术 ${idx + 1}</span> ${ang}</strong>
                        <div class="text-slate-700 text-xs mt-1 leading-relaxed">${act}</div>
                    </div>`;
            }).join('');

            cardsHtml += `
                <div class="xp-strategy-card xp-strategy-battle-card">
                    <div class="xp-strategy-card-title justify-between">
                        <div class="flex items-center gap-2">
                            <i class="ph-bold ph-shield-star text-orange-600"></i>
                            <span>${isZh ? '⚔️ 竞争对战卡 (Competitive Battle Card)' : '⚔️ Competitive Battle Card'}</span>
                        </div>
                        <button type="button" class="text-xs bg-orange-600 hover:bg-orange-700 text-white font-bold px-2.5 py-1 rounded-md transition-all shadow-2xs flex items-center gap-1 cursor-pointer" onclick="window.xp_saveBattleCardToBrandProfile && window.xp_saveBattleCardToBrandProfile()" title="${isZh ? '将对战卡洞察转存为商品营销画像档案' : 'Save insights to brand profile'}">
                            <i class="ph-bold ph-floppy-disk"></i>
                            <span>${isZh ? '转存为营销画像' : 'Save to Brand Hub'}</span>
                        </button>
                    </div>

                    ${whyItems ? `
                        <div class="mt-3">
                            <div class="text-xs font-bold text-slate-800 mb-1.5">🔄 ${isZh ? '为什么从竞品转移 (Why Switch)：' : 'Why Switch From Competitor:'}</div>
                            ${whyItems}
                        </div>` : ''}

                    ${whoFor || whoNotFor ? `
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
                            ${whoFor ? `
                                <div class="xp-strategy-item bg-emerald-50/70 border border-emerald-200 text-emerald-950">
                                    <strong class="text-emerald-900">🎯 ${isZh ? '适合核心人群 (Who It\'s For)：' : 'Who It\'s For:'}</strong>
                                    <span>${whoFor}</span>
                                </div>` : ''}
                            ${whoNotFor ? `
                                <div class="xp-strategy-item bg-rose-50/70 border border-rose-200 text-rose-950">
                                    <strong class="text-rose-900">🚫 ${isZh ? '明确不适合人群 (Who It\'s NOT For)：' : 'Who It\'s NOT For:'}</strong>
                                    <span>${whoNotFor}</span>
                                </div>` : ''}
                        </div>` : ''}

                    ${tacticalItems ? `
                        <div class="mt-3">
                            <div class="text-xs font-bold text-slate-800 mb-1.5">⚡ ${isZh ? '3大实战拦截打法 (Tactical Counter-Attacks)：' : 'Tactical Counter-Attacks:'}</div>
                            ${tacticalItems}
                        </div>` : ''}
                </div>`;
        }

        // 卡片 1: 🏆 Winner 深度解剖与突破死穴
        if (winner) {
            const adv = xp_processText(winner.key_advantages || '');
            const vuln = xp_processText(winner.fatal_vulnerability || '');
            cardsHtml += `
                <div class="xp-strategy-card xp-strategy-winner-card">
                    <div class="xp-strategy-card-title">
                        <i class="ph-bold ph-trophy"></i>
                        <span>${isZh ? '胜出竞品深度解剖与突破死穴' : 'Winner Advantage & Vulnerability'}</span>
                    </div>
                    ${adv ? `
                        <div class="xp-strategy-item">
                            <strong>🛡️ ${isZh ? '核心护城河与胜出根基：' : 'Key Advantages & Moat:'}</strong>
                            <span>${adv}</span>
                        </div>` : ''}
                    ${vuln ? `
                        <div class="xp-strategy-item xp-vulnerability-item">
                            <strong>🎯 ${isZh ? '致命弱点与隐秘缺陷（我方主攻点）：' : 'Fatal Vulnerability (Attack Vector):'}</strong>
                            <span>${vuln}</span>
                        </div>` : ''}
                </div>`;
        }

        // 卡片 2: ⚔️ 我方差异化突围切入战法
        if (breakthrough) {
            const innov = xp_processText(breakthrough.product_innovation || '');
            const pricing = xp_processText(breakthrough.pricing_entry || '');
            const mkt = xp_processText(breakthrough.marketing_playbook || '');
            cardsHtml += `
                <div class="xp-strategy-card xp-strategy-breakthrough-card">
                    <div class="xp-strategy-card-title">
                        <i class="ph-bold ph-sword"></i>
                        <span>${isZh ? '我方差异化突围实战作战打法' : 'Breakthrough Strategy & Playbook'}</span>
                    </div>
                    ${innov ? `
                        <div class="xp-strategy-item">
                            <strong>💡 ${isZh ? '规格改良与微创新（降维打击）：' : 'Product Innovation & Spec Upgrade:'}</strong>
                            <span>${innov}</span>
                        </div>` : ''}
                    ${pricing ? `
                        <div class="xp-strategy-item">
                            <strong>🏷️ ${isZh ? '切入定价与毛利空间建议：' : 'Entry Price & Profit Margin:'}</strong>
                            <span>${pricing}</span>
                        </div>` : ''}
                    ${mkt ? `
                        <div class="xp-strategy-item">
                            <strong>🚀 ${isZh ? '冷启动流量打法（痛点反差钩子）：' : 'Go-To-Market Traffic Hook:'}</strong>
                            <span>${mkt}</span>
                        </div>` : ''}
                </div>`;
        }

        // 卡片 3: 🌐 竞争态势与价格带梯队
        if (landscape || pricingTier) {
            const ls = landscape ? xp_processText(landscape) : '';
            const pt = pricingTier ? xp_processText(pricingTier) : '';
            cardsHtml += `
                <div class="xp-strategy-card xp-strategy-landscape-card">
                    <div class="xp-strategy-card-title">
                        <i class="ph-bold ph-chart-line-up"></i>
                        <span>${isZh ? '市场博弈格局与价格带梯队' : 'Market Landscape & Price Tiers'}</span>
                    </div>
                    ${ls ? `
                        <div class="xp-strategy-item">
                            <strong>🌐 ${isZh ? '市场竞争态势与准入门槛：' : 'Competition Landscape & Entry Barriers:'}</strong>
                            <span>${ls}</span>
                        </div>` : ''}
                    ${pt ? `
                        <div class="xp-strategy-item">
                            <strong>💰 ${isZh ? '各梯队价格分布与毛利带：' : 'Pricing Tier & Margin Space:'}</strong>
                            <span>${pt}</span>
                        </div>` : ''}
                </div>`;
        }

        container.innerHTML = cardsHtml;
    }

    function xp_renderMatrixCompetitorDrilldown(products, winnerIdx) {
        const section = xp_getEl('xp-matrixDetailSection');
        const tabsContainer = xp_getEl('xp-matrixProductTabs');
        const contentContainer = xp_getEl('xp-matrixProductDetailContent');
        if (!section || !tabsContainer || !contentContainer) return;

        if (!products || products.length === 0) {
            section.classList.add('xp-hidden');
            tabsContainer.innerHTML = '';
            contentContainer.innerHTML = '';
            return;
        }

        section.classList.remove('xp-hidden');
        if (xp_currentMatrixSelectedProductIdx >= products.length) {
            xp_currentMatrixSelectedProductIdx = winnerIdx >= 0 ? winnerIdx : 0;
        }

        // 渲染选项卡 Tabs
        const isZh = xp_currentLang === 'zh';
        tabsContainer.innerHTML = products.map((p, idx) => {
            const isWin = idx === winnerIdx;
            const isActive = idx === xp_currentMatrixSelectedProductIdx;
            const pName = xp_getI18nText(p.product_name || `Product ${idx + 1}`);
            const price = xp_getI18nText(p.price || '');
            return `
                <button class="xp-matrix-tab-btn ${isActive ? 'active' : ''} ${isWin ? 'xp-winner-tab' : ''}" data-idx="${idx}">
                    ${isWin ? '👑 ' : ''}<span>${pName}</span>${price ? ` <span style="font-weight:normal;opacity:0.8;">(${price})</span>` : ''}
                </button>`;
        }).join('');

        // 绑定点击事件
        tabsContainer.querySelectorAll('.xp-matrix-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.getAttribute('data-idx'), 10);
                if (!isNaN(idx) && idx !== xp_currentMatrixSelectedProductIdx) {
                    xp_currentMatrixSelectedProductIdx = idx;
                    xp_renderMatrixCompetitorDrilldown(products, winnerIdx);
                }
            });
        });

        // 渲染当前选中的竞品深度资产
        const currentProd = products[xp_currentMatrixSelectedProductIdx];
        if (!currentProd) return;

        let drillHtml = '';

        // 1. 快捷流转操作按钮组
        const prodName = xp_getI18nText(currentProd.product_name || `Product ${xp_currentMatrixSelectedProductIdx + 1}`);
        drillHtml += `
            <div class="xp-card" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;background:#f8fafc;border:1px solid #e2e8f0;padding:12px 18px;">
                <div style="font-weight:800;color:#0f172a;font-size:1rem;display:flex;align-items:center;gap:8px;">
                    <span>📌 ${isZh ? '当前单品透视：' : 'Active Profile: '}<strong>${prodName}</strong></span>
                    ${xp_currentMatrixSelectedProductIdx === winnerIdx ? '<span class="xp-winner-badge">👑 Winner</span>' : ''}
                </div>
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <button class="xp-btn xp-btn-secondary" style="font-size:0.82rem;padding:6px 12px;background:linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);color:#fff;border:none;" onclick="xp_transferToBrandProfile(xp_matrixCurrentProducts[${xp_currentMatrixSelectedProductIdx}])" title="${isZh ? '将该单品洞察转存为商品营销画像' : 'Save to Brand Hub'}">
                        <i class="ph-bold ph-identification-card"></i>
                        <span>${isZh ? '存入营销档案库' : 'Save to Brand Hub'}</span>
                    </button>
                    <button class="xp-btn xp-btn-primary" style="font-size:0.82rem;padding:6px 12px;" onclick="xp_transferToDetails(xp_matrixCurrentProducts[${xp_currentMatrixSelectedProductIdx}])">
                        <i class="ph ph-image"></i>
                        <span>${isZh ? '带入详情页' : 'To Details'}</span>
                    </button>
                    <button class="xp-btn xp-btn-secondary" style="font-size:0.82rem;padding:6px 12px;" onclick="xp_transferToListing(xp_matrixCurrentProducts[${xp_currentMatrixSelectedProductIdx}])">
                        <i class="ph ph-file-text"></i>
                        <span>${isZh ? '带入 Listing' : 'To Listing'}</span>
                    </button>
                    <button class="xp-btn xp-btn-secondary" style="font-size:0.82rem;padding:6px 12px;" onclick="xp_transferToAds(xp_matrixCurrentProducts[${xp_currentMatrixSelectedProductIdx}])">
                        <i class="ph ph-megaphone"></i>
                        <span>${isZh ? '带入广告文案' : 'To Ads'}</span>
                    </button>
                </div>
            </div>`;

        // 2. 品牌心智与价值主张
        if (currentProd.brand_positioning) {
            const bp = currentProd.brand_positioning;
            const tagline = bp.tagline ? xp_getI18nText(bp.tagline) : '';
            const angle = bp.positioning_angle ? xp_getI18nText(bp.positioning_angle) : '';
            const triggers = bp.trust_triggers || [];
            const chips = triggers.map(t => `<span class="xp-trust-chip"><i class="ph ph-shield-check"></i>${xp_getI18nText(t)}</span>`).join('');

            drillHtml += `
                <div class="xp-brand-positioning-card">
                    <div class="xp-brand-header-flex">
                        <div class="xp-brand-tagline">${tagline ? `“${xp_processText(tagline)}”` : ''}</div>
                        ${angle ? `<span class="xp-brand-angle-badge"><i class="ph-bold ph-compass"></i>${xp_processText(angle)}</span>` : ''}
                    </div>
                    ${chips ? `
                        <div class="xp-brand-trust-triggers">
                            <span class="xp-brand-trust-label">${isZh ? '信任背书 / 权威背书' : 'Trust Triggers'}:</span>
                            ${chips}
                        </div>` : ''}
                </div>`;
        }

        // 3. 选品攻防对抗战术盘 (Battle Card)
        if (currentProd.battle_card) {
            const bc = xp_normalizeBattleCard(currentProd.battle_card);
            const renderBcList = (items) => {
                if (!items || items.length === 0) return `<li class="xp-battle-item-empty">-</li>`;
                return items.map(item => `<li>${xp_processText(String(item))}</li>`).join('');
            };
            drillHtml += `
                <div class="xp-battle-card-grid">
                    <div class="xp-battle-col xp-battle-col-strong">
                        <div class="xp-battle-col-header">
                            <div class="xp-battle-col-title">🛡️ <span>${isZh ? '竞品防守强区 (壁垒)' : 'Competitor Moat'}</span></div>
                            <span class="xp-battle-subtag">${isZh ? '避其锋芒' : 'Avoid Head-on'}</span>
                        </div>
                        <ul class="xp-battle-list">${renderBcList(bc.competitor_moat)}</ul>
                    </div>
                    <div class="xp-battle-col xp-battle-col-attack">
                        <div class="xp-battle-col-header">
                            <div class="xp-battle-col-title">⚔️ <span>${isZh ? '我方主攻破局点 (打痛点)' : 'Attack Vector'}</span></div>
                            <span class="xp-battle-subtag">${isZh ? '痛点暴击' : 'High Impact'}</span>
                        </div>
                        <ul class="xp-battle-list">${renderBcList(bc.attack_vector)}</ul>
                    </div>
                    <div class="xp-battle-col xp-battle-col-whitespace">
                        <div class="xp-battle-col-header">
                            <div class="xp-battle-col-title">💎 <span>${isZh ? '蓝海生态空白 (机会)' : 'Whitespace Opportunities'}</span></div>
                            <span class="xp-battle-subtag">${isZh ? '未被满足' : 'Underserved'}</span>
                        </div>
                        <ul class="xp-battle-list">${renderBcList(bc.whitespace_opportunities)}</ul>
                    </div>
                    <div class="xp-battle-col xp-battle-col-threat">
                        <div class="xp-battle-col-header">
                            <div class="xp-battle-col-title">⚠️ <span>${isZh ? '潜在反扑威胁 (预警)' : 'Threat Radar'}</span></div>
                            <span class="xp-battle-subtag">${isZh ? '防备报复' : 'Retaliation'}</span>
                        </div>
                        <ul class="xp-battle-list">${renderBcList(bc.threat_radar)}</ul>
                    </div>
                </div>`;
        }

        // 4. 买家常见异议预判与客服攻防库 (Customer Objection Q&A)
        if (currentProd.customer_objections && currentProd.customer_objections.length > 0) {
            const objectionsHtml = currentProd.customer_objections.map((item, idx) => {
                const q = xp_processText(item.objection || '');
                const a = xp_processText(item.response || '');
                const proof = item.proof_point ? xp_processText(item.proof_point) : '';
                return `
                    <div class="xp-objection-card">
                        <div class="xp-objection-header">
                            <div class="xp-objection-q">
                                <span class="xp-objection-tag-q">Q${idx + 1}</span>
                                <span>${q}</span>
                            </div>
                            <button class="xp-objection-copy-btn" data-index="${idx}" onclick="xp_copyObjection(${idx}, xp_matrixCurrentProducts[${xp_currentMatrixSelectedProductIdx}])" title="${isZh ? '复制此条话术' : 'Copy Q&A'}">
                                <i class="ph ph-copy"></i>
                                <span>${isZh ? '复制' : 'Copy'}</span>
                            </button>
                        </div>
                        <div class="xp-objection-a">
                            <div class="xp-objection-tag-a">
                                <i class="ph-bold ph-chat-teardrop-text"></i>
                                <span>${isZh ? '客服高转化应对策略与公关说辞' : 'Sales Defense & Response'}</span>
                            </div>
                            <div style="white-space:pre-wrap;">${a}</div>
                        </div>
                        ${proof ? `
                            <div class="xp-objection-proof">
                                <i class="ph-bold ph-seal-check"></i>
                                <span><strong>${isZh ? '背书事实/质保承诺' : 'Proof Point & Warranty'}:</strong> ${proof}</span>
                            </div>` : ''}
                    </div>`;
            }).join('');

            drillHtml += `
                <div class="xp-objections-section" style="margin-top:0;">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
                        <h3 style="font-size:0.95rem;font-weight:800;color:#0f172a;display:flex;align-items:center;gap:6px;">
                            <i class="ph-bold ph-shield-check" style="color:#2563eb;"></i>
                            <span>${isZh ? '买家常见异议预判与客服攻防库' : 'Customer Objection Defense Q&A'}</span>
                        </h3>
                        <button class="xp-btn xp-btn-secondary" id="xp-copyAllObjectionsBtn" style="font-size:0.8rem;padding:5px 12px;" onclick="xp_copyAllObjections(xp_matrixCurrentProducts[${xp_currentMatrixSelectedProductIdx}])">
                            <i class="ph ph-copy"></i>
                            <span>${isZh ? '复制全部攻防话术' : 'Copy All Objections'}</span>
                        </button>
                    </div>
                    <div class="xp-objections-grid">${objectionsHtml}</div>
                </div>`;
        }

        // 5. 爆款短视频/投流分镜头脚本 (Ad Angles)
        if (currentProd.ad_angles && currentProd.ad_angles.length > 0) {
            const anglesHtml = currentProd.ad_angles.map((item, idx) => {
                const parsed = xp_parseAdAngle(item);
                const angle = xp_processText(parsed.angle || '');
                const hook = xp_processText(parsed.hook || '');
                const script = xp_processText(parsed.script || '');
                const cta = xp_processText(parsed.cta_hashtags || '');

                return `
                    <div class="xp-card" style="padding:14px;border:1px solid #e2e8f0;background:#ffffff;border-radius:10px;">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                            <span style="font-weight:800;color:#0f172a;font-size:0.9rem;">🎬 #${idx + 1} ${angle}</span>
                            <button class="xp-btn xp-btn-secondary xp-ad-copy-btn" data-index="${idx}" style="font-size:0.78rem;padding:4px 10px;" onclick="xp_copyAdAngleScript(${idx}, xp_matrixCurrentProducts[${xp_currentMatrixSelectedProductIdx}])">
                                <i class="ph ph-copy"></i>
                                <span>${isZh ? '复制脚本' : 'Copy'}</span>
                            </button>
                        </div>
                        ${hook ? `<div style="font-size:0.83rem;color:#b45309;background:#fffbeb;padding:6px 10px;border-radius:6px;margin-bottom:6px;"><strong>${isZh ? '前3秒黄金Hook：' : '3-Sec Hook: '}</strong>${hook}</div>` : ''}
                        ${script ? `<div style="font-size:0.83rem;color:#334155;line-height:1.6;white-space:pre-wrap;background:#f8fafc;padding:8px 10px;border-radius:6px;margin-bottom:6px;">${script}</div>` : ''}
                        ${cta ? `<div style="font-size:0.78rem;color:#64748b;">${cta}</div>` : ''}
                    </div>`;
            }).join('');

            drillHtml += `
                <div style="margin-top:0.5rem;">
                    <h3 style="font-size:0.95rem;font-weight:800;color:#0f172a;display:flex;align-items:center;gap:6px;margin-bottom:12px;">
                        <i class="ph-bold ph-video-camera" style="color:#d97706;"></i>
                        <span>${isZh ? '爆款短视频/投流分镜头脚本 (Ad Angles)' : 'Short Video Ad Angle Scripts'}</span>
                    </h3>
                    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(280px, 1fr));gap:12px;">${anglesHtml}</div>
                </div>`;
        }

        contentContainer.innerHTML = drillHtml;
    }

    function xp_renderMatrixTemplate(data) {
        const { products, comparison, comprehensive_evaluation, recommendation_list, scores, url_statuses } = data;
        const scoresContainer = xp_getEl('xp-scoresContainer');
        const comparisonContainer = xp_getEl('xp-comparisonContainer');
        const compWinner = xp_getEl('xp-compWinner');
        const compLevel = xp_getEl('xp-compLevel');
        const compPosition = xp_getEl('xp-compPosition');
        const tableHeader = xp_getEl('xp-tableHeader');
        const tableBody = xp_getEl('xp-tableBody');
        const opportunitiesContainer = xp_getEl('xp-opportunitiesContainer');
        const evalGrid = xp_getEl('xp-evalGrid');
        const recGrid = xp_getEl('xp-recGrid');

        xp_matrixCurrentProducts = products || [];

        // 确定赢家
        xp_winnerIndex = -1;
        if (comparison && comparison.winner_product) {
            const winnerName = xp_getI18nText(comparison.winner_product).toLowerCase();
            (products || []).forEach((p, i) => {
                const name = xp_getI18nText(p.product_name || '').toLowerCase();
                if (name && winnerName.includes(name.substring(0, 10))) xp_winnerIndex = i;
            });
        }
        if (xp_winnerIndex < 0 && scores && scores.length === (products || []).length) {
            let bestScore = -Infinity;
            scores.forEach((scoreObj, i) => {
                const score = xp_investmentScore(scoreObj);
                if (score > bestScore) {
                    bestScore = score;
                    xp_winnerIndex = i;
                }
            });
        }

        document.getElementById('xp-url-status-warning')?.remove();
        const failedStatuses = (url_statuses || []).filter(s => s.status !== 'success' || s.score_status === 'error');
        if (failedStatuses.length > 0 && comparisonContainer) {
            const warningHtml = failedStatuses.map(s => {
                const msg = s.message || s.score_message || '处理失败';
                return `<div class="xp-url-status-item"><strong>${xp_truncateUrl(s.url || '')}</strong>：${xp_processText(msg)}</div>`;
            }).join('');
            comparisonContainer.insertAdjacentHTML('beforebegin', `
                <div id="xp-url-status-warning" class="xp-card" style="border:1px solid #f59e0b;background:#fffbeb;color:#92400e;margin-bottom:16px;">
                    <div style="font-weight:800;margin-bottom:8px;">部分链接未完整参与分析</div>
                    ${warningHtml}
                </div>`);
        }

        // 评分卡
        scoresContainer.innerHTML = '';
        if (scores && scores.length > 0) {
            scores.forEach(scoreObj => {
                const dScore = scoreObj.difficulty_score || 0;
                let diffKey = "low";
                if (dScore >= 85) diffKey = "very_high";
                else if (dScore >= 70) diffKey = "high";
                else if (dScore >= 40) diffKey = "medium";

                const diffLabels = {
                    low: { zh: "低难度", en: "Low" },
                    medium: { zh: "中等难度", en: "Medium" },
                    high: { zh: "高难度", en: "High" },
                    very_high: { zh: "极高难度", en: "Very High" }
                };
                const diffLabel = xp_currentLang === 'zh' ? diffLabels[diffKey].zh : diffLabels[diffKey].en;
                const diffClass = `xp-diff-${diffKey}`;
                const decision = xp_getI18nText(scoreObj.final_decision || "N/A");
                const decisionClass = xp_isRecommendDecision(decision) ? 'xp-decision-recommend' : 'xp-decision-caution';
                const decisionReason = xp_processText(scoreObj.decision_details?.reason || "");

                let evalHtml = '';
                if (scoreObj.evaluation_details && scoreObj.evaluation_details.length > 0) {
                    evalHtml = `<div class="xp-score-eval-list">` +
                        scoreObj.evaluation_details.map(ed => `
                            <div class="xp-score-eval-item">
                                <span class="xp-score-eval-dim">${xp_getI18nText(ed.dimension)}</span>
                                <span class="xp-score-eval-detail">${xp_getI18nText(ed.detail)}</span>
                            </div>`).join('') + `</div>`;
                }

                scoresContainer.innerHTML += `
                    <div class="xp-card xp-score-card">
                        <div class="xp-score-title">${xp_getI18nText(scoreObj.product)}</div>
                        <div class="xp-score-main-flex">
                            <div class="xp-score-item-box">
                                <div class="xp-score-label-small">${xp_currentLang === 'zh' ? '机会评分' : 'Opportunity'}</div>
                                <div class="xp-score-value-big xp-opp-text">${scoreObj.opportunity_score}</div>
                            </div>
                            <div class="xp-score-divider"></div>
                            <div class="xp-score-item-box">
                                <div class="xp-score-label-small">${xp_currentLang === 'zh' ? '进入难度' : 'Difficulty'}</div>
                                <div class="xp-score-value-big xp-diff-text">${scoreObj.difficulty_score}</div>
                                <div class="xp-difficulty-indicator ${diffClass}">${diffLabel}</div>
                            </div>
                        </div>
                        <div class="xp-decision-container">
                            <div class="xp-decision-header">
                                <div class="xp-score-label-small">${xp_currentLang === 'zh' ? '最终建议' : 'Recommendation'}</div>
                                <div class="xp-decision-badge ${decisionClass}">${decision}</div>
                            </div>
                            <div class="xp-decision-reason">${decisionReason}</div>
                        </div>
                        ${evalHtml}
                    </div>`;
            });
        }

        // 对比摘要
        if (comparison && (products || []).length > 1) {
            comparisonContainer.classList.remove('xp-hidden');
            compWinner.textContent = xp_getI18nText(comparison.winner_product);
            compLevel.textContent = xp_getI18nText(comparison.competition_level);
            compPosition.textContent = xp_getI18nText(comparison.market_position);
        } else {
            comparisonContainer.classList.add('xp-hidden');
        }

        // 多品战略破局蓝图看板
        xp_renderMatrixStrategySection(data);

        // 多竞品 2D 定位象限图 (competitor-profiling)
        xp_renderPositioningMap('xp-matrixPositioningMap', data.quadrant_map, true, data);

        // 对比表格
        xp_renderTable(products || [], tableHeader, tableBody);

        // 各竞品深度情报透视与战术库 (单品下钻)
        xp_renderMatrixCompetitorDrilldown(products || [], xp_winnerIndex);

        // 综合评估与建议
        const hasEval = comprehensive_evaluation && comprehensive_evaluation.length > 0;
        const hasRec = recommendation_list && recommendation_list.length > 0;
        if (hasEval || hasRec) {
            opportunitiesContainer.classList.remove('xp-hidden');
            evalGrid.innerHTML = '';
            if (hasEval) {
                comprehensive_evaluation.forEach(item => {
                    evalGrid.innerHTML += `<div class="xp-eval-card"><div class="xp-eval-card-dim">${xp_getI18nText(item.dimension).trim()}</div><div class="xp-eval-card-detail">${xp_processText(item.detail).trim()}</div></div>`;
                });
            }
            recGrid.innerHTML = '';
            if (hasRec) {
                recommendation_list.forEach(item => {
                    const actionText = xp_getI18nText(item.action);
                    const isRisk = actionText.includes('风险') || actionText.toLowerCase().includes('risk');
                    const isOpp = actionText.includes('机会') || actionText.toLowerCase().includes('opportunity');
                    const actionClass = isRisk ? 'xp-risk' : (isOpp ? 'xp-opportunity' : '');
                    recGrid.innerHTML += `<div class="xp-rec-card"><span class="xp-rec-card-action ${actionClass}">${actionText}</span><span class="xp-rec-card-content">${xp_processText(item.content)}</span></div>`;
                });
            }
        } else {
            opportunitiesContainer.classList.add('xp-hidden');
        }
    }

    function xp_renderTable(products, tableHeader, tableBody) {
        if (!products || products.length === 0) return;
        let headerHtml = `<th>${xp_currentLang === 'zh' ? '分析维度' : 'Dimension'}</th>`;
        products.forEach((p, idx) => {
            const isWinner = idx === xp_winnerIndex;
            const crownBadge = isWinner ? '<span class="xp-winner-badge">👑 Winner</span>' : '';
            const thClass = isWinner ? 'class="xp-winner-col-th"' : '';
            headerHtml += `<th ${thClass}>${xp_getI18nText(p.product_name) || 'Product ' + (idx + 1)} ${crownBadge}<br><span style="font-weight:normal;font-size:0.85rem;opacity:0.7;">${xp_getI18nText(p.price) || 'N/A'} (${xp_getI18nText(p.reviews_count || '0')} reviews)</span></th>`;
        });
        tableHeader.innerHTML = headerHtml;

        const rows = [
            {
                key: 'brand_positioning',
                labelZh: '🧠 品牌心智与定位',
                labelEn: '🧠 Brand Positioning',
                render: p => {
                    if (!p.brand_positioning) return '-';
                    const bp = p.brand_positioning;
                    const tag = bp.tagline ? `“${xp_getI18nText(bp.tagline)}”` : '';
                    const angle = bp.positioning_angle ? `<span class="xp-brand-angle-badge"><i class="ph-bold ph-compass"></i>${xp_getI18nText(bp.positioning_angle)}</span>` : '';
                    return `<div style="display:flex;flex-direction:column;gap:4px;">${angle ? `<div>${angle}</div>` : ''}${tag ? `<div style="font-weight:700;color:#334155;font-size:0.85rem;">${tag}</div>` : ''}</div>` || '-';
                }
            },
            { key: 'core_selling_points', labelZh: '✨ 核心卖点', labelEn: '✨ Selling Points', isList: true, tdClass: '' },
            { key: 'target_audience', labelZh: '🎯 消费者画像', labelEn: '🎯 Consumer Persona', isList: true, tdClass: '' },
            { key: 'use_scenarios', labelZh: '📍 使用场景', labelEn: '📍 Use Scenarios', isList: true, tdClass: '' },
            {
                key: 'strengths',
                labelZh: '🛡️ 核心优势/壁垒',
                labelEn: '🛡️ Strengths / Moat',
                isList: false,
                tdClass: 'xp-td-strength',
                render: p => {
                    const bc = xp_normalizeBattleCard(p.battle_card);
                    if (bc && bc.competitor_moat && bc.competitor_moat.length > 0) {
                        return '<ul class="xp-td-list">' + bc.competitor_moat.map(m => `<li>${xp_processText(String(m))}</li>`).join('') + '</ul>';
                    }
                    return xp_processText(String(p.strengths || '-'));
                }
            },
            {
                key: 'weaknesses',
                labelZh: '⚔️ 致命软肋/破局痛点',
                labelEn: '⚔️ Attack Vector',
                isList: false,
                tdClass: 'xp-td-weakness',
                render: p => {
                    const bc = xp_normalizeBattleCard(p.battle_card);
                    if (bc && bc.attack_vector && bc.attack_vector.length > 0) {
                        return '<ul class="xp-td-list">' + bc.attack_vector.map(a => `<li>${xp_processText(String(a))}</li>`).join('') + '</ul>';
                    }
                    return xp_processText(String(p.weaknesses || '-'));
                }
            },
            { key: 'voc_analysis', labelZh: '📣 用户口碑 VOC', labelEn: '📣 Feedback VOC', isList: false, tdClass: 'xp-td-voc' },
            {
                key: 'customer_objections',
                labelZh: '🔒 买家疑虑与对策',
                labelEn: '🔒 Buyer Objections',
                render: p => {
                    if (!p.customer_objections || p.customer_objections.length === 0) return '-';
                    return p.customer_objections.slice(0, 2).map((item, idx) => `
                        <div style="margin-bottom:6px;font-size:0.83rem;">
                            <strong style="color:#b91c1c;">Q${idx + 1}: ${xp_processText(item.objection || '')}</strong>
                            <div style="color:#2563eb;font-size:0.78rem;margin-top:2px;">💬 ${xp_processText(item.response || '')}</div>
                        </div>`).join('');
                }
            }
        ];

        let bodyHtml = '';
        rows.forEach(r => {
            bodyHtml += `<tr><td><strong>${xp_currentLang === 'zh' ? r.labelZh : r.labelEn}</strong></td>`;
            products.forEach((p, idx) => {
                const isWinner = idx === xp_winnerIndex;
                const tdClass = [isWinner ? 'xp-winner-col-td' : '', r.tdClass].filter(Boolean).join(' ');

                if (typeof r.render === 'function') {
                    bodyHtml += `<td class="${tdClass}">${r.render(p)}</td>`;
                    return;
                }

                let val = p[r.key];

                if (r.key === 'target_audience') {
                    let combined = [];
                    if (p.age_range) combined.push(`📅 ${xp_getI18nText(p.age_range)}`);
                    if (p.target_countries && Array.isArray(p.target_countries)) {
                        p.target_countries.forEach(c => combined.push(`🌍 ${xp_getI18nText(c)}`));
                    }
                    if (Array.isArray(val)) {
                        val.forEach(v => {
                            const text = typeof v === 'object' ? (v.audience || v.item || '') : String(v);
                            combined.push(xp_getI18nText(text));
                        });
                    }
                    val = combined;
                }

                if (r.key === 'voc_analysis' && val) {
                    const pros = (val.pros || []).slice(0, 2).map(item => `<div class="xp-td-voc-item xp-td-voc-pro">+ ${xp_getI18nText(item)}</div>`).join('');
                    const cons = (val.cons || []).slice(0, 2).map(item => `<div class="xp-td-voc-item xp-td-voc-con">- ${xp_getI18nText(item)}</div>`).join('');
                    bodyHtml += `<td class="${tdClass}"><div class="xp-td-voc-list">${pros}${cons}</div></td>`;
                } else if (r.isList && Array.isArray(val)) {
                    const listItems = val.map(item => xp_processText(String(item)).trim()).filter(item => item && item !== '-').map(item => `<li>${item}</li>`).join('');
                    bodyHtml += `<td class="${tdClass}"><ul class="xp-td-list">${listItems || '<li>-</li>'}</ul></td>`;
                } else {
                    bodyHtml += `<td class="${tdClass}">${xp_processText(String(val || '-'))}</td>`;
                }
            });
            bodyHtml += `</tr>`;
        });
        tableBody.innerHTML = bodyHtml;
    }

    // ─── 导出报告 ─────────────────────────────────────────────────────────────
    function xp_generateWhitePaperReport(response) {
        if (!response || !response.data) {
            return '<!DOCTYPE html><html><body><p>无有效分析报告数据</p></body></html>';
        }
        const data = response.data || {};
        const template_type = response.template_type || (data.single_data || (!data.products && !data.comparison) ? 'single' : 'matrix');
        const dateStr = new Date().toLocaleString();
        const isZh = xp_currentLang === 'zh';

        // 统一文本处理：尊重中英文切换、Markdown粗体解析与置信度标签
        const proc = (val) => {
            if (!val) return '';
            if (typeof val === 'string') {
                return xp_processText(val);
            }
            if (typeof val === 'object') {
                const text = val.point || val.detail || val.risk || val.opportunity || val.pain || val.audience || val.scenario || val.text || '';
                return xp_processText(text);
            }
            return String(val);
        };

        const rawText = (val) => {
            if (!val) return '';
            return xp_getI18nText(typeof val === 'object' ? (val.point || val.detail || val.risk || val.opportunity || val.pain || '') : String(val));
        };

        const conf = (c) => {
            if (!c) return '';
            const map = { high: 'xp-conf-high', medium: 'xp-conf-medium', low: 'xp-conf-low' };
            const labelZh = c === 'high' ? '高置信度' : c === 'low' ? '低置信度' : '中置信度';
            const labelEn = c.charAt(0).toUpperCase() + c.slice(1) + ' Confidence';
            return `<span class="xp-conf-badge ${map[c] || 'xp-conf-medium'}">${isZh ? labelZh : labelEn}</span>`;
        };

        let content = '';
        let reportTitle = isZh ? 'AI 跨境电商竞品深度解构报告' : 'AI E-Commerce Competitor Analysis Report';
        let reportSub = '';

        if (template_type === 'single') {
            const d = data.single_data || data || {};
            const scoreObj = (data.scores && data.scores.length > 0) ? data.scores[0] : (d.score || null);
            const productName = rawText(d.product_name) || (isZh ? '单品深度透视' : 'Single Product Analysis');
            reportSub = productName;

            // ── 0. TL;DR 极速选品决策看板 ──
            const decisionRaw = scoreObj ? (scoreObj.final_decision || '') : '';
            const decisionText = rawText(decisionRaw);
            let badgeType = 'warning';
            let badgeLabel = decisionText || (isZh ? '综合评估' : 'Evaluation');

            const lower = decisionText.toLowerCase();
            if (lower.includes('强烈建议') || lower.includes('优先') || lower.includes('建议进入') || (lower.includes('recommend') && !lower.includes('not recommend'))) {
                badgeType = 'success';
            } else if (lower.includes('不建议') || lower.includes('放弃') || lower.includes('高危') || lower.includes('not recommend') || lower.includes('reject')) {
                badgeType = 'danger';
            } else {
                badgeType = 'warning';
            }

            const oScore = scoreObj ? (scoreObj.opportunity_score ?? 0) : null;
            const dScore = scoreObj ? (scoreObj.difficulty_score ?? 0) : null;
            const scoresSub = (oScore !== null && dScore !== null)
                ? `<span class="xp-tldr-scores">（${isZh ? '机会' : 'Opp'} ${oScore} / ${isZh ? '难度' : 'Diff'} ${dScore}）</span>`
                : '';

            const decisionReason = scoreObj?.decision_details?.reason
                ? proc(scoreObj.decision_details.reason)
                : (d.entry_recommendation ? proc(d.entry_recommendation) : (isZh ? '结合自身供应链优势与资金周转评估进入节奏' : 'Evaluate entry based on supply chain and budget.'));

            let pitfallText = '';
            if (d.weaknesses && d.weaknesses.length > 0) {
                const w = d.weaknesses[0];
                const r = rawText(w.risk || '');
                const det = rawText(w.detail || '');
                pitfallText = r ? `${r}：${det}` : det;
            } else if (d.voc_analysis && d.voc_analysis.cons && d.voc_analysis.cons.length > 0) {
                pitfallText = rawText(d.voc_analysis.cons[0]);
            } else if (scoreObj && scoreObj.decision_details && scoreObj.decision_details.reason) {
                pitfallText = rawText(scoreObj.decision_details.reason);
            } else {
                pitfallText = isZh ? '暂未识别出致命缺陷，需严格监控品控及售后率' : 'No fatal flaws detected, monitor quality control.';
            }

            let oppText = '';
            if (d.differentiation_opportunities && d.differentiation_opportunities.length > 0) {
                const o = d.differentiation_opportunities[0];
                oppText = rawText(typeof o === 'object' ? (o.opportunity || o.point || '') : String(o));
            } else if (d.entry_recommendation) {
                oppText = rawText(d.entry_recommendation);
            } else if (d.strengths && d.strengths.length > 0) {
                const s = d.strengths[0];
                const p = rawText(s.point || '');
                const det = rawText(s.detail || '');
                oppText = p ? `${p}：${det}` : det;
            } else {
                oppText = isZh ? '主打视觉传达升级与精准场景化痛点营销' : 'Focus on visual upgrades and scenario marketing.';
            }

            content += `
                <div class="xp-tldr-card">
                    <div class="xp-tldr-header">
                        <div class="xp-tldr-header-left">
                            <div class="xp-tldr-tag">
                                <span>⚡ ${isZh ? '极速选品决策看板 (TL;DR)' : 'Product Decision TL;DR'}</span>
                            </div>
                            <div class="xp-tldr-sub">
                                <span>${isZh ? '5秒快速拍板：决策红绿灯 · 避坑雷区 · 破局点' : '5-Sec Decision: Traffic Light · Fatal Pitfall · Opportunity'}</span>
                            </div>
                        </div>
                        <div class="xp-tldr-decision-pill xp-tldr-badge-${badgeType}">
                            <span class="xp-tldr-dot"></span>
                            <span style="font-weight:800;">${badgeLabel}</span>
                            ${scoresSub}
                        </div>
                    </div>
                    <div class="xp-tldr-grid">
                        <div class="xp-tldr-col xp-tldr-col-conclusion">
                            <div class="xp-tldr-col-title">
                                <span>💡 ${isZh ? '操盘定调' : 'Executive Conclusion'}</span>
                            </div>
                            <div class="xp-tldr-col-desc">${decisionReason}</div>
                        </div>
                        <div class="xp-tldr-col xp-tldr-col-pitfall">
                            <div class="xp-tldr-col-title">
                                <span>⚠️ ${isZh ? '核心避坑雷区' : 'Fatal Pitfall'}</span>
                            </div>
                            <div class="xp-tldr-col-desc">${proc(pitfallText)}</div>
                        </div>
                        <div class="xp-tldr-col xp-tldr-col-breakthrough">
                            <div class="xp-tldr-col-title">
                                <span>🚀 ${isZh ? '最优破局机会' : 'Breakthrough Point'}</span>
                            </div>
                            <div class="xp-tldr-col-desc">${proc(oppText)}</div>
                        </div>
                    </div>
                </div>`;

            // ── 1. 智能投资打分 ──
            if (scoreObj) {
                const diffScore = scoreObj.difficulty_score || 0;
                const oppScore = scoreObj.opportunity_score || 0;
                const diffClass = diffScore >= 80 ? 'xp-diff-high' : (diffScore >= 50 ? 'xp-diff-mid' : 'xp-diff-low');
                const diffLabel = isZh ? (diffScore >= 80 ? '极高难度' : (diffScore >= 50 ? '中等难度' : '低难度')) : (diffScore >= 80 ? 'High' : (diffScore >= 50 ? 'Medium' : 'Low'));
                const decision = rawText(scoreObj.final_decision || '-');
                const isWinner = xp_isRecommendDecision(decision);
                const decClass = isWinner ? 'xp-decision-recommend' : 'xp-decision-caution';
                const decReason = proc(scoreObj.decision_details ? (scoreObj.decision_details.reason || '') : '');

                let evalHtml = '';
                if (scoreObj.evaluation_details && scoreObj.evaluation_details.length > 0) {
                    evalHtml = `<div class="xp-score-eval-list">` +
                        scoreObj.evaluation_details.map(ed => `
                            <div class="xp-score-eval-item">
                                <div class="xp-score-eval-dim">${proc(ed.dimension)}</div>
                                <div class="xp-score-eval-detail">${proc(ed.detail)}</div>
                            </div>`).join('') + `</div>`;
                }

                content += `
                    <div class="section">
                        <div class="section-title">📊 ${isZh ? '智能投资打分与多维评估' : 'Investment Scoring & Dimensions'}</div>
                        <div class="card xp-score-card">
                            <div class="xp-score-main-flex">
                                <div class="xp-score-item-box">
                                    <div class="xp-score-label-small">${isZh ? '机会评分' : 'Opportunity Score'}</div>
                                    <div class="xp-score-value-big xp-opp-text">${oppScore}</div>
                                </div>
                                <div class="xp-score-divider"></div>
                                <div class="xp-score-item-box">
                                    <div class="xp-score-label-small">${isZh ? '进入难度' : 'Difficulty Score'}</div>
                                    <div class="xp-score-value-big xp-diff-text">${diffScore}</div>
                                    <div class="xp-difficulty-indicator ${diffClass}">${diffLabel}</div>
                                </div>
                                <div class="xp-score-divider"></div>
                                <div class="xp-decision-container" style="flex:1;">
                                    <div class="xp-decision-header">
                                        <div class="xp-score-label-small">${isZh ? '投资结论' : 'Final Decision'}</div>
                                        <div class="xp-decision-badge ${decClass}">${decision}</div>
                                    </div>
                                    <div class="xp-decision-reason">${decReason}</div>
                                </div>
                            </div>
                            ${evalHtml}
                        </div>
                    </div>`;
            }

            // ── 1.5 品牌心智与价值主张 (competitor-profiling) ──
            if (d.brand_positioning && (d.brand_positioning.tagline || d.brand_positioning.positioning_angle || (d.brand_positioning.trust_triggers && d.brand_positioning.trust_triggers.length > 0))) {
                const bp = d.brand_positioning;
                const tagline = bp.tagline ? proc(bp.tagline) : '';
                const angle = bp.positioning_angle ? rawText(bp.positioning_angle) : '';
                const triggers = Array.isArray(bp.trust_triggers) ? bp.trust_triggers : [];
                const chips = triggers.map(t => {
                    const text = rawText(typeof t === 'string' ? t : (t.text || t.item || ''));
                    return text ? `<span class="xp-trust-chip">✓ ${proc(text)}</span>` : '';
                }).filter(Boolean).join('');

                content += `
                    <div class="section">
                        <div class="section-title">🧠 ${isZh ? '品牌心智与价值主张 (Brand Positioning)' : 'Brand Positioning & Value Proposition'}</div>
                        <div class="card xp-brand-pos-card">
                            <div class="xp-brand-pos-header">
                                <div class="xp-brand-tagline">“${tagline || (isZh ? '核心价值主张未明示' : 'Value proposition not stated')}”</div>
                                ${angle ? `<span class="xp-brand-angle-badge">🎯 ${angle}</span>` : ''}
                            </div>
                            ${chips ? `
                                <div class="xp-brand-trust-container">
                                    <span class="xp-brand-trust-label">${isZh ? '信任背书 / 权威背书' : 'Trust Triggers'}:</span>
                                    ${chips}
                                </div>` : ''}
                        </div>
                    </div>`;
            }

            // ── 1.6 2D 市场定位象限图 (competitor-profiling) ──
            const singleMapSvg = xp_generatePositioningMapSvg(d.quadrant_position, false, d, isZh ? 'zh' : 'en');
            content += `
                <div class="section">
                    <div class="section-title">🗺️ ${isZh ? '2D 市场定位象限 (Positioning Map)' : '2D Market Positioning Map'}</div>
                    <div class="card" style="padding:16px;text-align:center;">
                        <div style="max-width:640px;margin:0 auto;">
                            ${singleMapSvg}
                        </div>
                    </div>
                </div>`;

            // ── 1.7 跨境攻防对抗战术盘 (competitor-profiling) ──
            const bc = xp_normalizeBattleCard(d.battle_card);
            if (bc && (bc.competitor_moat?.length || bc.attack_vector?.length || bc.whitespace_opportunities?.length || bc.threat_radar?.length)) {
                const renderBcList = (items) => {
                    if (!items || items.length === 0) return `<li style="opacity:0.6;">-</li>`;
                    return items.map(item => `<li>${proc(item)}</li>`).join('');
                };

                content += `
                    <div class="section">
                        <div class="section-title">⚔️ ${isZh ? '跨境攻防对抗战术盘 (Battle Card)' : 'Competitive Battle Card'}</div>
                        <div class="xp-battle-card-grid">
                            <div class="xp-battle-col xp-battle-col-strong">
                                <div class="xp-battle-col-header">
                                    <div class="xp-battle-col-title">🛡️ <span>${isZh ? '竞品防守强区 (壁垒)' : 'Competitor Moat'}</span></div>
                                    <span class="xp-battle-subtag">${isZh ? '避其锋芒' : 'Avoid Head-on'}</span>
                                </div>
                                <ul class="xp-battle-list">${renderBcList(bc.competitor_moat)}</ul>
                            </div>
                            <div class="xp-battle-col xp-battle-col-attack">
                                <div class="xp-battle-col-header">
                                    <div class="xp-battle-col-title">⚔️ <span>${isZh ? '我方主攻破局点 (打痛点)' : 'Attack Vector'}</span></div>
                                    <span class="xp-battle-subtag">${isZh ? '痛点暴击' : 'High Impact'}</span>
                                </div>
                                <ul class="xp-battle-list">${renderBcList(bc.attack_vector)}</ul>
                            </div>
                            <div class="xp-battle-col xp-battle-col-whitespace">
                                <div class="xp-battle-col-header">
                                    <div class="xp-battle-col-title">💎 <span>${isZh ? '蓝海生态空白 (机会)' : 'Whitespace Opportunities'}</span></div>
                                    <span class="xp-battle-subtag">${isZh ? '未被满足' : 'Underserved'}</span>
                                </div>
                                <ul class="xp-battle-list">${renderBcList(bc.whitespace_opportunities)}</ul>
                            </div>
                            <div class="xp-battle-col xp-battle-col-threat">
                                <div class="xp-battle-col-header">
                                    <div class="xp-battle-col-title">⚠️ <span>${isZh ? '潜在反扑威胁 (预警)' : 'Threat Radar'}</span></div>
                                    <span class="xp-battle-subtag">${isZh ? '防备报复' : 'Retaliation'}</span>
                                </div>
                                <ul class="xp-battle-list">${renderBcList(bc.threat_radar)}</ul>
                            </div>
                        </div>
                    </div>`;
            }

            // ── 2. 产品深度透视 ──
            const sellingPoints = (d.core_selling_points || []).map(sp => {
                const text = proc(typeof sp === 'object' ? (sp.point || '') : String(sp));
                const badge = typeof sp === 'object' ? conf(sp.confidence) : '';
                return `<div class="xp-single-hero-point">${text} ${badge}</div>`;
            }).join('');

            content += `
                <div class="section">
                    <div class="section-title">🔬 ${isZh ? '产品深度透视' : 'Product Deep Dive'}</div>
                    <div class="card xp-single-hero-card">
                        <div class="xp-single-hero-name">${proc(d.product_name || '')}</div>
                        <div class="xp-single-hero-price">
                            <span>${proc(d.price || '-')}</span>
                            <span style="font-size:0.9rem;opacity:0.6;margin-left:1rem;">(${isZh ? '评价数' : 'Reviews'}: ${proc(d.reviews_count || '0')})</span>
                        </div>
                        <div class="xp-single-hero-points">${sellingPoints}</div>
                    </div>
                </div>`;

            // ── 3. 消费者画像与场景 ──
            const countries = (d.target_countries || []).map(c => rawText(c)).join(', ');
            const audiences = (d.target_audience || []).map(t => {
                const text = typeof t === 'object' ? (t.audience || t.item || '') : String(t);
                return rawText(text).trim();
            }).filter(Boolean).join('、');

            const scenarios = (d.use_scenarios || []).map(s => {
                const text = typeof s === 'object' ? (s.scenario || s.item || '') : String(s);
                const cleanText = rawText(text).trim();
                return cleanText ? `<span class="xp-single-tag xp-scenario">${cleanText}</span>` : '';
            }).join('');

            content += `
                <div class="section">
                    <div class="section-title">🎯 ${isZh ? '消费者画像与使用场景' : 'Consumer Persona & Scenarios'}</div>
                    <div class="grid-2">
                        <div class="card">
                            <div class="card-label">${isZh ? '目标人群画像' : 'Target Persona'}</div>
                            <div class="xp-persona-info-list">
                                <div class="xp-persona-info-item"><strong>${isZh ? '年龄段：' : 'Age Range: '}</strong><span>${rawText(d.age_range || '-')}</span></div>
                                <div class="xp-persona-info-item"><strong>${isZh ? '适合投放的国家：' : 'Target Countries: '}</strong><span>${countries || '-'}</span></div>
                                <div class="xp-persona-info-item"><strong>${isZh ? '用户群体：' : 'User Groups: '}</strong><span>${audiences || '-'}</span></div>
                            </div>
                        </div>
                        <div class="card">
                            <div class="card-label">${isZh ? '核心使用场景' : 'Use Scenarios'}</div>
                            <div class="xp-single-tags-block">${scenarios || '<p style="color:#94a3b8;">-</p>'}</div>
                        </div>
                    </div>
                </div>`;

            // ── 4. 用户痛点分析 ──
            const painHtml = (d.user_pain_points || []).map(pp => {
                const text = proc(typeof pp === 'object' ? (pp.pain || '') : String(pp));
                const badge = typeof pp === 'object' ? conf(pp.confidence) : '';
                return `<div class="xp-single-pain-card">${text} ${badge}</div>`;
            }).join('');

            content += `
                <div class="section">
                    <div class="section-title">😤 ${isZh ? '用户痛点深入洞察' : 'User Pain Points'}</div>
                    <div class="xp-single-pain-grid">${painHtml || '<p style="color:#94a3b8;">-</p>'}</div>
                </div>`;

            // ── 5. 逆向营销策略 ──
            const trafficItems = (d.traffic_strategy || []).map(t => {
                const channel = rawText(t.channel);
                const detail = proc(t.detail);
                return `<div class="xp-traffic-item"><div class="xp-traffic-channel">${channel}</div><div class="xp-traffic-detail">${detail}</div></div>`;
            }).join('');

            const adAngles = d.ad_angles || [];
            let adCardsHtml = '';
            if (adAngles.length > 0) {
                adCardsHtml = `<div class="xp-ad-script-list">` + adAngles.map((a, idx) => {
                    const parsed = xp_parseAdAngle(a);
                    const angle = proc(parsed.angle || '');
                    const hook = proc(parsed.hook || '');
                    const script = proc(parsed.script || '');
                    const cta = proc(parsed.cta_hashtags || '');
                    const num = String(idx + 1).padStart(2, '0');

                    let bodyHtml = '';
                    if (hook) {
                        bodyHtml += `
                            <div class="xp-ad-section-box xp-ad-hook-box">
                                <div class="xp-ad-sublabel"><span>🎯 ${isZh ? '前 3 秒黄金视听钩子 (Hook)' : '3-Sec Hook'}</span></div>
                                <div class="xp-ad-text-content">${hook}</div>
                            </div>`;
                    }
                    if (script) {
                        bodyHtml += `
                            <div class="xp-ad-section-box xp-ad-script-box">
                                <div class="xp-ad-sublabel"><span>🎬 ${isZh ? '分镜头核心反差与台词 (Script)' : 'Scene Breakdown & Script'}</span></div>
                                <div class="xp-ad-text-content" style="white-space:pre-wrap;">${script}</div>
                            </div>`;
                    }
                    if (cta) {
                        bodyHtml += `
                            <div class="xp-ad-section-box xp-ad-cta-box">
                                <div class="xp-ad-sublabel"><span>📣 ${isZh ? '行动号召与话题标签 (CTA & Hashtags)' : 'CTA & Hashtags'}</span></div>
                                <div class="xp-ad-text-content xp-ad-cta-text">${cta}</div>
                            </div>`;
                    }
                    if (!hook && !script && !cta) {
                        bodyHtml += `
                            <div class="xp-ad-section-box xp-ad-script-box">
                                <div class="xp-ad-text-content">${angle}</div>
                            </div>`;
                    }

                    return `
                        <div class="xp-ad-script-card">
                            <div class="xp-ad-script-header">
                                <div class="xp-ad-script-badge">
                                    <span>🎬 脚本 #${num}${(hook || script) ? ` · ${angle}` : ''}</span>
                                </div>
                            </div>
                            ${bodyHtml}
                        </div>`;
                }).join('') + `</div>`;
            }

            content += `
                <div class="section">
                    <div class="section-title">🚀 ${isZh ? '逆向营销与流量策略' : 'Reverse Marketing & Ad Strategy'}</div>
                    <div class="grid-2">
                        <div class="card">
                            <div class="card-label">${isZh ? '主要流量渠道' : 'Main Traffic Channels'}</div>
                            ${trafficItems || '<p style="color:#94a3b8;">-</p>'}
                        </div>
                        <div class="card">
                            <div class="card-label">${isZh ? '短视频广告分镜头脚本' : 'Video Ad Creative Scripts'}</div>
                            ${adCardsHtml || '<p style="color:#94a3b8;">-</p>'}
                        </div>
                    </div>
                </div>`;

            // ── 6. 核心优势与风险 ──
            const strItems = (d.strengths || []).map(s => {
                const point = rawText(s.point);
                const detail = proc(s.detail);
                return `<div class="xp-strength-item"><div class="xp-strength-point">${point}</div><div class="xp-strength-detail">${detail}</div></div>`;
            }).join('');

            const weakItems = (d.weaknesses || []).map(w => {
                const risk = rawText(w.risk);
                const detail = proc(w.detail);
                return `<div class="xp-weakness-item"><div class="xp-weakness-risk">${risk}</div><div class="xp-weakness-detail">${detail}</div></div>`;
            }).join('');

            content += `
                <div class="section">
                    <div class="section-title">⚡ ${isZh ? '核心优势与关键风险' : 'Core Strengths & Key Risks'}</div>
                    <div class="grid-2">
                        <div class="card xp-single-strength-card">
                            <div class="card-label" style="color:#059669;">✓ ${isZh ? '核心优势' : 'Strengths'}</div>
                            ${strItems || '<p style="color:#94a3b8;">-</p>'}
                        </div>
                        <div class="card xp-single-weakness-card">
                            <div class="card-label" style="color:#dc2626;">⚠️ ${isZh ? '关键风险' : 'Key Risks'}</div>
                            ${weakItems || '<p style="color:#94a3b8;">-</p>'}
                        </div>
                    </div>
                </div>`;

            // ── 7. 差异化改良机会 ──
            const diffHtml = (d.differentiation_opportunities || []).map(opp => {
                const text = proc(typeof opp === 'object' ? (opp.opportunity || '') : String(opp));
                const badge = typeof opp === 'object' ? conf(opp.confidence) : '';
                return `<div class="xp-eval-card"><div class="xp-eval-card-dim">${isZh ? '差异化改良切入点' : 'Opportunity'}</div><div class="xp-eval-card-detail">${text} ${badge}</div></div>`;
            }).join('');

            content += `
                <div class="section">
                    <div class="section-title">💡 ${isZh ? '差异化机会' : 'Differentiation Opportunities'}</div>
                    <div class="xp-single-diff-grid">${diffHtml || '<p style="color:#94a3b8;">-</p>'}</div>
                </div>`;

            // ── 8. 操盘建议 ──
            const recRaw = proc(d.entry_recommendation || '');
            const steps = recRaw.split(/(?=\d+\.|①|②|③|第[一二三])/).filter(s => s.trim());
            let recContent;
            if (steps.length > 1) {
                recContent = `<div class="xp-rec-steps">` + steps.map((s, i) => `
                    <div class="xp-rec-step">
                        <div class="xp-rec-step-num">${i + 1}</div>
                        <div>${s.replace(/^\d+\.\s*/, '').trim()}</div>
                    </div>`).join('') + `</div>`;
            } else {
                recContent = `<p style="line-height:1.7;">${recRaw}</p>`;
            }

            content += `
                <div class="section">
                    <div class="section-title">🎯 ${isZh ? '操盘实施建议' : 'Entry Strategy'}</div>
                    <div class="card xp-single-rec-card">${recContent}</div>
                </div>`;

            // ── 8.5 买家常见异议预判与客服攻防库 ──
            if (d.customer_objections && d.customer_objections.length > 0) {
                const objectionsHtml = d.customer_objections.map((item, idx) => {
                    const q = proc(item.objection || '');
                    const a = proc(item.response || '');
                    const proof = item.proof_point ? proc(item.proof_point) : '';
                    return `
                        <div class="xp-objection-card">
                            <div class="xp-objection-q">
                                <span class="xp-objection-tag-q">Q${idx + 1}</span>
                                <span>${q}</span>
                            </div>
                            <div class="xp-objection-a">
                                <div class="xp-objection-tag-a">💬 ${isZh ? '客服高转化应对策略与公关说辞' : 'Sales Defense & Response'}</div>
                                <div style="white-space:pre-wrap;">${a}</div>
                            </div>
                            ${proof ? `
                                <div class="xp-objection-proof">
                                    <span>🔒 <strong>${isZh ? '背书事实/质保承诺' : 'Proof Point & Warranty'}:</strong> ${proof}</span>
                                </div>` : ''}
                        </div>`;
                }).join('');

                content += `
                    <div class="section">
                        <div class="section-title">🛡️ ${isZh ? '买家常见异议预判与客服攻防话术库 (Customer Objection Defense)' : 'Customer Objection Defense Q&A'}</div>
                        <div class="xp-objections-grid">${objectionsHtml}</div>
                    </div>`;
            }

            // ── 9. VOC 用户口碑 ──
            if (d.voc_analysis) {
                const v = d.voc_analysis;
                const sentimentVal = parseInt(v.sentiment) || 80;
                const pList = (v.pros || []).map(p => `<li class="xp-voc-item">${proc(p)}</li>`).join('');
                const cList = (v.cons || []).map(c => `<li class="xp-voc-item">${proc(c)}</li>`).join('');

                content += `
                    <div class="section">
                        <div class="section-title">📣 ${isZh ? '用户评价深度洞察 (VOC)' : 'Voice of Customer (VOC)'}</div>
                        <div class="card">
                            <div class="xp-sentiment-container">
                                <span class="xp-sentiment-label">${isZh ? '好评率 / 情绪指数' : 'Sentiment Score'}</span>
                                <div class="xp-sentiment-bar-bg"><div class="xp-sentiment-bar-fill" style="width:${sentimentVal}%"></div></div>
                                <span class="xp-sentiment-value">${sentimentVal}%</span>
                            </div>
                            <div class="xp-voc-grid" style="margin-top:14px;">
                                <div class="xp-voc-card xp-voc-pros">
                                    <div class="xp-voc-card-title">✨ ${isZh ? '核心好评点' : 'Top Pros'}</div>
                                    <ul class="xp-voc-list">${pList}</ul>
                                </div>
                                <div class="xp-voc-card xp-voc-cons">
                                    <div class="xp-voc-card-title">⚠️ ${isZh ? '核心痛点 / 差评' : 'Top Cons'}</div>
                                    <ul class="xp-voc-list">${cList}</ul>
                                </div>
                            </div>
                        </div>
                    </div>`;
            }
        } else {
            // ── 矩阵对比报告 ──
            const { products = [], comparison, comprehensive_evaluation = [], recommendation_list = [], scores = [] } = data;
            reportSub = isZh ? `共分析 ${products.length} 款竞品对比` : `Comparing ${products.length} Competitor Products`;

            // 确定赢家
            let winnerIdx = -1;
            if (comparison && comparison.winner_product) {
                const winnerName = rawText(comparison.winner_product).toLowerCase();
                products.forEach((p, i) => {
                    const name = rawText(p.product_name || '').toLowerCase();
                    if (name && winnerName.includes(name.substring(0, 10))) winnerIdx = i;
                });
            }
            if (winnerIdx < 0 && scores && scores.length === products.length) {
                let bestScore = -Infinity;
                scores.forEach((scoreObj, i) => {
                    const score = xp_investmentScore(scoreObj);
                    if (score > bestScore) {
                        bestScore = score;
                        winnerIdx = i;
                    }
                });
            }

            // 1. 评分卡
            if (scores && scores.length > 0) {
                const scoreCards = scores.map((s, idx) => {
                    const isWin = idx === winnerIdx;
                    const dScore = s.difficulty_score || 0;
                    const oScore = s.opportunity_score || 0;
                    const dec = rawText(s.final_decision || 'N/A');
                    const isRec = xp_isRecommendDecision(dec);
                    const decClass = isRec ? 'xp-decision-recommend' : 'xp-decision-caution';
                    const reason = proc(s.decision_details?.reason || '');

                    return `
                        <div class="xp-card xp-score-card ${isWin ? 'xp-winner-score-card' : ''}" style="flex:1;min-width:260px;">
                            <div class="xp-score-title">
                                ${isWin ? '👑 ' : ''}${rawText(s.product || '')}
                            </div>
                            <div class="xp-score-main-flex">
                                <div class="xp-score-item-box">
                                    <div class="xp-score-label-small">${isZh ? '机会评分' : 'Opp Score'}</div>
                                    <div class="xp-score-value-big xp-opp-text">${oScore}</div>
                                </div>
                                <div class="xp-score-divider"></div>
                                <div class="xp-score-item-box">
                                    <div class="xp-score-label-small">${isZh ? '进入难度' : 'Difficulty'}</div>
                                    <div class="xp-score-value-big xp-diff-text">${dScore}</div>
                                </div>
                            </div>
                            <div class="xp-decision-container">
                                <div class="xp-decision-header">
                                    <div class="xp-score-label-small">${isZh ? '投资建议' : 'Decision'}</div>
                                    <div class="xp-decision-badge ${decClass}">${dec}</div>
                                </div>
                                <div class="xp-decision-reason">${reason}</div>
                            </div>
                        </div>`;
                }).join('');

                content += `
                    <div class="section">
                        <div class="section-title">📊 ${isZh ? '竞品投资打分横向对比' : 'Investment Scoring Comparison'}</div>
                        <div class="xp-scores-grid" style="display:flex;flex-wrap:wrap;gap:12px;">${scoreCards}</div>
                    </div>`;
            }

            // 2. 市场竞争分析与赢家产品
            if (comparison) {
                content += `
                    <div class="section">
                        <div class="section-title">⚖️ ${isZh ? '市场竞争态势与赢家研判' : 'Market Competition & Winner Overview'}</div>
                        <div class="card" style="background:linear-gradient(135deg, #f5f3ff 0%, #ffffff 100%);border:1px solid #ddd6fe;">
                            <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:16px;">
                                <div>
                                    <div class="card-label" style="color:#7c3aed;">👑 ${isZh ? '最具投资价值赢家产品' : 'Winner Product'}</div>
                                    <div style="font-size:1.1rem;font-weight:800;color:#5b21b6;">${rawText(comparison.winner_product)}</div>
                                </div>
                                <div>
                                    <div class="card-label">${isZh ? '市场竞争程度' : 'Competition Level'}</div>
                                    <div style="font-size:1rem;font-weight:700;color:#0f172a;">${rawText(comparison.competition_level)}</div>
                                </div>
                                <div>
                                    <div class="card-label">${isZh ? '推荐市场定位' : 'Market Positioning'}</div>
                                    <div style="font-size:1rem;font-weight:700;color:#0f172a;">${rawText(comparison.market_position)}</div>
                                </div>
                            </div>
                        </div>
                    </div>`;
            }

            // 2.2 多品战略博弈格局与我方突围蓝图 (Strategic Blueprint)
            const strat = data.strategic_insights || data.comparison || {};
            const winner = strat.winner_analysis;
            const breakthrough = strat.breakthrough_strategy;
            const landscape = strat.market_landscape;
            const pricingTier = strat.pricing_tier_analysis;

            if (winner || breakthrough || landscape || pricingTier) {
                let strategyCards = '';

                if (winner) {
                    const adv = proc(winner.key_advantages || '');
                    const vuln = proc(winner.fatal_vulnerability || '');
                    strategyCards += `
                        <div class="xp-strategy-card xp-strategy-winner-card">
                            <div class="xp-strategy-card-title">
                                <span>🏆 ${isZh ? '胜出竞品深度解剖与突破死穴' : 'Winner Advantage & Vulnerability'}</span>
                            </div>
                            ${adv ? `
                                <div class="xp-strategy-item">
                                    <strong>🛡️ ${isZh ? '核心护城河与胜出根基：' : 'Key Advantages & Moat:'}</strong>
                                    <span>${adv}</span>
                                </div>` : ''}
                            ${vuln ? `
                                <div class="xp-strategy-item xp-vulnerability-item">
                                    <strong>🎯 ${isZh ? '致命弱点与隐秘缺陷（我方主攻点）：' : 'Fatal Vulnerability (Attack Vector):'}</strong>
                                    <span>${vuln}</span>
                                </div>` : ''}
                        </div>`;
                }

                if (breakthrough) {
                    const innov = proc(breakthrough.product_innovation || '');
                    const pricing = proc(breakthrough.pricing_entry || '');
                    const mkt = proc(breakthrough.marketing_playbook || '');
                    strategyCards += `
                        <div class="xp-strategy-card xp-strategy-breakthrough-card">
                            <div class="xp-strategy-card-title">
                                <span>⚔️ ${isZh ? '我方差异化突围实战作战打法' : 'Breakthrough Strategy & Playbook'}</span>
                            </div>
                            ${innov ? `
                                <div class="xp-strategy-item">
                                    <strong>💡 ${isZh ? '规格改良与微创新（降维打击）：' : 'Product Innovation & Spec Upgrade:'}</strong>
                                    <span>${innov}</span>
                                </div>` : ''}
                            ${pricing ? `
                                <div class="xp-strategy-item">
                                    <strong>🏷️ ${isZh ? '切入定价与毛利空间建议：' : 'Entry Price & Profit Margin:'}</strong>
                                    <span>${pricing}</span>
                                </div>` : ''}
                            ${mkt ? `
                                <div class="xp-strategy-item">
                                    <strong>🚀 ${isZh ? '冷启动流量打法（痛点反差钩子）：' : 'Go-To-Market Traffic Hook:'}</strong>
                                    <span>${mkt}</span>
                                </div>` : ''}
                        </div>`;
                }

                if (landscape || pricingTier) {
                    const ls = landscape ? proc(landscape) : '';
                    const pt = pricingTier ? proc(pricingTier) : '';
                    strategyCards += `
                        <div class="xp-strategy-card xp-strategy-landscape-card">
                            <div class="xp-strategy-card-title">
                                <span>🌐 ${isZh ? '市场博弈格局与价格带梯队' : 'Market Landscape & Price Tiers'}</span>
                            </div>
                            ${ls ? `
                                <div class="xp-strategy-item">
                                    <strong>🌐 ${isZh ? '市场竞争态势与准入门槛：' : 'Competition Landscape & Entry Barriers:'}</strong>
                                    <span>${ls}</span>
                                </div>` : ''}
                            ${pt ? `
                                <div class="xp-strategy-item">
                                    <strong>💰 ${isZh ? '各梯队价格分布与毛利带：' : 'Pricing Tier & Margin Space:'}</strong>
                                    <span>${pt}</span>
                                </div>` : ''}
                        </div>`;
                }

                content += `
                    <div class="section">
                        <div class="section-title">🏆 ${isZh ? '战略博弈格局与我方突围蓝图 (Strategic Blueprint)' : 'Strategic Breakthrough Blueprint'}</div>
                        <div class="xp-matrix-strategy-grid">${strategyCards}</div>
                    </div>`;
            }

            // 2.5 多竞品 2D 定位象限图 (competitor-profiling)
            const matrixMapSvg = xp_generatePositioningMapSvg(data.quadrant_map, true, data, isZh ? 'zh' : 'en');
            content += `
                <div class="section">
                    <div class="section-title">🗺️ ${isZh ? '多竞品市场定位象限图 (Positioning Map)' : 'Multi-Product Positioning Map'}</div>
                    <div class="card" style="padding:16px;text-align:center;">
                        <div style="max-width:640px;margin:0 auto;">
                            ${matrixMapSvg}
                        </div>
                    </div>
                </div>`;

            // 3. 对比矩阵表格
            if (products.length > 0) {
                let ths = `<th>${isZh ? '分析维度' : 'Dimension'}</th>`;
                products.forEach((p, idx) => {
                    const isWin = idx === winnerIdx;
                    const crownBadge = isWin ? '<span class="xp-winner-badge">👑 Winner</span>' : '';
                    const thClass = isWin ? 'class="xp-winner-col-th"' : '';
                    ths += `<th ${thClass}>${proc(p.product_name || 'Product ' + (idx + 1))} ${crownBadge}<br><span style="font-weight:normal;font-size:0.82rem;color:#64748b;">${proc(p.price || '-')} (${proc(p.reviews_count || '0')} reviews)</span></th>`;
                });

                const matrixRows = [
                    {
                        label: isZh ? '🧠 品牌心智与定位' : 'Brand Positioning',
                        render: p => {
                            if (!p.brand_positioning) return '-';
                            const bp = p.brand_positioning;
                            const tag = bp.tagline ? `“${rawText(bp.tagline)}”` : '';
                            const angle = bp.positioning_angle ? `<span class="xp-brand-angle-badge" style="display:inline-block;margin-bottom:4px;">${rawText(bp.positioning_angle)}</span>` : '';
                            return `${angle ? `<div>${angle}</div>` : ''}${tag ? `<div style="font-weight:700;color:#334155;font-size:0.85rem;">${tag}</div>` : ''}` || '-';
                        }
                    },
                    {
                        label: isZh ? '✨ 核心卖点' : 'Selling Points',
                        render: p => {
                            const items = (p.core_selling_points || []).map(sp => `<li>${proc(typeof sp === 'object' ? (sp.point || '') : String(sp))}</li>`).join('');
                            return `<ul class="xp-td-list">${items || '-'}</ul>`;
                        }
                    },
                    {
                        label: isZh ? '🎯 消费者画像' : 'Consumer Persona',
                        render: p => {
                            const lines = [];
                            if (p.age_range) lines.push(`<strong>${isZh ? '年龄：' : 'Age: '}</strong>${rawText(p.age_range)}`);
                            if (p.target_countries && p.target_countries.length > 0) lines.push(`<strong>${isZh ? '国家：' : 'Countries: '}</strong>${p.target_countries.map(c => rawText(c)).join(', ')}`);
                            if (p.target_audience && p.target_audience.length > 0) {
                                const auds = p.target_audience.map(a => rawText(typeof a === 'object' ? (a.audience || a.item || '') : String(a))).join('、');
                                lines.push(`<strong>${isZh ? '人群：' : 'Groups: '}</strong>${auds}`);
                            }
                            return lines.length > 0 ? lines.map(l => `<div>${l}</div>`).join('') : '-';
                        }
                    },
                    {
                        label: isZh ? '📍 使用场景' : 'Use Scenarios',
                        render: p => {
                            const scs = (p.use_scenarios || []).map(s => {
                                const text = rawText(typeof s === 'object' ? (s.scenario || s.item || '') : String(s)).trim();
                                return text ? `<span class="xp-single-tag xp-scenario" style="margin:2px 4px 2px 0;display:inline-block;">${text}</span>` : '';
                            }).join('');
                            return scs || '-';
                        }
                    },
                    {
                        label: isZh ? '🛡️ 核心优势/壁垒' : 'Moat / Strengths',
                        render: p => {
                            const bc = xp_normalizeBattleCard(p.battle_card);
                            if (bc && bc.competitor_moat && bc.competitor_moat.length > 0) {
                                return '<ul class="xp-td-list">' + bc.competitor_moat.map(m => `<li>${proc(m)}</li>`).join('') + '</ul>';
                            }
                            const items = (p.strengths || []).map(s => `
                                <div style="margin-bottom:6px;">
                                    <strong style="color:#059669;">${rawText(s.point || '')}:</strong>
                                    <span style="color:#334155;font-size:0.85rem;">${proc(s.detail || '')}</span>
                                </div>`).join('');
                            return items || (typeof p.strengths === 'string' ? proc(p.strengths) : '-');
                        }
                    },
                    {
                        label: isZh ? '⚔️ 致命软肋/主攻痛点' : 'Attack Vector',
                        render: p => {
                            const bc = xp_normalizeBattleCard(p.battle_card);
                            if (bc && bc.attack_vector && bc.attack_vector.length > 0) {
                                return '<ul class="xp-td-list">' + bc.attack_vector.map(a => `<li>${proc(a)}</li>`).join('') + '</ul>';
                            }
                            const items = (p.weaknesses || []).map(w => `
                                <div style="margin-bottom:6px;">
                                    <strong style="color:#dc2626;">${rawText(w.risk || '')}:</strong>
                                    <span style="color:#334155;font-size:0.85rem;">${proc(w.detail || '')}</span>
                                </div>`).join('');
                            return items || (typeof p.weaknesses === 'string' ? proc(p.weaknesses) : '-');
                        }
                    },
                    {
                        label: isZh ? '📣 用户口碑 VOC' : 'Feedback VOC',
                        render: p => {
                            if (!p.voc_analysis) return '-';
                            const v = p.voc_analysis;
                            const pros = (v.pros || []).map(pr => `<div style="color:#059669;font-size:0.82rem;margin-bottom:2px;">👍 ${proc(pr)}</div>`).join('');
                            const cons = (v.cons || []).map(co => `<div style="color:#dc2626;font-size:0.82rem;margin-bottom:2px;">👎 ${proc(co)}</div>`).join('');
                            return `
                                <div style="margin-bottom:6px;font-size:0.8rem;font-weight:700;color:#64748b;">${isZh ? '情绪值：' : 'Sentiment: '}<span style="color:#7c3aed;">${rawText(v.sentiment || '80%')}</span></div>
                                ${pros}${cons}`;
                        }
                    },
                    {
                        label: isZh ? '🔒 买家疑虑与对策' : 'Buyer Objections',
                        render: p => {
                            if (!p.customer_objections || p.customer_objections.length === 0) return '-';
                            return p.customer_objections.slice(0, 2).map((item, idx) => `
                                <div style="margin-bottom:6px;font-size:0.82rem;">
                                    <strong style="color:#b91c1c;">Q${idx + 1}: ${proc(item.objection || '')}</strong>
                                    <div style="color:#2563eb;font-size:0.78rem;margin-top:2px;">💬 ${proc(item.response || '')}</div>
                                </div>`).join('');
                        }
                    }
                ];

                let tbodyHtml = '';
                matrixRows.forEach(r => {
                    let tds = `<td><strong>${r.label}</strong></td>`;
                    products.forEach((p, idx) => {
                        const isWin = idx === winnerIdx;
                        const tdClass = isWin ? 'class="xp-winner-col-td"' : '';
                        tds += `<td ${tdClass}>${r.render(p)}</td>`;
                    });
                    tbodyHtml += `<tr>${tds}</tr>`;
                });

                content += `
                    <div class="section">
                        <div class="section-title">📋 ${isZh ? '竞品横向深度对比矩阵' : 'Comparison Matrix'}</div>
                        <div class="xp-table-container">
                            <table class="xp-compare-table">
                                <thead><tr>${ths}</tr></thead>
                                <tbody>${tbodyHtml}</tbody>
                            </table>
                        </div>
                    </div>`;

                // 3.5 各竞品单品深度透视与战术库
                let competitorDetailsHtml = '';
                products.forEach((p, idx) => {
                    const isWin = idx === winnerIdx;
                    const pName = proc(p.product_name || `Product ${idx + 1}`);
                    const price = proc(p.price || '-');
                    const revs = proc(p.reviews_count || '0');

                    // 品牌心智
                    let bpBlock = '';
                    if (p.brand_positioning) {
                        const bp = p.brand_positioning;
                        const tag = bp.tagline ? `“${rawText(bp.tagline)}”` : '';
                        const angle = bp.positioning_angle ? rawText(bp.positioning_angle) : '';
                        const triggers = (bp.trust_triggers || []).map(t => `<span class="xp-trust-chip"><i class="ph ph-shield-check"></i>${rawText(t)}</span>`).join('');
                        bpBlock = `
                            <div class="xp-brand-positioning-card" style="margin-bottom:12px;">
                                <div class="xp-brand-header-flex">
                                    <div class="xp-brand-tagline">${tag}</div>
                                    ${angle ? `<span class="xp-brand-angle-badge">${angle}</span>` : ''}
                                </div>
                                ${triggers ? `<div class="xp-brand-trust-triggers"><span class="xp-brand-trust-label">${isZh ? '权威背书' : 'Triggers'}:</span> ${triggers}</div>` : ''}
                            </div>`;
                    }

                    // 攻防盘
                    let bcBlock = '';
                    if (p.battle_card) {
                        const bc = xp_normalizeBattleCard(p.battle_card);
                        const renderBc = (items) => (items || []).map(i => `<li>${proc(i)}</li>`).join('') || '<li style="opacity:0.6;">-</li>';
                        bcBlock = `
                            <div class="xp-battle-card-grid" style="margin-bottom:12px;">
                                <div class="xp-battle-col xp-battle-col-strong">
                                    <div class="xp-battle-col-header"><div class="xp-battle-col-title">🛡️ <span>${isZh ? '防守强区 (壁垒)' : 'Moat'}</span></div></div>
                                    <ul class="xp-battle-list">${renderBc(bc.competitor_moat)}</ul>
                                </div>
                                <div class="xp-battle-col xp-battle-col-attack">
                                    <div class="xp-battle-col-header"><div class="xp-battle-col-title">⚔️ <span>${isZh ? '我方主攻点 (打痛点)' : 'Attack Vector'}</span></div></div>
                                    <ul class="xp-battle-list">${renderBc(bc.attack_vector)}</ul>
                                </div>
                                <div class="xp-battle-col xp-battle-col-whitespace">
                                    <div class="xp-battle-col-header"><div class="xp-battle-col-title">💎 <span>${isZh ? '蓝海空白' : 'Whitespace'}</span></div></div>
                                    <ul class="xp-battle-list">${renderBc(bc.whitespace_opportunities)}</ul>
                                </div>
                                <div class="xp-battle-col xp-battle-col-threat">
                                    <div class="xp-battle-col-header"><div class="xp-battle-col-title">⚠️ <span>${isZh ? '反扑预警' : 'Threat Radar'}</span></div></div>
                                    <ul class="xp-battle-list">${renderBc(bc.threat_radar)}</ul>
                                </div>
                            </div>`;
                    }

                    // 客诉攻防
                    let objBlock = '';
                    if (p.customer_objections && p.customer_objections.length > 0) {
                        const objCards = p.customer_objections.map((item, oIdx) => `
                            <div class="xp-objection-card">
                                <div class="xp-objection-q"><span class="xp-objection-tag-q">Q${oIdx + 1}</span><span>${proc(item.objection || '')}</span></div>
                                <div class="xp-objection-a"><div class="xp-objection-tag-a">💬 ${isZh ? '客服攻防说辞' : 'Response'}</div><div style="white-space:pre-wrap;">${proc(item.response || '')}</div></div>
                                ${item.proof_point ? `<div class="xp-objection-proof"><span>🔒 <strong>${isZh ? '背书质保' : 'Proof'}:</strong> ${proc(item.proof_point)}</span></div>` : ''}
                            </div>`).join('');
                        objBlock = `<div style="margin-bottom:12px;"><div style="font-weight:700;font-size:0.85rem;color:#0f172a;margin-bottom:8px;">🛡️ ${isZh ? '买家常见异议预判与客服攻防话术' : 'Customer Objection Defense'}</div><div class="xp-objections-grid">${objCards}</div></div>`;
                    }

                    // 短视频脚本
                    let adBlock = '';
                    if (p.ad_angles && p.ad_angles.length > 0) {
                        const adCards = p.ad_angles.map((item, aIdx) => {
                            const parsed = xp_parseAdAngle(item);
                            return `
                                <div class="card" style="padding:10px 14px;background:#ffffff;border:1px solid #e2e8f0;margin-bottom:8px;">
                                    <div style="font-weight:800;font-size:0.85rem;color:#0f172a;margin-bottom:4px;">🎬 #${aIdx + 1} ${proc(parsed.angle || '')}</div>
                                    ${parsed.hook ? `<div style="font-size:0.8rem;color:#b45309;background:#fffbeb;padding:4px 8px;border-radius:4px;margin-bottom:4px;"><strong>Hook:</strong> ${proc(parsed.hook)}</div>` : ''}
                                    ${parsed.script ? `<div style="font-size:0.8rem;color:#334155;white-space:pre-wrap;">${proc(parsed.script)}</div>` : ''}
                                </div>`;
                        }).join('');
                        adBlock = `<div><div style="font-weight:700;font-size:0.85rem;color:#0f172a;margin-bottom:8px;">🎬 ${isZh ? '爆款短视频/投流分镜头脚本' : 'Ad Angle Scripts'}</div><div>${adCards}</div></div>`;
                    }

                    if (bpBlock || bcBlock || objBlock || adBlock) {
                        competitorDetailsHtml += `
                            <div class="card" style="margin-bottom:16px;border-left:4px solid ${isWin ? '#7c3aed' : '#94a3b8'};">
                                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #f1f5f9;">
                                    <div style="font-size:1.05rem;font-weight:800;color:#0f172a;">
                                        ${isWin ? '👑 ' : ''}<span>${pName}</span>
                                        <span style="font-size:0.85rem;font-weight:normal;color:#64748b;margin-left:8px;">${price} (${revs} reviews)</span>
                                    </div>
                                    ${isWin ? '<span class="xp-winner-badge">Winner</span>' : ''}
                                </div>
                                ${bpBlock}
                                ${bcBlock}
                                ${objBlock}
                                ${adBlock}
                            </div>`;
                    }
                });

                if (competitorDetailsHtml) {
                    content += `
                        <div class="section">
                            <div class="section-title">🔍 ${isZh ? '各竞品单品深度透视与战术情报库' : 'Individual Competitor Deep Intelligence & Playbooks'}</div>
                            <div>${competitorDetailsHtml}</div>
                        </div>`;
                }
            }

            // 4. 综合评估与建议
            const hasEval = comprehensive_evaluation && comprehensive_evaluation.length > 0;
            const hasRec = recommendation_list && recommendation_list.length > 0;
            if (hasEval || hasRec) {
                let evalCards = '';
                if (hasEval) {
                    evalCards = comprehensive_evaluation.map(item => {
                        if (typeof item === 'string') {
                            return `<div class="xp-eval-card"><div class="xp-eval-card-detail">${proc(item)}</div></div>`;
                        }
                        const dim = rawText(item.dimension || item.dim || '').trim();
                        const det = proc(item.detail || item.content || item.verdict || '').trim();
                        return `
                            <div class="xp-eval-card">
                                ${dim ? `<div class="xp-eval-card-dim">${dim}</div>` : ''}
                                <div class="xp-eval-card-detail">${det}</div>
                            </div>`;
                    }).join('');
                }

                let recCards = '';
                if (hasRec) {
                    recCards = recommendation_list.map(item => {
                        if (typeof item === 'string') {
                            return `
                                <div class="xp-rec-card">
                                    <span class="xp-rec-card-content">${proc(item)}</span>
                                </div>`;
                        }
                        const actionText = rawText(item.action || '');
                        const isRisk = actionText.includes('风险') || actionText.toLowerCase().includes('risk');
                        const isOpp = actionText.includes('机会') || actionText.toLowerCase().includes('opportunity');
                        const actionClass = isRisk ? 'xp-risk' : (isOpp ? 'xp-opportunity' : '');
                        return `
                            <div class="xp-rec-card">
                                ${actionText ? `<span class="xp-rec-card-action ${actionClass}">${actionText}</span>` : ''}
                                <span class="xp-rec-card-content">${proc(item.content || item.text || '')}</span>
                            </div>`;
                    }).join('');
                }

                content += `
                    <div class="section">
                        <div class="section-title">🎯 ${isZh ? '综合机会评估与操盘建议' : 'Comprehensive Evaluation & Advice'}</div>
                        <div class="grid-2">
                            <div>
                                <div class="card-label">${isZh ? '评估维度洞察' : 'Evaluation Insights'}</div>
                                <div>${evalCards || '<p style="color:#94a3b8;">-</p>'}</div>
                            </div>
                            <div>
                                <div class="card-label">${isZh ? '操盘落地建议' : 'Strategic Recommendations'}</div>
                                <div>${recCards || '<p style="color:#94a3b8;">-</p>'}</div>
                            </div>
                        </div>
                    </div>`;
            }
        }

        // ── 纯净现代高管白皮书排版样式 (White / Slate Executive Theme) ──
        const css = `
            :root {
                --bg: #f8fafc;
                --paper-bg: #ffffff;
                --text-primary: #0f172a;
                --text-secondary: #334155;
                --text-muted: #64748b;
                --card-border: #e2e8f0;
                --primary: #4f46e5;
                --primary-light: #eef2ff;
                --success: #10b981;
                --success-light: #ecfdf5;
                --warning: #f59e0b;
                --warning-light: #fffbeb;
                --danger: #ef4444;
                --danger-light: #fff1f2;
            }
            * { box-sizing: border-box; }
            body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                background-color: var(--bg);
                color: var(--text-primary);
                margin: 0;
                padding: 30px 16px;
                line-height: 1.6;
                -webkit-font-smoothing: antialiased;
            }
            .container {
                max-width: 1080px;
                margin: 0 auto;
                background: var(--paper-bg);
                border: 1px solid var(--card-border);
                border-radius: 20px;
                box-shadow: 0 10px 30px -5px rgba(15, 23, 42, 0.06);
                padding: 40px;
            }
            .header {
                background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
                border: 1px solid var(--card-border);
                border-radius: 16px;
                padding: 28px 32px;
                margin-bottom: 28px;
                position: relative;
                overflow: hidden;
            }
            .header::before {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                height: 4px;
                background: linear-gradient(90deg, #4f46e5 0%, #ec4899 50%, #f59e0b 100%);
            }
            .title {
                font-size: 26px;
                font-weight: 800;
                color: #0f172a;
                margin-bottom: 8px;
            }
            .subtitle {
                font-size: 15px;
                font-weight: 600;
                color: #4f46e5;
                margin-bottom: 12px;
            }
            .meta {
                color: var(--text-muted);
                font-size: 13px;
                display: flex;
                gap: 16px;
                flex-wrap: wrap;
            }
            .section {
                margin-bottom: 32px;
            }
            .section-title {
                font-size: 1.18rem;
                font-weight: 800;
                color: #0f172a;
                border-bottom: 2px solid var(--card-border);
                padding-bottom: 8px;
                margin-bottom: 16px;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .card {
                background: #ffffff;
                border: 1px solid var(--card-border);
                border-radius: 12px;
                padding: 20px;
                margin-bottom: 14px;
                box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
            }
            .card-label {
                font-size: 12px;
                font-weight: 700;
                color: var(--text-muted);
                text-transform: uppercase;
                letter-spacing: 0.05em;
                margin-bottom: 10px;
            }
            .grid-2 {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 16px;
            }
            @media (max-width: 820px) {
                .grid-2 { grid-template-columns: 1fr; }
            }

            /* TL;DR 看板样式 */
            .xp-tldr-card {
                background: #ffffff;
                border: 1px solid var(--card-border);
                border-radius: 14px;
                padding: 20px 24px;
                margin-bottom: 24px;
                box-shadow: 0 4px 12px -2px rgba(15, 23, 42, 0.05);
                position: relative;
                overflow: hidden;
            }
            .xp-tldr-card::before {
                content: '';
                position: absolute;
                top: 0; left: 0; right: 0;
                height: 4px;
                background: linear-gradient(90deg, #4f46e5 0%, #f59e0b 50%, #10b981 100%);
            }
            .xp-tldr-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                flex-wrap: wrap;
                gap: 12px;
                margin-bottom: 16px;
                padding-bottom: 12px;
                border-bottom: 1px solid #f1f5f9;
            }
            .xp-tldr-header-left {
                display: flex;
                flex-direction: column;
                gap: 4px;
            }
            .xp-tldr-tag {
                font-size: 1rem;
                font-weight: 800;
                color: #1e293b;
            }
            .xp-tldr-sub {
                font-size: 0.78rem;
                color: var(--text-muted);
            }
            .xp-tldr-decision-pill {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 6px 14px;
                border-radius: 9999px;
                font-size: 0.85rem;
                box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
            }
            .xp-tldr-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
            }
            .xp-tldr-scores {
                font-size: 0.75rem;
                opacity: 0.85;
                margin-left: 4px;
            }
            .xp-tldr-badge-success { background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; }
            .xp-tldr-badge-success .xp-tldr-dot { background: #10b981; }
            .xp-tldr-badge-warning { background: #fffbeb; color: #92400e; border: 1px solid #fde68a; }
            .xp-tldr-badge-warning .xp-tldr-dot { background: #f59e0b; }
            .xp-tldr-badge-danger { background: #fff1f2; color: #9f1239; border: 1px solid #fecdd3; }
            .xp-tldr-badge-danger .xp-tldr-dot { background: #f43f5e; }

            .xp-tldr-grid {
                display: grid;
                grid-template-columns: repeat(3, minmax(0, 1fr));
                gap: 14px;
            }
            @media (max-width: 850px) {
                .xp-tldr-grid { grid-template-columns: 1fr; }
            }
            .xp-tldr-col {
                border-radius: 10px;
                padding: 14px 16px;
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            .xp-tldr-col-conclusion { background: #f8fafc; border: 1px solid #e2e8f0; }
            .xp-tldr-col-pitfall { background: #fff5f5; border: 1px solid #fed7d7; }
            .xp-tldr-col-breakthrough { background: #f0fdf4; border: 1px solid #bbf7d0; }
            .xp-tldr-col-title {
                font-size: 0.82rem;
                font-weight: 800;
                color: #1e293b;
            }
            .xp-tldr-col-desc {
                font-size: 0.85rem;
                line-height: 1.5;
                color: #334155;
            }

            /* 评分卡 */
            .xp-score-card {
                padding: 20px;
            }
            .xp-score-main-flex {
                display: flex;
                align-items: center;
                gap: 24px;
                margin-bottom: 16px;
                flex-wrap: wrap;
            }
            .xp-score-item-box {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 4px;
                min-width: 100px;
            }
            .xp-score-divider {
                width: 1px;
                height: 48px;
                background: #e2e8f0;
            }
            .xp-score-label-small {
                font-size: 0.72rem;
                font-weight: 700;
                color: var(--text-muted);
                text-transform: uppercase;
            }
            .xp-score-value-big {
                font-size: 2.2rem;
                font-weight: 800;
                line-height: 1;
            }
            .xp-opp-text { color: #2563eb; }
            .xp-diff-text { color: #ea580c; }
            .xp-difficulty-indicator {
                font-size: 0.68rem;
                padding: 2px 8px;
                border-radius: 4px;
                font-weight: 700;
            }
            .xp-diff-low { background: #ecfdf5; color: #047857; }
            .xp-diff-mid, .xp-diff-medium { background: #fffbeb; color: #b45309; }
            .xp-diff-high, .xp-diff-very_high { background: #fff1f2; color: #b91c1c; }

            .xp-decision-container {
                background: #f8fafc;
                border: 1px solid #e2e8f0;
                border-radius: 10px;
                padding: 12px 16px;
            }
            .xp-decision-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 6px;
            }
            .xp-decision-badge {
                padding: 3px 10px;
                border-radius: 6px;
                font-size: 0.8rem;
                font-weight: 800;
            }
            .xp-decision-recommend { background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; }
            .xp-decision-caution { background: #fffbeb; color: #92400e; border: 1px solid #fde68a; }
            .xp-decision-reason {
                font-size: 0.85rem;
                color: #334155;
                line-height: 1.5;
            }

            .xp-score-eval-list {
                border-top: 1px solid #f1f5f9;
                padding-top: 12px;
                margin-top: 12px;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .xp-score-eval-item {
                display: flex;
                justify-content: space-between;
                align-items: baseline;
                font-size: 0.84rem;
                gap: 12px;
            }
            .xp-score-eval-dim {
                font-weight: 700;
                color: #475569;
                min-width: 110px;
            }
            .xp-score-eval-detail {
                color: #0f172a;
                text-align: right;
                flex: 1;
            }

            /* 产品透视 Hero */
            .xp-single-hero-card {
                border-left: 4px solid #4f46e5;
            }
            .xp-single-hero-name {
                font-size: 1.4rem;
                font-weight: 800;
                color: #0f172a;
                margin-bottom: 6px;
            }
            .xp-single-hero-price {
                font-size: 1.2rem;
                font-weight: 800;
                color: #4f46e5;
                margin-bottom: 12px;
            }
            .xp-single-hero-points {
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            .xp-single-hero-point {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 0.9rem;
                color: #334155;
            }
            .xp-single-hero-point::before {
                content: '✓';
                color: #10b981;
                font-weight: 800;
            }

            /* 标签与画像 */
            .xp-single-tags-block {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
            }
            .xp-single-tag {
                background: #f1f5f9;
                border: 1px solid #cbd5e1;
                color: #334155;
                padding: 4px 10px;
                border-radius: 9999px;
                font-size: 0.8rem;
                font-weight: 600;
            }
            .xp-single-tag.xp-scenario {
                background: #e0f2fe;
                border-color: #bae6fd;
                color: #0369a1;
            }
            .xp-persona-info-list {
                display: flex;
                flex-direction: column;
                gap: 8px;
                font-size: 0.88rem;
            }
            .xp-persona-info-item strong {
                color: #64748b;
                display: inline-block;
                min-width: 120px;
            }

            /* 痛点卡片 */
            .xp-single-pain-grid {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .xp-single-pain-card {
                background: #fff5f5;
                border: 1px solid #fed7d7;
                border-left: 4px solid #ef4444;
                border-radius: 8px;
                padding: 12px 16px;
                font-size: 0.88rem;
                color: #991b1b;
                line-height: 1.5;
            }

            /* 广告分镜头脚本卡片 */
            .xp-ad-script-list {
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            .xp-ad-script-card {
                background: #ffffff;
                border: 1px solid #e2e8f0;
                border-radius: 10px;
                padding: 14px 16px;
            }
            .xp-ad-script-header {
                margin-bottom: 8px;
            }
            .xp-ad-script-badge {
                display: inline-block;
                background: #eef2ff;
                color: #3730a3;
                border: 1px solid #c7d2fe;
                font-size: 0.76rem;
                font-weight: 800;
                padding: 3px 8px;
                border-radius: 6px;
            }
            .xp-ad-section-box {
                border-radius: 6px;
                padding: 8px 12px;
                margin-bottom: 6px;
                font-size: 0.82rem;
                line-height: 1.5;
            }
            .xp-ad-section-box:last-child { margin-bottom: 0; }
            .xp-ad-hook-box { background: #fffbeb; border-left: 3px solid #f59e0b; color: #92400e; }
            .xp-ad-script-box { background: #f8fafc; border-left: 3px solid #6366f1; color: #1e293b; }
            .xp-ad-cta-box { background: #f0fdf4; border-left: 3px solid #10b981; color: #065f46; }
            .xp-ad-sublabel { font-weight: 800; margin-bottom: 4px; }

            /* 优势/风险 */
            .xp-single-strength-card { border-left: 4px solid #10b981; }
            .xp-single-weakness-card { border-left: 4px solid #ef4444; }
            .xp-strength-item {
                background: #f0fdf4;
                border-left: 3px solid #10b981;
                border-radius: 6px;
                padding: 10px 12px;
                margin-bottom: 8px;
            }
            .xp-strength-point { font-weight: 700; color: #065f46; font-size: 0.9rem; margin-bottom: 2px; }
            .xp-strength-detail { font-size: 0.84rem; color: #334155; }
            .xp-weakness-item {
                background: #fff5f5;
                border-left: 3px solid #ef4444;
                border-radius: 6px;
                padding: 10px 12px;
                margin-bottom: 8px;
            }
            .xp-weakness-risk { font-weight: 700; color: #991b1b; font-size: 0.9rem; margin-bottom: 2px; }
            .xp-weakness-detail { font-size: 0.84rem; color: #334155; }

            /* 差异化卡片 */
            .xp-eval-card {
                background: #fdf4ff;
                border: 1px solid #f0abfc;
                border-left: 4px solid #a855f7;
                border-radius: 8px;
                padding: 12px 16px;
                margin-bottom: 8px;
            }
            .xp-eval-card-dim { font-size: 0.75rem; font-weight: 700; color: #7e22ce; text-transform: uppercase; margin-bottom: 2px; }
            .xp-eval-card-detail { font-size: 0.88rem; color: #3b0764; }

            /* 操盘步骤 */
            .xp-single-rec-card {
                background: #f5f3ff;
                border: 1px solid #ddd6fe;
                border-left: 4px solid #7c3aed;
            }
            .xp-rec-steps {
                display: flex;
                flex-direction: column;
                gap: 10px;
            }
            .xp-rec-step {
                display: flex;
                align-items: flex-start;
                gap: 12px;
                font-size: 0.9rem;
                color: #334155;
            }
            .xp-rec-step-num {
                flex-shrink: 0;
                width: 22px;
                height: 22px;
                background: #7c3aed;
                color: #ffffff;
                font-weight: 800;
                font-size: 0.7rem;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                margin-top: 2px;
            }

            /* VOC */
            .xp-sentiment-container {
                display: flex;
                align-items: center;
                gap: 12px;
                background: #f8fafc;
                padding: 10px 14px;
                border-radius: 8px;
            }
            .xp-sentiment-label { font-size: 0.82rem; font-weight: 700; color: #64748b; }
            .xp-sentiment-bar-bg {
                flex: 1;
                height: 8px;
                background: #e2e8f0;
                border-radius: 99px;
                overflow: hidden;
            }
            .xp-sentiment-bar-fill {
                height: 100%;
                background: linear-gradient(90deg, #4f46e5, #10b981);
                border-radius: 99px;
            }
            .xp-sentiment-value { font-size: 1rem; font-weight: 800; color: #0f172a; }
            .xp-voc-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 12px;
            }
            .xp-voc-card {
                padding: 12px 14px;
                border-radius: 8px;
                border: 1px solid var(--card-border);
            }
            .xp-voc-pros { background: #f0fdf4; border-color: #bbf7d0; }
            .xp-voc-cons { background: #fff5f5; border-color: #fecdd3; }
            .xp-voc-card-title { font-size: 0.76rem; font-weight: 800; text-transform: uppercase; margin-bottom: 6px; }
            .xp-voc-pros .xp-voc-card-title { color: #047857; }
            .xp-voc-cons .xp-voc-card-title { color: #b91c1c; }
            .xp-voc-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; font-size: 0.82rem; }
            .xp-voc-item { line-height: 1.5; color: #334155; }

            /* 矩阵表格 */
            .xp-table-container {
                width: 100%;
                overflow-x: auto;
                border: 1px solid var(--card-border);
                border-radius: 12px;
            }
            .xp-compare-table {
                width: 100%;
                border-collapse: collapse;
                min-width: 680px;
                font-size: 0.88rem;
            }
            .xp-compare-table th, .xp-compare-table td {
                padding: 12px 14px;
                border-bottom: 1px solid #e2e8f0;
                border-right: 1px solid #e2e8f0;
                vertical-align: top;
                text-align: left;
            }
            .xp-compare-table th {
                background: #f8fafc;
                color: #0f172a;
                font-weight: 700;
            }
            .xp-winner-badge {
                display: inline-block;
                background: #fef08a;
                color: #854d0e;
                font-size: 0.72rem;
                font-weight: 800;
                padding: 2px 6px;
                border-radius: 4px;
                margin-left: 4px;
            }
            .xp-winner-col-th {
                background: #ede9fe !important;
                border-top: 3px solid #7c3aed !important;
                color: #4338ca !important;
            }
            .xp-winner-col-td {
                background: #faf5ff !important;
            }
            .xp-winner-score-card {
                border: 2px solid #a78bfa !important;
                background: #faf5ff !important;
            }
            .xp-rec-card {
                background: #ffffff;
                border: 1px solid #e2e8f0;
                border-radius: 8px;
                padding: 10px 14px;
                margin-bottom: 8px;
            }
            .xp-rec-card-action {
                font-size: 0.74rem;
                font-weight: 800;
                display: inline-block;
                padding: 2px 6px;
                border-radius: 4px;
                margin-bottom: 4px;
            }
            .xp-rec-card-action.xp-opportunity { background: #dbeafe; color: #1e40af; }
            .xp-rec-card-action.xp-risk { background: #fee2e2; color: #991b1b; }
            .xp-rec-card-content { font-size: 0.85rem; color: #334155; display: block; }
            .xp-td-list { list-style: none; padding-left: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
            .xp-td-list li { position: relative; padding-left: 14px; font-size: 0.84rem; }
            .xp-td-list li::before { content: '•'; position: absolute; left: 0; color: #4f46e5; }

            /* 置信度徽章 */
            .xp-conf-badge, .xp-badge {
                display: inline-flex;
                align-items: center;
                padding: 2px 8px;
                border-radius: 9999px;
                font-size: 10px;
                font-weight: 700;
                margin-left: 6px;
                vertical-align: middle;
            }
            .xp-conf-high, .xp-badge-success { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
            .xp-conf-medium, .xp-badge-warning { background: #fffbeb; color: #b45309; border: 1px solid #fde68a; }
            .xp-conf-low, .xp-badge-danger { background: #fff1f2; color: #b91c1c; border: 1px solid #fecdd3; }

            /* Brand Positioning & Trust Triggers */
            .xp-brand-pos-card {
                background: #ffffff;
                border: 1px solid var(--card-border);
                border-radius: 12px;
                padding: 16px 20px;
                margin-bottom: 14px;
            }
            .xp-brand-pos-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                flex-wrap: wrap;
                gap: 10px;
                margin-bottom: 10px;
            }
            .xp-brand-tagline {
                font-size: 1.05rem;
                font-weight: 800;
                color: #0f172a;
                line-height: 1.4;
            }
            .xp-brand-angle-badge {
                display: inline-flex;
                align-items: center;
                gap: 5px;
                background: #eef2ff;
                color: #4338ca;
                border: 1px solid #c7d2fe;
                font-size: 0.78rem;
                font-weight: 800;
                padding: 4px 12px;
                border-radius: 9999px;
            }
            .xp-brand-trust-container {
                display: flex;
                align-items: center;
                flex-wrap: wrap;
                gap: 8px;
                margin-top: 10px;
                padding-top: 10px;
                border-top: 1px dashed #f1f5f9;
            }
            .xp-brand-trust-label {
                font-size: 0.72rem;
                font-weight: 700;
                color: var(--text-muted);
                text-transform: uppercase;
                letter-spacing: 0.05em;
                margin-right: 4px;
            }
            .xp-trust-chip {
                display: inline-flex;
                align-items: center;
                gap: 5px;
                background: #f8fafc;
                border: 1px solid var(--card-border);
                border-radius: 6px;
                padding: 3px 9px;
                font-size: 0.76rem;
                font-weight: 600;
                color: #334155;
            }

            /* Competitive Battle Card */
            .xp-battle-card-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 12px;
                margin-bottom: 14px;
            }
            @media (max-width: 768px) {
                .xp-battle-card-grid { grid-template-columns: 1fr; }
            }
            .xp-battle-col {
                background: #ffffff;
                border: 1px solid var(--card-border);
                border-radius: 10px;
                padding: 14px 16px;
                position: relative;
                overflow: hidden;
            }
            .xp-battle-col-strong { background: #f8fafc; border-color: #cbd5e1; border-left: 4px solid #64748b; }
            .xp-battle-col-attack { background: #fff7ed; border-color: #fed7aa; border-left: 4px solid #f97316; }
            .xp-battle-col-whitespace { background: #f0fdf4; border-color: #bbf7d0; border-left: 4px solid #10b981; }
            .xp-battle-col-threat { background: #fff1f2; border-color: #fecdd3; border-left: 4px solid #f43f5e; }
            .xp-battle-col-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 8px;
            }
            .xp-battle-col-title { font-size: 0.82rem; font-weight: 800; display: flex; align-items: center; gap: 6px; }
            .xp-battle-col-strong .xp-battle-col-title { color: #334155; }
            .xp-battle-col-attack .xp-battle-col-title { color: #c2410c; }
            .xp-battle-col-whitespace .xp-battle-col-title { color: #047857; }
            .xp-battle-col-threat .xp-battle-col-title { color: #be123c; }
            .xp-battle-subtag { font-size: 0.68rem; font-weight: 700; padding: 2px 6px; border-radius: 4px; }
            .xp-battle-col-strong .xp-battle-subtag { background: #e2e8f0; color: #475569; }
            .xp-battle-col-attack .xp-battle-subtag { background: #ffedd5; color: #9a3412; }
            .xp-battle-col-whitespace .xp-battle-subtag { background: #dcfce7; color: #166534; }
            .xp-battle-col-threat .xp-battle-subtag { background: #ffe4e6; color: #9f1239; }
            .xp-battle-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; font-size: 0.8rem; line-height: 1.5; color: #334155; }
            .xp-battle-list li { position: relative; padding-left: 14px; }
            .xp-battle-list li::before { content: '•'; position: absolute; left: 2px; font-weight: 800; }
            .xp-battle-col-strong .xp-battle-list li::before { color: #64748b; }
            .xp-battle-col-attack .xp-battle-list li::before { color: #f97316; }
            .xp-battle-col-whitespace .xp-battle-list li::before { color: #10b981; }
            .xp-battle-col-threat .xp-battle-list li::before { color: #f43f5e; }

            /* Customer Objection Handling */
            .xp-objections-grid { display: flex; flex-direction: column; gap: 12px; margin-bottom: 14px; }
            .xp-objection-card {
                background: #ffffff;
                border: 1px solid var(--card-border);
                border-radius: 10px;
                padding: 14px 16px;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .xp-objection-q { font-size: 0.92rem; font-weight: 800; color: #0f172a; display: flex; align-items: flex-start; gap: 8px; }
            .xp-objection-tag-q { background: #fee2e2; color: #b91c1c; font-size: 0.72rem; font-weight: 800; padding: 2px 7px; border-radius: 4px; flex-shrink: 0; }
            .xp-objection-a {
                background: #f8fafc;
                border: 1px solid #e2e8f0;
                border-left: 3px solid #3b82f6;
                border-radius: 6px;
                padding: 8px 12px;
                font-size: 0.84rem;
                line-height: 1.5;
                color: #1e293b;
            }
            .xp-objection-tag-a { color: #2563eb; font-weight: 800; font-size: 0.75rem; margin-bottom: 4px; }
            .xp-objection-proof {
                background: #f0fdf4;
                border: 1px dashed #86efac;
                border-radius: 6px;
                padding: 6px 10px;
                font-size: 0.78rem;
                color: #166534;
            }

            .footer {
                text-align: center;
                padding: 28px 0 10px;
                color: var(--text-muted);
                font-size: 12px;
                border-top: 1px solid var(--card-border);
                margin-top: 36px;
            }

            @media print {
                body { background: #ffffff !important; padding: 0 !important; }
                .container { box-shadow: none !important; border: none !important; padding: 0 !important; max-width: 100% !important; }
                .section, .card, .xp-tldr-card { break-inside: avoid; }
            }
        `;

        return `<!DOCTYPE html>
<html lang="${isZh ? 'zh-CN' : 'en'}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${reportTitle} - ${reportSub || dateStr}</title>
    <style>${css}</style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="title">${reportTitle}</div>
            ${reportSub ? `<div class="subtitle">📦 ${reportSub}</div>` : ''}
            <div class="meta">
                <span>📅 ${isZh ? '生成时间' : 'Generated'}: ${dateStr}</span>
                <span>⚙️ ${isZh ? '模式' : 'Mode'}: ${template_type === 'single' ? (isZh ? '单品深度透视' : 'Single Product Deep Dive') : (isZh ? '多竞品横向矩阵' : 'Multi-Product Matrix')}</span>
                <span>🔒 ${isZh ? '机密等级' : 'Classification'}: ${isZh ? '内部商业战略报告' : 'Internal Strategic Intelligence'}</span>
            </div>
        </div>
        ${content}
        <div class="footer">
            ${isZh ? '本报告由 AI 跨境电商竞品解构引擎自动生成 · 包含完整定量算法打分与定性深度洞察' : 'Generated by AI E-Commerce Competitor Intelligence Engine · Deterministic Scoring & Qualitative Insights'}
        </div>
    </div>
</body>
</html>`;
    }

    if (typeof window !== 'undefined') {
        window.xp_normalizeBattleCard = xp_normalizeBattleCard;
        window.xp_generateWhitePaperReport = xp_generateWhitePaperReport;
        window.xp_renderBrandPositioning = xp_renderBrandPositioning;
        window.xp_renderBattleCard = xp_renderBattleCard;
        window.xp_renderObjections = xp_renderObjections;
        window.xp_generatePositioningMapSvg = xp_generatePositioningMapSvg;
        window.xp_renderPositioningMap = xp_renderPositioningMap;
        window.xp_renderMatrixStrategySection = xp_renderMatrixStrategySection;
        window.xp_renderMatrixCompetitorDrilldown = xp_renderMatrixCompetitorDrilldown;
        window.xp_renderMatrixTemplate = xp_renderMatrixTemplate;
        window.xp_renderTable = xp_renderTable;
        window.xp_saveBattleCardToBrandProfile = function() {
            xp_transferToBrandProfile();
        };
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            xp_normalizeBattleCard,
            xp_extractAdAngleText,
            xp_parseAdAngle,
            xp_detectRegion,
            xp_renderSingleTldr,
            xp_transferToDetails,
            xp_transferToListing,
            xp_transferToAds,
            xp_extractProfileFromAnalysis,
            xp_inferCategoryFromText,
            xp_transferToBrandProfile,
            xp_transferMatrixToDetails,
            xp_transferMatrixToListing,
            xp_transferMatrixToAds,
            xp_copyTldrSummary,
            xp_copyAdAngleScript,
            xp_copyObjection,
            xp_copyAllObjections,
            xp_generateWhitePaperReport,
            xp_renderBrandPositioning,
            xp_renderBattleCard,
            xp_renderObjections,
            xp_generatePositioningMapSvg,
            xp_renderPositioningMap,
            xp_renderMatrixStrategySection,
            xp_renderMatrixCompetitorDrilldown,
            xp_renderMatrixTemplate,
            xp_renderTable,
            xp_saveBattleCardToBrandProfile,
            xp_openCrawlerSettings,
            xp_resetAnalysisSession,
            xp_showError
        };
    }

})();
