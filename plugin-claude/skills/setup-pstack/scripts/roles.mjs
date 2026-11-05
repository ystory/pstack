import { hash } from './state.mjs';

export const roles = {
  'feature, refactoring': 'scalar',
  'bug-fix': 'scalar',
  'perf-issue': 'scalar',
  hillclimb: 'scalar',
  'judgment and prose': 'scalar',
  'hardest tasks': 'scalar',
  'how explorer': 'scalar',
  'how explainer': 'scalar',
  'why investigators': 'scalar',
  'why synthesizer': 'scalar',
  'reflect tooling': 'scalar',
  'reflect judgment, divergent, synthesizer': 'scalar',
  'arena runners': 'panel',
  'arena cross-judge pool': 'pool',
  'swarm workers': 'scalar',
  'architect runners': 'panel',
  'interrogate reviewers': 'panel',
};
export const budgets = {
  unlimited: 'max',
  large: 'xhigh',
  medium: 'high',
  small: 'medium',
};
export const efforts = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];
export const aliases = new Set(['auto', 'inherit-parent']);
export const kinds = [
  'general-purpose',
  'poteto-agent',
  'comment-sicko',
  'read-only',
];
export const entriesFor = (value) => (Array.isArray(value) ? value : [value]);
export const modelFor = (entry) =>
  typeof entry === 'string' ? entry : entry.model;
export const agentType = (kind, model) => {
  if (!kinds.includes(kind)) throw new Error(`Unknown worker kind: ${kind}`);
  return aliases.has(model)
    ? `pstack-cc:${kind}`
    : `pstack-cc-${kind}-${hash(model).slice(0, 16)}`;
};
