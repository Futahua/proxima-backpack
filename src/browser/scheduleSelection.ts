import {
  eventsForSelection,
  projectsFor,
} from '../domain/selectors.js';
import type {
  CalendarEvent,
  ProximaState,
} from '../domain/types.js';

export function scheduleEventsForSelection(
  state: ProximaState,
  selection: string,
): CalendarEvent[] {
  const scheduleProjectIds = new Set(
    projectsFor(state.projects, 'schedule')
      .map((project) => project.id),
  );

  const scheduleEvents = state.events.filter(
    (event) => (
      event.projectId === null
      || scheduleProjectIds.has(event.projectId)
    ),
  );

  return eventsForSelection(
    scheduleEvents,
    selection,
  );
}
