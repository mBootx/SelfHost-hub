import type { HubApi } from './index'

declare global {
  interface Window {
    api: HubApi
  }
}
