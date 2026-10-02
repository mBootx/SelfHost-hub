// Just enough of zustand for the phone's watch link and diagnostics under real-phone.js, so that the harness needs
// nothing but esbuild (no install of the phone app's dependencies).
exports.create = (init) => {
  let state
  const listeners = new Set()
  const getState = () => state
  const setState = (partial) => {
    const previous = state
    state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) }
    listeners.forEach((listener) => listener(state, previous))
  }
  const subscribe = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  state = init(setState, getState)
  const useStore = (selector) => (selector ? selector(state) : state)
  return Object.assign(useStore, { getState, setState, subscribe })
}
