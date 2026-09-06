import { createMemoryVault } from '../adapters/memoryVault.js';
import { loadVaultState } from '../app/vaultRepository.js';
import { fixedClock, sequentialIdGenerator } from '../domain/clock.js';
import { BUILD_IDENTITY } from './generated/buildIdentity.generated.js';
import { FIXTURE_VAULTS } from './generated/fixtureVault.generated.js';

const FIXTURE_NAME = 'vault-basic';
const FIXTURE_ROOT = FIXTURE_VAULTS[FIXTURE_NAME];
const FIXED_CLOCK = fixedClock(BUILD_IDENTITY.fixedClock);
const DETERMINISTIC_IDS = sequentialIdGenerator();

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Proxima boot element missing: ${selector}`);
  return found;
}

function setText(selector: string, text: string): void {
  element<HTMLElement>(selector).textContent = text;
}

function setBootState(state: 'loading' | 'ready' | 'error'): void {
  const root = element<HTMLElement>('#proxima-app');
  root.dataset.proximaMode = 'fixture';
  root.dataset.proximaHydrated = state === 'ready' ? 'true' : 'false';
  root.dataset.proximaBootState = state;
}

async function boot(): Promise<void> {
  setBootState('loading');
  const vault = createMemoryVault(FIXTURE_ROOT);
  const loaded = await loadVaultState(vault);
  const hydrationRevision = `fixture:${BUILD_IDENTITY.fixtureHash.slice(0, 16)}:1`;

  element<HTMLElement>('#proxima-app').dataset.proximaFixture = FIXTURE_NAME;
  element<HTMLElement>('#proxima-app').dataset.proximaClock = new Date(FIXED_CLOCK.now()).toISOString();
  element<HTMLElement>('#proxima-app').dataset.proximaIdSeed = DETERMINISTIC_IDS.next('fixture');
  setText('#boot-mode', 'Fixture mode — bundled vault bytes');
  setText('#boot-status', 'Hydrated');
  setText(
    '#hydration-summary',
    JSON.stringify(
      {
        mode: 'fixture',
        fixture: FIXTURE_NAME,
        hydrationRevision,
        projects: loaded.state.projects.length,
        tasks: loaded.state.tasks.length,
        events: loaded.state.events.length,
        problems: loaded.problems.length,
        fixedClock: BUILD_IDENTITY.fixedClock,
        deterministicIds: true,
      },
      null,
      2,
    ),
  );
  setText('#build-identity', JSON.stringify(BUILD_IDENTITY, null, 2));
  setBootState('ready');
}

boot().catch((error: unknown) => {
  setBootState('error');
  setText('#boot-status', 'Fixture boot failed');
  setText('#hydration-summary', error instanceof Error ? error.message : String(error));
});
