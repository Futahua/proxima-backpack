// @vitest-environment happy-dom

/**
 * The Event modal, as the surfaces actually render it.
 *
 * The § Event modal boxes say every meaningful field must be representable, so this suite
 * checks the rendered document rather than the projection: the field is there, with the
 * control its type calls for and the value the record holds, plus the three things the
 * modal states — why there is no colour control, what the recurrence rule is, and that
 * changing one occurrence is not changing the series.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { eventEditorInputFor, eventFormValuesFrom, eventRecurrenceFor, renderEventModal } from '../src/browser/eventModal.js';
import { renderScheduleProjection } from '../src/browser/scheduleProjection.js';
import { renderScheduleTimeGrid } from '../src/browser/scheduleTimeGrid.js';
import { EMPTY_STATE, type CalendarEvent, type ProximaState } from '../src/domain/types.js';

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

const project = {
  id: 'p1',
  source: { path: 'Proxima/projects/p1.md', revision: 'r1', kind: 'project' as const, idOrigin: 'frontmatter' as const },
  name: 'Alpha project',
  description: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  status: 'active' as const,
  projectType: 'task' as const,
  linkedFolders: [],
};

function state(events: CalendarEvent[]): ProximaState {
  return { ...EMPTY_STATE, projects: [project], events };
}

const projectNames = new Map([['p1', 'Alpha project']]);
const now = new Date('2026-02-01T08:00:00.000Z');

function modal(events: CalendarEvent[], eventId: string | null, mode: 'edit' | 'read-only' = 'edit', writes: { refusal: string | null; feedback: string | null } | null = null): HTMLElement {
  document.body.innerHTML = renderEventModal({ events, projectNames, eventId, closeAction: 'close-event', closeAttribute: 'data-schedule-action', mode, writes });
  return document.body;
}

function field(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-c1-key="schedule-event-${id}"]`);
}

/**
 * The options a select marks as chosen.
 *
 * Selection is read from the `selected` attribute rather than `select.value`: happy-dom
 * computes `value` wrongly when selection comes from the attribute on a disabled select
 * (it picks an option that is not the marked one), and the attribute is what a browser
 * honours. Asserting the attribute keeps this suite about the markup the modal emits.
 */
