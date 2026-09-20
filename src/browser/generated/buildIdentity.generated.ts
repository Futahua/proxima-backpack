// Standalone build identity. This file intentionally contains no fixture hash or vault data.
export const BUILD_IDENTITY = {
  proximaVersion: '0.1.0',
  gitSha: 'working-tree',
  buildMode: 'standalone',
  agentBridgeEnabled: false,
  domainSchemaVersion: '1',
  controlSchemaVersion: '0',
  fixtureSchemaVersion: 'none',
  fixtureHash: 'none',
  lockfileHash: 'not-applicable',
  fixedClock: '2026-09-06T12:00:00.000Z',
} as const;
