/** Unsupported legacy calls fail closed; image generation uses reserved tasks. */
import type { AiConfig } from '@/stores/use-config-store';
import type { ReferenceImage } from '@/types/image';
import type { AiTextMessage } from '@/services/api/image';
type Options={signal?: AbortSignal};
export async function requestGeneration(_config: AiConfig,_prompt: string,_options?: Options): Promise<Array<{dataUrl:string}>> {throw new Error('请从图片节点发起生成');}
export async function requestEdit(_config: AiConfig,_prompt: string,_references: ReferenceImage[],_options?: Options): Promise<Array<{dataUrl:string}>> {throw new Error('请从图片节点发起编辑');}
export async function requestImageQuestion(_config: AiConfig,_messages: AiTextMessage[],_onDelta: (text:string)=>void,_options?: Options): Promise<string> {throw new Error('此画布仅支持图片功能');}