function selectedOptions(id: string): string[] {
  const select = field(id) as HTMLSelectElement;

  return Array.from(select.options)
    .filter((option) => option.hasAttribute('selected'))
    .map((option) => option.value);
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Event modal fields', () => {
  it('shows every field of the event, with the value the record holds', () => {
    const detailed = event({
      id: 'e1',
      name: 'Kickoff',
      description: 'First session',
      startDate: '2026-02-01T09:00:00.000Z',
      deadline: '2026-02-01T10:30:00.000Z',
      isCompleted: true,
    });

    const root = modal([detailed], 'e1');

    expect(root.querySelector('[data-c1-key="schedule-event-modal"]')).not.toBeNull();
    expect((field('name') as HTMLInputElement).value).toBe('Kickoff');
    expect(field('name')!.getAttribute('data-schedule-event-control')).toBe('text');
    expect((field('description') as HTMLTextAreaElement).value).toBe('First session');
    expect(field('description')!.getAttribute('data-schedule-event-control')).toBe('textarea');
    expect((field('start') as HTMLInputElement).value).toBe('2026-02-01T09:00:00.000Z');
    expect((field('end') as HTMLInputElement).value).toBe('2026-02-01T10:30:00.000Z');
    expect((field('completion') as HTMLInputElement).checked).toBe(true);
    expect(field('completion')!.getAttribute('data-schedule-event-control')).toBe('checkbox');

    // The project select offers the projects this surface knows, with the held one chosen.
    const project_ = field('project') as HTMLSelectElement;
    expect(project_.tagName).toBe('SELECT');
    expect(Array.from(project_.options).map((option) => option.value)).toEqual(['p1', '']);
    expect(selectedOptions('project')).toEqual(['p1']);
    expect(Array.from(project_.options).map((option) => option.textContent)).toEqual(['Alpha project', 'No project']);

    // Nothing here writes, and the modal says where Save would be.
    expect((field('name') as HTMLInputElement).readOnly).toBe(true);
    expect((root.querySelector('[data-c1-key="schedule-event-save"]') as HTMLButtonElement).disabled).toBe(true);
    expect(root.querySelector('[data-c1-key="schedule-event-save"]')!.getAttribute('data-schedule-event-save-refusal')).toBe('action-not-available');
    expect((root.querySelector('[data-c1-key="schedule-event-delete"]') as HTMLButtonElement).disabled).toBe(true);
    expect(root.querySelector('[data-c1-key="schedule-event-save-note"]')!.textContent).toContain('until the record store can write');
    expect(root.querySelector('[data-c1-key="schedule-event-modal"]')!.getAttribute('data-schedule-event-field-count')).toBe('12');
  });

  it('makes the recurrence controls real when the run can write, and leaves them inert when it cannot', () => {
    const weekly = event({ id: 'e1', properties: { recurrence: { frequency: 'weekly', interval: 2, until: '2026-06-30' } } });

    // No resolved write path: every control is inert, which is what the box about an inert form records. A
    // select says so with `disabled` and a text field with `readonly`, which is the shape this modal uses.
    modal([weekly], 'e1');
    expect((field('recurrenceFrequency') as HTMLSelectElement).disabled).toBe(true);
    expect((field('recurrenceInterval') as HTMLInputElement).readOnly).toBe(true);

    // A resolved one: the rule is a control the reader can change, because a changed rule has somewhere to go -
    // `saveEventFormAction` routes it to the series verbs rather than folding it into the field update.
    modal([weekly], 'e1', 'edit', { refusal: null, feedback: null });
    expect((field('recurrenceFrequency') as HTMLSelectElement).disabled).toBe(false);
    expect((field('recurrenceInterval') as HTMLInputElement).readOnly).toBe(false);
    expect((field('recurrenceEndKind') as HTMLSelectElement).disabled).toBe(false);
    expect((field('recurrenceUntil') as HTMLInputElement).readOnly).toBe(false);
    // The six field controls stay what they were, and Save is a control.
    expect((field('name') as HTMLInputElement).readOnly).toBe(false);
    expect((document.querySelector('[data-c1-key="schedule-event-save"]') as HTMLButtonElement).disabled).toBe(false);

    // And the form reads the rule back out of those controls, which is what a save submits. The values are set
    // the way a browser records a reader's choice - in the control itself - rather than by parsing the markup's
    // `selected` attribute, which is what the display cases above assert.
    (field('recurrenceEndKind') as HTMLSelectElement).value = 'until';
    (field('recurrenceUntil') as HTMLInputElement).value = '2026-06-30';
    const collected = eventFormValuesFrom(document.body);
    expect(collected?.recurrence).toEqual({ kind: 'series', frequency: 'weekly', interval: 2, end: { kind: 'until', until: '2026-06-30' } });

    // Choosing "none" is how a reader turns recurrence off, and the form says exactly that.
    (field('recurrenceEndKind') as HTMLSelectElement).value = 'none';
    expect(eventFormValuesFrom(document.body)?.recurrence).toEqual({ kind: 'none' });
  });

  it('says why there is no colour control rather than leaving the question open', () => {
    const root = modal([event({ id: 'e1' })], 'e1');

    const note = root.querySelector('[data-c1-key="schedule-event-colour-note"]')!;
    expect(note.textContent).toContain('no colour');
    expect(root.querySelector('[data-schedule-event-field*="colour"]')).toBeNull();
  });

  it('shows the recurrence rule the record holds, and the end condition it ends with', () => {
    const weekly = event({ id: 'e1', properties: { recurrence: { frequency: 'weekly', interval: 2, until: '2026-06-30' } } });

    const root = modal([weekly], 'e1');

    expect(root.querySelector('[data-c1-key="schedule-event-modal"]')!.getAttribute('data-schedule-event-recurrence-kind')).toBe('series');
    expect(selectedOptions('recurrenceFrequency')).toEqual(['weekly']);
    expect((field('recurrenceInterval') as HTMLInputElement).value).toBe('2');
    expect(selectedOptions('recurrenceEndKind')).toEqual(['until']);
    expect(Array.from((field('recurrenceEndKind') as HTMLSelectElement).options).map((option) => option.value)).toEqual(['none', 'never', 'until', 'count']);
    expect((field('recurrenceUntil') as HTMLInputElement).value).toBe('2026-06-30');

    // The scope question is answered in the form, not left to be discovered.
    expect(field('recurrenceScope')!.getAttribute('data-schedule-event-control')).toBe('derived');
    expect(field('recurrenceScope')!.textContent).toContain('choose this occurrence or the whole series');
  });

  it('offers the recurrence controls for an event that does not recur, saying so', () => {
    const root = modal([event({ id: 'e1' })], 'e1');

    expect(root.querySelector('[data-c1-key="schedule-event-modal"]')!.getAttribute('data-schedule-event-recurrence-kind')).toBe('none');
    expect(selectedOptions('recurrenceEndKind')).toEqual(['none']);
    expect(field('recurrenceEndKind')!.ownerDocument.defaultView).not.toBeNull();
    expect(document.querySelector('[data-schedule-event-note="recurrenceEndKind"]')!.textContent).toContain('does not recur');
  });

  it('reports recurrence it cannot read instead of showing the event as plain', () => {
    const broken = event({ id: 'e1', properties: { recurrence: { frequency: 'sometimes' } } });

    const root = modal([broken], 'e1');

    expect(root.querySelector('[data-c1-key="schedule-event-modal"]')!.getAttribute('data-schedule-event-recurrence-kind')).toBe('unsupported');
    expect(document.querySelector('[data-schedule-event-note="recurrenceEndKind"]')!.textContent).toContain('could not be read');
  });

  it('renders nothing for no event, or for one this surface does not hold', () => {
    expect(renderEventModal({ events: [event({ id: 'e1' })], projectNames, eventId: null, closeAction: 'close-event', closeAttribute: 'data-schedule-action', mode: 'edit' })).toBe('');
    expect(renderEventModal({ events: [event({ id: 'e1' })], projectNames, eventId: 'missing', closeAction: 'close-event', closeAttribute: 'data-schedule-action', mode: 'edit' })).toBe('');
  });

  it('reads the recurrence and the choices the way the modal needs them', () => {
    expect(eventRecurrenceFor(event({ id: 'e1' }))).toEqual({ kind: 'none' });
    expect(eventRecurrenceFor(event({ id: 'e1', properties: { recurrence: { frequency: 'monthly' } } }))).toEqual({ kind: 'series', frequency: 'monthly', interval: 1, count: null, until: null });
    expect(eventRecurrenceFor(event({ id: 'e1', properties: { recurrence: { frequency: 'nope' } } })).kind).toBe('unsupported');

    expect(eventEditorInputFor([event({ id: 'e1' })], new Map([['p2', 'Beta']])).projectChoices).toEqual([
      { id: 'p2', label: 'Beta' },
      { id: '', label: 'No project' },
    ]);
  });
});

