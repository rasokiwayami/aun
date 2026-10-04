import bank from '../questions.json' with { type: 'json' };
import mapping from '../question-goals.json' with { type: 'json' };

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export const questions = freeze(bank.questions);
export const categories = freeze(bank.categories);
export const questionGoals = freeze(mapping);
export const purposes = Object.freeze(['self_reflection', 'conversation', 'draft_reply', 'compare', 'learn', 'create', 'plan']);
export const initialQuestionIds = Object.freeze([
  'HZ-SUP-001','HZ-SUP-002','HZ-SUP-003','HZ-SUP-007','HZ-GOA-001','HZ-NOW-001',
  'HZ-VAL-001','HZ-VAL-002','HZ-AID-001','HZ-PRI-001','HZ-PRI-002','HZ-CHG-002',
  'HZ-DEC-001','HZ-LEA-001','HZ-COM-001','HZ-REL-001','HZ-CRE-002','HZ-FUN-001',
]);
export const topicChoices = freeze([
  { id: 'free', label: '自由に話す' },
  ...Object.entries(categories).map(([id, category]) => ({ id, label: category.name })),
]);
const byId = new Map(questions.map(q => [q.id, q]));
export const getQuestion = id => byId.get(id) ?? null;
export const goalFor = id => getQuestion(id)?.goal_id ?? null;

// Fail closed on a partial bank or drift between the explicit registry and runtime bank.
if (questions.length !== 300 || byId.size !== 300) throw new Error('Invalid question-bank size');
for (const question of questions) {
  const rule = mapping.questions[question.id];
  if (!rule || rule.goal_id !== question.goal_id ||
      JSON.stringify(rule.topic_ids) !== JSON.stringify(question.topic_ids) ||
      JSON.stringify(rule.purposes) !== JSON.stringify(question.purposes) ||
      !mapping.goals[rule.goal_id]?.question_ids.includes(question.id) ||
      rule.topic_ids.some(id => !Object.hasOwn(mapping.topics, id))) {
    throw new Error(`Invalid question mapping: ${question.id}`);
  }
}
