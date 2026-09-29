export interface XhrRequestConfig {
  url: string
  method?: string
  headers?: Record<string, string>
  data?: unknown
  timeout?: number
}

export interface XhrResponse {
  ok: boolean
  status: number
  data: any
  headers: Record<string, string>
  error?: string
}

/**
 * React Native's XMLHttpRequest polyfill exposes every response header
 * (including Set-Cookie) via getAllResponseHeaders() - unlike a browser,
 * which strips it for CORS reasons that don't apply to a native app. That
 * makes XHR the only reliable way to read the FileBrowser Quantum login
 * cookie ourselves, since there's no shared cookie jar to lean on instead.
 */
export function xhrRequest(config: XhrRequestConfig): Promise<XhrResponse> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open(config.method || 'GET', config.url, true)
    xhr.timeout = config.timeout ?? 20000
    if (config.headers) {
      for (const [key, value] of Object.entries(config.headers)) {
        xhr.setRequestHeader(key, value)
      }
    }
    xhr.onload = () => {
      const headers: Record<string, string> = {}
      xhr
        .getAllResponseHeaders()
        .trim()
        .split(/[\r\n]+/)
        .forEach((line) => {
          if (!line) return
          const parts = line.split(': ')
          const key = parts.shift()
          if (key) headers[key.toLowerCase()] = parts.join(': ')
        })
      let data: any = xhr.responseText
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        // not JSON, keep the raw text
      }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data, headers })
    }
    xhr.onerror = () => resolve({ ok: false, status: 0, data: null, headers: {}, error: 'Erreur réseau' })
    xhr.ontimeout = () => resolve({ ok: false, status: 0, data: null, headers: {}, error: 'Délai dépassé' })
    xhr.send(config.data !== undefined ? JSON.stringify(config.data) : undefined)
  })
}
