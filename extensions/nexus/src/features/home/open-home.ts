// Keeps the Nexus home in front whenever nothing else is (PLAN L1-22, extension half; the tab-less look is the core
// change in L1-02). It opens the home at startup if no editor is open, and reopens it, debounced, whenever the last
// editor closes. It never opens a second home: it acts only while the editor area is completely empty.

export interface HomeKeeperDeps {
  /** Number of open editor tabs across all groups. */
  tabCount(): number;
  /** Opens the home (the `nexus.openHome` command, owned by Lane 3). */
  openHome(): Promise<void>;
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  /** Called when openHome fails (e.g. the command is not registered yet). */
  onError?(error: unknown): void;
  debounceMs?: number;
}

export const HOME_DEBOUNCE_MS = 150;
const RETRY_DELAYS_MS = [2000, 5000, 10000];

export class HomeKeeper {
  private timer: unknown;
  private opening = false;
  private disposed = false;
  private failures = 0;

  constructor(private readonly deps: HomeKeeperDeps) {}

  /** At startup: open the home if the editor area is empty. */
  start(): void {
    this.tabsChanged();
  }

  /** Call on every tab-group change. Safe to call often. */
  tabsChanged(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) this.deps.cancel(this.timer);
    if (this.deps.tabCount() > 0) { this.timer = undefined; this.failures = 0; return; }
    this.timer = this.deps.schedule(() => { this.timer = undefined; void this.reopen(); }, this.deps.debounceMs ?? HOME_DEBOUNCE_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) this.deps.cancel(this.timer);
    this.timer = undefined;
  }

  private async reopen(): Promise<void> {
    if (this.disposed || this.opening || this.deps.tabCount() > 0) return;     // something opened in the meantime
    this.opening = true;
    try {
      await this.deps.openHome();
      this.failures = 0;
    } catch (e) {
      this.deps.onError?.(e);
      // The home command may simply not be registered yet at startup: try again a few times, then wait for a tab change.
      const delay = RETRY_DELAYS_MS[this.failures++];
      if (delay !== undefined && !this.disposed) this.timer = this.deps.schedule(() => { this.timer = undefined; void this.reopen(); }, delay);
    } finally {
      this.opening = false;
    }
  }
}
