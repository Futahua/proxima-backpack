/**
 * Developer control bridge launch boundary.
 *
 * Two conditions gate the transport: the build must be opted in, and the launch must carry a
 * session token. The second is what this file is about now - loopback reachability is not identity,
 * so an enabled build launched with no token resolves to no bridge rather than to an open one.
 */
import { describe, expect, it } from 'vitest';
import { bridgeUrlForLaunch } from '../src/browser/agentBridge.js';
import { BUILD_IDENTITY } from '../src/browser/generated/buildIdentity.generated.js';

const QUERY = '?bridge=http%3A%2F%2F127.0.0.1%3A4174';
const HASH = '#token=run-token-1';

describe('Developer control bridge launch boundary', () => {
  it('does not activate ?bridge= in the ordinary fixture build', () => {
    expect(BUILD_IDENTITY.buildMode).toBe('fixture');
    expect(BUILD_IDENTITY.agentBridgeEnabled).toBe(false);
    expect(bridgeUrlForLaunch(QUERY, HASH, BUILD_IDENTITY.agentBridgeEnabled)).toBeNull();
  });

  it('requires explicit build opt-in before resolving an agent bridge URL', () => {
    expect(bridgeUrlForLaunch(QUERY, HASH, true)).toBe('http://127.0.0.1:4174#token=run-token-1');
    expect(bridgeUrlForLaunch('', HASH, true)).toBeNull();
  });

  it('requires a session token, and carries it in the fragment rather than the query', () => {
    // No token at all: no bridge. That is the fail-closed direction - the surface then behaves as it
    // does when the transport is absent, instead of talking to an unauthenticated one.
    expect(bridgeUrlForLaunch(QUERY, '', true)).toBeNull();
    expect(bridgeUrlForLaunch(QUERY, '#other=1', true)).toBeNull();
    // A token that arrived in the query is not a token: reading it from there would put a credential
    // in a request line, which is exactly what the fragment avoids.
    expect(bridgeUrlForLaunch(`${QUERY}&token=run-token-1`, '', true)).toBeNull();
    // And a fragment smuggled inside the bridge URL is replaced, so one launch carries one token.
    const stray = `?bridge=${encodeURIComponent('http://127.0.0.1:4174#token=stale')}`;
    expect(bridgeUrlForLaunch(stray, HASH, true)).toBe('http://127.0.0.1:4174#token=run-token-1');
  });
});
