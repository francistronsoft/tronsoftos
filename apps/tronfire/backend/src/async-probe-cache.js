export class AsyncProbeCache {
  constructor({ ttlMs, staleMs = ttlMs }) {
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.staleMs = Math.max(this.ttlMs, Number(staleMs) || this.ttlMs);
    this.entries = new Map();
    this.inFlight = new Map();
  }

  async get(key, loader, { force = false, allowStale = true } = {}) {
    const now = Date.now();
    const current = this.entries.get(key);
    if (!force && current && now - current.loadedAt < this.ttlMs) return current.value;

    const pending = this.inFlight.get(key);
    if (pending) return this.resolve(pending, key, allowStale);

    const load = Promise.resolve()
      .then(loader)
      .then(value => {
        this.entries.set(key, { value, loadedAt: Date.now() });
        return value;
      })
      .finally(() => {
        if (this.inFlight.get(key) === load) this.inFlight.delete(key);
      });

    this.inFlight.set(key, load);
    return this.resolve(load, key, allowStale);
  }

  async resolve(load, key, allowStale) {
    try {
      return await load;
    } catch (error) {
      const fallback = this.entries.get(key);
      if (allowStale && fallback && Date.now() - fallback.loadedAt < this.staleMs) return fallback.value;
      throw error;
    }
  }

  invalidate(key) {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }
}
