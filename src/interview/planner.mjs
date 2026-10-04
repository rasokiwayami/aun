import { questions, getQuestion, goalFor, initialQuestionIds, questionGoals, purposes } from './questions.mjs';

const closed = new Set(['unknown','deferred','not_applicable','refused_item','refused_topic','sufficient_for_scope','covered_by_existing']);
const moves = new Set(['next','follow_up']);
const priority = { P0: 0, P1: 1, P2: 2 };
const initialRank = new Map(initialQuestionIds.map((id, index) => [id,index]));
const knownTopic = topic => topic === 'free' || Object.hasOwn(questionGoals.topics, topic);
const defaultGoal = () => ({ status: 'unasked', visits: 0, limit: 2 });

export function createInquiry() {
  return { version: 1, goals: {}, seenIds: [], refusedTopics: [], topic: 'free', paused: false, currentId: null };
}

function stateOf(inquiry, question) {
  return inquiry.goals?.[question.goal_id] ?? defaultGoal();
}

function allowed(inquiry, question) {
  if (!question || inquiry.paused) return false;
  if (question.topic_ids.some(id => inquiry.refusedTopics?.includes(id))) return false;
  const state = stateOf(inquiry, question);
  // Limits are bounded even when callers load older or malformed persisted state.
  const limit = state.limit === 3 ? 3 : 2;
  if (!Number.isSafeInteger(state.visits) || state.visits < 0 || state.visits >= limit) return false;
  if (closed.has(state.status)) return false;
  return state.visits === 0 || state.status === 'partial';
}

/** Pure selection. applicableIds, when supplied, are the caller's purpose-specific hard gate.
 * coveredGoals must come from evidence applicable to the current purpose/scope, never from
 * bare model labels. This function does not persist coverage as confirmed knowledge.
 */
export function eligibleQuestions({ inquiry = createInquiry(), topic = inquiry.topic ?? 'free', purpose = 'self_reflection', coveredGoals = [], currentId, excludeIds = [], applicableIds } = {}) {
  if (!knownTopic(topic) || !purposes.includes(purpose)) return [];
  const covered = new Set(coveredGoals);
  const excluded = new Set(excludeIds);
  const applicable = applicableIds === undefined ? null : new Set(applicableIds);
  return questions.filter(question => {
    if (!allowed(inquiry, question) || covered.has(question.goal_id) || excluded.has(question.id)) return false;
    if (question.id === currentId || inquiry.seenIds?.includes(question.id)) return false;
    if (topic !== 'free' && !question.topic_ids.includes(topic)) return false;
    if (!question.purposes.includes(purpose)) return false;
    if (applicable && !applicable.has(question.id)) return false;
    // Free conversation has a bounded entry set, not a 300-question completion loop.
    if (topic === 'free' && !applicable && !initialRank.has(question.id)) return false;
    return true;
  }).sort((a,b) => {
    const aInitial = initialRank.get(a.id) ?? 999;
    const bInitial = initialRank.get(b.id) ?? 999;
    return aInitial - bInitial || priority[a.priority] - priority[b.priority] || a.id.localeCompare(b.id, 'en');
  });
}

export const nextQuestion = options => eligibleQuestions(options)[0] ?? null;

/** Validate provider-selected IDs; navigation/reopening is deliberately not a model move. */
export function validateQuestionChoice(inquiry, { questionId, currentId, move = 'next', topic = inquiry.topic ?? 'free', purpose = 'self_reflection', coveredGoals = [], applicableIds } = {}) {
  const question = getQuestion(questionId);
  if (!moves.has(move) || !knownTopic(topic) || !purposes.includes(purpose) || !allowed(inquiry, question)) return false;
  if (topic !== 'free' && !question.topic_ids.includes(topic)) return false;
  if (!question.purposes.includes(purpose) || coveredGoals.includes(question.goal_id)) return false;
  if (applicableIds && !applicableIds.includes(questionId)) return false;
  if (topic === 'free' && !applicableIds && !initialRank.has(questionId) && move !== 'follow_up') return false;
  if (move === 'follow_up') return stateOf(inquiry, question).status === 'partial';
  return questionId !== currentId && !inquiry.seenIds?.includes(questionId);
}

/** Count once per committed delivery; caller operation IDs handle transport retries. */
export function recordQuestion(inquiry, questionId) {
  const question = getQuestion(questionId);
  if (!allowed(inquiry, question)) throw new Error('question_unavailable');
  const next = structuredClone(inquiry);
  const state = { ...defaultGoal(), ...stateOf(inquiry, question) };
  state.visits += 1;
  state.status = state.visits >= state.limit ? 'exhausted' : 'awaiting';
  next.goals[question.goal_id] = state;
  next.seenIds = [...new Set([...(next.seenIds ?? []), questionId])];
  next.currentId = questionId;
  return next;
}

