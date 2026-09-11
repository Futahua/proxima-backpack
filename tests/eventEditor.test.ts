/**
 * Event editor model contracts.
 *
 * The same walk the Task editor gets, over a different record: every field of the event,
 * every property the schema declares, the recurrence controls including the end condition,
 * and the three things this editor states rather than hides — that event records carry no
 * colour, that recurrence is offered even for an event that does not recur, and that
 * changing one occurrence is not changing the series.
 */

import { describe, expect, it } from 'vitest';

import {
  applyEventEditorEdit,
  eventEditorDraftFor,
  eventEditorPropertyFieldId,
  EVENT_EDITOR_COLOUR_NOTE,
  EVENT_EDITOR_SAVE_NOTE,
  EVENT_EDITOR_SAVE_REFUSAL,
  EVENT_EDITOR_SCOPE_NOTE,
  projectEventEditor,
  sameEventEditorDraft,
  type EventEditorField,
  type EventEditorRecurrence,
  type EventEditorSection,
} from '../src/app/eventEditor.js';
import { EMPTY_STATE, type CalendarEvent, type PropertySchema, type ProximaState } from '../src/domain/types.js';

function event(overrides: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    source: { path: `Proxima/events/${overrides.id}.md`, revision: 'r1', kind: 'event', idOrigin: 'frontmatter' },
    name: overrides.id,
    description: '',
    projectId: 'p1',
    createdAt: '2026-01-01T00:00:00.000Z',
    startDate: '2026-02-01T09:00:00.000Z',
    deadline: '2026-02-01T10:00:00.000Z',
    isCompleted: false,
    properties: {},
    ...overrides,
  };
}

const schema: PropertySchema[] = [
  { id: 'location', name: 'Location', type: 'text' },
  { id: 'seats', name: 'Seats', type: 'number' },
  { id: 'track', name: 'Track', type: 'select', options: [{ id: 'a', name: 'Track A', color: '#111' }] },
  { id: 'prep', name: 'Prep', type: 'date' },
  { id: 'confirmed', name: 'Confirmed', type: 'checkbox' },
  { id: 'total', name: 'Total', type: 'rollup', aggregation: 'sum', targetProperty: 'seats' },
];

function state(overrides: Partial<ProximaState> = {}): ProximaState {
  return {
    ...EMPTY_STATE,
    projects: [
      { id: 'p1', source: { path: 'Proxima/projects/p1.md', revision: 'r1', kind: 'project', idOrigin: 'frontmatter' }, name: 'Alpha project', description: '', createdAt: '2026-01-01T00:00:00.000Z', status: 'active', projectType: 'task', linkedFolders: [] },
    ],
    taskSchema: schema,
    ...overrides,
  };
}

const none: EventEditorRecurrence = { kind: 'none' };

function fieldsOf(sections: readonly EventEditorSection[]): EventEditorField[] {
  return sections.flatMap((section) => [...section.fields]);
}

function fieldFor(sections: readonly EventEditorSection[], id: string): EventEditorField {
  const found = fieldsOf(sections).find((candidate) => candidate.id === id);

  if (!found) throw new Error(`no field "${id}"; the editor has ${fieldsOf(sections).map((candidate) => candidate.id).join(', ')}`);

  return found;
}

