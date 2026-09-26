/**
 * Sequence definitions and placeholder resolution (B1). Shared by the server (preflight and
 * sending) and the console (preflight preview), so both always agree.
 */

export type SequenceRole = 'admin' | 'member';

export interface SequenceStepDef {
  index: number;
  accountRole: SequenceRole;
  text: string;
  delaySeconds: number;
}

export interface SequenceDef {
  name: string;
  steps: SequenceStepDef[];
}

/** `default` = from vars; `step:<n>` = first given (or last changed) by stepVars of step n. */
export type VarSource = 'default' | `step:${number}`;

export interface ResolvedStep {
  index: number;
  text: string;
  resolvedVars: Record<string, string>;
  varSources: Record<string, VarSource>;
}

export type ResolveResult =
  | { ok: true; steps: ResolvedStep[] }
  | { ok: false; stepIndex: number; key: string };

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

/** Placeholder keys in order of first appearance. */
export function placeholders(text: string): string[] {
  const keys: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) if (!keys.includes(m[1]!)) keys.push(m[1]!);
  return keys;
}

/**
 * Value rules: the starting values are `vars` (an empty string counts as not provided). A step that
 * gives a non-empty value in `stepVars` changes it from that step on, until a later step gives
 * another; an empty string in `stepVars` means "no change". Every `{key}` of every step must
 * resolve, otherwise the first unresolved one (in step order, then text order) is reported.
 */
export function resolveSequence(
  steps: SequenceStepDef[],
  vars: Record<string, string> = {},
  stepVars: Record<string, Record<string, string>> = {},
): ResolveResult {
  const current = new Map<string, { value: string; source: VarSource }>();
  for (const [k, v] of Object.entries(vars)) if (typeof v === 'string' && v !== '') current.set(k, { value: v, source: 'default' });

  const resolved: ResolvedStep[] = [];
  for (const step of [...steps].sort((a, b) => a.index - b.index)) {
    for (const [k, v] of Object.entries(stepVars[String(step.index)] ?? {})) {
      if (typeof v === 'string' && v !== '') current.set(k, { value: v, source: `step:${step.index}` });
    }
    const resolvedVars: Record<string, string> = {};
    const varSources: Record<string, VarSource> = {};
    for (const key of placeholders(step.text)) {
      const c = current.get(key);
      if (!c) return { ok: false, stepIndex: step.index, key };
      resolvedVars[key] = c.value;
      varSources[key] = c.source;
    }
    const text = step.text.replace(PLACEHOLDER, (_m, key: string) => current.get(key)!.value);
    resolved.push({ index: step.index, text, resolvedVars, varSources });
  }
  return { ok: true, steps: resolved };
}

/** Returns a list of problems; empty when the definition is valid. */
export function validateSequence(def: unknown): string[] {
  const errors: string[] = [];
  const d = def as Partial<SequenceDef> | null;
  if (!d || typeof d !== 'object') return ['sequence must be an object'];
  if (typeof d.name !== 'string' || d.name.trim() === '') errors.push('name is required');
  if (!Array.isArray(d.steps) || d.steps.length === 0) return [...errors, 'steps must be a non-empty array'];
  d.steps.forEach((s, i) => {
    const at = `steps[${i}]`;
    if (!s || typeof s !== 'object') return errors.push(`${at} must be an object`);
    if (s.index !== i + 1) errors.push(`${at}.index must be ${i + 1} (1-based, in order)`);
    if (s.accountRole !== 'admin' && s.accountRole !== 'member') errors.push(`${at}.accountRole must be "admin" or "member"`);
    if (typeof s.text !== 'string' || s.text.trim() === '') errors.push(`${at}.text is required`);
    if (typeof s.delaySeconds !== 'number' || !Number.isFinite(s.delaySeconds) || s.delaySeconds < 0) {
      errors.push(`${at}.delaySeconds must be a number >= 0`);
    }
  });
  return errors;
}
