import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Credential } from '@earendil-works/pi-ai'
import { codexCliCredential, FileOAuthStore } from '../src/oauth-store.ts'

const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-oauth-'))
  homes.push(dir)
  return dir
}

function oauthCredential(overrides: Partial<Credential & { accountId?: string }> = {}): Credential {
  return {
    type: 'oauth',
    access: 'access-token',
    refresh: 'refresh-token',
    expires: 1_800_000_000_000,
    accountId: 'acct-1',
    ...overrides,
  }
}

describe('FileOAuthStore', () => {
  it('reads, lists, modifies, and deletes credentials durably', async () => {
    const dir = await home()
    const path = join(dir, 'oauth.json')
    const store = new FileOAuthStore(path)

    await expect(store.read('openai-codex')).resolves.toBeUndefined()
    await expect(store.list()).resolves.toEqual([])

    const credential = oauthCredential()
    await expect(store.modify('openai-codex', async () => credential)).resolves.toEqual(credential)
    await expect(store.read('openai-codex')).resolves.toEqual(credential)
    await expect(store.list()).resolves.toEqual([{ providerId: 'openai-codex', type: 'oauth' }])

    // A fresh instance sees the persisted document.
    const reloaded = new FileOAuthStore(path)
    await expect(reloaded.read('openai-codex')).resolves.toEqual(credential)

    // modify's `fn` sees the current credential and undefined keeps it unchanged.
    await expect(store.modify('openai-codex', async (current) => {
      expect(current).toEqual(credential)
      return undefined
    })).resolves.toEqual(credential)
    await expect(store.read('openai-codex')).resolves.toEqual(credential)

    await store.delete('openai-codex')
    await expect(store.read('openai-codex')).resolves.toBeUndefined()
    await expect(new FileOAuthStore(path).read('openai-codex')).resolves.toBeUndefined()
  })

  it('serializes concurrent mutations so the document never loses a write', async () => {
    const dir = await home()
    const path = join(dir, 'oauth.json')
    const store = new FileOAuthStore(path)

    await Promise.all([
      store.modify('a', async () => oauthCredential({ refresh: 'a' })),
      store.modify('b', async () => oauthCredential({ refresh: 'b' })),
      store.modify('c', async () => oauthCredential({ refresh: 'c' })),
    ])
    const document = JSON.parse(await readFile(path, 'utf8')) as Record<string, { refresh: string }>
    expect(Object.keys(document).sort()).toEqual(['a', 'b', 'c'])
    expect(document.a?.refresh).toBe('a')
    expect(document.b?.refresh).toBe('b')
    expect(document.c?.refresh).toBe('c')
  })

  it('fails loudly on a malformed document, naming the entry at fault', async () => {
    const dir = await home()
    const path = join(dir, 'oauth.json')
    await new FileOAuthStore(path).modify('openai-codex', async () => oauthCredential())

    const broken = join(dir, 'broken.json')
    await writeFile(broken, '{not json')
    await expect(new FileOAuthStore(broken).read('x')).rejects.toThrow(/not valid JSON/)

    await writeFile(path, JSON.stringify({ 'openai-codex': { type: 'api_key', key: 'k' } }))
    await expect(new FileOAuthStore(path).read('openai-codex'))
      .rejects.toThrow(/provider "openai-codex" is invalid/)

    await writeFile(path, JSON.stringify({ 'openai-codex': { type: 'oauth', access: '', refresh: 'r', expires: 1 } }))
    await expect(new FileOAuthStore(path).read('openai-codex'))
      .rejects.toThrow(/access token must be a non-empty string/)
  })

  it('treats a missing document as an empty store', async () => {
    const dir = await home()
    const store = new FileOAuthStore(join(dir, 'absent.json'))
    await expect(store.read('openai-codex')).resolves.toBeUndefined()
    await expect(store.list()).resolves.toEqual([])
    await store.delete('openai-codex')
    await expect(store.list()).resolves.toEqual([])
  })

  it('adopts an external source credential on first read, copying it into the document', async () => {
    const dir = await home()
    const path = join(dir, 'oauth.json')
    const source = vi.fn(async () => oauthCredential({ accountId: 'acct-codex' }))
    const store = new FileOAuthStore(path, { sources: { 'openai-codex': source } })

    await expect(store.read('openai-codex')).resolves.toEqual(oauthCredential({ accountId: 'acct-codex' }))
    expect(source).toHaveBeenCalledTimes(1)
    // The adopted credential became a durable copy: a fresh instance answers
    // from the document without consulting the source again.
    const reloaded = new FileOAuthStore(path)
    await expect(reloaded.read('openai-codex')).resolves.toEqual(oauthCredential({ accountId: 'acct-codex' }))
    expect(source).toHaveBeenCalledTimes(1)
    // The copy is owned now: a stored credential outranks the source.
    await store.modify('openai-codex', async () => oauthCredential({ accountId: 'acct-refreshed' }))
    await expect(store.read('openai-codex')).resolves.toEqual(oauthCredential({ accountId: 'acct-refreshed' }))
  })

  it('treats a source that resolves nothing as an unconfigured route', async () => {
    const dir = await home()
    const store = new FileOAuthStore(join(dir, 'oauth.json'), {
      sources: { 'openai-codex': async () => undefined },
    })
    await expect(store.read('openai-codex')).resolves.toBeUndefined()
  })

  it('keeps a sign-out durable: a blocked route never re-adopts its source', async () => {
    const dir = await home()
    const path = join(dir, 'oauth.json')
    const source = vi.fn(async () => oauthCredential())
    const store = new FileOAuthStore(path, { sources: { 'openai-codex': source } })

    await expect(store.read('openai-codex')).resolves.toEqual(oauthCredential())
    await store.delete('openai-codex')
    // The blocked marker is durable, so a fresh instance still refuses the
    // source across restarts.
    await expect(store.read('openai-codex')).resolves.toBeUndefined()
    const reloaded = new FileOAuthStore(path, { sources: { 'openai-codex': source } })
    await expect(reloaded.read('openai-codex')).resolves.toBeUndefined()
    expect(source).toHaveBeenCalledTimes(1)
    // A real login clears the block and writes the fresh credential.
    await reloaded.modify('openai-codex', async () => oauthCredential({ accountId: 'acct-login' }))
    await expect(reloaded.read('openai-codex')).resolves.toEqual(oauthCredential({ accountId: 'acct-login' }))
  })
})

