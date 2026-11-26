// Remembers that "Here's what I figured out" was closed for one setup run (keyed by the run's setupAt), so Settings
// stops offering it. Storage can be unavailable (private mode); then it simply shows once per session.
const KEY = "paper-trail:figured-out-dismissed";

export function figuredOutDismissed(setupAt: string | null): boolean {
  if (setupAt === null) return true;
  try {
    return window.localStorage.getItem(KEY) === setupAt;
  } catch {
    return false;
  }
}

export function dismissFiguredOut(setupAt: string | null): void {
  if (setupAt === null) return;
  try {
    window.localStorage.setItem(KEY, setupAt);
  } catch {
    // ignore
  }
}
