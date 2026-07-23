export function createMemoryKv(options = {}) {
  const store = new Map();
  let nowFn = options.now || (() => Date.now());

  function isExpired(entry, now) {
    return entry.expiresAt != null && now >= entry.expiresAt;
  }

  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (isExpired(entry, nowFn())) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(key, value, putOptions = {}) {
      const now = nowFn();
      let expiresAt = null;
      if (putOptions.expirationTtl != null) {
        expiresAt = now + Number(putOptions.expirationTtl) * 1000;
      }
      store.set(key, { value: String(value), expiresAt });
    },
    async delete(key) {
      store.delete(key);
    },
    _setNow(fnOrMs) {
      if (typeof fnOrMs === "function") nowFn = fnOrMs;
      else nowFn = () => fnOrMs;
    }
  };
}
