/* Research panel owns its state; it never loads the SOP's global scripts. */
(function (root) {
    'use strict';
    const state = { token: '', enabled: false, project: null, product: null, preview: null,
        cursor: null, generation: 0, undo: null, pendingConfirmation: null, applying: false };
    const labels = { confirmed: '人工核实', inferred: '待人工核实', unknown: '未知', stale: '已失效' };
    const fieldLabels = { product_name: '商品名称', category: '类别', material: '材质', dimensions: '尺寸', features: '特征', warranty: '质保条款' };
    const el = id => typeof document !== 'undefined' ? document.getElementById(id) : null;
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const base = () => typeof API_BASE !== 'undefined' ? API_BASE : 'http://127.0.0.1:9503';

    function message(text, error = false) {
        const box = el('researchStatus');
        if (box) { box.textContent = text; box.classList.toggle('r-error', error); }
    }

    async function request(path, body) {
        const response = await fetch(base() + '/api/research/v1' + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Research-Token': state.token },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(15000)
        });
        const data = await response.json();
        if (!response.ok) {
            const detail = data.detail;
            const error = new Error(typeof detail === 'string' ? detail : (detail?.message || '请求未完成，请核对输入或刷新研究状态'));
            error.status = response.status;
            throw error;
        }
        return data;
    }

    function existingFor(module) {
        const ids = module === 'listing' ? ['listingName', 'listingPoints'] : module === 'ads' ? ['adsProductNameInput', 'adsSellingPoints'] : ['productNameInput', 'productFactsText'];
        return { productNameInput: el(ids[0])?.value || '', productFactsText: el(ids[1])?.value || '' };
    }

    function applyDraft(preview, acceptedFields, module = 'details') {
        const mapping = module === 'listing' ? { productNameInput: 'listingName', productFactsText: 'listingPoints' } :
            module === 'ads' ? { productNameInput: 'adsProductNameInput', productFactsText: 'adsSellingPoints' } :
                { productNameInput: 'productNameInput', productFactsText: 'productFactsText' };
        const changes = [];
        const selected = new Set(acceptedFields);
        const grouped = {};
        for (const field of preview.fields || []) {
            if (!selected.has(field.key) || !mapping[field.target]) continue;
            const id = mapping[field.target];
            (grouped[id] ||= []).push(field.value);
        }
        for (const [id, values] of Object.entries(grouped)) {
            const input = el(id);
            if (!input) continue;
            const before = input.value || '';
            // Merchant-entered product names are always retained.
            if (id === mapping.productNameInput && before.trim()) continue;
            const after = [before, ...values].filter(Boolean).join('\n');
            input.value = after;
            changes.push({ id, before, after });
            if (typeof Event === 'function') input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return changes;
    }

    function undoDraft(changes) {
        let restored = 0;
        for (const change of changes || []) {
            const input = el(change.id);
            if (!input || input.value !== change.after) continue;
            input.value = change.before;
            if (typeof Event === 'function') input.dispatchEvent(new Event('input', { bubbles: true }));
            restored++;
        }
        return restored;
    }

    async function loadProjects(append = false) {
        const generation = state.generation;
        try {
            const page = await request('/projects' + (append && state.cursor ? '?cursor=' + encodeURIComponent(state.cursor) : ''));
            if (generation !== state.generation) return;
            const html = page.projects.map(p => `<button class="r-project" data-research-project="${escapeHtml(p.id)}"><strong>${escapeHtml(p.title)}</strong><span>${escapeHtml(p.market)} · 版本 ${p.source_version}</span></button>`).join('');
            const list = el('researchProjectList');
            if (append) list.insertAdjacentHTML('beforeend', html); else list.innerHTML = html || '<p class="r-muted">尚无研究项目。可在独立研究工作台创建项目。</p>';
            state.cursor = page.next_cursor;
            el('researchMoreProjects').hidden = !state.cursor;
            message('研究资料已同步；导入前仍需人工核实自有产品事实。');
        } catch (error) { if (generation === state.generation) message(error.message, true); }
    }

    async function openProject(id) {
        const generation = ++state.generation;
        try {
            const project = await request('/projects/' + id);
            if (generation !== state.generation) return;
            state.project = project; state.product = null; state.preview = null;
            el('researchProjectTitle').textContent = `${project.title} · ${project.market}`;
            el('researchProducts').innerHTML = project.products.map(p => `<button class="r-project" data-research-product="${escapeHtml(p.source_ref.product_id)}"><strong>${escapeHtml(p.name)}</strong><span>${p.merged ? '已合并' : '身份版本 ' + p.source_ref.identity_revision} · ${escapeHtml(p.decision || '未决策')}</span></button>`).join('') || '<p class="r-muted">尚无商品，请在研究工作台中添加或采集。</p>';
            el('researchProductDetail').innerHTML = '';
            el('researchPreview').innerHTML = '';
        } catch (error) { if (generation === state.generation) message(error.message, true); }
    }

    function openProduct(id) {
        const product = state.project?.products.find(p => p.source_ref.product_id === id);
        if (!product) return;
        state.generation++;
        state.product = product; state.preview = null;
        el('researchPreview').innerHTML = '';
        el('researchProductDetail').innerHTML = `
            <h3>${escapeHtml(product.name)}</h3>
            <p class="r-muted">研究商品信息不会自动成为自家产品声明。请按实物或自有商品资料逐项核实。</p>
            <div class="r-facts">${product.facts.map(f => `<div><strong>${escapeHtml(fieldLabels[f.key])}</strong><span>${escapeHtml(f.value || '未记录')}</span><small>${escapeHtml(labels[f.state])}</small></div>`).join('')}</div>
            <div class="r-steps">${product.steps.map(s => `<span title="${escapeHtml(s.reason)}">${escapeHtml(s.label)}：${escapeHtml(s.state)}</span>`).join('')}</div>
            <form id="researchConfirmForm" class="r-card">
                <h4>核实自有产品事实</h4>
                <label>字段<select name="key">${Object.entries(fieldLabels).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></label>
                <label>已核实内容<input name="value" required maxlength="2000"></label>
                <label>核实来源地址<input name="source_url" type="url" required value="${escapeHtml(product.url || '')}"></label>
                <label class="r-check"><input name="own_product" type="checkbox" required>我已核实这是自有商品的信息，不是直接采用竞品宣传</label>
                <button type="submit">保存人工核实记录</button>
            </form>
            <button type="button" data-research-preview>预览可交接事实</button>`;
    }

    async function confirmFact(form) {
        const generation = state.generation;
        const product = state.product, project = state.project;
        if (!product || !form.elements.own_product.checked) return;
        const payload = { expected_version: project.source_version, identity_revision: product.source_ref.identity_revision,
            market: product.market, key: form.elements.key.value, value: form.elements.value.value.trim(),
            source_url: form.elements.source_url.value, own_product: true };
        const path = `/projects/${project.id}/products/${product.source_ref.product_id}/confirm-fact`;
        const signature = JSON.stringify([path, payload]);
        if (state.pendingConfirmation && state.pendingConfirmation.signature !== signature) {
            message('此前提交结果尚未确认，请保持原输入重试或刷新研究状态，避免重复提交。', true); return;
        }
        const commandId = state.pendingConfirmation?.id || crypto.randomUUID();
        state.pendingConfirmation = { id: commandId, signature, path, body: { ...payload, command_id: commandId } };
        el('researchResolveConfirmation').hidden = false;
        const button = form.querySelector('button'); button.disabled = true;
        try {
            await request(path, state.pendingConfirmation.body);
            const updated = await request('/projects/' + project.id);
            state.pendingConfirmation = null;
            el('researchResolveConfirmation').hidden = true;
            if (generation !== state.generation || state.project?.id !== project.id || state.product?.source_ref.product_id !== product.source_ref.product_id) return;
            state.project = updated; openProduct(product.source_ref.product_id);
            message('人工核实记录已保存；可逐项预览并填入营销草稿。');
        } catch (error) {
            if ([403, 409, 422].includes(error.status)) {
                state.pendingConfirmation = null;
                el('researchResolveConfirmation').hidden = true;
                message(error.message + '；请刷新资料并重新核实。', true);
            } else message(error.message + '。未自动重发，保留原操作编号。', true);
        }
        finally { button.disabled = false; }
    }

    async function fetchPreview(module = 'details') {
        const p = state.product;
        if (!p) throw new Error('请先选择研究商品');
        return await request(`/projects/${p.source_ref.project_id}/products/${p.source_ref.product_id}/preview`, {
            expected_source_version: p.source_ref.source_version, expected_identity_revision: p.source_ref.identity_revision,
            expected_market: p.market, existing: existingFor(module)
        });
    }

    async function showPreview() {
        const generation = state.generation;
        try {
            const preview = await fetchPreview();
            if (generation !== state.generation) return;
            state.preview = preview;
            const fields = state.preview.fields;
            el('researchPreview').innerHTML = `<div class="r-card"><h4>选择要交接的已核实事实</h4>${fields.length ? fields.map(f => `<label class="r-check"><input type="checkbox" data-research-field="${escapeHtml(f.key)}">${escapeHtml(f.label)}：${escapeHtml(f.value)}</label>`).join('') : '<p>没有可交接的人工核实事实。请先核实自有产品信息。</p>'}
                <p class="r-muted">保留现有名称；事实追加到草稿，不启动生成或上传。${state.preview.blocked_count} 个未核实或失效字段未进入交接。</p>
                ${fields.length ? '<button data-research-apply="details">填入详情页</button><button data-research-apply="listing">填入 Listing</button><button data-research-apply="ads">填入广告草稿</button>' : ''}</div>`;
        } catch (error) { message(error.message, true); }
    }

    async function handoff(module) {
        if (state.applying) return;
        const generation = state.generation;
        const selection = Array.from(el('researchPreview').querySelectorAll('[data-research-field]:checked')).map(input => input.dataset.researchField);
        if (!selection.length) { message('请先勾选要交接的事实。', true); return; }
        state.applying = true;
        try {
            // Re-read source immediately before applying, enforcing version and identity again.
            const fresh = await fetchPreview(module);
            if (generation !== state.generation) return;
            state.undo = applyDraft(fresh, selection, module);
            if (!state.undo.length) { message('未修改输入：现有名称已保留，或没有可填入的字段。'); return; }
            el('researchUndo').hidden = false;
            message('已填入营销草稿，可撤销本次填充；没有启动生成。');
            if (typeof switchMainTab === 'function') switchMainTab(module === 'details' ? 'generate' : module);
        } catch (error) { if (generation === state.generation) message(error.message, true); }
        finally { state.applying = false; }
    }

    async function resolveConfirmation() {
        const pending = state.pendingConfirmation;
        if (!pending) return;
        const button = el('researchResolveConfirmation');
        button.disabled = true;
        try {
            // Explicit user reconciliation reuses the exact idempotent operation.
            const projectPath = pending.path.split('/products/')[0];
            const status = await request(projectPath + '/confirmations/' + pending.id);
            if (status.state !== 'committed') {
                message('暂未查到提交记录。保留原输入和操作编号，点击原保存按钮可提交同一操作。', true);
                return;
            }
            if (state.pendingConfirmation === pending) state.pendingConfirmation = null;
            button.hidden = true;
            if (state.project) await openProject(state.project.id);
            message('上次提交已核对，请重新选择商品并预览。');
        } catch (error) { message(error.message + '；原操作编号继续保留。', true); }
        finally { button.disabled = false; }
    }

    async function calculate(form) {
        const values = Object.fromEntries(new FormData(form));
        const number = key => values[key] === '' ? null : Number(values[key]);
        const output = form.querySelector('output');
        try {
            const isWeight = form.id === 'researchWeightForm';
            const payload = isWeight ? { actual_weight_kg: number('weight'), dimensions_cm: ['length', 'width', 'height'].map(number), divisor_cm3_per_kg: number('divisor') } :
                { monthly_visits: number('visits'), aov: number('aov'), cvr_low: number('low'), cvr_base: number('base'), cvr_high: number('high'), traffic_scope: values.scope };
            const result = await request('/math/' + (isWeight ? 'logistics' : 'scenarios'), payload);
            output.textContent = isWeight ? `体积重：${result.volumetric_weight_kg ?? '未知'} kg；计费重：${result.chargeable_weight_kg ?? '未知'} kg` :
                `低／中／高情景订单：${result.low.monthly_orders}／${result.base.monthly_orders}／${result.high.monthly_orders}；对应收入（USD）：${result.low.monthly_revenue}／${result.base.monthly_revenue}／${result.high.monthly_revenue}。${result.scope === 'product' ? '产品范围情景' : '来源范围情景，不能视为产品销量'}；不是实际销量。`;
        } catch (error) { output.textContent = error.message; }
    }

    function bind() {
        const panel = el('researchView');
        if (!panel || panel.dataset.bound) return;
        panel.dataset.bound = 'true';
        panel.addEventListener('click', event => {
            const button = event.target.closest('button'); if (!button) return;
            if (button.dataset.researchProject) openProject(button.dataset.researchProject);
            if (button.dataset.researchProduct) openProduct(button.dataset.researchProduct);
            if (button.hasAttribute('data-research-preview')) showPreview();
            if (button.dataset.researchApply) handoff(button.dataset.researchApply);
            if (button.id === 'researchRefresh') { if (state.project) openProject(state.project.id); loadProjects(); }
            if (button.id === 'researchResolveConfirmation') resolveConfirmation();
            if (button.id === 'researchMoreProjects') loadProjects(true);
            if (button.id === 'researchUndo') { message(`已撤销 ${undoDraft(state.undo)} 项填充；后续人工修改已保留。`); state.undo = null; button.hidden = true; }
        });
        panel.addEventListener('submit', event => {
            event.preventDefault();
            if (event.target.id === 'researchConfirmForm') confirmFact(event.target);
            if (['researchWeightForm', 'researchScenarioForm'].includes(event.target.id)) calculate(event.target);
        });
    }

    async function init() {
        bind();
        const generation = ++state.generation;
        try {
            const session = await request('/session');
            if (generation !== state.generation) return;
            state.token = session.csrf_token; state.enabled = session.enabled;
            const link = el('researchWorkbenchLink');
            if (session.workbench_url) {
                const url = new URL(session.workbench_url);
                if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) { link.href = url.href; link.hidden = false; }
            }
            if (state.enabled) await loadProjects(); else message('独立计算工具已就绪；研究服务连接尚未启用。');
        } catch (error) { if (generation === state.generation) message('研究入口加载失败：' + error.message, true); }
    }

    const api = { init, suspend: () => { state.generation++; }, applyDraft, undoDraft, escapeHtml };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.ResearchPanel = api;
})(typeof window !== 'undefined' ? window : globalThis);
