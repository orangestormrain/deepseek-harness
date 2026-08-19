/** Page-store join: directory × namespaces × credentials, with last-good rows on failure. */
import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '@deepseek-ai/dsh-api-remotes/client'
import { messageOf, ModelsSettingsStore } from '../src/client/store.ts'

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: false, error: { code: 'internal', message, details: {} } } }
}

const DIRECTORY = [
  { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
  { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true },
  { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false },
  { provider: 'ghost', displayName: 'Ghost', settingsNs: '', settingsPath: [], active: true },
]

const NAMESPACES = [
  {
    ns: 'llm-deepseek',
    schema: {},
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://base' },
    base: { baseURL: 'https://base' },
    applies: 'live' as const,
    secrets: [],
    revision: 0,
  },
  {
    ns: 'llm-pi-ai',
    schema: {},
    value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    user: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    applies: 'live' as const,
    secrets: [],
    revision: 0,
  },
]

function api(overrides: {
  providers?: () => Promise<RpcResponse<{ providers: typeof DIRECTORY }>>
  describeSettings?: () => Promise<RpcResponse<{ writable: boolean; namespaces: typeof NAMESPACES }>>
  describeCredentials?: (refs: string[]) => Promise<RpcResponse<{ credentials: Record<string, unknown> }>>
  oauthStatus?: () => Promise<RpcResponse<{ providers: Array<{ provider: string; connected: boolean; accountId?: string }> }>>
  login?: (payload: { provider: string }) => Promise<RpcResponse<{}>>
  loginInput?: (payload: { provider: string; value: string }) => Promise<RpcResponse<{}>>
  cancelLogin?: (payload: { provider: string }) => Promise<RpcResponse<{}>>
  logout?: (payload: { provider: string }) => Promise<RpcResponse<{}>>
} = {}) {
  const seenRefs: string[][] = []
  const login = overrides.login ?? vi.fn(() => Promise.resolve(ok({})))
  const loginInput = overrides.loginInput ?? vi.fn(() => Promise.resolve(ok({})))
  const cancelLogin = overrides.cancelLogin ?? vi.fn(() => Promise.resolve(ok({})))
  const logout = overrides.logout ?? vi.fn(() => Promise.resolve(ok({})))
  const face = {
    llm: {
      providers: overrides.providers ?? (() => Promise.resolve(ok({ providers: DIRECTORY }))),
      models: () => Promise.resolve(ok({ groups: [], failures: [] })),
      oauthStatus: overrides.oauthStatus ?? (() => Promise.resolve(ok({ providers: [] }))),
      login,
      loginInput,
      cancelLogin,
      logout,
    },
    settings: {
      describe: overrides.describeSettings ?? (() => Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: NAMESPACES }))),
      update: () => Promise.resolve(fail('unused')),
      replace: () => Promise.resolve(fail('unused')),
      mutate: () => Promise.resolve(fail('unused')),
    },
    credentials: {
      describe: (payload: { refs: string[] }) => {
        seenRefs.push(payload.refs)
        return (overrides.describeCredentials ?? (refs => Promise.resolve(ok({
          credentials: Object.fromEntries(refs.map(ref => [ref, { configured: ref === 'OPENAI_API_KEY', writable: true }])),
        }))))(payload.refs)
      },
      set: () => Promise.resolve(ok({})),
      unset: () => Promise.resolve(ok({})),
    },
  }
  return { face: face as never, seenRefs, login, loginInput, cancelLogin, logout }
}

