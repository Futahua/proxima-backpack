/**
 * Types for the Node-only tools.
 *
 * These modules are plain `.mjs` because they run outside the browser build and use
 * `node:` builtins that `src/` deliberately cannot compile against. Declaring their
 * shapes here keeps the test suite typechecked rather than letting the boundary
 * become an untyped hole.
 */

declare module '*/tree-fingerprint.mjs' {
  export type TreeFingerprint = Map<string, string>;
  export function fingerprint(root: string): Promise<TreeFingerprint>;
  export function changedPaths(before: TreeFingerprint, after: TreeFingerprint): string[];
}

declare module '*/agent-accept.mjs' {
  export const ACCEPTANCE_SCHEMA_VERSION: 1;

  export interface AcceptanceCounts {
    projects: number;
    tasks: number;
    events: number;
    problems: number;
    records: number;
  }

  export interface AcceptanceReport {
    schemaVersion: 1;
    status: 'PASS' | 'BLOCKED' | 'ABORTED';
    transport: 'loopback-agent-bridge';
    papersHosted: false;
    readOnly: true;
    stages: Record<string, 'PASS' | 'FAIL'>;
    blockerCodes: string[];
    observedReads: number;
    counts: AcceptanceCounts | null;
    open: string[];
  }

  export interface AcceptanceOptions {
    /** Explicitly supplied source root. Never discovered or guessed. */
    root?: string;
    /** Bridge port; 0 or omitted asks the OS for an ephemeral one. */
    port?: number;
    /** Paths a caller deliberately changed, subtracted from the effect witness. */
    declaredPeerWrites?: string[];
    /** Regression hook: hand the unwrapped reader over so the witness sees nothing. */
    unwireWitness?: boolean;
    /** Supply an already-running bridge instead of spawning one. */
    spawnBridge?: (root: string, port: number) => Promise<{ child: unknown; port: number; output: string[] }>;
  }

  export function runAcceptance(options?: AcceptanceOptions): Promise<AcceptanceReport>;

  /** Path-specific attribution of on-disk changes to declared peer operations. */
  export function evaluateTreeDelta(
    before: Map<string, string>,
    after: Map<string, string>,
    declaredPeerWrites?: string[],
  ): { ok: boolean; unattributed: string[] };
}
