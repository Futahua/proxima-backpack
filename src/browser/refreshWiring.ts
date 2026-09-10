import type { RefreshReason } from '../app/refreshController.js';

export interface RefreshEventTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

export interface RefreshVisibilityTarget extends RefreshEventTarget {
  visibilityState: 'visible' | 'hidden' | string;
}

export interface RefreshWiringOptions {
  documentTarget: RefreshVisibilityTarget;
  windowTarget: RefreshEventTarget;
  setVisible: (visible: boolean, options: { refreshOnVisible: boolean }) => void;
  refresh: (reason: Extract<RefreshReason, 'focus'>) => void | Promise<unknown>;
}

/** Browser-only trigger adapter; source reads remain in SourceSession. */
export function bindRefreshWiring(options: RefreshWiringOptions): () => void {
  const visible = (): boolean => options.documentTarget.visibilityState !== 'hidden';
  const onVisibilityChange = (): void => options.setVisible(visible(), { refreshOnVisible: false });
  const onFocus = (): void => { if (visible()) void options.refresh('focus'); };
  options.setVisible(visible(), { refreshOnVisible: false });
  options.documentTarget.addEventListener('visibilitychange', onVisibilityChange);
  options.windowTarget.addEventListener('focus', onFocus);
  return () => {
    options.documentTarget.removeEventListener?.('visibilitychange', onVisibilityChange);
    options.windowTarget.removeEventListener?.('focus', onFocus);
  };
}
