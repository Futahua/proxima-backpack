import type { Clock, IdGenerator } from '../domain/clock.js';

export const EVENT_SCHEMA_VERSION = 1 as const;
export const DEFAULT_EVENT_CAPACITY = 128;

export type ProximaEventKind = 'action.accepted' | 'action.rejected' | 'state.settled';
export type ProximaEventCategory = 'domain' | 'diagnostic' | 'lifecycle';

export interface ProximaEvent {
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
  sequence: number;
  kind: ProximaEventKind;
  category: ProximaEventCategory;
  entityIds: string[];
  requestId: string;
  actionType: string;
  stateRevision: number;
  timestamp: string;
  errorCode?: string;
}

export interface EventRing {
  append(event: Omit<ProximaEvent, 'schemaVersion' | 'sequence' | 'timestamp'>): ProximaEvent;
  read(afterSequence?: number): ProximaEvent[];
  latestSequence(): number;
}

export interface EventRingOptions {
  clock: Clock;
  ids: IdGenerator;
  capacity?: number;
}

export function createEventRing(options: EventRingOptions): EventRing {
  const capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_EVENT_CAPACITY));
  const events: ProximaEvent[] = [];
  let sequence = 0;
  return {
    append(input) {
      const event: ProximaEvent = { schemaVersion: EVENT_SCHEMA_VERSION, sequence: ++sequence, timestamp: new Date(options.clock.now()).toISOString(), ...input, entityIds: [...input.entityIds] };
      events.push(event);
      while (events.length > capacity) events.shift();
      return { ...event, entityIds: [...event.entityIds] };
    },
    read(afterSequence = 0) {
      return events.filter((event) => event.sequence > afterSequence).map((event) => ({ ...event, entityIds: [...event.entityIds] }));
    },
    latestSequence() { return sequence; },
  };
}
