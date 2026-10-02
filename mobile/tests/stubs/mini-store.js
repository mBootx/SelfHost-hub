// A tiny zustand-like store: getState, setState and subscribe((state, prev) => ...).
module.exports = function miniStore(initial) {
  const listeners = new Set()
  let state = initial
  const api = {
    getState: () => state,
    setState: (partial) => {
      const prev = state
      state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) }
      listeners.forEach((l) => l(state, prev))
    },
    subscribe: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    }
  }
  return Object.assign((selector) => selector(state), api)
}
