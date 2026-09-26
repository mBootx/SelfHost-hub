export type ServiceKey = 'navidrome' | 'filebrowser' | 'downtify'

export interface SavedConnection {
  url: string
  username: string
}

const secretKey = (service: ServiceKey, field: string): string => `${service}.${field}`

export const storage = {
  async saveConnection(service: ServiceKey, conn: SavedConnection): Promise<void> {
    await window.api.store.set(`${service}.connection`, conn)
  },
  async loadConnection(service: ServiceKey): Promise<SavedConnection | null> {
    return (await window.api.store.get(`${service}.connection`)) as SavedConnection | null
  },
  async clearConnection(service: ServiceKey): Promise<void> {
    await window.api.store.delete(`${service}.connection`)
  },

  async saveSecret(service: ServiceKey, field: string, value: string): Promise<void> {
    await window.api.secure.set(secretKey(service, field), value)
  },
  async loadSecret(service: ServiceKey, field: string): Promise<string | null> {
    return window.api.secure.get(secretKey(service, field))
  },
  async clearSecret(service: ServiceKey, field: string): Promise<void> {
    await window.api.secure.delete(secretKey(service, field))
  },

  async savePref<T>(key: string, value: T): Promise<void> {
    await window.api.store.set(`prefs.${key}`, value)
  },
  async loadPref<T>(key: string): Promise<T | null> {
    return (await window.api.store.get(`prefs.${key}`)) as T | null
  }
}