describe('Event modal through the schedule surfaces', () => {
  it('is the modal a month projection opens, with that surface closing it', () => {
    const loaded = state([event({ id: 'e1', name: 'Kickoff' })]);

    document.body.innerHTML = renderScheduleProjection({
      mode: 'month',
      events: loaded.events,
      projectNames,
      selectionLabel: 'All projects',
      calendarCursor: now,
      now,
      selectedEventId: 'e1',
    });

    const section = document.querySelector('[data-c1-key="schedule-event-modal"]')!;
    expect(section).not.toBeNull();
    expect(section.getAttribute('data-schedule-editor-mode')).toBe('read-only');
    expect((document.querySelector('[data-c1-key="schedule-event-name"]') as HTMLInputElement).value).toBe('Kickoff');
    expect(document.querySelector('[data-c1-key="schedule-event-modal-close"]')!.getAttribute('data-schedule-projection-action')).toBe('close-event');
    expect(document.querySelector('[data-c1-key="schedule-event-modal-close"]')!.hasAttribute('data-schedule-action')).toBe(false);
    expect(document.querySelector('[data-c1-key="schedule-event-save"]')).not.toBeNull();
  });

  it('is the modal a time grid opens, with that surface closing it', () => {
    const loaded = state([event({ id: 'e1', name: 'Kickoff' })]);

    document.body.innerHTML = renderScheduleTimeGrid({
      mode: 'day',
      events: loaded.events,
      projectNames,
      selectionLabel: 'All projects',
      calendarCursor: now,
      now,
      selectedEventId: 'e1',
    });

    const section = document.querySelector('[data-c1-key="schedule-event-modal"]')!;
    expect(section).not.toBeNull();
    expect(section.getAttribute('data-schedule-editor-mode')).toBe('edit');
    expect(document.querySelector('[data-c1-key="schedule-event-modal-close"]')!.getAttribute('data-schedule-action')).toBe('close-event');
    expect(document.querySelector('[data-c1-key="schedule-event-close"]')).toBeNull();
  });
});