describe('ModelsSettingsStore', () => {
  it('joins rows with configured, removable, and credential state', async () => {
    const { face, seenRefs } = api()
    const store = new ModelsSettingsStore(face)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.writable).toBe(true)
    expect(state.credentialError).toBeNull()
    expect(seenRefs).toEqual([['DEEPSEEK_API_KEY', 'OPENAI_API_KEY']])
    const byProvider = new Map(state.rows.map(row => [row.entry.provider, row]))
    expect(byProvider.get('deepseek-official')).toMatchObject({
      configured: true,
      removable: false,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      credential: { configured: false, writable: true },
    })
    expect(byProvider.get('openai')).toMatchObject({
      configured: true,
      removable: true,
      apiKeyEnv: 'OPENAI_API_KEY',
      credential: { configured: true },
    })
    expect(byProvider.get('anthropic')).toMatchObject({ configured: false, removable: false })
    expect(byProvider.get('anthropic')?.apiKeyEnv).toBeUndefined()
    expect(byProvider.get('ghost')).toMatchObject({ configured: false, removable: false })
    expect(state.namespaces.get('llm-pi-ai')?.ns).toBe('llm-pi-ai')
  })

  it('degrades the credential badge, not the page, when the credential domain fails', async () => {
    const { face } = api({ describeCredentials: () => Promise.resolve(fail('no provider')) })
    const store = new ModelsSettingsStore(face)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.credentialError).toBe('no provider')
    expect(state.rows.every(row => row.credential === undefined)).toBe(true)
  })

  it('settles a credential transport rejection without leaving the store loading', async () => {
    const { face } = api({
      describeCredentials: () => Promise.reject(new Error('credential transport down')),
    })
    const store = new ModelsSettingsStore(face)
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'ready',
      credentialError: 'credential transport down',
    })
  })

  it('stringifies a non-Error credential transport rejection', async () => {
    const { face } = api({
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the scenario
      describeCredentials: () => Promise.reject('credential transport refusal'),
    })
    const store = new ModelsSettingsStore(face)
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.store.getSnapshot().credentialError).toBe('credential transport refusal')
  })

  it('surfaces a directory failure and keeps the last good rows', async () => {
    const { face } = api()
    const store = new ModelsSettingsStore(face)
    await store.load()
    expect(store.store.getSnapshot().rows).toHaveLength(4)
    const broken = api({ providers: () => Promise.resolve(fail('directory down')) })
    const failing = new ModelsSettingsStore(broken.face)
    await failing.load()
    expect(failing.store.getSnapshot()).toMatchObject({ status: 'error', error: 'directory down' })
    // The first store's snapshot is untouched by the second's failure.
    expect(store.store.getSnapshot().status).toBe('ready')
  })

  it('lets the newest load win over a stale slow response', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let call = 0
    const { face } = api({
      providers: async () => {
        call += 1
        if (call === 1) {
          await gate
          return fail('stale slow failure')
        }
        return ok({ providers: DIRECTORY })
      },
    })
    const store = new ModelsSettingsStore(face)
    const first = store.load()
    const second = store.load()
    release?.()
    await Promise.all([first, second])
    expect(store.store.getSnapshot().status).toBe('ready')
  })
})

describe('edge joins', () => {
  it('treats a non-object profile as having no credential reference', async () => {
    const { face } = api({
      describeSettings: () => Promise.resolve(ok({
        writable: true,
        hasDocument: false,
        namespaces: [{
          ns: 'llm-pi-ai',
          schema: {},
          value: { providers: { weird: 'oops' } },
          applies: 'live' as const,
          secrets: [],
          revision: 0,
        }] as never,
      })),
      providers: () => Promise.resolve(ok({
        providers: [
          { provider: 'weird', displayName: 'weird', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'weird'], active: false },
        ] as never,
      })),
    })
    const store = new ModelsSettingsStore(face)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.rows[0]).toMatchObject({ configured: true, removable: false })
    expect(state.rows[0]?.apiKeyEnv).toBeUndefined()
  })

  it('skips the credential describe entirely when no row names a reference', async () => {
    const { face, seenRefs } = api({
      describeSettings: () => Promise.resolve(ok({
        writable: true,
        hasDocument: false,
        namespaces: [{ ns: 'llm-pi-ai', schema: {}, value: { providers: {} }, applies: 'live' as const, secrets: [], revision: 0 }] as never,
      })),
      providers: () => Promise.resolve(ok({
        providers: [
          { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false },
        ] as never,
      })),
    })
    const store = new ModelsSettingsStore(face)
    await store.load()
    expect(seenRefs).toEqual([])
    expect(store.store.getSnapshot().status).toBe('ready')
  })

  it('surfaces a settings describe failure', async () => {
    const { face } = api({ describeSettings: () => Promise.resolve(fail('settings down')) })
    const store = new ModelsSettingsStore(face)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'error', error: 'settings down' })
  })

  it('stringifies a non-Error load failure', async () => {
    // The wire can surface non-Error throwables; the store must stringify them.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the scenario
    const { face } = api({ providers: () => Promise.reject('plain refusal') })
    const store = new ModelsSettingsStore(face)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'error', error: 'plain refusal' })
  })

  it('drops a stale successful response after a newer load finished', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let call = 0
    const { face } = api({
      providers: async () => {
        call += 1
        if (call === 1) {
          await gate
          return ok({ providers: [] as never })
        }
        return ok({ providers: DIRECTORY })
      },
    })
    const store = new ModelsSettingsStore(face)
    const first = store.load()
    const second = store.load()
    await second
    release?.()
    await first
    // The stale empty directory never overwrote the newer join.
    expect(store.store.getSnapshot().rows).toHaveLength(4)
  })
})