function coverageError(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

/** Apply only evidence-bound provider coverage, never raw navigation or permissions.
 * `source` must be the current canonical raw source fetched by the caller in its commit
 * transaction, not a provider-supplied source. Exact spans establish provenance, not
 * semantic truth. The caller still rejects stale generations and invalidates evidence
 * when its source is corrected/deleted. Updates are atomic and bounded to bank size.
 */
export function applyEvidenceCoverage(inquiry, updates, source) {
  if (!source || typeof source.id !== 'string' || !source.id ||
      !Number.isSafeInteger(source.revision) || source.revision < 1 ||
      typeof source.text !== 'string' || source.speaker !== 'self') coverageError('invalid_inquiry_source');
  if (!Array.isArray(updates) || updates.length > questions.length) coverageError('invalid_inquiry_update');
  const permitted = new Set(['partial','sufficient','unknown']);
  for (const update of updates) {
    if (!update || typeof update !== 'object' || Array.isArray(update) ||
        Object.keys(update).some(k => !['questionId','state','evidence'].includes(k)) ||
        !getQuestion(update.questionId) || !permitted.has(update.state)) coverageError('invalid_inquiry_update');
    const evidence = update.evidence;
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) ||
        Object.keys(evidence).some(k => !['sourceId','revision','start','end','quote'].includes(k)) ||
        evidence.sourceId !== source.id || evidence.revision !== source.revision ||
        !Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end) ||
        evidence.start < 0 || evidence.end <= evidence.start || evidence.end > source.text.length ||
        typeof evidence.quote !== 'string' || !evidence.quote.trim() ||
        source.text.slice(evidence.start,evidence.end) !== evidence.quote) coverageError('invalid_inquiry_evidence');
  }
  const next = structuredClone(inquiry);
  if (next.paused) return next;
  for (const update of updates) {
    const question = getQuestion(update.questionId);
    const state = { ...defaultGoal(), ...stateOf(next,question) };
    if (closed.has(state.status) || state.status === 'exhausted' ||
        question.topic_ids.some(id => next.refusedTopics?.includes(id))) continue;
    const limit = state.limit === 3 ? 3 : 2;
    if (!Number.isSafeInteger(state.visits) || state.visits < 0 || state.visits >= limit) continue;
    state.status = {partial:'partial',sufficient:'sufficient_for_scope',unknown:'unknown'}[update.state];
    state.evidence = structuredClone(update.evidence);
    next.goals[question.goal_id] = state;
  }
  return next;
}

/** Trusted explicit user navigation only. Never pass raw provider output here. */
export function navigateInquiry(inquiry, { action, questionId, topic } = {}) {
  const next = structuredClone(inquiry);
  const question = getQuestion(questionId ?? (action === 'resume' ? null : inquiry.currentId));
  if (action === 'stop') { next.paused = true; return next; }
  if (action === 'topic') {
    if (!knownTopic(topic)) throw new Error('invalid_topic');
    next.topic = topic;
    return next; // Topic change is not an implicit resume or refusal reset.
  }
  if (action === 'resume') {
    if (topic !== undefined && !knownTopic(topic)) throw new Error('invalid_topic');
    // Resuming the session alone does not clear any goal or topic suppression.
    next.paused = false;
    const targets = topic && topic !== 'free'
      ? questions.filter(q => q.topic_ids.includes(topic))
      : question ? [question] : [];
    const goals = new Set(targets.map(q => q.goal_id));
    for (const id of goals) next.goals[id] = defaultGoal();
    next.seenIds = (next.seenIds ?? []).filter(id => !goals.has(goalFor(id)));
    const reopenedTopics = topic && topic !== 'free' ? [topic] : question?.topic_ids ?? [];
    next.refusedTopics = (next.refusedTopics ?? []).filter(id => !reopenedTopics.includes(id));
    return next;
  }
  if (action === 'refuse' && !question && topic && knownTopic(topic) && topic !== 'free') {
    next.refusedTopics = [...new Set([...(next.refusedTopics ?? []),topic])];
    return next;
  }
  if (!question) throw new Error('invalid_question');
  const state = { ...defaultGoal(), ...stateOf(inquiry,question) };
  if (action === 'refuse') {
    state.status = 'refused_topic';
    next.refusedTopics = [...new Set([...(next.refusedTopics ?? []),...question.topic_ids])];
  } else if (action === 'continue') {
    // This opt-in only extends pursuit of an unresolved goal; it cannot reopen a refusal.
    if (!closed.has(state.status) && !question.topic_ids.some(id => next.refusedTopics.includes(id))) {
      state.limit = 3;
      state.status = state.visits < 3 ? 'partial' : 'exhausted';
    }
  } else {
    const states = { skip:'deferred', defer:'deferred', unknown:'unknown', not_applicable:'not_applicable', partial:'partial', sufficient:'sufficient_for_scope', covered:'covered_by_existing' };
    if (!Object.hasOwn(states,action)) throw new Error('invalid_inquiry_action');
    // Responses and model-supported partial/coverage updates never reopen a closed goal.
    if (!closed.has(state.status)) state.status = action === 'partial' && state.visits >= state.limit ? 'exhausted' : states[action];
  }
  next.goals[question.goal_id] = state;
  return next;
}
