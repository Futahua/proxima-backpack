import { describe, expect, it } from 'vitest';
import { bindRefreshWiring, refreshReasonForAction } from '../src/browser/refreshWiring.js';

function target(visibilityState: 'visible' | 'hidden') {
  const listeners = new Map<string, Set<() => void>>();
  return {
    visibilityState,
    addEventListener(type: string, listener: () => void) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener); },
    removeEventListener(type: string, listener: () => void) { listeners.get(type)?.delete(listener); },
    emit(type: string) { for (const listener of listeners.get(type) ?? []) listener(); },
  };
}

describe('Gate 6.1 browser refresh trigger adapter', () => {
  it('maps manual action and owns focus refresh while visibility only arms/suspends policy', () => {
    const documentTarget = target('visible');
    const windowTarget = target('visible');
    const visibleCalls: Array<{ visible: boolean; refreshOnVisible: boolean }> = [];
    const refreshes: string[] = [];
    const dispose = bindRefreshWiring({ documentTarget, windowTarget, setVisible: (visible, options) => visibleCalls.push({ visible, ...options }), refresh: (reason) => { refreshes.push(reason); } });
    expect(visibleCalls).toEqual([{ visible: true, refreshOnVisible: false }]);
    expect(refreshReasonForAction('source-refresh')).toBe('manual');
    expect(refreshReasonForAction('switch-surface')).toBeNull();
    documentTarget.visibilityState = 'hidden';
    documentTarget.emit('visibilitychange');
    windowTarget.emit('focus');
    documentTarget.visibilityState = 'visible';
    documentTarget.emit('visibilitychange');
    windowTarget.emit('focus');
    expect(visibleCalls).toEqual([{ visible: true, refreshOnVisible: false }, { visible: false, refreshOnVisible: false }, { visible: true, refreshOnVisible: false }]);
    expect(refreshes).toEqual(['focus']);
    dispose();
    windowTarget.emit('focus');
    expect(refreshes).toEqual(['focus']);
  });
});
