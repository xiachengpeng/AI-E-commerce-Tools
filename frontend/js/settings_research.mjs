import { renderWorkerStatus } from './research-workbench/components/worker-status.mjs';
import { createApi } from './research-workbench/api.mjs';
import { createLifecycle } from './research-workbench/lifecycle.mjs';
import { renderIntegrationSettings } from './research-workbench/settings.mjs';

/** One credential editor owner for the main Settings / External services pane. */
export function createSettingsIntegrations() {
    let current=null;
    function unmount() {
        if(!current)return;
        current.life.dispose();current.host.replaceChildren();current.firecrawlHost?.replaceChildren();current=null;
    }
    async function mount(host,options={}) {
        if(current?.host===host)return current.ready;
        unmount();
        const life=createLifecycle(),instance={host,life,firecrawlHost:options.firecrawlHost};current=instance;
        const status=host.ownerDocument.createElement('p');status.dataset.rwStatus='';status.setAttribute('role','status');status.textContent='正在读取接口配置…';host.replaceChildren(status);
        const api=createApi({...options,signal:life.signal});
        const context={root:host,life,api,state:{},context:{openMainSettings:options.openMainSettings}};
        instance.ready=(async()=>{
            try {
                await api.session();if(!life.active||current!==instance)return;
                status.textContent='';status.hidden=true;
                host.append(renderIntegrationSettings(context,{firecrawlHost:options.firecrawlHost}));
                if(host.ownerDocument.body?.classList.contains('research-design-mode'))host.append(status);
            }catch{if(life.active&&current===instance){status.hidden=false;status.textContent='接口配置暂时无法读取，请重新进入外部服务。已有配置保持不变。';}}
        })();
        return instance.ready;
    }
    return {mount,unmount};
}

/** Runtime observations belong to the Logs pane; disposed when leaving it. */
export function createSettingsWorkerStatus() {
    let current;
    return {
        async mount(host, options={}) {
            if(current?.host===host)return;
            this.unmount();
            const life=createLifecycle();current={host,life};
            const api=createApi({...options,signal:life.signal});
            try { await api.session();if(!life.active)return;
                host.replaceChildren(renderWorkerStatus({root:host,life,api}));
            } catch {if(life.active)host.textContent='后台状态暂不可读取，请重新进入运行观测。';}
        },
        unmount() {if(current){current.life.dispose();current.host.replaceChildren();current=null;}}
    };
}
