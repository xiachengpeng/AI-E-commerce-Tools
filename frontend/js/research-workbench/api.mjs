const NATIVE_PATH = '/api/research/workbench/v1';
export function createApi(context = {}) {
    const base = new URL(context.apiBase || 'http://127.0.0.1:9503');
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname) || base.port !== '9503' || base.username || base.password || base.search || base.hash || !['/', NATIVE_PATH, NATIVE_PATH + '/'].includes(base.pathname)) {
        throw new Error('Research API must use local port 9503');
    }
    const transport = context.fetch || globalThis.fetch.bind(globalThis);
    let token = '';
    async function send(url, options = {}) {
        const signal = context.signal && options.signal ? AbortSignal.any([context.signal, options.signal]) : options.signal || context.signal;
        const response = await transport(url, {
            method: options.method || 'GET',
            headers: { 'Content-Type': 'application/json', 'X-Research-Token': token },
            ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
            signal, cache: 'no-store', redirect: 'error'
        });
        const data = await response.json();
        if (!response.ok) {
            const error = new Error('研究请求未完成，请刷新状态或核对输入');
            error.status = response.status;
            throw error;
        }
        return data;
    }
    return {
        async session() {
            const data = await send(base.origin + '/api/research/v1/session');
            if (typeof data.csrf_token !== 'string' || !data.csrf_token) throw new Error('研究会话不可用');
            token = data.csrf_token;
            return data;
        },
        async request(path, options = {}) {
            if (typeof path !== 'string' || !/^\/(?!\/)/.test(path) || /[\\#]/.test(path) || /(?:^|\/)\.\.(?:\/|\?|$)/.test(path)) throw new Error('Invalid research path');
            const url = new URL(base.origin + NATIVE_PATH + path);
            if (!url.pathname.startsWith(NATIVE_PATH + '/')) throw new Error('Invalid research path');
            if (!token) throw new Error('研究会话不可用');
            // One transport attempt, including commands with ambiguous outcomes.
            return send(url.href, options);
        }
    };
}
