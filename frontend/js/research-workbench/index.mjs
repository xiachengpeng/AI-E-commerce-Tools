import { createState } from './state.mjs';
import { createApi } from './api.mjs';
import { createLifecycle } from './lifecycle.mjs';

export function createWorkbench() {
    let instance = null;
    const snapshots = new WeakMap();
    function renderProjects(current) {
        const list = current.root.querySelector('[data-rw-projects]');
        const nodes = current.state.projects.map(project => {
            const button = current.root.ownerDocument.createElement('button');
            button.type = 'button'; button.dataset.rwProject = project.id;
            button.textContent = project.title || '未命名项目';
            return button;
        });
        list.replaceChildren(...nodes);
        if (!nodes.length) list.textContent = '暂无研究项目';
    }
    async function refresh(current = instance) {
        if (!current?.life.active || current.state.busy) return;
        current.state.busy = true;
        try {
            const data = await current.api.request('/projects');
            if (!current.life.active || current !== instance) return;
            if (!Array.isArray(data.projects)) throw new Error('Invalid projects');
            current.state.projects = data.projects;
            current.state.error = '';
            renderProjects(current);
            current.root.querySelector('[data-rw-status]').textContent = '研究资料已更新';
        } catch (_) {
            if (current.life.active && current === instance) {
                current.state.error = '研究资料暂时无法读取；已加载资料保持显示。';
                current.root.querySelector('[data-rw-status]').textContent = current.state.error;
            }
        } finally { current.state.busy = false; }
    }
    function unmount() {
        if (instance) snapshots.set(instance.root, structuredClone({ ...instance.state, busy: false, error: '' }));
        instance?.life.dispose();
        instance = null;
    }
    async function mount(root, context = {}) {
        if (instance?.root === root) return instance.ready;
        unmount();
        const life = createLifecycle();
        const current = { root, life, state: { ...createState(), ...structuredClone(snapshots.get(root)) }, context, api: createApi({ ...context, signal: life.signal }) };
        instance = current;
        root.innerHTML = '<div class="rw-header"><h2>选品研究工作台</h2><button type="button" data-rw-refresh>刷新研究资料</button></div><p data-rw-status role="status" aria-live="polite">正在读取研究资料…</p><div class="rw-layout"><nav aria-label="研究项目" data-rw-projects></nav><section data-rw-page><h3>选择研究项目</h3><p>原生项目、商品与报告页面将在后续迁入步骤接入。</p></section></div>';
        if (snapshots.has(root)) renderProjects(current);
        life.listen(root, 'click', event => {
            const button = event.target.closest?.('button');
            if (button?.hasAttribute('data-rw-refresh')) void refresh(current);
            if (button?.dataset.rwProject) context.onSelectProject?.(button.dataset.rwProject, current);
        });
        current.ready = (async () => {
            try {
                await current.api.session();
                if (life.active && current === instance) await refresh(current);
            } catch (_) {
                if (life.active && current === instance) root.querySelector('[data-rw-status]').textContent = '研究会话暂时不可用，请刷新研究入口。';
            }
        })();
        return current.ready;
    }
    return { mount, unmount, refresh, get state() { return instance?.state || null; } };
}
const workbench = createWorkbench();
export const mount = workbench.mount;
export const unmount = workbench.unmount;
