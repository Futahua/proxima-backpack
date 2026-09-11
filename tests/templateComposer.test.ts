/**
 * Template composer contracts.
 *
 * The format is this project's own, so these cases are the specification: what a task line
 * is, what a field line is, which values are refused, and — the rule that makes the composer
 * usable while somebody is typing — that one unreadable line never costs the reader the
 * tasks that could be read.
 */

import { describe, expect, it } from 'vitest';

import {
  describeTemplateTask,
  MAX_TEMPLATE_TASKS,
  parseTemplatePlan,
  TEMPLATE_FIELD_KEYS,
  type TemplateComposerError,
  type TemplateErrorCode,
} from '../src/app/templateComposer.js';

function codes(errors: readonly TemplateComposerError[]): TemplateErrorCode[] {
  return errors.map((error) => error.code);
}

describe('Template composer', () => {
  it('reads a task per unindented line, and a field per indented line', () => {
    const plan = parseTemplatePlan([
      '# A comment, ignored.',
      '',
      'Ship the release',
      '  weight: 3',
      '  status: running',
      '  start: 2026-06-01',
      '  deadline: 2026-06-30T17:00:00Z',
      '  fixed: 90',
      '  max: 240',
      '  completed: false',
      '  property.area: work',
      '',
      'Write the notes',
      '  property.area: writing',
    ].join('\n'));

    expect(plan.errors).toEqual([]);
    expect(plan.lineCount).toBe(14);
    expect(plan.tasks).toHaveLength(2);

    expect(plan.tasks[0]).toEqual({
      name: 'Ship the release',
      line: 3,
      weight: 3,
      status: 'running',
      startDate: '2026-06-01',
      deadline: '2026-06-30T17:00:00Z',
      fixedDuration: 90,
      maxDuration: 240,
      isCompleted: false,
      properties: { area: 'work' },
    });
    expect(plan.tasks[1]!.name).toBe('Write the notes');
    expect(plan.tasks[1]!.weight).toBeNull();
    expect(plan.tasks[1]!.properties).toEqual({ area: 'writing' });

    // A value is kept exactly as written: normalising a date into an instant is the
    // importer's job, not a text box's.
    expect(plan.tasks[0]!.startDate).toBe('2026-06-01');
  });

  it('describes a planned task in one line for a preview', () => {
    const plan = parseTemplatePlan('Ship\n  weight: 3\n  deadline: 2026-06-30\n  property.area: work\n');
    expect(describeTemplateTask(plan.tasks[0]!)).toBe('weight 3 · due 2026-06-30 · area: work');
    expect(describeTemplateTask(parseTemplatePlan('Bare\n').tasks[0]!)).toBe('No fields');
  });

  it('refuses a field that arrives before any task, and says where', () => {
    const plan = parseTemplatePlan('  weight: 3\nShip\n');

    expect(codes(plan.errors)).toEqual(['property-before-task']);
    expect(plan.errors[0]!.line).toBe(1);
    expect(plan.errors[0]!.column).toBe(3);
    expect(plan.errors[0]!.text).toBe('weight: 3');
    expect(plan.errors[0]!.message).toContain('no task has been named above it');
    // The task below it is still planned: a bad line is a complaint, not a stop.
    expect(plan.tasks.map((task) => task.name)).toEqual(['Ship']);
  });

  it('refuses an unknown field and names what a template may set', () => {
    const plan = parseTemplatePlan('Ship\n  colour: red\n');

    expect(codes(plan.errors)).toEqual(['unknown-field']);
    expect(plan.errors[0]!.message).toContain('"colour" is not a task field');
    for (const key of TEMPLATE_FIELD_KEYS) expect(plan.errors[0]!.message).toContain(key);
    expect(plan.tasks[0]!.properties).toEqual({});
  });

  it('refuses a field set twice, and a property with no name', () => {
    const plan = parseTemplatePlan('Ship\n  weight: 3\n  weight: 4\n  property.: x\n  property: y\n');

    expect(codes(plan.errors)).toEqual(['duplicate-field', 'unknown-field', 'unknown-field']);
    expect(plan.errors[0]!.message).toContain('already set on "Ship"');
    expect(plan.tasks[0]!.weight).toBe(3);
  });

  it('refuses a line that is not a field at all', () => {
    const plan = parseTemplatePlan('Ship\n  weight 3\n');

    expect(codes(plan.errors)).toEqual(['missing-field-separator']);
    expect(plan.errors[0]!.column).toBe(3);
  });

  it('refuses an empty value rather than treating it as absent', () => {
    const plan = parseTemplatePlan('Ship\n  status:\n  weight: 3\n');

    expect(codes(plan.errors)).toEqual(['empty-field-value']);
    // The complaint points at the colon, which is the character with nothing after it.
    expect(plan.errors[0]!.column).toBe(9);
    expect(plan.errors[0]!.message).toContain('"status" was given no value');
    expect(plan.tasks[0]!.status).toBeNull();
    expect(plan.tasks[0]!.weight).toBe(3);
  });

  it('refuses a number that is not one, or is negative', () => {
    expect(codes(parseTemplatePlan('Ship\n  weight: heavy\n').errors)).toEqual(['invalid-number']);
    expect(codes(parseTemplatePlan('Ship\n  max: -5\n').errors)).toEqual(['invalid-number']);
    expect(parseTemplatePlan('Ship\n  weight: 0\n').errors).toEqual([]);
    expect(parseTemplatePlan('Ship\n  weight: 2.5\n').tasks[0]!.weight).toBe(2.5);
    expect(parseTemplatePlan('Ship\n  weight: heavy\n').tasks[0]!.weight).toBeNull();

    // The column is where the value actually starts, not one before it: `weight: heavy` and
    // `weight:heavy` differ by exactly the space, and a reader following the number wants
    // the character the parser is complaining about.
    expect(parseTemplatePlan('Ship\n  weight: heavy\n').errors[0]!.column).toBe(11);
    expect(parseTemplatePlan('Ship\n  weight:heavy\n').errors[0]!.column).toBe(10);
  });

  it('refuses a date it cannot read, and accepts a day or an instant', () => {
    expect(codes(parseTemplatePlan('Ship\n  deadline: soon\n').errors)).toEqual(['invalid-date']);
    expect(codes(parseTemplatePlan('Ship\n  deadline: 2026-13-01\n').errors)).toEqual(['invalid-date']);
    expect(parseTemplatePlan('Ship\n  deadline: 2026-06-30\n').errors).toEqual([]);
    expect(parseTemplatePlan('Ship\n  deadline: 2026-06-30T09:00:00.000Z\n').errors).toEqual([]);
  });

  it('refuses a boolean that is not true or false', () => {
    expect(codes(parseTemplatePlan('Ship\n  completed: yes\n').errors)).toEqual(['invalid-boolean']);
    expect(parseTemplatePlan('Ship\n  completed: true\n').tasks[0]!.isCompleted).toBe(true);
    expect(parseTemplatePlan('Ship\n  completed: false\n').tasks[0]!.isCompleted).toBe(false);
  });

  it('refuses a tab, because indentation must read the same everywhere', () => {
    const plan = parseTemplatePlan('Ship\n\tweight: 3\n');

    expect(codes(plan.errors)).toEqual(['invalid-indentation']);
    expect(plan.tasks[0]!.weight).toBeNull();
  });

  it('plans nothing from empty text, and says nothing is wrong', () => {
    expect(parseTemplatePlan('')).toEqual({ tasks: [], errors: [], lineCount: 1 });
    expect(parseTemplatePlan('\n\n# only comments\n').tasks).toEqual([]);
    expect(parseTemplatePlan('\n\n# only comments\n').errors).toEqual([]);
  });

  it('reads every line ending a paste may carry', () => {
    expect(parseTemplatePlan('Ship\r\n  weight: 3\r\n').tasks[0]!.weight).toBe(3);
    expect(parseTemplatePlan('Ship\r  weight: 3\r').tasks[0]!.weight).toBe(3);
  });

  it('bounds how much a paste may plan, rather than accepting an unbounded job', () => {
    const many = Array.from({ length: MAX_TEMPLATE_TASKS + 2 }, (_value, index) => `Task ${index}`).join('\n');
    const plan = parseTemplatePlan(many);

    expect(plan.tasks).toHaveLength(MAX_TEMPLATE_TASKS);
    expect(codes(plan.errors)).toEqual(['too-many-tasks', 'too-many-tasks']);
    expect(plan.errors[0]!.message).toContain(`at most ${MAX_TEMPLATE_TASKS} tasks`);
  });

  it('keeps every task it could read when some lines are wrong', () => {
    const plan = parseTemplatePlan([
      'First',
      '  weight: 1',
      '  nope: x',
      'Second',
      '  deadline: never',
      '  weight: 2',
      'Third',
    ].join('\n'));

    expect(plan.tasks.map((task) => task.name)).toEqual(['First', 'Second', 'Third']);
    expect(plan.tasks[1]!.weight).toBe(2);
    expect(plan.tasks[1]!.deadline).toBeNull();
    expect(codes(plan.errors)).toEqual(['unknown-field', 'invalid-date']);
  });

  it('never reads a record and never writes one: the plan is data', () => {
    const text = 'Ship\n  weight: 3\n';
    const plan = parseTemplatePlan(text);

    expect(plan.tasks[0]).not.toBe(parseTemplatePlan(text).tasks[0]);
    expect(text).toBe('Ship\n  weight: 3\n');
    // The plan holds no reference to the text it came from.
    expect(JSON.stringify(plan)).not.toContain('weight: 3\\n');
  });
});
