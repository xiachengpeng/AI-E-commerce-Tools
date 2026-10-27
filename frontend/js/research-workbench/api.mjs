const NATIVE_PATH = '/api/research/workbench/v1';
export function createApi(context = {}) {
    const base = new URL(context.apiBase || 'http://127.0.0.1:9503');
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname) || base.port !== '9503' || base.username || base.password || base.search || base.hash || !['/', NATIVE_PATH, NATIVE_PATH + '/'].includes(base.pathname)) {
        throw new Error('Research API must use local port 9503');
    }
    const pageOrigin = context.pageOrigin ?? globalThis.location?.origin;
    const origin = ['http://127.0.0.1:9502', 'http://localhost:9502'].includes(pageOrigin) ? pageOrigin : base.origin;
    const transport = context.fetch || globalThis.fetch.bind(globalThis);
    let token = '';
    async function send(url, options = {}) {
        const signals=[context.signal,options.signal,AbortSignal.timeout(options.responseType==='stream'?70000:25000)].filter(Boolean);
        const signal=AbortSignal.any(signals);
        let response;
        try { response = await transport(url, {
            method: options.method || 'GET',
            headers: { 'Content-Type': 'application/json', 'X-Research-Token': token },
            ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
            signal, cache: 'no-store', redirect: 'error'
        }); } catch(error) {
            if(!signal.aborted&&/failed to fetch|load failed|networkerror/i.test(error.message))throw new Error('暂时无法连接本机研究服务，请确认应用仍在运行；已提交操作请先核对状态。');
            throw error;
        }
        const data = response.ok && options.responseType === 'blob' ? await response.blob() : response.ok && options.responseType === 'stream' ? response.body : await response.json();
        if (!response.ok) {
            const error = new Error(response.status===503?'研究能力暂不可用或尚未配置（503），请核对来源状态':response.status===429?'请求达到连接或预算限制（429），请稍后核对':'研究请求未完成，请刷新状态或核对输入');
            // Media routes return bounded service diagnostics; never echo raw upstream text.
            if(options.responseType==='blob'&&response.status===502){
                const status=typeof data.detail==='string'?data.detail.match(/来源返回 HTTP ([1-5][0-9]{2})/):null;
                error.message=status?'素材来源返回 HTTP '+status[1]+'，暂时无法显示。链接可能失效或受访问限制，请打开原来源核对。':'素材来源暂时无法读取，可能超时、链接失效或格式不可用，请打开原来源核对。';
            }else if(options.responseType==='blob'&&response.status===422)error.message='素材未保存或当前记录已变化，请刷新当前线索后重试。';
            error.status = response.status;
            throw error;
        }
        return data;
    }
    return {
        async session() {
            const data = await send(origin + '/api/research/v1/session');
            if (typeof data.csrf_token !== 'string' || !data.csrf_token) throw new Error('研究会话不可用');
            token = data.csrf_token;
            return data;
        },
        async request(path, options = {}) {
            if (typeof path !== 'string' || !/^\/(?!\/)/.test(path) || /[\\#]/.test(path) || /(?:^|\/)\.\.(?:\/|\?|$)/.test(path)) throw new Error('Invalid research path');
            const url = new URL(origin + NATIVE_PATH + path);
            if (!url.pathname.startsWith(NATIVE_PATH + '/')) throw new Error('Invalid research path');
            if (!token) throw new Error('研究会话不可用');
            // One transport attempt, including commands with ambiguous outcomes.
            return send(url.href, options);
        },
        async integration(provider, purpose, options = {}) {
            if (!['apify','serpapi','firecrawl','aliyun','feishu'].includes(provider) || purpose !== 'research' || !['GET','PATCH'].includes(options.method || 'GET')) throw new Error('Invalid integration destination');
            if (!token) throw new Error('研究会话不可用');
            return send(origin + '/api/settings/integrations/' + provider + '/' + purpose, options);
        },
        async testIntegration(provider, purpose, options = {}) {
            if (!['apify','serpapi','firecrawl','aliyun','feishu'].includes(provider) || purpose !== 'research' || !token) throw new Error('Invalid integration test');
            return send(origin + '/api/settings/integrations/' + provider + '/' + purpose + '/test', {...options,method:'POST'});
        },
        async integrationProfile(provider, operation, options = {}) {
            if (!['apify','serpapi','firecrawl','aliyun','feishu'].includes(provider) || !token) throw new Error('Invalid integration profile');
            const method=options.method||'GET';
            const valid=(operation==='profiles'&&method==='POST') || (/^profiles\/(default|[a-f0-9]{32})$/.test(operation)&&['GET','PATCH'].includes(method)) || (['activate','reveal'].includes(operation)&&method==='POST');
            if(!valid)throw new Error('Invalid integration operation');
            return send(origin+'/api/settings/integrations/'+provider+'/research/'+operation,options);
        },
        blob(path, options = {}) { return this.request(path, {...options,responseType:'blob'}); },
        stream(path, options = {}) { return this.request(path, {...options,responseType:'stream'});
        }
    };
}
