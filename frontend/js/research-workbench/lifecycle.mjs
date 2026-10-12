/** Resource scope used by every native page. No timers survive a tab switch. */
export function createLifecycle() {
    const controller = new AbortController();
    const cleanup = new Set();
    let active = true;
    const track = dispose => {
        if (!active) dispose(); else cleanup.add(dispose);
        return () => { if (cleanup.delete(dispose)) dispose(); };
    };
    return {
        get active() { return active; },
        signal: controller.signal,
        track,
        listen(target, type, callback, options) {
            target.addEventListener(type, callback, options);
            return track(() => target.removeEventListener(type, callback, options));
        },
        poll(callback, milliseconds) {
            if (!active) return () => {};
            const timer = setInterval(() => { if (active) callback(); }, milliseconds);
            return track(() => clearInterval(timer));
        },
        stream(stream) { return track(() => stream.close()); },
        dispose() {
            if (!active) return;
            active = false;
            controller.abort();
            for (const dispose of cleanup) { try { dispose(); } catch (_) { /* Continue releasing other resources. */ } }
            cleanup.clear();
        }
    };
}
