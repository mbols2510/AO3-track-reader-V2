import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** A JSON file kept in memory and written atomically (debounced). */
export class JsonStore<T extends object> {
  data: T;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly path: string, defaults: () => T) {
    mkdirSync(dirname(path), { recursive: true });
    let loaded: Partial<T> = {};
    if (existsSync(path)) {
      try {
        loaded = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        // Keep the corrupt file for inspection rather than silently losing data.
        copyFileSync(path, `${path}.corrupt-${Date.now()}`);
      }
    }
    this.data = { ...defaults(), ...loaded };
  }

  save(delayMs = 500) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delayMs);
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.path);
  }
}
