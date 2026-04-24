/**
 * 统一工具函数库
 */

const API_BASE = "http://localhost:8000";

/**
 * 将日志发送至后端终端
 */
async function remoteLog(msg) {
    try {
        const cleanMsg = msg.replace(/%c/g, '');
        fetch(`${API_BASE}/log`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: cleanMsg })
        }).catch(() => {});
    } catch (e) {}
}

/**
 * 统一弹窗提示
 */
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    let bgClass = type === 'success' ? 'bg-emerald-600' : (type === 'error' ? 'bg-red-500' : (type === 'warning' ? 'bg-amber-500' : 'bg-gray-800'));
    let icon = type === 'success' ? 'ph-check-circle' : (type === 'error' ? 'ph-warning-circle' : 'ph-info');
    toast.className = `toast-enter flex items-center gap-2 ${bgClass} text-white px-4 py-3 rounded-xl shadow-xl text-sm font-medium tracking-wide`;
    toast.innerHTML = `<i class="ph ${icon} text-lg"></i> <span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0'; toast.style.transform = 'translateY(-10px)'; toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

/**
 * 带重试机制的 Fetch
 */
async function fetchWithRetry(url, options, retries = 5) {
    const delays = [1000, 2000, 4000, 8000, 16000];
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, options);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (e) {
            if (i === retries - 1) throw e;
            await new Promise(r => setTimeout(r, delays[i]));
        }
    }
}

/**
 * 复制文本到剪贴板
 */
function copyText(inputId) {
    let text = document.getElementById(inputId).value;
    if (!text) return;
    const textArea = document.createElement("textarea");
    textArea.value = text;
    document.body.appendChild(textArea);
    textArea.select();
    try { document.execCommand('copy'); showToast('已复制到剪贴板', 'success'); } catch (e) { showToast('复制失败', 'error'); }
    document.body.removeChild(textArea);
}

/**
 * 复制指定区块文本
 */
function copySectionText(containerId, langType) {
    const el = document.getElementById(containerId);
    if (!el) return;
    let text = '';
    const selector = langType === 'target' ? '.target-text' : '.zh-text';

    if (el.tagName === 'UL') {
        const lis = el.querySelectorAll('li');
        lis.forEach(li => {
            const txt = li.querySelector(selector)?.textContent;
            if(txt) text += txt + '\n';
        });
    } else if (containerId === 'resListingQA') {
        const qas = el.querySelectorAll('.bg-indigo-50\\/50');
        qas.forEach(qa => {
           const lines = qa.querySelectorAll(selector);
           if(lines.length >= 2) {
               text += `Q: ${lines[0].textContent}\nA: ${lines[1].textContent}\n\n`;
           }
        });
    } else {
        const txt = el.querySelector(selector)?.textContent;
        if(txt) text = txt;
    }

    const textArea = document.createElement("textarea");
    textArea.value = text.trim();
    document.body.appendChild(textArea);
    textArea.select();
    try { document.execCommand('copy'); showToast(`已复制${langType==='target'?'外文':'中文'}文本`, 'success'); } catch(e){}
    document.body.removeChild(textArea);
}
