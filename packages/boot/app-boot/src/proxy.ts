/**
 * System-proxy adoption for the host process's HTTP traffic.
 *
 * Node's built-in `fetch` ignores both the system proxy and proxy environment
 * variables, so a machine that reaches the internet through a local proxy
 * (browsers and most native CLIs honor it; the harness's Node requests do
 * not) fails every outbound call with the proxy-less result — for ChatGPT
 * OAuth this surfaces as OpenAI's region refusal. This module installs undici
 *'s environment-proxy agent once, from an explicit `HTTPS_PROXY`/`HTTP_PROXY`
 * or, on Windows, from the system proxy (`HKCU\...\Internet Settings`).
 * `NO_PROXY` defaults to the loopback addresses so local servers are never
 * routed through the proxy.
 *
 * @module @deepseek-ai/dsh-app-boot/proxy
 */

import { spawnSync } from 'node:child_process'
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'

/** Windows system-proxy registry key. */
const WIN_INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** The proxy-independent loopback default for `NO_PROXY`. */
const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1'

/** Injectable facts for deterministic tests. */
export interface SystemProxyInternals {
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  /** Windows registry query output; absent lets the module query `reg.exe`. */
  registryText?: string
  /** Skip installing the global dispatcher (pure-resolution test seam). */
  dryRun?: boolean
}

/**
 * The proxy URL an environment names, if any. `HTTPS_PROXY` wins over
 * `HTTP_PROXY` (case-insensitive per convention), because HTTPS traffic is
 * the case that needs a proxy at all.
 * @param env - environment mapping.
 * @returns the proxy URL, or `undefined` when none is named.
 */
export function envProxyUrl(env: Record<string, string | undefined>): string | undefined {
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const value = env[name]
    if (value !== undefined && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * The proxy URL the Windows system-proxy registry declares, if enabled.
 * `ProxyServer` may be a bare `host:port` or a per-protocol list such as
 * `http=127.0.0.1:8080;https=127.0.0.1:8080`; the https entry wins, and a
 * scheme-less value becomes `http://…`.
 * @param registryText - `reg.exe query` output for the Internet Settings key.
 * @returns the https proxy URL, or `undefined` when the system proxy is off.
 */
export function windowsSystemProxyUrl(registryText: string): string | undefined {
  const enable = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(registryText)?.[1]
  if (enable === undefined || parseInt(enable, 16) !== 1) return undefined
  const declared = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(registryText)?.[1]
  if (declared === undefined || declared.length === 0) return undefined
  const https = declared.split(';')
    .map(entry => entry.trim())
    .find(entry => entry.toLowerCase().startsWith('https='))
  const server = https === undefined ? declared : https.slice('https='.length)
  if (server.length === 0) return undefined
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(server) ? server : `http://${server}`
}

/** Ensure the loopback default protects local servers when no NO_PROXY exists. */
function defaultNoProxy(env: Record<string, string | undefined>): void {
  if (env.NO_PROXY !== undefined || env.no_proxy !== undefined) return
  env.NO_PROXY = DEFAULT_NO_PROXY
}

/**
 * Install the environment-proxy agent for the whole process, once. The
 * effective proxy is the environment's own `HTTPS_PROXY`/`HTTP_PROXY` when
 * one is set; otherwise, on Windows, the system proxy is adopted into the
 * process environment first. Non-Windows platforms without an explicit proxy
 * environment stay unproxied — there is no portable system-proxy query for
 * them here.
 * @param internals - platform, environment, and registry seams for tests.
 */
export function applySystemProxy(internals: SystemProxyInternals = {}): void {
  if (applied) return
  const env = internals.env ?? process.env
  let proxy = envProxyUrl(env)
  if (proxy === undefined && (internals.platform ?? process.platform) === 'win32') {
    let registryText = internals.registryText
    if (registryText === undefined) {
      const result = spawnSync('reg.exe', ['query', WIN_INTERNET_SETTINGS_KEY], { encoding: 'utf8' })
      registryText = result.stdout
    }
    proxy = windowsSystemProxyUrl(registryText)
    if (proxy !== undefined) env.HTTPS_PROXY = proxy
  }
  if (proxy === undefined) {
    // One decision per process, proxy or none: the dispatcher is process-global.
    applied = true
    return
  }
  // Whatever the proxy's origin, the loopback default keeps local servers
  // (the GUI itself, test carriers) off the proxy.
  defaultNoProxy(env)
  if (internals.dryRun === true) return
  applied = true
  setGlobalDispatcher(new EnvHttpProxyAgent())
}

/** One installation per process: the dispatcher is process-global. */
let applied = false
