/** Provider access belongs to the application backend. */
import type { AiConfig, ModelChannel } from '@/stores/use-config-store';
import type { ReferenceImage } from '@/types/image';
export type AiTextMessage={role:'system'|'user'|'assistant';content:string|Array<{type:'text';text:string}|{type:'image_url';image_url:{url:string}}>};
type Options={signal?:AbortSignal};
const disabled=()=>new Error('请通过画布图片节点和系统设置使用图片服务');
export async function requestGeneration(_config:AiConfig,_prompt:string,_options?:Options):Promise<Array<{id:string;dataUrl:string}>>{throw disabled();}
export async function requestEdit(_config:AiConfig,_prompt:string,_references:ReferenceImage[],_options?:Options):Promise<Array<{id:string;dataUrl:string}>>{throw disabled();}
export async function requestImageQuestion(_config:AiConfig,_messages:AiTextMessage[],_onDelta:(text:string)=>void,_options?:Options):Promise<string>{throw disabled();}
export async function fetchImageModels(_config:Pick<AiConfig,'baseUrl'|'apiKey'|'apiFormat'>):Promise<string[]>{throw disabled();}
export async function fetchChannelModels(_channel:ModelChannel):Promise<string[]>{throw disabled();}
