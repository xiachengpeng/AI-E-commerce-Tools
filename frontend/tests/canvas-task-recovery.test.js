const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const moduleUrl = pathToFileURL(path.join(__dirname, '../infinite-image-canvas/web/src/integration/task-recovery.mjs')).href;

test('task history offers a retry after an uncertain task is reviewed or a task definitively failed', async () => {
    const { taskRecoveryAction } = await import(moduleUrl);
    const represented = new Set();
    assert.equal(taskRecoveryAction({status:'unknown',reviewed:false}, represented), 'review');
    assert.equal(taskRecoveryAction({status:'unknown',reviewed:true}, represented), 'retry');
    assert.equal(taskRecoveryAction({status:'failed',reviewed:false}, represented), 'retry');
});

test('node generation adapter reports the saved task failure reason', async () => {
    const { createNodeGenerationAdapter } = await import(pathToFileURL(path.join(__dirname, '../infinite-image-canvas/web/src/integration/node-generation-adapter.mjs')).href);
    const adapter = createNodeGenerationAdapter({api:{submit:async()=>({status:'failed',error_message:'服务商拒绝了请求：认证失败。'})},repository:{},confirm:async()=>true});
    await assert.rejects(adapter.execute({projectId:'p',requests:[{operation_key:'op'}]},0), /认证失败/);
});

test('text generation adapter reports the saved task failure reason', async () => {
    const { createNodeTextAdapter } = await import(pathToFileURL(path.join(__dirname, '../infinite-image-canvas/web/src/integration/node-text-adapter.mjs')).href);
    const adapter = createNodeTextAdapter({api:{submitText:async()=>({status:'unknown',error_message:'服务商响应超时，请核对服务商任务记录。'})},repository:{},confirm:async()=>true});
    await assert.rejects(adapter.execute({projectId:'p',requests:[{operation_key:'op'}]},0), /响应超时/);
});
