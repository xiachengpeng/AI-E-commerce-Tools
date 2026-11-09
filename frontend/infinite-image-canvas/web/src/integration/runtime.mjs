import {createNodeCanvasTransport} from './local-api.mjs';
import {createNodeProjectRepository} from './project-repository.mjs';
import {createCanvasPersistence} from './canvas-persistence.mjs';
export const localApi=createNodeCanvasTransport('http://127.0.0.1:9503');
export const projectRepository=createNodeProjectRepository(localApi);
export const canvasPersistence=createCanvasPersistence(projectRepository);
