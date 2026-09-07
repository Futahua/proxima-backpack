/** Resolve the optional agent bridge only in a build explicitly enabled for it. */
export function bridgeUrlForLaunch(search: string, enabled: boolean): string | null {
  if (!enabled) return null;
  return new URLSearchParams(search).get('bridge');
}
