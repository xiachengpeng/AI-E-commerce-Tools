/** Legacy-compatible change detection; the server owns business validation/idempotency. */
export function newCommandId(cryptoProvider = globalThis.crypto) {
    if (cryptoProvider.randomUUID) return cryptoProvider.randomUUID();
    const bytes = cryptoProvider.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const h = Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export async function submissionFingerprint(content, cryptoProvider = globalThis.crypto) {
    const bytes = new TextEncoder().encode(JSON.stringify(content));
    if (cryptoProvider.subtle) return Array.from(new Uint8Array(await cryptoProvider.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
    let a = 2166136261, b = 2246822507;
    for (const x of bytes) { a = Math.imul(a ^ x, 16777619); b = Math.imul(b ^ x, 3266489909); }
    return `change:${bytes.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}
export function restoreDraft(saved = {}) {
    return { values: saved.values && typeof saved.values === 'object' && !Array.isArray(saved.values) ? saved.values : {},
        command_id: /^[0-9a-f-]{36}$/i.test(saved.command_id || '') ? saved.command_id : newCommandId(),
        submittedHash: typeof saved.submittedHash === 'string' ? saved.submittedHash : null, uncertain: saved.uncertain === true };
}
export function safeDraft(values, defs, identity) {
    const excluded = new Set(defs.filter(f => ['url','file'].includes(f.type)).map(f => f.key));
    const safe = Object.fromEntries(Object.entries(values).filter(([key,value]) => !excluded.has(key) && (typeof value !== 'string' || (value.length <= 10000 && !/https?:\/\//i.test(value)))));
    return { values: safe, command_id: identity.command_id, submittedHash: identity.submittedHash || null, uncertain: identity.uncertain === true };
}
export async function submitMutation(api, path, content, draft, persist = () => {}) {
    if (draft.submitting) throw Error('上一项保存尚未完成，请稍后操作。');
    draft.submitting = true;
    try {
        const fingerprintContent = { ...content }; delete fingerprintContent.version; delete fingerprintContent.command_id;
        const hash = await submissionFingerprint(fingerprintContent);
        // Submitted identities are never silently regenerated, including imported legacy hashes.
        if (draft.submittedHash && draft.submittedHash !== hash) throw Error('此前保存已有提交记录，请保持原输入重试或刷新核对，再显式放弃草稿开始新操作。');
        draft.command_id ||= newCommandId(); draft.submittedHash = hash; draft.uncertain = true; persist();
        const result = await api.request(path, { method: 'POST', body: { ...content, command_id: draft.command_id } });
        draft.uncertain = false; persist(); return result;
    } catch (error) {
        if (error.status && error.status < 500) { draft.uncertain = false; persist(); }
        throw error;
    } finally { delete draft.submitting; }
}
export function submitCommand(api, { project_id, version, command_id, action, payload, draft = { command_id } }, persist) {
    return submitMutation(api, `/projects/${encodeURIComponent(project_id)}/commands`, { action, version: draft.version ?? version, payload }, draft, persist);
}
