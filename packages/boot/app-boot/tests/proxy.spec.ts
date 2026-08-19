/**
 * System-proxy adoption: environment precedence, Windows registry parsing,
 * and the one-shot global-dispatcher installation.
 */
import { describe, expect, it } from 'vitest'
import { applySystemProxy, envProxyUrl, windowsSystemProxyUrl } from '../src/proxy.ts'

describe('envProxyUrl', () => {
  it('prefers HTTPS_PROXY over HTTP_PROXY, ignoring empty values', () => {
    expect(envProxyUrl({ HTTPS_PROXY: 'http://proxy:1' })).toBe('http://proxy:1')
    expect(envProxyUrl({ HTTPS_PROXY: '', HTTP_PROXY: 'http://proxy:2' })).toBe('http://proxy:2')
    expect(envProxyUrl({ https_proxy: 'http://proxy:3', http_proxy: 'http://proxy:4' })).toBe('http://proxy:3')
    expect(envProxyUrl({ HTTP_PROXY: 'http://proxy:4' })).toBe('http://proxy:4')
    expect(envProxyUrl({ HTTPS_PROXY: '  ' })).toBeUndefined()
    expect(envProxyUrl({})).toBeUndefined()
  })
})

describe('windowsSystemProxyUrl', () => {
  it('resolves a bare host:port when the system proxy is enabled', () => {
    const registry = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '    ProxyEnable    REG_DWORD    0x1',
      '    ProxyServer    REG_SZ    127.0.0.1:10808',
    ].join('\r\n')
    expect(windowsSystemProxyUrl(registry)).toBe('http://127.0.0.1:10808')
  })

  it('prefers the https entry of a per-protocol list', () => {
    const registry = [
      'ProxyEnable    REG_DWORD    0x1',
      'ProxyServer    REG_SZ    http=127.0.0.1:8080;https=127.0.0.1:8443',
    ].join('\r\n')
    expect(windowsSystemProxyUrl(registry)).toBe('http://127.0.0.1:8443')
  })

  it('keeps an explicit scheme and answers undefined when the proxy is off or empty', () => {
    expect(windowsSystemProxyUrl([
      'ProxyEnable    REG_DWORD    0x1',
      'ProxyServer    REG_SZ    https://proxy.example:1080',
    ].join('\r\n'))).toBe('https://proxy.example:1080')
    expect(windowsSystemProxyUrl('ProxyEnable    REG_DWORD    0x0')).toBeUndefined()
    expect(windowsSystemProxyUrl('ProxyEnable    REG_DWORD    0x1')).toBeUndefined()
    expect(windowsSystemProxyUrl('')).toBeUndefined()
  })
})

describe('applySystemProxy', () => {
  it('adopts the environment proxy and defaults NO_PROXY to loopback', () => {
    const env: Record<string, string | undefined> = { HTTPS_PROXY: 'http://proxy:1' }
    applySystemProxy({ env, dryRun: true })
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1')
  })

  it('respects an existing NO_PROXY instead of replacing it', () => {
    const env: Record<string, string | undefined> = { HTTPS_PROXY: 'http://proxy:1', NO_PROXY: '*.internal' }
    applySystemProxy({ env, dryRun: true })
    expect(env.NO_PROXY).toBe('*.internal')
  })

  it('adopts the Windows system proxy into the environment on win32', () => {
    const env: Record<string, string | undefined> = {}
    applySystemProxy({
      platform: 'win32',
      env,
      registryText: [
        'ProxyEnable    REG_DWORD    0x1',
        'ProxyServer    REG_SZ    127.0.0.1:10808',
      ].join('\r\n'),
      dryRun: true,
    })
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:10808')
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1')
  })

  it('does nothing on non-Windows platforms without an explicit proxy', () => {
    const env: Record<string, string | undefined> = {}
    applySystemProxy({ platform: 'linux', env, dryRun: true })
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.NO_PROXY).toBeUndefined()
  })
})
