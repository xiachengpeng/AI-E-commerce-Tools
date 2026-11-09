/** Migrate the previous built-in three-image default; node-specific counts are untouched. */
export function migrateCanvasDefaults(persisted,version) {
  const state=persisted && typeof persisted==='object' ? persisted : {};
  if(version>=1 || !state.config || state.config.canvasImageCount!=='3') return state;
  return {...state,config:{...state.config,canvasImageCount:'1'}};
}
