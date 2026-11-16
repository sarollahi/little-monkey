/**
 * Intentional session deletion must win over automatic daemon discovery.
 * Deleting an open chat does not cancel its resident run, but a background
 * observer must not recreate that chat on the next five-second poll.
 *
 * IDs only, never prompts, model targets or workspace grants. This local
 * durable marker applies across the desktop windows sharing the Tauri origin.
 */
const KEY = "little-monkey-dismissed-daemon-sessions-v1";
const MAX_IDS = 4096;
const VALID_SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const dismissedInMemory = new Set<string>();

function storedIds(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string =>
      typeof entry === "string" && VALID_SESSION_ID.test(entry));
  } catch {
    return [];
  }
}

export function isDaemonSessionDismissed(sessionId: string): boolean {
  return dismissedInMemory.has(sessionId) || storedIds().includes(sessionId);
}

export function rememberDaemonSessionDismissal(sessionId: string): void {
  if (!VALID_SESSION_ID.test(sessionId)) return;
  dismissedInMemory.add(sessionId);
  const ids = [...storedIds().filter(id => id !== sessionId), sessionId]
    .slice(-MAX_IDS);
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    // In-memory suppression still prevents a same-process resurrection.
    // When storage is unavailable, preservation across a restart is not
    // guaranteed; it never authorizes another run.
  }
}
