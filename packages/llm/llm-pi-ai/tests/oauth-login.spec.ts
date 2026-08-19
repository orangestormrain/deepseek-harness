import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { LlmLoginInteraction, LlmOAuthEvent } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'

const homes: string[] = []

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  return Promise.all(homes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-login-'))
  homes.push(dir)
  return dir
}

/** Mount the adapter over a codex home that contains no login at all. */
function pluginConfig(codexHome: string): LlmPiAi.Config {
  return { providers: { 'openai-codex': {} }, oauthCodexHome: codexHome }
}

/** One stubbed device-code exchange: user code, one immediate grant, token. */
function stubDeviceCodeFlow(): void {
  const fetchMock = vi.mocked(fetch)
  fetchMock.mockImplementation(async (input) => {
    const url = String(input)
    if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
      return new Response(JSON.stringify({
        device_auth_id: 'device-1',
        user_code: 'CODE-1234',
        interval: '0',
      }), { status: 200 })
    }
    if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
      return new Response(JSON.stringify({
        authorization_code: 'authz-code',
        code_verifier: 'verifier',
      }), { status: 200 })
    }
    if (url === 'https://auth.openai.com/oauth/token') {
      const payload = JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-device-test' },
      })
      const jwt = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(payload).toString('base64url')}.sig`
      return new Response(JSON.stringify({
        access_token: jwt,
        refresh_token: 'refresh-token',
        expires_in: 3600,
      }), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
}

/** A login interaction that picks the device-code method and records events. */
function deviceCodeInteraction(): { interaction: LlmLoginInteraction; events: LlmOAuthEvent[] } {
  const events: LlmOAuthEvent[] = []
  const interaction: LlmLoginInteraction = {
    notify: (event) => { events.push(event) },
    prompt: async (prompt) => {
      if (prompt.type === 'select') return 'device_code'
      throw new Error(`unexpected prompt: ${JSON.stringify(prompt)}`)
    },
  }
  return { interaction, events }
}

describe('llm-pi-ai OAuth login flow', () => {
  it('runs the provider flow, persists the credential, and reports status', async () => {
    const dir = await home()
    vi.stubEnv('DSH_HOME', dir)
    stubDeviceCodeFlow()

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, pluginConfig(join(dir, 'codex-home')))

    expect(await ctx.llm.oauthStatus('openai-codex')).toEqual({
      provider: 'openai-codex',
      connected: false,
    })

    const { interaction, events } = deviceCodeInteraction()
    await expect(ctx.llm.login('openai-codex', interaction)).resolves.toEqual({
      accountId: 'acct-device-test',
    })

    expect(events).toContainEqual({
      type: 'device_code',
      userCode: 'CODE-1234',
      verificationUri: 'https://auth.openai.com/codex/device',
      intervalSeconds: 0,
      expiresInSeconds: 900,
    })
    const status = await ctx.llm.oauthStatus('openai-codex')
    expect(status.provider).toBe('openai-codex')
    expect(status.connected).toBe(true)
    expect(status.accountId).toBe('acct-device-test')
    expect(status.expiresAt).toBeGreaterThan(Date.now())

    // The stored credential survives a fresh adapter (the document is durable).
    const rebooted = new Context()
    await rebooted.plugin(LlmRuntime)
    await rebooted.plugin(LlmPiAi, pluginConfig(join(dir, 'codex-home')))
    await expect(rebooted.llm.oauthStatus('openai-codex')).resolves.toMatchObject({
      provider: 'openai-codex',
      connected: true,
      accountId: 'acct-device-test',
    })

    await ctx.llm.logout('openai-codex')
    await expect(ctx.llm.oauthStatus('openai-codex')).resolves.toEqual({
      provider: 'openai-codex',
      connected: false,
    })
  })

  it('refuses a login method the provider does not know without storing anything', async () => {
    const dir = await home()
    vi.stubEnv('DSH_HOME', dir)
    stubDeviceCodeFlow()

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, pluginConfig(join(dir, 'codex-home')))

    const interaction: LlmLoginInteraction = {
      notify: () => {},
      prompt: async (prompt) => {
        if (prompt.type === 'select') return 'unknown-method'
        throw new Error(`unexpected prompt: ${JSON.stringify(prompt)}`)
      },
    }
    await expect(ctx.llm.login('openai-codex', interaction)).rejects.toThrow(/Unknown OpenAI Codex login method/)
    await expect(ctx.llm.oauthStatus('openai-codex')).resolves.toEqual({
      provider: 'openai-codex',
      connected: false,
    })
  })

  it('adopts an existing codex-cli ChatGPT login without a flow, and keeps a sign-out durable', async () => {
    const dir = await home()
    const codexHome = join(dir, 'codex-home')
    await mkdir(join(codexHome, '.codex'), { recursive: true })
    await writeFile(join(codexHome, '.codex', 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'access-from-codex',
        refresh_token: 'refresh-from-codex',
        account_id: 'acct-codex',
      },
    }))
    vi.stubEnv('DSH_HOME', dir)
    // No fetch is stubbed: adoption must not perform any network call.
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, pluginConfig(codexHome))

    await expect(ctx.llm.oauthStatus('openai-codex')).resolves.toEqual({
      provider: 'openai-codex',
      connected: true,
      accountId: 'acct-codex',
      // codex-cli records no expiry, so status reports connection without one.
    })

    // Signing out blocks the codex source durably: a fresh adapter still
    // reports the route unconnected instead of re-adopting the login.
    await ctx.llm.logout('openai-codex')
    const rebooted = new Context()
    await rebooted.plugin(LlmRuntime)
    await rebooted.plugin(LlmPiAi, pluginConfig(codexHome))
    await expect(rebooted.llm.oauthStatus('openai-codex')).resolves.toEqual({
      provider: 'openai-codex',
      connected: false,
    })
  })
})
