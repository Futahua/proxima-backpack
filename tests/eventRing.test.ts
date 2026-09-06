import { describe, expect, it } from 'vitest';
import { fixedClock, sequentialIdGenerator } from '../src/domain/clock.js';
import { createEventRing } from '../src/app/eventRing.js';

describe('Gate 3B structured event ring', () => {
  it('keeps monotonic bounded events with injected time and safe reads', () => {
    const ring = createEventRing({ clock: fixedClock('2026-09-06T12:00:00.000Z'), ids: sequentialIdGenerator(), capacity: 2 });
    ring.append({ kind: 'action.accepted', category: 'domain', entityIds: ['proj-a'], requestId: 'request-0001', actionType: 'project.select', stateRevision: 2 });
    ring.append({ kind: 'state.settled', category: 'lifecycle', entityIds: [], requestId: 'request-0001', actionType: 'project.select', stateRevision: 2 });
    ring.append({ kind: 'action.rejected', category: 'diagnostic', entityIds: [], requestId: 'request-0002', actionType: 'unknown', stateRevision: 2, errorCode: 'invalid-action' });

    expect(ring.latestSequence()).toBe(3);
    expect(ring.read()).toHaveLength(2);
    expect(ring.read().map((event) => event.sequence)).toEqual([2, 3]);
    expect(ring.read(2)[0]).toMatchObject({ sequence: 3, timestamp: '2026-09-06T12:00:00.000Z', category: 'diagnostic' });
    const first = ring.read()[0]!;
    first.entityIds.push('mutated');
    expect(ring.read()[0]?.entityIds).not.toContain('mutated');
  });
});
