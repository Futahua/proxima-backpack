/**
 * The two pieces of the semantic envelope a test has to supply: an id source and an audit sink.
 *
 * Shared rather than repeated, because the point of both is that they are injected - a test that builds its
 * own copy of either is a test that can drift from the contract without anything failing. The sink records
 * instead of journalling, so a test asserts the terminal event an action owed rather than assuming it.
 */
import { sequentialIdGenerator, type IdGenerator } from '../src/domain/clock.js';
import type { SemanticAuditEvent, SemanticAuditSink } from '../src/app/semanticAudit.js';

export interface RecordingAudit extends SemanticAuditSink {
  readonly events: readonly SemanticAuditEvent[];
}

/** A sink that keeps what it was told, in order. */
export function recordingAudit(): RecordingAudit {
  const events: SemanticAuditEvent[] = [];
  return {
    events,
    append(event: SemanticAuditEvent): void {
      events.push({ ...event, entityIds: [...event.entityIds] });
    },
  };
}

/** Deterministic ids for a run's semantic request envelope. */
export function semanticIds(): IdGenerator {
  return sequentialIdGenerator();
}
