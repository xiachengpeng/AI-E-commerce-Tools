/** Each workbench owns a fresh state; pages receive it explicitly. */
export function createState() {
    return { projects: [], project: null, product: null, view: 'projects', busy: false, error: '', revision: 0, actions: [], keywordActions: {}, drafts: {}, commands: {}, form: null, explorationKeyword: null, focusIndices: {}, queueSelection: null, writeBusy: false };
}