describe('Event editor projection', () => {
  it('represents every field of the event itself', () => {
    const loaded = state({
      events: [event({
        id: 'e1',
        name: 'Kickoff',
        description: 'First session',
        projectId: 'p1',
        startDate: '2026-02-01T09:00:00.000Z',
        deadline: '2026-02-01T10:30:00.000Z',
        isCompleted: true,
      })],
    });

    const editor = projectEventEditor(loaded, 'e1', null, none)!;

    expect(editor.eventId).toBe('e1');
    expect(editor.title).toBe('Kickoff');
    expect(fieldFor(editor.sections, 'name').value).toBe('Kickoff');
    expect(fieldFor(editor.sections, 'name').control).toBe('text');
    expect(fieldFor(editor.sections, 'description').value).toBe('First session');
    expect(fieldFor(editor.sections, 'description').control).toBe('textarea');
    expect(fieldFor(editor.sections, 'project').control).toBe('select');
    expect(fieldFor(editor.sections, 'project').options.map((option) => option.id)).toEqual(['p1', '']);
    expect(fieldFor(editor.sections, 'start').value).toBe('2026-02-01T09:00:00.000Z');
    expect(fieldFor(editor.sections, 'start').control).toBe('date');
    expect(fieldFor(editor.sections, 'end').value).toBe('2026-02-01T10:30:00.000Z');
    expect(fieldFor(editor.sections, 'end').note).toContain('deadline');
    expect(fieldFor(editor.sections, 'completion').checked).toBe(true);
  });

  it('states why there is no colour control instead of inventing one', () => {
    const loaded = state({ events: [event({ id: 'e1' })] });
    const editor = projectEventEditor(loaded, 'e1', null, none)!;

    expect(editor.colourNote).toBe(EVENT_EDITOR_COLOUR_NOTE);
    expect(editor.colourNote).toContain('no colour');
    expect(fieldsOf(editor.sections).some((field) => field.id.toLowerCase().includes('colour'))).toBe(false);
    expect(fieldsOf(editor.sections).every((field) => field.value !== undefined)).toBe(true);
  });

  it('offers the recurrence controls, and answers "does not recur" with them', () => {
    const loaded = state({ events: [event({ id: 'e1' })] });
    const editor = projectEventEditor(loaded, 'e1', null, none)!;
    const recurrence = editor.sections.find((section) => section.id === 'recurrence')!;

    expect(recurrence.fields.map((field) => field.id)).toEqual([
      'recurrenceFrequency',
      'recurrenceInterval',
      'recurrenceEndKind',
      'recurrenceUntil',
      'recurrenceCount',
      'recurrenceScope',
    ]);

    // The end-condition select is what answers whether the event recurs at all.
    expect(fieldFor(editor.sections, 'recurrenceEndKind').options.map((option) => option.id)).toEqual(['none', 'never', 'until', 'count']);
    expect(fieldFor(editor.sections, 'recurrenceEndKind').value).toBe('none');
    expect(fieldFor(editor.sections, 'recurrenceEndKind').note).toContain('does not recur');
    expect(fieldFor(editor.sections, 'recurrenceFrequency').options.map((option) => option.id)).toEqual(['daily', 'weekly', 'monthly', 'yearly']);

    // The scope question is stated in the form, not left for the reader to infer.
    expect(fieldFor(editor.sections, 'recurrenceScope').control).toBe('derived');
    expect(fieldFor(editor.sections, 'recurrenceScope').editable).toBe(false);
    expect(fieldFor(editor.sections, 'recurrenceScope').value).toBe(EVENT_EDITOR_SCOPE_NOTE);
    expect(editor.recurrenceKind).toBe('none');
  });

  it('shows a series rule with the end condition it actually has', () => {
    const loaded = state({ events: [event({ id: 'e1' })] });

    const until = projectEventEditor(loaded, 'e1', null, { kind: 'series', frequency: 'weekly', interval: 2, count: null, until: '2026-06-30' })!;
    expect(fieldFor(until.sections, 'recurrenceFrequency').value).toBe('weekly');
    expect(fieldFor(until.sections, 'recurrenceInterval').value).toBe('2');
    expect(fieldFor(until.sections, 'recurrenceEndKind').value).toBe('until');
    expect(fieldFor(until.sections, 'recurrenceUntil').value).toBe('2026-06-30');
    expect(fieldFor(until.sections, 'recurrenceUntil').note).toBeNull();
    expect(fieldFor(until.sections, 'recurrenceCount').note).toContain('number of times');
    expect(until.recurrenceKind).toBe('series');

    const counted = projectEventEditor(loaded, 'e1', null, { kind: 'series', frequency: 'monthly', interval: 1, count: 6, until: null })!;
    expect(fieldFor(counted.sections, 'recurrenceEndKind').value).toBe('count');
    expect(fieldFor(counted.sections, 'recurrenceCount').value).toBe('6');
    expect(fieldFor(counted.sections, 'recurrenceCount').note).toBeNull();

    const endless = projectEventEditor(loaded, 'e1', null, { kind: 'series', frequency: 'daily', interval: 1, count: null, until: null })!;
    expect(fieldFor(endless.sections, 'recurrenceEndKind').value).toBe('never');
  });

  it('reports recurrence it cannot read rather than showing the event as plain', () => {
    const loaded = state({ events: [event({ id: 'e1' })] });
    const editor = projectEventEditor(loaded, 'e1', null, { kind: 'unsupported', detail: 'The stored interval is not a whole number.' })!;

    expect(editor.recurrenceKind).toBe('unsupported');
    expect(fieldFor(editor.sections, 'recurrenceEndKind').note).toBe('The stored interval is not a whole number.');
    expect(fieldFor(editor.sections, 'recurrenceEndKind').value).toBe('none');
  });

  it('represents every schema property, and shows a value the schema does not declare', () => {
    const loaded = state({
      events: [event({
        id: 'e1',
        properties: { location: 'Room 2', seats: 12, track: 'a', confirmed: true, mystery: 'unknown' },
      })],
    });

    const editor = projectEventEditor(loaded, 'e1', null, none)!;
    const properties = editor.sections.find((section) => section.id === 'properties')!;

    expect(properties.fields.map((field) => field.id)).toEqual([
      eventEditorPropertyFieldId('location'),
      eventEditorPropertyFieldId('seats'),
      eventEditorPropertyFieldId('track'),
      eventEditorPropertyFieldId('prep'),
      eventEditorPropertyFieldId('confirmed'),
      eventEditorPropertyFieldId('total'),
      eventEditorPropertyFieldId('mystery'),
    ]);

    expect(fieldFor(editor.sections, eventEditorPropertyFieldId('location')).value).toBe('Room 2');
    expect(fieldFor(editor.sections, eventEditorPropertyFieldId('seats')).control).toBe('number');
    expect(fieldFor(editor.sections, eventEditorPropertyFieldId('seats')).value).toBe('12');
    expect(fieldFor(editor.sections, eventEditorPropertyFieldId('track')).control).toBe('select');
    expect(fieldFor(editor.sections, eventEditorPropertyFieldId('track')).options.map((option) => option.label)).toEqual(['Track A']);
    expect(fieldFor(editor.sections, eventEditorPropertyFieldId('prep')).control).toBe('date');
    expect(fieldFor(editor.sections, eventEditorPropertyFieldId('confirmed')).checked).toBe(true);
    expect(fieldFor(editor.sections, eventEditorPropertyFieldId('total')).control).toBe('derived');
    expect(fieldFor(editor.sections, eventEditorPropertyFieldId('total')).editable).toBe(false);
    expect(fieldFor(editor.sections, eventEditorPropertyFieldId('mystery')).value).toBe('unknown');
    expect(fieldFor(editor.sections, eventEditorPropertyFieldId('mystery')).note).toContain('not in the schema');

    const ids = fieldsOf(editor.sections).map((field) => field.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('counts the fields it shows, and returns nothing for an event that is not loaded', () => {
    const loaded = state({ events: [event({ id: 'e1' })] });
    const editor = projectEventEditor(loaded, 'e1', null, none)!;

    expect(editor.fieldCount).toBe(fieldsOf(editor.sections).length);
    expect(editor.fieldCount).toBe(6 + 6 + schema.length);
    expect(projectEventEditor(loaded, 'missing', null, none)).toBeNull();
  });
});

describe('Event editor draft', () => {
  it('starts from the record, so a fresh draft is not yet a change', () => {
    const loaded = state({
      events: [event({ id: 'e1', name: 'Kickoff', properties: { location: 'Room 2', confirmed: true } })],
    });
    const record = loaded.events[0]!;
    const recurrence: EventEditorRecurrence = { kind: 'series', frequency: 'weekly', interval: 1, count: null, until: '2026-06-30' };
    const draft = eventEditorDraftFor(record, recurrence);

    expect(draft.values.name).toBe('Kickoff');
    expect(draft.values[eventEditorPropertyFieldId('location')]).toBe('Room 2');
    expect(draft.values.recurrenceUntil).toBe('2026-06-30');
    expect(draft.checks[eventEditorPropertyFieldId('confirmed')]).toBe(true);

    const seeded = projectEventEditor(loaded, 'e1', draft, recurrence)!;
    const unedited = projectEventEditor(loaded, 'e1', null, recurrence)!;
    expect(seeded.dirty).toBe(false);
    expect(unedited.dirty).toBe(false);
    expect(seeded.sections).toEqual(unedited.sections);
    expect(sameEventEditorDraft(draft, eventEditorDraftFor(record, recurrence))).toBe(true);
  });

  it('takes an edit, marks the editor dirty, and goes back when it is undone', () => {
    const loaded = state({ events: [event({ id: 'e1', name: 'Kickoff' })] });
    const seed = eventEditorDraftFor(loaded.events[0]!, none);

    const renamed = applyEventEditorEdit(seed, { fieldId: 'name', value: 'Kickoff 2' });
    expect(projectEventEditor(loaded, 'e1', renamed, none)!.dirty).toBe(true);
    expect(fieldFor(projectEventEditor(loaded, 'e1', renamed, none)!.sections, 'name').value).toBe('Kickoff 2');

    const ended = applyEventEditorEdit(renamed, { fieldId: 'recurrenceEndKind', value: 'count' });
    expect(fieldFor(projectEventEditor(loaded, 'e1', ended, none)!.sections, 'recurrenceCount').note).toBeNull();

    const completed = applyEventEditorEdit(ended, { fieldId: 'completion', checked: true });
    expect(fieldFor(projectEventEditor(loaded, 'e1', completed, none)!.sections, 'completion').checked).toBe(true);

    const undone = applyEventEditorEdit(completed, { fieldId: 'completion', checked: false });
    expect(projectEventEditor(loaded, 'e1', undone, none)!.dirty).toBe(true);

    const back = applyEventEditorEdit(applyEventEditorEdit(undone, { fieldId: 'name', value: 'Kickoff' }), { fieldId: 'recurrenceEndKind', value: 'none' });
    expect(projectEventEditor(loaded, 'e1', back, none)!.dirty).toBe(false);
  });

  it('never mutates the draft it was given, and states the refusal it will answer with', () => {
    const loaded = state({ events: [event({ id: 'e1' })] });
    const seed = eventEditorDraftFor(loaded.events[0]!, none);
    const before = JSON.stringify(seed);

    applyEventEditorEdit(seed, { fieldId: 'name', value: 'x' });
    applyEventEditorEdit(seed, { fieldId: 'completion', checked: true });

    expect(JSON.stringify(seed)).toBe(before);
    expect(EVENT_EDITOR_SAVE_REFUSAL).toBe('action-not-available');
    expect(EVENT_EDITOR_SAVE_NOTE).toContain('until the record store can write');
    expect(EVENT_EDITOR_SAVE_NOTE).toContain('Nothing on this form has been changed');
  });
});
