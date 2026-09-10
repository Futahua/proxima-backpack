/**
 * The vocabulary every Proxima action is classified by.
 *
 * Two separate questions get asked about an action, and conflating them is how the old
 * plugin ended up writing cockpit preferences into creator files:
 *
 *   category — what does performing this action COST?  Nothing durable, some disposable
 *              cockpit state, a canonical record, or an ordinary vault file.
 *   outcome  — what actually HAPPENED?  One machine-readable answer, never inferred by
 *              the caller from the absence of an error.
 *
 * The outcome vocabulary exists because an agent is a first-class caller. "It did not
 * throw" is not an answer an agent can act on: losing a race, being refused for staleness
 * and failing to reach storage require three different responses, and only the last is a
 * reason to alarm anyone.
 */
export const ACTION_TAXONOMY_VERSION = 2 as const;

/**
 * `presentation` and `local-state` are the two halves that need no write authority.
 * `record-mutation` and `artifact-mutation` are separate because they have different
 * concurrency stories: records are Proxima-owned and single-writer, ordinary vault
 * artifacts are shared with whatever else edits the vault.
 */
export type ActionCategory = 'presentation' | 'local-state' | 'record-mutation' | 'artifact-mutation';

export type ActionOutcome =
  | 'accepted'
  | 'validation-refused'
  | 'not-found'
  | 'stale-revision'
  | 'semantic-conflict'
  | 'unavailable'
  | 'recovery-required'
  | 'storage-failure';

export type ActionErrorCode =
  | 'invalid-action'
  | 'invalid-action-input'
  | 'project-not-found'
  | 'record-not-found'
  | 'action-not-available'
  | 'stale-revision'
  | 'semantic-conflict'
  | 'recovery-required'
  | 'storage-failure';

export const ACTION_CATEGORIES: readonly ActionCategory[] = [
  'presentation',
  'local-state',
  'record-mutation',
  'artifact-mutation',
];

export const ACTION_OUTCOMES: readonly ActionOutcome[] = [
  'accepted',
  'validation-refused',
  'not-found',
  'stale-revision',
  'semantic-conflict',
  'unavailable',
  'recovery-required',
  'storage-failure',
];

/**
 * Every action type in the union maps here. A type with no entry is a programming
 * error rather than a default, so `categoryOf` returns undefined instead of guessing:
 * defaulting an unregistered mutation to `presentation` would let a durable write
 * through a boundary that believes nothing durable happens.
 */
const REGISTRY = {
  'project.select': 'local-state',
  'surface.select': 'local-state',
  'tasks.mode.select': 'local-state',
  'timekeeping.panel.set-visible': 'local-state',
  'task.timeline.change': 'record-mutation',
  'elastic.target.set': 'local-state',
  'elastic.lock': 'local-state',
  'elastic.unlock': 'local-state',
  'task.execution.move': 'record-mutation',
  'event.schedule.change': 'record-mutation',
  'schedule.mode.select': 'local-state',
  'project.workspace-tab.select': 'local-state',
  'calendar.navigate': 'local-state',
  'calendar.today': 'local-state',
  'calendar.shift-month': 'local-state',
  'fixture.reset': 'local-state',
} as const satisfies Readonly<Record<string, ActionCategory>>;

export type RegisteredActionType = keyof typeof REGISTRY;

export function categoryOf(actionType: string): ActionCategory | undefined {
  return Object.prototype.hasOwnProperty.call(REGISTRY, actionType)
    ? REGISTRY[actionType as RegisteredActionType]
    : undefined;
}

export function registeredActionTypes(): RegisteredActionType[] {
  return (Object.keys(REGISTRY) as RegisteredActionType[]).sort();
}

/** A category that can change something the creator would miss if it vanished. */
export function isMutationCategory(category: ActionCategory): boolean {
  return category === 'record-mutation' || category === 'artifact-mutation';
}

export function outcomeForErrorCode(code: ActionErrorCode): Exclude<ActionOutcome, 'accepted'> {
  switch (code) {
    case 'invalid-action':
    case 'invalid-action-input':
      return 'validation-refused';
    case 'project-not-found':
    case 'record-not-found':
      return 'not-found';
    case 'action-not-available':
      return 'unavailable';
    case 'stale-revision':
      return 'stale-revision';
    case 'semantic-conflict':
      return 'semantic-conflict';
    case 'recovery-required':
      return 'recovery-required';
    case 'storage-failure':
      return 'storage-failure';
  }
}

/**
 * The caller observed an older revision than the store holds, so re-reading and
 * re-deciding is a sensible response. Retrying the identical request is not: the
 * refusal was correct, and a blind retry against a moved record is how a toggle
 * silently undoes somebody else's edit.
 */
export function isRetryableAfterRefetch(outcome: ActionOutcome): boolean {
  return outcome === 'stale-revision' || outcome === 'semantic-conflict';
}

/**
 * The request may or may not have taken effect and the store cannot yet say which.
 * A caller must not present this as either success or failure, and must not retry:
 * reconciliation decides, on evidence, what actually happened.
 */
export function isAmbiguousOutcome(outcome: ActionOutcome): boolean {
  return outcome === 'recovery-required';
}

/** Nothing happened and nothing will happen until the caller changes the request. */
export function isTerminalRefusal(outcome: ActionOutcome): boolean {
  return outcome === 'validation-refused' || outcome === 'not-found' || outcome === 'unavailable';
}

export function isActionCategory(value: unknown): value is ActionCategory {
  return typeof value === 'string' && (ACTION_CATEGORIES as readonly string[]).includes(value);
}

export function isActionOutcome(value: unknown): value is ActionOutcome {
  return typeof value === 'string' && (ACTION_OUTCOMES as readonly string[]).includes(value);
}

export function isActionErrorCode(value: unknown): value is ActionErrorCode {
  switch (value) {
    case 'invalid-action':
    case 'invalid-action-input':
    case 'project-not-found':
    case 'record-not-found':
    case 'action-not-available':
    case 'stale-revision':
    case 'semantic-conflict':
    case 'recovery-required':
    case 'storage-failure':
      return true;
    default:
      return false;
  }
}
