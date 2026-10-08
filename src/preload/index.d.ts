import type { QueryForgeApi } from './index'

declare global {
  interface Window {
    api: QueryForgeApi
  }
}