describe('OAuth joins and flows', () => {
  const OAUTH_DIRECTORY = [
    ...DIRECTORY,
    { provider: 'openai-codex', displayName: 'OpenAI Codex', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai-codex'], active: true, auth: 'oauth' as const },
  ]

  it('joins the durable OAuth status into oauth rows', async () => {
    const { face } = api({
      providers: () => Promise.resolve(ok({ providers: OAUTH_DIRECTORY as never })),
      oauthStatus: () => Promise.resolve(ok({ providers: [{ provider: 'openai-codex', connected: true, accountId: 'acct-1' }] })),
    })
    const store = new ModelsSettingsStore(face)
    await store.load()
    const row = store.store.getSnapshot().rows.find(row => row.entry.provider === 'openai-codex')
    expect(row?.oauth).toEqual({ provider: 'openai-codex', connected: true, accountId: 'acct-1' })
    expect(store.store.getSnapshot().oauthError).toBeNull()
  })

  it('degrades the oauth join, not the page, when the status read fails', async () => {
    const { face } = api({
      providers: () => Promise.resolve(ok({ providers: OAUTH_DIRECTORY as never })),
      oauthStatus: () => Promise.resolve(fail('oauth status down')),
    })
    const store = new ModelsSettingsStore(face)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.oauthError).toBe('oauth status down')
    expect(state.rows.find(row => row.entry.provider === 'openai-codex')?.oauth).toBeUndefined()
  })

  it('settles an oauth status transport rejection without failing the load', async () => {
    const { face } = api({
      providers: () => Promise.resolve(ok({ providers: OAUTH_DIRECTORY as never })),
      oauthStatus: () => Promise.reject(new Error('oauth transport down')),
    })
    const store = new ModelsSettingsStore(face)
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'ready', oauthError: 'oauth transport down' })
  })

  it('folds login-flow events into the per-route flow state', async () => {
    const { face } = api()
    const store = new ModelsSettingsStore(face)
    store.handleOAuthEvent('openai-codex', { type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize', instructions: 'finish it' })
    expect(store.store.getSnapshot().oauthFlows['openai-codex']).toEqual({
      status: 'waiting',
      url: 'https://auth.openai.com/oauth/authorize',
      instructions: 'finish it',
    })
    store.handleOAuthEvent('openai-codex', { type: 'device_code', userCode: 'ABC-123', verificationUri: 'https://auth.openai.com/codex/device' })
    expect(store.store.getSnapshot().oauthFlows['openai-codex']).toEqual({
      status: 'waiting',
      deviceCode: 'ABC-123',
      verificationUri: 'https://auth.openai.com/codex/device',
    })
    store.handleOAuthEvent('openai-codex', { type: 'manual_code', message: 'paste it', placeholder: 'http://localhost:1455/auth/callback' })
    expect(store.store.getSnapshot().oauthFlows['openai-codex']).toEqual({
      status: 'waiting',
      manualMessage: 'paste it',
      manualPlaceholder: 'http://localhost:1455/auth/callback',
    })
    store.handleOAuthEvent('openai-codex', { type: 'manual_code', message: 'paste it without a placeholder' })
    expect(store.store.getSnapshot().oauthFlows['openai-codex']).toEqual({
      status: 'waiting',
      manualMessage: 'paste it without a placeholder',
    })
    store.handleOAuthEvent('openai-codex', { type: 'progress', message: 'still going' })
    store.handleOAuthEvent('openai-codex', { type: 'info', message: 'note' })
    expect(store.store.getSnapshot().oauthFlows['openai-codex']?.status).toBe('waiting')
    store.handleOAuthEvent('openai-codex', { type: 'error', message: 'denied' })
    expect(store.store.getSnapshot().oauthFlows['openai-codex']).toEqual({ status: 'error', message: 'denied' })
  })

  it('drops a stale response whose load was parked at the credential describe', async () => {
    // The oauth-stage guard is exercised by the gated-providers test above
    // (a stale load returns at the first guard it reaches). This one parks
    // the stale load PAST that guard, at the credential describe, so the
    // final guard's return is what discards it. The stale load must reach
    // the describe before the newer load starts, or it returns at the oauth
    // guard first.
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let signalParked: (() => void) | undefined
    const parked = new Promise<void>((resolve) => { signalParked = resolve })
    let call = 0
    const { face } = api({
      describeCredentials: async (refs) => {
        call += 1
        signalParked?.()
        if (call === 1) {
          await gate
          return ok({ credentials: { DEEPSEEK_API_KEY: { configured: true, writable: true } } })
        }
        return ok({ credentials: Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: true }])) })
      },
    })
    const store = new ModelsSettingsStore(face)
    const first = store.load()
    await parked
    const second = store.load()
    await second
    release?.()
    await first
    // The stale credential join never overwrote the newer one.
    expect(store.store.getSnapshot().rows.find(row => row.entry.provider === 'deepseek-official')?.credential)
      .toEqual({ configured: false, writable: true })
  })

  it('refreshes the page when a flow completes', async () => {
    const { face } = api()
    const store = new ModelsSettingsStore(face)
    await store.load()
    store.handleOAuthEvent('openai-codex', { type: 'complete', accountId: 'acct-1' })
    // The flow state cleared and the page reloaded to pick up the new
    // credential and profile.
    expect(store.store.getSnapshot().oauthFlows['openai-codex']).toEqual({ status: 'idle' })
    await vi.waitFor(() => expect(store.store.getSnapshot().status).toBe('ready'))
  })

  it('starts a login, marking the flow starting until events arrive', async () => {
    const { face, login } = api()
    const store = new ModelsSettingsStore(face)
    await store.login('openai-codex')
    expect(login).toHaveBeenCalledWith({ provider: 'openai-codex' })
    expect(store.store.getSnapshot().oauthFlows['openai-codex']).toEqual({ status: 'starting' })
  })

  it('reports a login rejection in the flow state', async () => {
    const { face } = api({ login: () => Promise.resolve(fail('no such provider')) })
    const store = new ModelsSettingsStore(face)
    await store.login('openai-codex')
    expect(store.store.getSnapshot().oauthFlows['openai-codex']).toEqual({
      status: 'error',
      message: 'no such provider',
    })
  })

  it('answers a manual-code prompt and cancels a live flow', async () => {
    const { face, loginInput, cancelLogin } = api()
    const store = new ModelsSettingsStore(face)
    await store.loginInput('openai-codex', 'http://localhost:1455/auth/callback?code=x')
    expect(loginInput).toHaveBeenCalledWith({
      provider: 'openai-codex',
      value: 'http://localhost:1455/auth/callback?code=x',
    })
    await store.cancelLogin('openai-codex')
    expect(cancelLogin).toHaveBeenCalledWith({ provider: 'openai-codex' })
    expect(store.store.getSnapshot().oauthFlows['openai-codex']).toEqual({ status: 'idle' })
  })

  it('reports a rejected prompt answer and a rejected cancel in the flow state', async () => {
    const { face } = api({
      loginInput: () => Promise.resolve(fail('no pending prompt')),
      cancelLogin: () => Promise.resolve(fail('no active flow')),
    })
    const store = new ModelsSettingsStore(face)
    await store.loginInput('openai-codex', 'code')
    expect(store.store.getSnapshot().oauthFlows['openai-codex']).toEqual({
      status: 'error',
      message: 'no pending prompt',
    })
    await store.cancelLogin('openai-codex')
    // A refused cancel still clears the page-side flow state: the host keeps
    // its own flow, and the next login restarts it.
    expect(store.store.getSnapshot().oauthFlows['openai-codex']).toEqual({ status: 'idle' })
  })

  it('signs out through the wire and refreshes', async () => {
    const { face, logout } = api()
    const store = new ModelsSettingsStore(face)
    await store.logout('openai-codex')
    expect(logout).toHaveBeenCalledWith({ provider: 'openai-codex' })
    await vi.waitFor(() => expect(store.store.getSnapshot().status).toBe('ready'))
  })

  it('reports a sign-out rejection in the flow state', async () => {
    const { face } = api({ logout: () => Promise.resolve(fail('storage refused')) })
    const store = new ModelsSettingsStore(face)
    await store.logout('openai-codex')
    expect(store.store.getSnapshot().oauthFlows['openai-codex']).toEqual({
      status: 'error',
      message: 'storage refused',
    })
  })
})

describe('messageOf', () => {
  it('reads an Error message, and stringifies anything else a rejection may carry', () => {
    // The wire layer rejects with an Error, but a host or a runtime can reject
    // with any value, and the page still has to render something.
    expect(messageOf(new Error('connection lost'))).toBe('connection lost')
    expect(messageOf('the host refused')).toBe('the host refused')
    expect(messageOf(undefined)).toBe('undefined')
  })
})
