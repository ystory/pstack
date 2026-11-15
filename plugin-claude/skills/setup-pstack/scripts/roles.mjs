import { hash } from './state.mjs';

export const roles = {
  'feature, refactoring': { kind: 'scalar', effort: 'xhigh' },
  'bug-fix': { kind: 'scalar', effort: 'xhigh' },
  'perf-issue': { kind: 'scalar', effort: 'xhigh' },
  hillclimb: { kind: 'scalar', effort: 'xhigh' },
  'judgment and prose': { kind: 'scalar', effort: 'xhigh' },
  'hardest tasks': { kind: 'scalar', effort: 'max' },
  'reflect tooling': { kind: 'scalar', effort: 'high' },
  'reflect judgment, divergent, synthesizer': {
    kind: 'scalar',
    effort: 'xhigh',
  },
  'arena runners': { kind: 'panel', effort: 'high' },
  'arena cross-judge pool': { kind: 'pool', effort: 'high' },
  'swarm workers': { kind: 'scalar', effort: 'high' },
  'architect runners': { kind: 'panel', effort: 'high' },
  'interrogate reviewers': { kind: 'panel', effort: 'high' },
};
export const retiredRoles = new Set([
  'how explorer',
  'how explainer',
  'why investigators',
  'why synthesizer',
]);
export const seats = { scalar: 1, panel: 3, pool: 3 };
const budgetLadder = ['low', 'medium', 'high', 'xhigh', 'max'];
export const budgets = { unlimited: 1, large: 0, medium: -1, small: -2 };
const shifted = (effort, budget) =>
  budgetLadder[
    Math.min(
      budgetLadder.length - 1,
      Math.max(0, budgetLadder.indexOf(effort) + budgets[budget]),
    )
  ];
export const targetEffort = (role, budget) =>
  shifted(roles[role].effort, budget);
// A budget label names the effort an `xhigh` role lands on.
export const namedEffort = (budget) => shifted('xhigh', budget);
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