describe('codexCliCredential', () => {
  it('adopts a chatgpt-mode codex login with its account id and no known expiry', async () => {
    const dir = await home()
    await mkdir(join(dir, '.codex'), { recursive: true })
    await writeFile(join(dir, '.codex', 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'access-from-codex',
        refresh_token: 'refresh-from-codex',
        account_id: 'acct-codex',
      },
    }))
    await expect(codexCliCredential(dir)).resolves.toEqual({
      type: 'oauth',
      access: 'access-from-codex',
      refresh: 'refresh-from-codex',
      expires: 0,
      accountId: 'acct-codex',
    })
  })

  it('resolves undefined when codex-cli is absent, not logged in, or in api-key mode', async () => {
    const dir = await home()
    await expect(codexCliCredential(dir)).resolves.toBeUndefined()
    await mkdir(join(dir, '.codex'), { recursive: true })
    await writeFile(join(dir, '.codex', 'auth.json'), 'not json')
    await expect(codexCliCredential(dir)).resolves.toBeUndefined()
    await writeFile(join(dir, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' }))
    await expect(codexCliCredential(dir)).resolves.toBeUndefined()
    await writeFile(join(dir, '.codex', 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: '', refresh_token: 'r' },
    }))
    await expect(codexCliCredential(dir)).resolves.toBeUndefined()
  })
})
