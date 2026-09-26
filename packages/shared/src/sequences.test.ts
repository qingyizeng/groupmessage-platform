import { describe, expect, it } from 'vitest';
import { placeholders, resolveSequence, validateSequence, type SequenceStepDef } from './sequences';

const steps: SequenceStepDef[] = [
  { index: 1, accountRole: 'admin', text: '{event} 将于 {time} 开始，请提前准备', delaySeconds: 10 },
  { index: 2, accountRole: 'member', text: '提醒：{event} 的资料已上传到 {location}', delaySeconds: 5 },
  { index: 3, accountRole: 'member', text: '{event} 地点：{location}', delaySeconds: 5 },
];

describe('resolveSequence', () => {
  it('uses vars, lets a step change a value from that step on, and reports sources', () => {
    const r = resolveSequence(steps, { event: '周会', time: '10:00', location: '共享盘' }, { '2': { location: '共享盘/第二季度' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.steps[0]).toEqual({
      index: 1,
      text: '周会 将于 10:00 开始，请提前准备',
      resolvedVars: { event: '周会', time: '10:00' },
      varSources: { event: 'default', time: 'default' },
    });
    expect(r.steps[1]!.text).toBe('提醒：周会 的资料已上传到 共享盘/第二季度');
    expect(r.steps[1]!.varSources).toEqual({ event: 'default', location: 'step:2' });
    // Carried forward: the source is the step that first gave the current value.
    expect(r.steps[2]!.varSources).toEqual({ event: 'default', location: 'step:2' });
    expect(r.steps[2]!.resolvedVars.location).toBe('共享盘/第二季度');
  });

  it('empty string in vars counts as missing; in stepVars it means "no change"', () => {
    expect(resolveSequence(steps, { event: 'x', time: '' }, {})).toEqual({ ok: false, stepIndex: 1, key: 'time' });
    const r = resolveSequence(steps, { event: 'x', time: 't', location: 'a' }, { '2': { location: '' }, '3': { location: 'b' } });
    expect(r.ok && r.steps.map((s) => s.resolvedVars.location)).toEqual([undefined, 'a', 'b']);
    expect(r.ok && r.steps[2]!.varSources.location).toBe('step:3');
  });

  it('a value introduced by a later step does not help earlier steps', () => {
    expect(resolveSequence(steps, { event: 'x', time: 't' }, { '3': { location: 'late' } })).toEqual({
      ok: false,
      stepIndex: 2,
      key: 'location',
    });
  });

  it('reports the first unresolved placeholder of step 3', () => {
    const s: SequenceStepDef[] = [
      { index: 1, accountRole: 'admin', text: 'a', delaySeconds: 0 },
      { index: 2, accountRole: 'admin', text: '{x}', delaySeconds: 0 },
      { index: 3, accountRole: 'admin', text: '{x} {missing_key} {other}', delaySeconds: 0 },
    ];
    expect(resolveSequence(s, { x: '1' })).toEqual({ ok: false, stepIndex: 3, key: 'missing_key' });
  });

  it('only [A-Za-z0-9_]+ inside braces is a placeholder', () => {
    expect(placeholders('{a} {b_2} {no-dash} {} {c}{a}')).toEqual(['a', 'b_2', 'c']);
    const r = resolveSequence([{ index: 1, accountRole: 'admin', text: '{a} {no-dash} {}', delaySeconds: 0 }], { a: 'A' });
    expect(r.ok && r.steps[0]!.text).toBe('A {no-dash} {}');
  });
});

describe('validateSequence', () => {
  it('accepts the example and rejects malformed definitions', () => {
    expect(validateSequence({ name: 'n', steps })).toEqual([]);
    expect(validateSequence({ name: '', steps: [] })).toHaveLength(2);
    expect(validateSequence({ name: 'n', steps: [{ ...steps[0], index: 2 }] })[0]).toMatch(/index must be 1/);
    expect(validateSequence({ name: 'n', steps: [{ ...steps[0], accountRole: 'owner' }] })[0]).toMatch(/accountRole/);
    expect(validateSequence({ name: 'n', steps: [{ ...steps[0], delaySeconds: -1 }] })[0]).toMatch(/delaySeconds/);
  });
});
