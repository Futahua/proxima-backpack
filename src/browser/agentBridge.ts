/**
 * Resolve the optional agent bridge only in a build explicitly enabled for it.
 *
 * Two conditions, and the second is new: the build must be opted in, **and** the launch must carry
 * a session token. The token travels in the page's fragment rather than its query, because a
 * fragment is never sent to a server and never appears in a request line, and the bridge refuses an
 * unauthenticated caller outright. An enabled build launched without a token therefore resolves to
 * **no bridge** rather than to an unauthenticated one, which is the fail-closed direction: the
 * surface behaves exactly as it does when the transport is absent.
 */
export function bridgeUrlForLaunch(search: string, hash: string, enabled: boolean): string | null {
  if (!enabled) return null;
  const bridge = new URLSearchParams(search).get('bridge');
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  if (!bridge || !token) return null;
  // The bridge URL keeps the token as its own fragment and nothing else, so there is exactly one
  // credential per launch and it never reaches a request line.
  return `${bridge.replace(/#.*$/, '')}#token=${encodeURIComponent(token)}`;
}
