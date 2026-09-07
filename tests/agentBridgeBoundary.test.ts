import { describe, expect, it } from 'vitest';
import { bridgeUrlForLaunch } from '../src/browser/agentBridge.js';
import { BUILD_IDENTITY } from '../src/browser/generated/buildIdentity.generated.js';

describe('Developer control bridge launch boundary', () => {
  it('does not activate ?bridge= in the ordinary fixture build', () => {
    expect(BUILD_IDENTITY.buildMode).toBe('fixture');
    expect(BUILD_IDENTITY.agentBridgeEnabled).toBe(false);
    expect(bridgeUrlForLaunch('?bridge=http%3A%2F%2F127.0.0.1%3A4174', BUILD_IDENTITY.agentBridgeEnabled)).toBeNull();
  });

  it('requires explicit build opt-in before resolving an agent bridge URL', () => {
    expect(bridgeUrlForLaunch('?bridge=http%3A%2F%2F127.0.0.1%3A4174', true)).toBe('http://127.0.0.1:4174');
    expect(bridgeUrlForLaunch('', true)).toBeNull();
  });
});
