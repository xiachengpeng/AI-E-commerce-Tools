import type { CanvasPlugin } from '@/types/canvas-plugin';
import type { InstalledPlugin } from '@/stores/canvas/use-plugin-store';
const disabled=()=>new Error('此画布仅支持图片功能，插件不可用');
export function activatePlugin(_plugin: CanvasPlugin): void {throw disabled();}
export function deactivatePlugin(_id: string): void {}
export async function installPluginFromUrl(_url: string,_opts?: {official?:boolean;bustCache?:boolean}): Promise<CanvasPlugin> {throw disabled();}
export async function updatePlugin(_record: InstalledPlugin): Promise<CanvasPlugin> {throw disabled();}
export async function setPluginEnabled(_record: InstalledPlugin,_enabled: boolean): Promise<void> {throw disabled();}
export function uninstallPlugin(_id: string): void {}
export async function ensurePluginsLoaded(): Promise<void> {}
