/* Research panel owns its state; it never loads the SOP's global scripts. */
(function (root) {
    'use strict';
    const state = { token: '', enabled: false, project: null, product: null, preview: null,
        cursor: null, generation: 0, undo: null, pendingConfirmation: null, applying: false, loadingProjects: false,
        pendingImport: null, imports: [], importCursor: null, loadingImports: false };
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
        if (state.loadingProjects || (append && !state.cursor)) return;
        state.loadingProjects = true;
        el('researchMoreProjects').disabled = true;
        const generation = state.generation;
        try {
            const page = await request('/projects' + (append && state.cursor ? '?cursor=' + encodeURIComponent(state.cursor) : ''));
            if (generation !== state.generation) return;
            const html = page.projects.map(p => `<button class="r-project" data-research-project="${escapeHtml(p.id)}"><strong>${escapeHtml(p.title)}</strong><span>${escapeHtml(p.market)} · 版本 ${p.source_version}</span></button>`).join('');
            const list = el('researchProjectList');
            if (append) list.insertAdjacentHTML('beforeend', html); else list.innerHTML = html || '<p class="r-muted">尚无研究项目。可在研究工作台创建项目。</p>';
            state.cursor = page.next_cursor;
            el('researchMoreProjects').hidden = !state.cursor;
            message('研究资料已同步；导入前仍需人工核实自有产品事实。');
        } catch (error) { if (generation === state.generation) message(error.message, true); }
        finally { state.loadingProjects = false; el('researchMoreProjects').disabled = false; }
    }

    async function openProject(id) {
        const generation = ++state.generation;
        try {
            const project = await request('/projects/' + id);
            if (generation !== state.generation) return;
            setProject(project);
        } catch (error) { if (generation === state.generation) message(error.message, true); }
    }

    function setProject(project) {
        state.project = project; state.product = null; state.preview = null;
        el('researchProjectTitle').textContent = `${project.title} · ${project.market}`;
        el('researchProducts').innerHTML = project.products.map(p => `<button class="r-project" data-research-product="${escapeHtml(p.source_ref.product_id)}"><strong>${escapeHtml(p.name)}</strong><span>${p.merged ? '已合并' : '身份版本 ' + p.source_ref.identity_revision} · ${escapeHtml(p.decision || '未决策')}</span></button>`).join('') || '<p class="r-muted">尚无商品，请在研究工作台中添加或采集。</p>';
        el('researchProductDetail').innerHTML = '';
        el('researchPreview').innerHTML = '';
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

    async function showPreview(origin) {
        const generation = state.generation;
        try {
            const preview = await fetchPreview();
            if (generation !== state.generation || (origin && !origin.isCurrent())) return;
            state.preview = preview;
            const fields = state.preview.fields;
            el('researchPreview').innerHTML = `<div class="r-card"><h4>选择要交接的已核实事实</h4>${fields.length ? fields.map(f => `<label class="r-check"><input type="checkbox" data-research-field="${escapeHtml(f.key)}">${escapeHtml(f.label)}：${escapeHtml(f.value)}</label>`).join('') : '<p>没有可交接的人工核实事实。请先核实自有产品信息。</p>'}
                <p class="r-muted">保留现有名称；事实追加到草稿，不启动生成或上传。${state.preview.blocked_count} 个未核实或失效字段未进入交接。</p>
                ${fields.length ? '<button data-research-apply="details">填入详情页</button><button data-research-apply="listing">填入 Listing</button><button data-research-apply="ads">填入广告草稿</button><button id="researchSaveImport">保存所选事实为营销档案</button>' : ''}</div>`;
        } catch (error) { if (!origin || origin.isCurrent()) message(error.message, true); }
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
            if (button.id === 'researchReturnNative') mountPanel();
            if (button.id === 'researchSaveImport') saveImport();
            if (button.id === 'researchLoadImports') loadImports();
            if (button.id === 'researchResolveImport') resolveImport();
            if (button.id === 'researchRetryImport') retryOriginalImport();
            if (button.id === 'researchMoreImports') loadImports(true);
            if (button.hasAttribute('data-research-history')) loadArtifactChoices(button.closest('form'));
            if (button.dataset.researchImport) reopenImport(button.dataset.researchImport);
            if (button.id === 'researchUndo') { message(`已撤销 ${undoDraft(state.undo)} 项填充；后续人工修改已保留。`); state.undo = null; button.hidden = true; }
        });
        panel.addEventListener('submit', event => {
            event.preventDefault();
            if (event.target.id === 'researchConfirmForm') confirmFact(event.target);
            if (['researchWeightForm', 'researchScenarioForm'].includes(event.target.id)) calculate(event.target);
            if (event.target.dataset?.researchArtifact) attachArtifact(event.target);
        });
    }

    // The complete workbench lives in the main application.
    let nativeModule = null;
    let nativeGeneration = 0;
    function restorePendingImport() {
        try {
            const pending = JSON.parse(sessionStorage.getItem('research_pending_import') || 'null');
            if (/^\/projects\/[0-9a-f-]{36}\/products\/[0-9a-f-]{36}\/imports$/i.test(pending?.path || '') && /^[0-9a-f-]{36}$/i.test(pending?.body?.import_id || '') && pending.signature === JSON.stringify([pending.path, Object.fromEntries(Object.entries(pending.body).filter(([key]) => key !== 'import_id'))])) {
                state.pendingImport = pending;
                el('researchResolveImport').hidden = false;
                el('researchRetryImport').hidden = false;
                if (el('researchPendingImportEntry')) el('researchPendingImportEntry').hidden = false;
            }
        } catch (_) { /* Storage is optional; no business call is replayed on load. */ }
    }

    async function openPendingImport() {
        if (!state.pendingImport) return;
        unmountPanel();
        if (el('researchReturnNative')) el('researchReturnNative').hidden = false;
        await init();
    }

    async function mountPanel() {
        restorePendingImport();
        const generation = ++nativeGeneration;
        const host = el('researchNativeRoot');
        if (!host) return;
        el('researchView').hidden = true;
        host.hidden = false;
        try {
            nativeModule = await import('./research-workbench/index.mjs?v=20261026-candidate-switch');
            if (generation !== nativeGeneration) return;
            await nativeModule.mount(host, { apiBase: base(), onSelectProduct: selectSource, openMainSettings: tab => { root.switchMainTab?.('settings'); root.switchSettingsTab?.(tab); } });
        } catch (_) {
            if (generation === nativeGeneration) host.textContent = '原生研究入口暂时不可用，请重新进入研究页。';
        }
    }
    async function openNativePage(view, kind) {
        if (!['settings','history','reports'].includes(view)) return;
        root.switchMainTab?.('research');
        await mountPanel();
        if (el('researchNativeRoot')?.hidden === false) nativeModule?.navigate(view, kind);
    }
    function unmountPanel() {
        nativeGeneration++;
        nativeModule?.unmount();
        state.generation++;
        if (el('researchNativeRoot')) el('researchNativeRoot').hidden = true;
        if (el('researchView')) el('researchView').hidden = false;
    }

    async function init() {
        bind();
        if (typeof location !== 'undefined' && location.protocol === 'file:') {
            message('请通过 http://127.0.0.1:9502/index.html 打开主工具，以使用安全研究会话。', true); return;
        }
        const generation = ++state.generation;
        try {
            const session = await request('/session');
            if (generation !== state.generation) return;
            state.token = session.csrf_token; state.enabled = session.enabled;
            restorePendingImport();
            if (state.enabled) await loadProjects(); else message('独立计算工具已就绪；研究服务连接尚未启用。');
        } catch (error) { if (generation === state.generation) message('研究入口加载失败：' + error.message, true); }
    }

    // Native handoff carries IDs/fences only. Main v1 reads the authoritative DTO.
    async function selectSource(data, origin) {
        const originCurrent = () => !origin || origin.isCurrent();
        if (!originCurrent()) return;
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuid.test(data?.project_id) || !uuid.test(data?.product_id) || !Number.isInteger(data?.source_version) || data.source_version < 0 || !Number.isInteger(data?.identity_revision) || data.identity_revision < 1) return;
        const generation = ++state.generation;
        try {
            if (!state.token) {
                const session = await request('/session');
                if (generation !== state.generation || !originCurrent()) return;
                state.token = session.csrf_token; state.enabled = session.enabled;
            }
            const project = await request('/projects/' + data.project_id);
            if (generation !== state.generation || !originCurrent()) return;
            const product = await request('/projects/' + data.project_id + '/products/' + data.product_id);
            if (generation !== state.generation || !originCurrent()) return;
            if (!product || product.merged || product.merged_into || project.id !== data.project_id || product.source_ref.project_id !== data.project_id || product.source_ref.product_id !== data.product_id || project.source_version !== data.source_version || product.source_ref.source_version !== data.source_version || product.source_ref.identity_revision !== data.identity_revision || product.market !== project.market || (data.market !== undefined && product.market !== data.market)) throw new Error('所选研究资料已更新，请在工作台刷新后重新交接');
            bind();setProject({...project,products:[...(project.products||[]).filter(p=>p.source_ref.product_id!==data.product_id),product]});openProduct(data.product_id);
            // Preview/import enforce stale, identity, quotes, hashes and own-product
            // human confirmation server-side; no browser field becomes truth here.
            await showPreview(origin);
            if (generation + 1 !== state.generation || !originCurrent()) return;
            if (el('researchView')) el('researchView').hidden = false;
            if (el('researchNativeRoot')) el('researchNativeRoot').hidden = true;
            if (el('researchReturnNative')) el('researchReturnNative').hidden = false;
            el('researchPreview').scrollIntoView?.({block:'center',behavior:'smooth'});
        } catch (error) { if (originCurrent() && (generation === state.generation || generation + 1 === state.generation)) message(error.message,true); }
    }

    async function saveImport() {
        const selected = Array.from(el('researchPreview').querySelectorAll('[data-research-field]:checked')).map(input => input.dataset.researchField);
        if (!selected.length || !state.product) { message('请先勾选要保存的已核实事实。',true); return; }
        const product = state.product;
        const path = `/projects/${product.source_ref.project_id}/products/${product.source_ref.product_id}/imports`;
        const body = {expected_source_version:product.source_ref.source_version,expected_identity_revision:product.source_ref.identity_revision,
            expected_market:product.market,name:product.name.trim().slice(0,200) || '研究商品档案',selected_fields:selected};
        const signature = JSON.stringify([path,body]);
        if (state.pendingImport && state.pendingImport.signature !== signature) { message('上次保存结果尚未确认，请保留原选择重试。',true); return; }
        const pending = state.pendingImport ||= {signature,path,body:{...body,import_id:crypto.randomUUID()}};
        try { sessionStorage.setItem('research_pending_import',JSON.stringify(pending)); } catch (_) {}
        el('researchResolveImport').hidden = false;
        el('researchRetryImport').hidden = false;
        const button = el('researchSaveImport'); button.disabled = true;
        try {
            await request(pending.path,pending.body);
            state.pendingImport = null;
            clearPendingImport();
            await loadImports();
            message('营销档案已保存；来源与所选事实可追溯，没有启动生成。');
        } catch (error) {
            if ([403,409,422].includes(error.status)) { state.pendingImport = null; clearPendingImport(); }
            message(error.message + '；没有自动重发。',true);
        } finally { button.disabled = false; }
    }

    function clearPendingImport() {
        if (el('researchPendingImportEntry')) el('researchPendingImportEntry').hidden = true;
        try { sessionStorage.removeItem('research_pending_import'); } catch (_) {}
        el('researchResolveImport').hidden = true;
        el('researchRetryImport').hidden = true;
    }

    async function resolveImport() {
        const pending = state.pendingImport;
        if (!pending) return;
        try {
            await request('/imports/' + encodeURIComponent(pending.body.import_id));
            if (state.pendingImport === pending) { state.pendingImport = null; clearPendingImport(); }
            await loadImports(); message('上次档案已保存，已核对原操作编号。');
        } catch (error) { message(error.status === 404 ? '暂未查到记录；保留原选择可重试同一保存，不会自动提交。' : error.message,true); }
    }

    async function retryOriginalImport() {
        const pending = state.pendingImport;
        if (!pending) return;
        const button = el('researchRetryImport'); button.disabled = true;
        try {
            await request(pending.path,pending.body);
            if (state.pendingImport === pending) { state.pendingImport = null; clearPendingImport(); }
            await loadImports(); message('原档案保存已核对；可以继续保存其他商品。');
        } catch (error) {
            if ([403,409,422].includes(error.status) && state.pendingImport === pending) { state.pendingImport = null; clearPendingImport(); }
            message(error.message + ([403,409,422].includes(error.status) ? '；原提交已明确拒绝，请重新预览当前资料。' : '；保留原操作编号。'),true);
        } finally { button.disabled = false; }
    }

    async function loadImports(append = false) {
        if (state.loadingImports || (append && !state.importCursor)) return;
        state.loadingImports = true;
        try {
            const data = await request('/imports' + (append ? '?cursor=' + encodeURIComponent(state.importCursor) : ''));
            state.imports = append ? [...state.imports,...data.imports] : data.imports;
            state.importCursor = data.next_cursor;
            el('researchMoreImports').hidden = !state.importCursor;
            el('researchImports').innerHTML = state.imports.map(item => `<div class="r-card"><strong>${escapeHtml(item.name)}</strong><p class="r-muted">${escapeHtml(item.snapshot.market)} · 来源版本 ${item.snapshot.source_ref.source_version} · ${escapeHtml(item.created_at)}</p>
                ${item.snapshot.facts.map(f => `<p>${escapeHtml(fieldLabels[f.key])}：${escapeHtml(f.value)}</p>`).join('')}
                <button data-research-import="${escapeHtml(item.import_id)}">核对来源并交接</button><p class="r-muted">成果关联：${escapeHtml(item.artifacts.map(a => `${a.module} #${a.history_id}`).join('、') || '尚无')}</p>
                <form data-research-artifact="${escapeHtml(item.import_id)}"><label>关联已有营销历史<select name="module"><option value="details">详情图片</option><option value="listing">Listing</option><option value="ads">广告</option><option value="analysis">竞品分析</option></select></label><button type="button" data-research-history>读取此类型已有成果</button><label>选择历史<select name="history_id" required><option value="">先读取已有成果</option></select></label><button type="submit">关联已有成果</button></form></div>`).join('') || '<p class="r-muted">暂无档案；在事实预览中勾选并保存。</p>';
        } catch (error) { message(error.message,true); }
        finally { state.loadingImports = false; }
    }

    async function loadArtifactChoices(form) {
        const module = form.elements.module.value;
        try {
            const data = await request('/artifact-choices?module=' + encodeURIComponent(module) + '&limit=50');
            if (form.elements.module.value !== module) return;
            form.elements.history_id.dataset.module = module;
            form._researchChoices = data.items;
            form.elements.history_id.innerHTML = '<option value="">请选择成果</option>' + data.items.map(item => `<option value="${item.id}">#${item.id} · ${escapeHtml(item.label)} · ${escapeHtml(item.created_at || '')}</option>`).join('');
            if (!data.items.length) message('此类型暂无已保存的营销历史。');
        } catch (error) { message(error.message,true); }
    }

    async function reopenImport(id) {
        const item = state.imports.find(i => i.import_id === id);
        if (!item) return;
        const generation = ++state.generation;
        try {
            const project = await request('/projects/' + item.snapshot.source_ref.project_id);
            if (generation !== state.generation) return;
            const product = project.products.find(p => p.source_ref.product_id === item.snapshot.source_ref.product_id);
            if (!product || product.source_ref.source_version !== item.snapshot.source_ref.source_version || product.source_ref.identity_revision !== item.snapshot.source_ref.identity_revision) throw new Error('原档案仍可查阅，但来源已更新或删除；请重新选择并核实当前商品。');
            setProject(project); openProduct(product.source_ref.product_id); await showPreview();
        } catch (error) { message(error.message,true); }
    }

    async function attachArtifact(form) {
        const item = state.imports.find(i => i.import_id === form.dataset.researchArtifact);
        if (!item) return;
        if (form.elements.history_id.dataset.module !== form.elements.module.value || !form.elements.history_id.value) { message('请读取并选择当前类型的已有成果。',true); return; }
        const choice = form._researchChoices?.find(item => item.id === Number(form.elements.history_id.value));
        if (!choice) { message('请重新读取并选择已有成果。',true); return; }
        const button = form.querySelector('button'); button.disabled = true;
        try {
            await request('/imports/' + item.import_id + '/artifacts',{expected_revision:item.revision,module:form.elements.module.value,history_id:Number(form.elements.history_id.value),expected_history_timestamp:choice.created_at});
            await loadImports(); message('已有营销成果已关联；可在完整工作台人工记录测试与复盘。');
        } catch (error) { message(error.message,true); }
        finally { button.disabled = false; }
    }

    const api = { init, openPendingImport, openNativePage, mount: mountPanel, unmount: unmountPanel, suspend: unmountPanel, applyDraft, undoDraft, escapeHtml, selectSource };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.ResearchPanel = api;
})(typeof window !== 'undefined' ? window : globalThis);
