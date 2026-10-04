import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { questions, categories, goalFor, getQuestion, initialQuestionIds, topicChoices } from '../src/interview/questions.mjs';
import { createInquiry, nextQuestion, eligibleQuestions, navigateInquiry, recordQuestion, validateQuestionChoice, applyEvidenceCoverage } from '../src/interview/planner.mjs';

test('300 full metadata questions and explicit canonical mappings are structurally consistent', () => {
  assert.equal(questions.length, 300);
  assert.equal(new Set(questions.map(q => q.id)).size, 300);
  assert.equal(Object.keys(categories).length, 22);
  const mapping = JSON.parse(readFileSync(new URL('../src/question-goals.json', import.meta.url)));
  for (const q of questions) {
    for (const key of ['revision','category','priority','priority_reason','decision_use','basic_wording','applicability','followups','sufficient_when','sensitivity','nonanswer_options','update_triggers','display','global_policy_ref']) assert.ok(q[key] !== undefined, `${q.id}: ${key}`);
    assert.ok(q.goal_id && q.topic_ids.length);
    assert.ok(mapping.goals[q.goal_id].question_ids.includes(q.id));
    assert.deepEqual(mapping.questions[q.id].topic_ids, q.topic_ids);
    assert.ok(q.topic_ids.every(id => mapping.topics[id]));
    assert.ok(q.nonanswer_options.includes('今は分からない'));
    assert.ok(q.nonanswer_options.includes('この話題は今後聞かない'));
    assert.ok(q.applicability.default.includes('属性'));
    assert.ok(['P0','P1','P2'].includes(q.priority));
    assert.ok(['S0','S1','S2','S3'].includes(q.sensitivity.baseline));
    assert.ok(q.category.id in categories);
    assert.ok(Array.isArray(q.followups) && q.followups.every(f=>typeof f.when==='string' && typeof f.wording==='string'));
    assert.ok(Array.isArray(q.update_triggers) && q.update_triggers.every(t=>typeof t==='string'));
    assert.ok(Array.isArray(q.purposes) && q.purposes.includes('self_reflection'));
  }
  for(const [id,category] of Object.entries(categories)) assert.equal(questions.filter(q=>q.category.id===id).length,category.count);
});

test('original 300 question metadata and wording match the supplied draft canonical digest', () => {
  const bank=JSON.parse(readFileSync(new URL('../src/questions.json',import.meta.url)));
  delete bank.implementation;
  for(const q of bank.questions) { delete q.goal_id; delete q.topic_ids; delete q.purposes; }
  assert.equal(createHash('sha256').update(JSON.stringify(bank)).digest('hex'),'dff3c385d4ec26af86cf41cacb76f13dda3555834f3cd79f13441664c00fd765');
});

test('18 initial candidates retain order and are reachable without mandating completion', () => {
  assert.equal(initialQuestionIds.length, 18);
  assert.equal(initialQuestionIds[0], 'HZ-SUP-001');
  assert.equal(initialQuestionIds[17], 'HZ-FUN-001');
  assert.deepEqual(initialQuestionIds,['HZ-SUP-001','HZ-SUP-002','HZ-SUP-003','HZ-SUP-007','HZ-GOA-001','HZ-NOW-001','HZ-VAL-001','HZ-VAL-002','HZ-AID-001','HZ-PRI-001','HZ-PRI-002','HZ-CHG-002','HZ-DEC-001','HZ-LEA-001','HZ-COM-001','HZ-REL-001','HZ-CRE-002','HZ-FUN-001']);
  assert.equal(nextQuestion({ inquiry: createInquiry() }).id, initialQuestionIds[0]);
  for (const id of initialQuestionIds) assert.equal(nextQuestion({ inquiry:createInquiry(), applicableIds:[id] }).id,id);
});

