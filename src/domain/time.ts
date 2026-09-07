/**
 * Presentation of time. Pure, and always given "now" rather than reading a clock.
 * Ported from the plugin's utils.ts; the Obsidian theme token in the contrast
 * helper is replaced by a Proxima-owned token.
 */

export function formatAge(createdAtIso: string, now: number): string {
  const diff = now - new Date(createdAtIso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function formatCountdown(diffMs: number): string {
  const isPast = diffMs < 0;
  const totalSeconds = Math.floor(Math.abs(diffMs) / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  let text = '';
  if (days > 0) text += `${days}d `;
  if (hours > 0) text += `${hours}h `;
  text += `${minutes}m ${seconds}s`;
  return isPast ? `overdue by ${text}` : text;
}

/** Deadline urgency as a hue. Purple is overdue; red is under a day. */
export function deadlineHue(remainingMs: number): string {
  if (remainingMs < 0) return 'hsl(300, 60%, 85%)';
  const days = remainingMs / 86400000;
  if (days > 30) return 'hsl(210, 60%, 85%)';
  if (days >= 7) return 'hsl(180, 60%, 85%)';
  if (days >= 3) return 'hsl(60, 70%, 85%)';
  if (days >= 1) return 'hsl(30, 90%, 80%)';
  return 'hsl(0, 90%, 80%)';
}

export function formatDuration(minutes: number): string {
  const whole = Math.round(minutes);
  return whole >= 60 ? `${Math.floor(whole / 60)}h ${whole % 60}m` : `${whole}m`;
}

/** Calendar date in the viewer's local zone, as YYYY-MM-DD. */
export function localDateKey(value: string | number | Date): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = value instanceof Date ? value : new Date(value);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatClockTime(value: string | number | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function contrastText(hexColor: string): string {
  if (!hexColor || !hexColor.startsWith('#')) return 'var(--proxima-text)';
  const hex = hexColor.replace('#', '');
  if (hex.length !== 6) return 'var(--proxima-text)';
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 128 ? '#111111' : '#ffffff';
}
