export type BootState = 'loading' | 'ready' | 'error';

/** Boot lifecycle owns lifecycle flags only; source mode is assigned after resolution. */
export function applyBootState(dataset: { [key: string]: string | undefined }, state: BootState): void {
  dataset.proximaHydrated = state === 'ready' ? 'true' : 'false';
  dataset.proximaBootState = state;
}
