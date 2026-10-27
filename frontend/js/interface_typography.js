/** Local UI preference only. Never rewrites product data, generated HTML or images. */
(function (scope) {
    'use strict';
    const KEY='ai_ecommerce_interface_font_size';
    const SIZES=[14,16,18,20];
    const seen=new WeakSet();
    function scaleFontRules(sheets) {
        function visit(rules) {
            for(const rule of rules) {
                if(rule.cssRules?.length)visit(rule.cssRules);
                if(!rule.selectorText||!rule.style||seen.has(rule))continue;
                seen.add(rule);
                if(rule.selectorText.split(',').some(s=>/^(html|:root|:host)$/.test(s.trim())))continue;
                const size=rule.style.getPropertyValue('font-size').trim();
                // Relative em/% already inherit their parent's size; scaling them again compounds it.
                if(!/^\d*\.?\d+(px|rem)$/.test(size))continue;
                rule.style.setProperty('font-size',`calc(${size} * var(--app-font-scale, 1))`,rule.style.getPropertyPriority('font-size'));
            }
        }
        for(const sheet of sheets){try{visit(sheet.cssRules||[]);}catch{/* External font/icon sheets are not application-owned. */}}
    }
    function createInterfaceTypography({document,storage}) {
        let size=16,stored=!!storage;
        try{const value=Number(storage?.getItem(KEY));if(SIZES.includes(value))size=value;}catch{stored=false;}
        function paint() {
            document.documentElement.style.setProperty('--app-font-scale',String(size/16));
            const select=document.getElementById('settingsInterfaceFontSize');if(select)select.value=String(size);
            const status=document.getElementById('settingsInterfaceFontStatus');
            if(status)status.textContent=`当前字号：${size}px · 即时生效`+(stored?'，已在此设备记住。':'；本次生效，当前环境无法保存偏好。');
        }
        return {
            get size(){return size;},
            init(){scaleFontRules(document.styleSheets);paint();},
            setSize(value){
                const next=Number(value);if(!SIZES.includes(next))return false;
                size=next;
                try{if(!storage)throw Error();storage.setItem(KEY,String(size));stored=true;}catch{stored=false;}
                paint();return true;
            },
            reset(){return this.setSize(16);}
        };
    }
    if(typeof module!=='undefined'&&module.exports)module.exports={createInterfaceTypography,scaleFontRules};
    if(scope.document){
        let storage;try{storage=scope.localStorage;}catch{/* Session-only setting remains usable. */}
        const controller=createInterfaceTypography({document:scope.document,storage});
        scope.appTypography=controller;
        scope.setInterfaceFontSize=value=>controller.setSize(value);
        scope.resetInterfaceFontSize=()=>controller.reset();
        controller.init();
    }
})(typeof window!=='undefined'?window:globalThis);
