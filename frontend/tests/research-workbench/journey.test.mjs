import test from 'node:test';
import assert from 'node:assert/strict';
import { journeyGroups, stepStatusLabel, productTasks, decisionSummary, evidenceTasks } from '../../js/research-workbench/services/journey.mjs';

test('four user task groups preserve every existing business stage exactly once',()=>{
 assert.equal(journeyGroups.length,4);
 assert.deepEqual(journeyGroups.flatMap(g=>g.steps),['identification','coarse','expansion','channels','funnel','economics','score','decision','test','review']);
});
test('recording a decision or review never claims that a product passed screening',()=>{
 assert.equal(stepStatusLabel({key:'decision',state:'passed'}),'已记录决定');
 assert.equal(stepStatusLabel({key:'review',state:'passed'}),'已保存复盘');
 assert.equal(stepStatusLabel({key:'identification',state:'passed'},{identification:{confirmation_method:'ai'}}),'AI 已匹配');
 assert.equal(stepStatusLabel({key:'coarse',state:'passed'}),'已通过');
});
test('actionable gaps come from actual unresolved stages, never invented counts',()=>{
 const tasks=productTasks({steps:[{key:'coarse',state:'needs_input',reason:'需核实三个独立创意'},{key:'channels',state:'passed'},{key:'review',state:'pending'}]});
 assert.deepEqual(tasks.map(t=>t.key),['coarse']);assert.match(tasks[0].reason,/三个独立创意/);
 assert.deepEqual(productTasks({requirement_summary:{required_gaps:7}}),[]);
});
test('missing, observed and stale decisions retain their distinct business meanings',()=>{
 assert.equal(decisionSummary({}).label,'尚未作出决定');
 assert.equal(decisionSummary({decision:{pool:'observe',reason:'缺真实报价'}}).label,'观察');
 assert.match(decisionSummary({decision:{pool:'test',stale:true}}).label,/需重新核对/);
 assert.match(decisionSummary({decision:{pool:'test'}}).note,/不代表已批准投放/);
 assert.equal(decisionSummary({decision:{pool:'unrecognized'}}).label,'去向待核对');
});
test('evidence tasks honor server blocking levels, exemptions and source reasons',()=>{
 const rows=evidenceTasks({requirement_statuses:[
  {key:'trends_12m',label:'近12个月趋势',status:'unknown',status_reason:'没有同一市场的趋势',blocks_scoring:true,applies:true},
  {key:'pinterest',label:'Pinterest',status:'unknown',blocks_scoring:false,applies:true,level:'recommended'},
  {key:'amazon',status:'pass',blocks_scoring:false,applies:true},
  {key:'certification_verification',status:'not_applicable',blocks_scoring:false,applies:false},
 ]});
 assert.equal(rows.length,2);assert.equal(rows[0].step,'channels');assert.equal(rows[0].blocking,true);assert.match(rows[0].reason,/同一市场/);assert.equal(rows[1].blocking,false);
 assert.deepEqual(evidenceTasks({}),[]);
});
test('decision summary flags server-invalid backup decisions even if the stored stale flag is false',()=>{
 const d=decisionSummary({decision:{pool:'backup',stale:false},steps:[{key:'decision',state:'needs_input'}]});
 assert.equal(d.stale,true);assert.match(d.label,/需重新核对/);
});
