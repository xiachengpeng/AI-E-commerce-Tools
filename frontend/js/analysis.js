/**
 * 竞品分析模块 - 嵌入模式
 * 所有变量和函数使用 XP_ 前缀命名空间，避免与主程序冲突
 */
(function () {
    'use strict';

    // ─── 常量 ────────────────────────────────────────────────────────────────
    const XP_API_URL = 'http://localhost:8000/compare';
    const XP_STORAGE_KEY = 'xuanpin_last_result_v27';
    const XP_STORAGE_URLS_KEY = 'xuanpin_last_urls_v27';
    const XP_MAX_URLS = 5;

    // ─── 状态 ────────────────────────────────────────────────────────────────
    let xp_urlsArray = [];
    let xp_currentLang = 'zh';
    let xp_currentResponse = null;
    let xp_winnerIndex = -1;

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

        if (!analyzeBtn) return; // 防止重复初始化

        // 标题点击重置
        appTitle.addEventListener('click', () => {
            xp_urlsArray = [];
            if (urlInputField) urlInputField.value = '';
            const tags = tagsList.querySelectorAll('.xp-url-tag');
            tags.forEach(tag => tag.remove());
            xp_updateCounter(urlCounter, urlInputField);
            if (resultSection) resultSection.classList.add('xp-hidden');
            localStorage.removeItem(XP_STORAGE_KEY);
            localStorage.removeItem(XP_STORAGE_URLS_KEY);
            const mTemp = xp_getEl('xp-matrix-template');
            const sTemp = xp_getEl('xp-single-template');
            if (mTemp) mTemp.classList.add('xp-hidden');
            if (sTemp) sTemp.classList.add('xp-hidden');
            xp_currentResponse = null;
        });

        // 复制所有链接
        copyAllBtn.addEventListener('click', () => {
            if (xp_urlsArray.length === 0) return;
            navigator.clipboard.writeText(xp_urlsArray.join('\n')).then(() => {
                copyAllBtn.classList.add('xp-success');
                copyAllBtn.querySelector('.xp-copy-icon').textContent = '✅';
                copyAllBtn.querySelector('.xp-copy-text').textContent = '已复制';
                setTimeout(() => {
                    copyAllBtn.classList.remove('xp-success');
                    copyAllBtn.querySelector('.xp-copy-icon').textContent = '📋';
                    copyAllBtn.querySelector('.xp-copy-text').textContent = '复制全部';
                }, 2000);
            });
        });

        // 语言切换
        langToggle.addEventListener('click', () => {
            xp_currentLang = xp_currentLang === 'zh' ? 'en' : 'zh';
            langToggle.innerHTML = xp_currentLang === 'zh' ? '🌐 English' : '🌐 中文';
            xp_updateStaticI18n();
            if (xp_currentResponse) xp_renderResults(xp_currentResponse);
        });

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

    function xp_addUrlTag(url, tagsList, urlInputField, urlCounter) {
        url = url.trim();
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
        if (typeof text !== 'string') return '';
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

    function xp_showError(errorMsg, message) {
        errorMsg.textContent = typeof message === 'string' ? xp_getI18nText(message) : message;
        errorMsg.classList.remove('xp-hidden');
    }

    function xp_hideError(errorMsg) {
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
        const pendingUrl = urlInputField.value.trim();
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
        resultSection.classList.add('xp-hidden');
        xp_currentResponse = null;
        xp_winnerIndex = -1;
        localStorage.removeItem(XP_STORAGE_KEY);
        localStorage.removeItem(XP_STORAGE_URLS_KEY);
        loadingSection.classList.remove('xp-hidden');
        analyzeBtn.disabled = true;
        analyzeBtn.innerHTML = '正在解构中... <div class="xp-spinner" style="width:15px;height:15px;border-width:2px;display:inline-block;"></div>';

        try {
            const response = await fetch(XP_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ urls: rawUrls })
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
            xp_showError(errorMsg, '无法连接到服务器，请确保后端服务在 http://localhost:8000 运行。');
        } finally {
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

    // ─── 单品深度模板 ─────────────────────────────────────────────────────────
    function xp_renderSingleTemplate(d, scoreObj = null) {
        if (!d) return;

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
                const isWinner = decision.includes('优先') || decision.toLowerCase().includes('recommend');
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

        // 广告切入角度
        const adItems = (d.ad_angles || []).map(a => `<li>${xp_processText(String(a))}</li>`).join('');
        singleAdAngles.innerHTML = `<h3>${xp_currentLang === 'zh' ? '广告素材切入点' : 'Ad Creative Angles'}</h3><ol class="xp-single-ad-list">${adItems}</ol>`;

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
    function xp_renderMatrixTemplate(data) {
        const { products, comparison, comprehensive_evaluation, recommendation_list, scores } = data;
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

        // 确定赢家
        xp_winnerIndex = -1;
        if (comparison && comparison.winner_product) {
            const winnerName = xp_getI18nText(comparison.winner_product).toLowerCase();
            (products || []).forEach((p, i) => {
                const name = xp_getI18nText(p.product_name || '').toLowerCase();
                if (name && winnerName.includes(name.substring(0, 10))) xp_winnerIndex = i;
            });
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
                const decisionClass = decision.toLowerCase().includes('recommend') || decision.includes('建议') ? 'xp-decision-recommend' : 'xp-decision-caution';
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

        // 对比表格
        xp_renderTable(products || [], tableHeader, tableBody);

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
            { key: 'core_selling_points', labelZh: '✨ 核心卖点', labelEn: '✨ Selling Points', isList: true, tdClass: '' },
            { key: 'target_audience', labelZh: '🎯 消费者画像', labelEn: '🎯 Consumer Persona', isList: true, tdClass: '' },
            { key: 'use_scenarios', labelZh: '📍 使用场景', labelEn: '📍 Use Scenarios', isList: true, tdClass: '' },
            { key: 'strengths', labelZh: '💪 产品优势', labelEn: '💪 Strengths', isList: false, tdClass: 'xp-td-strength' },
            { key: 'weaknesses', labelZh: '📉 产品劣势', labelEn: '📉 Weaknesses', isList: false, tdClass: 'xp-td-weakness' },
            { key: 'voc_analysis', labelZh: '📣 用户口碑', labelEn: '📣 Feedback', isList: false, tdClass: 'xp-td-voc' },
        ];

        let bodyHtml = '';
        rows.forEach(r => {
            bodyHtml += `<tr><td><strong>${xp_currentLang === 'zh' ? r.labelZh : r.labelEn}</strong></td>`;
            products.forEach((p, idx) => {
                const isWinner = idx === xp_winnerIndex;
                const tdClass = [isWinner ? 'xp-winner-col-td' : '', r.tdClass].filter(Boolean).join(' ');
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
        const { template_type, data } = response;
        const dateStr = new Date().toLocaleString();
        const zh = (str) => {
            if (!str || typeof str !== 'string') return str || '';
            return str.split('|||')[0].trim();
        };

        let content = '';

        if (template_type === 'single') {
            const d = data.single_data || {};
            const scoreObj = (data.scores && data.scores.length > 0) ? data.scores[0] : null;

            // 1. 评分
            if (scoreObj) {
                content += `<div class="section">
                    <div class="section-header"><div class="section-title">📊 智能投资打分</div></div>
                    <div class="score-box" style="display:flex;justify-content:space-around;align-items:center;padding:30px;">
                        <div style="text-align:center;"><div style="font-size:12px;color:#64748b;text-transform:uppercase;margin-bottom:5px;">机会评分</div><div style="font-size:36px;font-weight:800;color:#3b82f6;">${scoreObj.opportunity_score}</div></div>
                        <div style="height:60px;width:1px;background:#e2e8f0;"></div>
                        <div style="text-align:center;"><div style="font-size:12px;color:#64748b;text-transform:uppercase;margin-bottom:5px;">进入难度</div><div style="font-size:36px;font-weight:800;color:#f97316;">${scoreObj.difficulty_score}</div></div>
                        <div style="height:60px;width:1px;background:#e2e8f0;"></div>
                        <div style="text-align:left;max-width:400px;">
                            <div style="font-size:12px;font-weight:700;color:#64748b;margin-bottom:8px;">投资结论：<strong style="color:#7c3aed;">${zh(scoreObj.final_decision || 'N/A')}</strong></div>
                            <div style="font-size:13px;color:#334155;line-height:1.5;">${zh(scoreObj.decision_details?.reason || '')}</div>
                        </div>
                    </div>
                </div>`;
            }

            // 2. 产品信息
            const spHtml = (d.core_selling_points || []).map(sp => `<li>${typeof sp === 'object' ? zh(sp.point) : zh(sp)}</li>`).join('');
            content += `<div class="section"><div class="section-header"><div class="section-title">🔬 产品深度透视</div></div>
                <div class="card"><div class="card-label">产品名称</div><div style="font-size:18px;font-weight:700;">${zh(d.product_name) || 'N/A'}</div></div>
                <div class="card"><div class="card-label">市场定价</div><div style="font-size:16px;color:#7c3aed;font-weight:700;">${zh(d.price) || 'N/A'}</div></div>
                <div class="card"><div class="card-label">评价数</div><div>${zh(d.reviews_count || '0')}</div></div>
                <div class="card"><div class="card-label">核心卖点</div><ul style="margin:0;padding-left:20px;">${spHtml}</ul></div></div>`;

            // 3. 消费者画像与场景
            const countries = (d.target_countries || []).map(c => zh(c)).join(', ');
            const audiences = (d.target_audience || []).map(t => zh(typeof t === 'object' ? (t.audience || t.item || '') : String(t))).join('、');
            const scenarios = (d.use_scenarios || []).map(s => `<span style="display:inline-block;background:#f0f9ff;color:#0369a1;padding:4px 12px;border-radius:15px;font-size:12px;margin:0 5px 5px 0;border:1px solid #bae6fd;">${zh(typeof s === 'object' ? (s.scenario || s.item || '') : String(s))}</span>`).join('');

            content += `<div class="section"><div class="section-header"><div class="section-title">🎯 消费者画像与场景</div></div>
                <div class="card"><div class="card-label">人群画像</div>
                    <p><strong>年龄段：</strong>${zh(d.age_range || '-')}</p>
                    <p><strong>目标国家：</strong>${countries || '-'}</p>
                    <p><strong>用户群体：</strong>${audiences || '-'}</p>
                </div>
                <div class="card"><div class="card-label">使用场景</div><div>${scenarios || '-'}</div></div></div>`;

            // 4. 用户痛点
            const painHtml = (d.user_pain_points || []).map(pp => `<div style="background:#fff1f2;border-left:4px solid #f43f5e;padding:12px;margin-bottom:8px;font-size:13px;color:#9f1239;">${zh(typeof pp === 'object' ? pp.pain : String(pp))}</div>`).join('');
            content += `<div class="section"><div class="section-header"><div class="section-title">😤 用户痛点分析</div></div>${painHtml || '<div class="card">-</div>'}</div>`;

            // 5. 营销策略
            const trafficHtml = (d.traffic_strategy || []).map(t => `<div style="margin-bottom:10px;"><strong>${zh(t.channel)}:</strong> <span style="font-size:13px;color:#475569;">${zh(t.detail)}</span></div>`).join('');
            const adHtml = (d.ad_angles || []).map(a => `<li>${zh(String(a))}</li>`).join('');
            content += `<div class="section"><div class="section-header"><div class="section-title">🚀 逆向营销策略</div></div>
                <div class="card"><div class="card-label">流量渠道</div>${trafficHtml || '-'}</div>
                <div class="card"><div class="card-label">广告切入点</div><ul style="margin:0;padding-left:20px;">${adHtml || '-'}</ul></div></div>`;

            // 6. 优势与风险
            const strHtml = (d.strengths || []).map(s => `<div style="margin-bottom:10px;"><strong style="color:#059669;">${zh(s.point)}:</strong> <span style="font-size:13px;color:#475569;">${zh(s.detail)}</span></div>`).join('');
            const weakHtml = (d.weaknesses || []).map(w => `<div style="margin-bottom:10px;"><strong style="color:#dc2626;">${zh(w.risk)}:</strong> <span style="font-size:13px;color:#475569;">${zh(w.detail)}</span></div>`).join('');
            content += `<div class="section"><div class="section-header"><div class="section-title">⚡ 优势与风险</div></div>
                <div class="card" style="border-left:4px solid #10b981;"><div class="card-label" style="color:#10b981;">核心优势</div>${strHtml || '-'}</div>
                <div class="card" style="border-left:4px solid #ef4444;"><div class="card-label" style="color:#ef4444;">核心风险</div>${weakHtml || '-'}</div></div>`;

            // 7. 差异化机会与建议
            const oppHtml = (d.differentiation_opportunities || []).map(opp => `<div class="card" style="border-left:4px solid #8b5cf6;"><div class="card-label">差异化机会</div><p style="margin:0;font-size:13px;">${zh(typeof opp === 'object' ? opp.opportunity : String(opp))}</p></div>`).join('');
            content += `<div class="section"><div class="section-header"><div class="section-title">💡 差异化机会</div></div>${oppHtml || '-'}</div>`;

            const recRaw = zh(d.entry_recommendation || '');
            content += `<div class="section"><div class="section-header"><div class="section-title">🎯 操盘建议</div></div>
                <div class="card" style="background:#f5f3ff;border:1px solid #ddd6fe;"><p style="white-space:pre-wrap;margin:0;font-size:14px;color:#4c1d95;">${recRaw}</p></div></div>`;

            // 8. VOC
            if (d.voc_analysis) {
                const v = d.voc_analysis;
                const pList = (v.pros || []).map(p => `<li style="color:#059669;margin-bottom:5px;">👍 ${zh(p)}</li>`).join('');
                const cList = (v.cons || []).map(c => `<li style="color:#dc2626;margin-bottom:5px;">👎 ${zh(c)}</li>`).join('');
                content += `<div class="section"><div class="section-header"><div class="section-title">📣 用户评价深度洞察 (VOC)</div></div>
                    <div class="card"><div style="font-size:12px;color:#64748b;margin-bottom:15px;padding-bottom:10px;border-bottom:1px solid #f1f5f9;">好评率/满意度：<strong style="color:#7c3aed;font-size:16px;">${zh(v.sentiment || '80%')}</strong></div>
                    <div style="display:flex;">
                        <div style="flex:1;padding-right:15px;border-right:1px solid #f1f5f9;"><div style="font-size:11px;font-weight:bold;color:#059669;margin-bottom:10px;">✨ 核心好评点</div><ul style="margin:0;padding:0;list-style:none;font-size:13px;">${pList}</ul></div>
                        <div style="flex:1;padding-left:15px;"><div style="font-size:11px;font-weight:bold;color:#dc2626;margin-bottom:10px;">⚠️ 核心痛点/差评</div><ul style="margin:0;padding:0;list-style:none;font-size:13px;">${cList}</ul></div>
                    </div></div></div>`;
            }
        } else {
            const { products = [], comparison, comprehensive_evaluation = [], recommendation_list = [], scores = [] } = data;

            // 1. 评分
            const scoreHtml = scores.map(s => `
                <td style="border:none;padding:10px;width:${100 / Math.max(1, scores.length)}%;">
                    <div class="score-box" style="text-align:left;padding:20px;height:100%;">
                        <div style="font-size:12px;color:#64748b;margin-bottom:10px;font-weight:700;">${zh(s.product) || ''}</div>
                        <div style="display:flex;justify-content:space-between;margin-bottom:15px;">
                            <div><div style="font-size:10px;color:#94a3b8;">机会评分</div><div style="font-size:24px;font-weight:800;color:#3b82f6;">${s.opportunity_score}</div></div>
                            <div style="text-align:right;"><div style="font-size:10px;color:#94a3b8;">进入难度</div><div style="font-size:24px;font-weight:800;color:#f97316;">${s.difficulty_score}</div></div>
                        </div>
                        <div style="background:rgba(0,0,0,0.03);padding:12px;border-radius:8px;">
                            <div style="font-size:12px;color:#334155;">${zh(s.decision_details?.reason || '')}</div>
                        </div>
                    </div>
                </td>`).join('');
            content += `<div class="section"><div class="section-header"><div class="section-title">📊 智能投资打分</div></div><table style="border:none;width:100%;table-layout:fixed;"><tr>${scoreHtml}</tr></table></div>`;

            // 2. 竞争分析
            if (comparison) {
                content += `<div class="section"><div class="section-header"><div class="section-title">⚖️ 市场竞争分析</div></div>
                    <div class="card"><p><strong>赢家产品：</strong><span style="color:#7c3aed;font-weight:bold;">${zh(comparison.winner_product)}</span></p>
                    <p><strong>竞争程度：</strong>${zh(comparison.competition_level)}</p>
                    <p><strong>市场定位：</strong>${zh(comparison.market_position)}</p></div></div>`;
            }

            // 3. 对比矩阵
            const ths = products.map(p => `<th style="width:${90 / products.length}%;">${zh(p.product_name) || 'N/A'}</th>`).join('');

            const rows = [
                { label: '价格', key: 'price' },
                { label: '评价数', key: 'reviews_count' },
                { label: '核心卖点', key: 'core_selling_points', isList: true },
                { label: '目标受众', key: 'target_audience', isList: true },
                { label: '使用场景', key: 'use_scenarios', isList: true },
                { label: '核心优势', key: 'strengths', isDetailList: true, color: '#059669' },
                { label: '核心风险', key: 'weaknesses', isDetailList: true, color: '#dc2626' }
            ];

            let tableRowsHtml = '';
            rows.forEach(r => {
                let cells = products.map(p => {
                    let val = p[r.key];
                    if (r.isList && Array.isArray(val)) {
                        return `<ul style="margin:0;padding-left:15px;font-size:11px;">${val.map(i => `<li>${zh(typeof i === 'object' ? (i.point || i.audience || i.scenario || String(i)) : String(i))}</li>`).join('')}</ul>`;
                    } else if (r.isDetailList && Array.isArray(val)) {
                        return `<div style="font-size:11px;">${val.map(i => `<div style="margin-bottom:5px;"><strong style="color:${r.color};">${zh(i.point || i.risk)}:</strong> ${zh(i.detail)}</div>`).join('')}</div>`;
                    }
                    return `<span style="font-size:12px;">${zh(val) || '-'}</span>`;
                }).map(cell => `<td>${cell}</td>`).join('');
                tableRowsHtml += `<tr><td class="dim-col" style="width:10%;">${r.label}</td>${cells}</tr>`;
            });

            content += `<div class="section"><div class="section-header"><div class="section-title">📋 竞品横向对比矩阵</div></div>
                <table style="table-layout:fixed;"><thead><tr><th style="width:10%;">维度</th>${ths}</tr></thead><tbody>${tableRowsHtml}</tbody></table></div>`;

            // 4. 评估与建议
            const evHtml = comprehensive_evaluation.map(ev => `<div class="card"><div class="card-label">${zh(ev.dimension)}</div><p style="font-size:14px;margin:0;">${zh(ev.detail)}</p></div>`).join('');
            if (evHtml) content += `<div class="section"><div class="section-header"><div class="section-title">📊 综合评估维度</div></div>${evHtml}</div>`;

            const recHtml = recommendation_list.map(rec => `<div class="card" style="border-left:4px solid #8b5cf6;"><div style="font-size:12px;font-weight:bold;color:#7c3aed;margin-bottom:5px;">${zh(rec.action)}</div><p style="font-size:14px;margin:0;">${zh(rec.content)}</p></div>`).join('');
            if (recHtml) content += `<div class="section"><div class="section-header"><div class="section-title">🎯 操盘建议清单</div></div>${recHtml}</div>`;
        }

        const css = `
            :root {
                --bg: #0b0f19;
                --card-bg: rgba(17, 24, 39, 0.8);
                --card-border: rgba(255, 255, 255, 0.1);
                --text-primary: #f8fafc;
                --text-secondary: #94a3b8;
                --accent: #8b5cf6;
                --accent-gradient: linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%);
            }
            body {
                font-family: 'Inter', -apple-system, sans-serif;
                background-color: var(--bg);
                color: var(--text-primary);
                margin: 0;
                padding: 40px 20px;
                line-height: 1.6;
            }
            .container {
                max-width: 1000px;
                margin: 0 auto;
            }
            .header {
                text-align: center;
                margin-bottom: 40px;
                padding: 40px;
                background: var(--card-bg);
                border: 1px solid var(--card-border);
                border-radius: 24px;
                position: relative;
                overflow: hidden;
            }
            .header::before {
                content: '';
                position: absolute;
                inset: 0;
                background: radial-gradient(circle at 50% 50%, rgba(139, 92, 246, 0.15), transparent 70%);
                z-index: 0;
            }
            .title {
                font-size: 32px;
                font-weight: 800;
                background: linear-gradient(135deg, #fff, #cbd5e1);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                position: relative;
                z-index: 1;
            }
            .meta {
                color: var(--text-secondary);
                font-size: 14px;
                margin-top: 10px;
                position: relative;
                z-index: 1;
            }
            .section {
                margin-bottom: 40px;
            }
            .section-title {
                font-size: 1.25rem;
                font-weight: 700;
                border-bottom: 2px solid rgba(255, 255, 255, 0.07);
                padding-bottom: 8px;
                margin-bottom: 20px;
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .card {
                background: var(--card-bg);
                border: 1px solid var(--card-border);
                border-radius: 16px;
                padding: 20px;
                margin-bottom: 16px;
                backdrop-filter: blur(20px);
            }
            .card-label {
                font-size: 12px;
                font-weight: 700;
                color: var(--text-secondary);
                text-transform: uppercase;
                letter-spacing: 0.05em;
                margin-bottom: 8px;
            }
            .score-box {
                background: var(--card-bg);
                border: 1px solid var(--accent);
                border-radius: 20px;
            }
            .score-value {
                font-size: 42px;
                font-weight: 800;
            }
            .opp-text { color: #3b82f6; }
            .diff-text { color: #f97316; }
            table {
                width: 100%;
                border-collapse: collapse;
                background: var(--card-bg);
                border: 1px solid var(--card-border);
                border-radius: 12px;
                overflow: hidden;
            }
            th, td {
                padding: 16px;
                text-align: left;
                border-bottom: 1px solid rgba(255, 255, 255, 0.05);
                border-right: 1px solid rgba(255, 255, 255, 0.05);
                vertical-align: top;
            }
            th {
                background: rgba(15, 23, 42, 0.8);
                color: #fff;
                font-size: 14px;
            }
            .dim-col {
                background: rgba(255, 255, 255, 0.05);
                font-weight: bold;
                color: var(--accent);
            }
            .badge {
                display: inline-block;
                padding: 4px 12px;
                border-radius: 99px;
                font-size: 12px;
                font-weight: 600;
            }
            .footer {
                text-align: center;
                padding: 40px;
                color: var(--text-secondary);
                font-size: 12px;
                border-top: 1px solid rgba(255, 255, 255, 0.05);
            }
        `;

        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>AI 竞品深度解构报告</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;800&display=swap" rel="stylesheet">
        <style>${css}</style></head>
<body><div class="container">
    <div class="header"><div class="title">AI 竞品深度解构报告</div><div class="meta">分析生成时间：${dateStr}</div></div>
    ${content}
    <div class="footer">本报告由 AI 竞品分析系统深度解构生成 | 内部商业机密</div>
</div></body></html>`;
    }

})();