test('known goals suppress every alias; selection has no side effects', () => {
  const inquiry = createInquiry();
  const before = structuredClone(inquiry);
  assert.equal(goalFor('HZ-VAL-001'), goalFor('HZ-DEC-001'));
  const candidates = eligibleQuestions({inquiry, coveredGoals:[goalFor('HZ-VAL-001')]});
  assert.ok(!candidates.some(q => q.goal_id === goalFor('HZ-DEC-001')));
  assert.deepEqual(inquiry,before);
});

test('skip is not refusal or sufficient knowledge and excludes the canonical goal', () => {
  const state = navigateInquiry(createInquiry(), {action:'skip',questionId:'HZ-VAL-001'});
  assert.equal(state.goals[goalFor('HZ-VAL-001')].status,'deferred');
  assert.deepEqual(state.refusedTopics, []);
  assert.equal(nextQuestion({inquiry:state,applicableIds:['HZ-DEC-001']}),null);
});

test('refused disclosure topic blocks aliases across category IDs and scope changes', () => {
  const state = navigateInquiry(createInquiry(), {action:'refuse',questionId:'HZ-PRI-001'});
  for (const id of ['HZ-PRI-001','HZ-COM-005','HZ-VAL-006','HZ-ETH-011']) {
    assert.equal(validateQuestionChoice(state,{questionId:id,move:'next',scope:'new'}),false,id);
    assert.equal(nextQuestion({inquiry:state,applicableIds:[id]}),null,id);
  }
  assert.equal(navigateInquiry(state,{action:'topic',topic:'COM'}).refusedTopics.length,state.refusedTopics.length);
});

test('unknown and deferred never revive from time, topic switches, or model move labels', () => {
  for(const action of ['unknown','defer','not_applicable']) {
    const state = navigateInquiry(createInquiry(),{action,questionId:'HZ-VAL-001'});
    const moved = navigateInquiry(state,{action:'topic',topic:'DEC'});
    assert.equal(nextQuestion({inquiry:moved,applicableIds:['HZ-DEC-001'],now:'2099-01-01'}),null);
    assert.equal(validateQuestionChoice(moved,{questionId:'HZ-DEC-001',move:'reopen'}),false);
  }
});

test('same goal uses one shared budget despite ID, next label, unrelated question, and scope switches', () => {
  let state = recordQuestion(createInquiry(),'HZ-VAL-001');
  assert.equal(validateQuestionChoice(state,{questionId:'HZ-VAL-001',currentId:'HZ-VAL-001',move:'follow_up'}),false);
  state = navigateInquiry(state,{action:'partial',questionId:'HZ-VAL-001'});
  assert.equal(validateQuestionChoice(state,{questionId:'HZ-VAL-001',currentId:'HZ-VAL-001',move:'follow_up'}),true);
  state = recordQuestion(state,'HZ-DEC-001');
  state = recordQuestion(state,'HZ-LEA-001');
  assert.equal(state.goals[goalFor('HZ-VAL-001')].visits,2);
  for(const move of ['next','follow_up']) assert.equal(validateQuestionChoice(state,{questionId:'HZ-VAL-001',currentId:'HZ-LEA-001',move,scope:'different'}),false);
  assert.equal(nextQuestion({inquiry:state,applicableIds:['HZ-VAL-001','HZ-DEC-001']}),null);
});

test('explicit continue allows only a second followup and explicit resume is needed to reopen', () => {
  let state = recordQuestion(createInquiry(),'HZ-VAL-001');
  state = navigateInquiry(state,{action:'partial',questionId:'HZ-VAL-001'});
  state = recordQuestion(state,'HZ-DEC-001');
  state = navigateInquiry(state,{action:'continue',questionId:'HZ-VAL-001'});
  assert.equal(validateQuestionChoice(state,{questionId:'HZ-VAL-001',currentId:'HZ-DEC-001',move:'follow_up'}),true);
  state = recordQuestion(state,'HZ-VAL-001');
  state = navigateInquiry(state,{action:'continue',questionId:'HZ-VAL-001'});
  assert.equal(validateQuestionChoice(state,{questionId:'HZ-DEC-001',move:'next'}),false);
  state = navigateInquiry(state,{action:'refuse',questionId:'HZ-VAL-001'});
  assert.equal(validateQuestionChoice(state,{questionId:'HZ-DEC-001',move:'resume'}),false);
  state = navigateInquiry(state,{action:'resume',questionId:'HZ-VAL-001'});
  assert.equal(nextQuestion({inquiry:state,applicableIds:['HZ-DEC-001']}).id,'HZ-DEC-001');
});

