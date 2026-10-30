// Listener callbacks must return before model I/O: Empirica awaits them
// while holding its shared event mutex. Claim synchronously, observe every
// rejection, and expose drain only for shutdown/tests (never await in a listener).
export function createBackgroundTasks({ onError = console.error } = {}) {
  const tasks = new Map();
  return {
    launch(key, run) {
      if (tasks.has(key)) return false;
      tasks.set(key, null);
      let result;
      try { result = run(); } catch (error) { result = Promise.reject(error); }
      const task = Promise.resolve(result).catch(error => onError(error, key)).finally(() => tasks.delete(key));
      tasks.set(key, task);
      return true;
    },
    async drain() { while (tasks.size) await Promise.all([...tasks.values()]); },
  };
}
