/**
 * Host-neutral durable recovery adapter. The Papers/native or test boundary owns
 * the actual file/OPFS journal; the application never imports Node filesystem APIs.
 */
export {
  createDurableRecoveryStore,
  type RecoveryJournalBackend,
} from '../app/vaultRecovery.js';