test('no automatic reask of delivered question, stop halts, and purpose gates exclude unrelated questions', () => {
  const state = recordQuestion(createInquiry(),'HZ-SUP-001');
  assert.equal(nextQuestion({inquiry:state,applicableIds:['HZ-SUP-001']}),null);
  assert.equal(nextQuestion({inquiry:navigateInquiry(state,{action:'stop'})}),null);
  assert.equal(nextQuestion({inquiry:createInquiry(),purpose:'draft_reply',applicableIds:['HZ-LEA-001']}),null);
  assert.equal(nextQuestion({inquiry:createInquiry(),purpose:'learn',applicableIds:['HZ-LEA-001']}).id,'HZ-LEA-001');
  assert.equal(nextQuestion({inquiry:createInquiry(),purpose:'invalid'}),null);
  assert.equal(nextQuestion({inquiry:createInquiry(),topic:'invalid'}),null);
  assert.ok(topicChoices.some(t=>t.id==='free'));
  assert.equal(getQuestion('invalid'),null);
  assert.equal(validateQuestionChoice(createInquiry(),{questionId:'HZ-MON-012',move:'next'}),false);
});

test('session resume does not implicitly reopen current refused goal', () => {
  let state = recordQuestion(createInquiry(),'HZ-PRI-001');
  state = navigateInquiry(state,{action:'refuse'});
  state = navigateInquiry(state,{action:'stop'});
  const resumed = navigateInquiry(state,{action:'resume'});
  assert.equal(resumed.paused,false);
  assert.deepEqual(resumed.refusedTopics,state.refusedTopics);
  assert.equal(nextQuestion({inquiry:resumed,applicableIds:['HZ-COM-005']}),null);
  assert.throws(()=>recordQuestion(resumed,'HZ-COM-005'),/question_unavailable/);
});

test('every canonical alias shares refusal and exhausted budgets', () => {
  const registry = JSON.parse(readFileSync(new URL('../src/question-goals.json', import.meta.url)));
  for (const group of Object.values(registry.goals)) {
    const [first] = group.question_ids;
    const refused = navigateInquiry(createInquiry(),{action:'refuse',questionId:first});
    let exhausted = recordQuestion(createInquiry(),first);
    exhausted = navigateInquiry(exhausted,{action:'partial',questionId:first});
    exhausted = recordQuestion(exhausted,first);
    for(const id of group.question_ids) {
      assert.equal(validateQuestionChoice(refused,{questionId:id,move:'follow_up'}),false,id);
      assert.equal(validateQuestionChoice(exhausted,{questionId:id,move:'next'}),false,id);
    }
  }
});

test('question text and registry cannot be mutated by a consumer', () => {
  assert.throws(()=>{ questions[0].topic_ids.push('fake'); },TypeError);
  assert.throws(()=>{ getQuestion('HZ-SUP-001').basic_wording='replacement'; },TypeError);
  assert.throws(()=>navigateInquiry(createInquiry(),{action:'reopen',questionId:'HZ-SUP-001'}),/invalid_inquiry_action/);
});

const coverageSource = {id:'synthetic-source',revision:2,text:'今週は追加の予定を入れない。',speaker:'self'};
const coverageUpdate = (questionId='HZ-NOW-002',state='partial') => ({questionId,state,evidence:{sourceId:coverageSource.id,revision:2,start:0,end:coverageSource.text.length,quote:coverageSource.text}});

