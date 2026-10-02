import * as SecureStore from 'expo-secure-store'
import AsyncStorage from '@react-native-async-storage/async-storage'

export type ServiceKey = 'navidrome' | 'filebrowser' | 'downtify' | 'remote'

export interface SavedConnection {
  url: string
  username: string
}

const secretKey = (service: ServiceKey, field: string): string => `${service}_${field}`

export const storage = {
  async saveConnection(service: ServiceKey, conn: SavedConnection): Promise<void> {
    await AsyncStorage.setItem(`${service}.connection`, JSON.stringify(conn))
  },
  async loadConnection(service: ServiceKey): Promise<SavedConnection | null> {
    const raw = await AsyncStorage.getItem(`${service}.connection`)
    return raw ? (JSON.parse(raw) as SavedConnection) : null
  },
  async clearConnection(service: ServiceKey): Promise<void> {
    await AsyncStorage.removeItem(`${service}.connection`)
  },

  async saveSecret(service: ServiceKey, field: string, value: string): Promise<void> {
    await SecureStore.setItemAsync(secretKey(service, field), value)
  },
  async loadSecret(service: ServiceKey, field: string): Promise<string | null> {
    return SecureStore.getItemAsync(secretKey(service, field))
  },
  async clearSecret(service: ServiceKey, field: string): Promise<void> {
    await SecureStore.deleteItemAsync(secretKey(service, field))
  },

  async savePref<T>(key: string, value: T): Promise<void> {
    await AsyncStorage.setItem(`prefs.${key}`, JSON.stringify(value))
  },
  async loadPref<T>(key: string): Promise<T | null> {
    const raw = await AsyncStorage.getItem(`prefs.${key}`)
    return raw ? (JSON.parse(raw) as T) : null
  }
}