test('plan purpose admits relevant planning questions and excludes unrelated learning or aesthetic collection', () => {
  for(const id of ['HZ-NOW-002','HZ-LIF-002','HZ-WOR-002','HZ-MON-001']) {
    assert.equal(nextQuestion({inquiry:createInquiry(),purpose:'plan',applicableIds:[id]}).id,id);
  }
  assert.equal(nextQuestion({inquiry:createInquiry(),purpose:'plan',applicableIds:['HZ-LEA-006','HZ-AES-004']}),null);
});

test('exact current-source evidence allows narrow coverage updates without knowledge confirmation', () => {
  const original=recordQuestion(createInquiry(),'HZ-NOW-002');
  const updated=applyEvidenceCoverage(original,[coverageUpdate()],coverageSource);
  assert.equal(original.goals[goalFor('HZ-NOW-002')].status,'awaiting');
  assert.equal(updated.goals[goalFor('HZ-NOW-002')].status,'partial');
  assert.equal(updated.goals[goalFor('HZ-NOW-002')].visits,1);
  assert.deepEqual(updated.goals[goalFor('HZ-NOW-002')].evidence,coverageUpdate().evidence);
  const sufficient=applyEvidenceCoverage(updated,[coverageUpdate('HZ-NOW-002','sufficient')],coverageSource);
  assert.equal(sufficient.goals[goalFor('HZ-NOW-002')].status,'sufficient_for_scope');
  assert.equal(nextQuestion({inquiry:sufficient,applicableIds:['HZ-REL-003']}),null);
  assert.equal(sufficient.knowledge,undefined);
});

test('coverage validation rejects wrong source, revision, span, quote, speaker and arbitrary actions atomically', () => {
  const inquiry=createInquiry();
  for(const evidence of [{sourceId:'other'},{revision:1},{start:-1},{end:9999},{start:0.5},{start:2,end:1},{quote:'違う引用'},{quote:''}]) {
    const bad=coverageUpdate();Object.assign(bad.evidence,evidence);
    assert.throws(()=>applyEvidenceCoverage(inquiry,[coverageUpdate(),bad],coverageSource),/invalid_inquiry_evidence/);
  }
  for(const state of ['resume','refuse','accepted','continue']) assert.throws(()=>applyEvidenceCoverage(inquiry,[coverageUpdate('HZ-NOW-002',state)],coverageSource),/invalid_inquiry_update/);
  assert.throws(()=>applyEvidenceCoverage(inquiry,[{...coverageUpdate(),reopen:true}],coverageSource),/invalid_inquiry_update/);
  assert.throws(()=>applyEvidenceCoverage(inquiry,[coverageUpdate()],{...coverageSource,speaker:'unknown'}),/invalid_inquiry_source/);
  assert.deepEqual(inquiry,createInquiry());
});

test('evidence updates never reopen unknown, deferred, refused, exhausted or stopped inquiry', () => {
  for(const action of ['unknown','defer','not_applicable','refuse']) {
    const original=navigateInquiry(createInquiry(),{action,questionId:'HZ-NOW-002'});
    const updated=applyEvidenceCoverage(original,[coverageUpdate()],coverageSource);
    assert.deepEqual(updated,original,action);
  }
  let exhausted=recordQuestion(createInquiry(),'HZ-NOW-002');
  exhausted=navigateInquiry(exhausted,{action:'partial',questionId:'HZ-NOW-002'});
  exhausted=recordQuestion(exhausted,'HZ-NOW-002');
  assert.deepEqual(applyEvidenceCoverage(exhausted,[coverageUpdate()],coverageSource),exhausted);
  const stopped=navigateInquiry(createInquiry(),{action:'stop'});
  assert.deepEqual(applyEvidenceCoverage(stopped,[coverageUpdate()],coverageSource),stopped);
});
