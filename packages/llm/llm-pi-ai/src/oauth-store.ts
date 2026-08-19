/**
 * Durable pi-ai `CredentialStore` for OAuth credentials, backed by one JSON
 * document under the harness home (default `$DSH_HOME/.oauth.json`, mode
 * 0600). API keys keep living in the credentials seam; this file holds only
 * the structured OAuth tokens a login flow returns, so a route's stored
 * credential survives restarts and token refresh rotates it under the same
 * store lock pi-ai's `Models` runs.
 *
 * Writes are serialized through one promise chain, which is stronger than the
 * per-provider mutual exclusion `CredentialStore` documents and keeps the
 * whole document's rewrite atomic: every mutation ends in one
 * `writeFileAtomic` of the complete next file.
 *
 * A route may name an **external source** for its credential — another tool
 * on the machine that already holds the account, codex-cli's ChatGPT login
 * being the shipped one. A source is consulted only when the document holds
 * nothing for the route, and the adopted credential is copied into the
 * document on first use (the store then owns and refreshes its own copy).
 * A `null` document entry is an explicit sign-out: it blocks the source for
 * that route across restarts, so "退出登录" stays off until a real login.
 *
 * @module dsh-llm-pi-ai/oauth-store
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'

/** Default OAuth credential document name under the harness home. */
export const OAUTH_STORE_FILENAME = '.oauth.json'

/** Owner-only bits for the OAuth token document and its parent directory. */
const OAUTH_FILE_MODE = 0o600
const OAUTH_DIR_MODE = 0o700

/**
 * One external credential source for a provider route: a file another tool
 * owns (codex-cli's login state, for instance). Resolves `undefined` when the
 * tool is not installed or not signed in; the store then simply has nothing.
 */
export type CredentialSource = () => Promise<Credential | undefined>

/** One parsed document: stored credentials plus the explicitly signed-out routes. */
interface ParsedDocument {
  credentials: Map<string, Credential>
  blocked: Set<string>
}

/** One malformed entry, named for the operator's next move. */
function invalidEntry(provider: string, detail: string): never {
  throw new Error(`llm-pi-ai: stored OAuth credential for provider "${provider}" is invalid: ${detail}`)
}

/** Detach and validate one parsed document entry. */
function parseEntry(provider: string, raw: unknown): Credential {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    invalidEntry(provider, 'expected an object')
  }
  const entry = raw as Record<string, unknown>
  if (entry.type !== 'oauth') invalidEntry(provider, `expected type "oauth", got ${JSON.stringify(entry.type)}`)
  if (typeof entry.access !== 'string' || entry.access.length === 0) {
    invalidEntry(provider, 'access token must be a non-empty string')
  }
  if (typeof entry.refresh !== 'string' || entry.refresh.length === 0) {
    invalidEntry(provider, 'refresh token must be a non-empty string')
  }
  if (typeof entry.expires !== 'number' || !Number.isFinite(entry.expires)) {
    invalidEntry(provider, 'expiry must be a finite number')
  }
  return entry as Credential
}

/** Parse the whole document, refusing a shape the store cannot serve. */
function parseDocument(text: string): ParsedDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`llm-pi-ai: the OAuth credential document is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('llm-pi-ai: the OAuth credential document must be an object keyed by provider route')
  }
  const credentials = new Map<string, Credential>()
  const blocked = new Set<string>()
  for (const [provider, raw] of Object.entries(parsed)) {
    if (provider.length === 0) throw new Error('llm-pi-ai: the OAuth credential document has an empty provider key')
    if (raw === null) {
      blocked.add(provider)
      continue
    }
    credentials.set(provider, parseEntry(provider, raw))
  }
  return { credentials, blocked }
}

/**
 * The ChatGPT account credential codex-cli stores after `codex login`, when
 * one exists. `auth_mode` distinguishes a ChatGPT (OAuth) login from other
 * auth shapes codex-cli may record; a missing or unreadable file simply
 * resolves `undefined`, exactly like "codex-cli is not signed in".
 *
 * codex-cli records no access-token expiry, so the adopted credential is
 * stamped `expires: 0` — every first use refreshes it under pi-ai's store
 * lock with the refresh token, which is also what makes the adopted copy
 * independent of codex-cli's own refresh cycle.
 * @param home - the OS home whose `~/.codex/auth.json` to read (test seam).
 * @returns the ChatGPT OAuth credential, or `undefined` when there is none.
 */
export async function codexCliCredential(home: string): Promise<Credential | undefined> {
  let text: string
  try {
    text = await readFile(join(home, '.codex', 'auth.json'), 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  if (document.auth_mode !== 'chatgpt') return undefined
  const tokens = document.tokens
  if (typeof tokens !== 'object' || tokens === null) return undefined
  const source = tokens as Record<string, unknown>
  const access = typeof source.access_token === 'string' && source.access_token.length > 0
    ? source.access_token
    : undefined
  const refresh = typeof source.refresh_token === 'string' && source.refresh_token.length > 0
    ? source.refresh_token
    : undefined
  if (access === undefined || refresh === undefined) return undefined
  const accountId = typeof source.account_id === 'string' && source.account_id.length > 0
    ? source.account_id
    : undefined
  return {
    type: 'oauth',
    access,
    refresh,
    expires: 0,
    ...accountId === undefined ? {} : { accountId },
  }
}

/** Constructor options of {@link FileOAuthStore}. */
export interface OAuthStoreOptions {
  /**
   * External credential sources by provider route, consulted when the
   * document holds nothing for the route and the route is not signed out.
   */
  sources?: Readonly<Record<string, CredentialSource>>
}

/**
 * File-backed OAuth credential store: one credential per provider route,
 * published by atomic whole-file rewrite. The document is read lazily on the
 * first operation, so a corrupt file fails the operation that touches it with
 * the file named, and every mutation is serialized through one chain.
 */
export class FileOAuthStore implements CredentialStore {
  private readonly credentials = new Map<string, Credential>()
  /** Routes the user signed out of; their external sources stay blocked. */
  private readonly blocked = new Set<string>()
  private loaded: Promise<void> | undefined
  /** One chain serializes every mutation and its document rewrite. */
  private writeChain: Promise<unknown> = Promise.resolve()

  /**
   * @param path - absolute path of the JSON document (owner-only on write).
   * @param options - external credential sources.
   */
  constructor(
    private readonly path: string,
    private readonly options: OAuthStoreOptions = {},
  ) {}

  /** Load the document once; a later failure is kept, never silently retried. */
  private load(): Promise<void> {
    this.loaded ??= (async () => {
      let text: string
      try {
        text = await readFile(this.path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw new Error(`llm-pi-ai: cannot read the OAuth credential document at ${this.path}: ${error instanceof Error ? error.message : String(error)}`)
      }
      const { credentials, blocked } = parseDocument(text)
      for (const [provider, credential] of credentials) {
        this.credentials.set(provider, credential)
      }
      for (const provider of blocked) this.blocked.add(provider)
    })()
    return this.loaded
  }

  /** Serialize one mutation behind the current tail of the write chain. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task, task)
    this.writeChain = run.then(() => undefined, () => undefined)
    return run
  }

  /** Rewrite the whole document from the current map and blocked set. */
  private async persist(): Promise<void> {
    const document: Record<string, unknown> = Object.fromEntries(this.credentials)
    for (const provider of this.blocked) {
      if (!(provider in document)) document[provider] = null
    }
    const text = `${JSON.stringify(document, null, 2)}\n`
    await writeFileAtomic(this.path, text, { mode: OAUTH_FILE_MODE, dirMode: OAUTH_DIR_MODE })
  }

  /** Adopt the route's external credential, if any, copying it into the document. */
  private async importFromSource(providerId: string): Promise<Credential | undefined> {
    if (this.blocked.has(providerId)) return undefined
    const source = this.options.sources?.[providerId]
    if (source === undefined) return undefined
    const imported = await source()
    if (imported === undefined) return undefined
    this.credentials.set(providerId, imported)
    await this.persist()
    return imported
  }

  async read(providerId: string): Promise<Credential | undefined> {
    await this.load()
    const stored = this.credentials.get(providerId)
    return stored === undefined ? this.importFromSource(providerId) : stored
  }

  async list(): Promise<readonly CredentialInfo[]> {
    await this.load()
    return [...this.credentials.entries()].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }))
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      await this.load()
      const current = this.credentials.get(providerId)
      const next = await fn(current)
      if (next === undefined) return current
      this.credentials.set(providerId, next)
      this.blocked.delete(providerId)
      await this.persist()
      return next
    })
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.load()
      const hadCredential = this.credentials.delete(providerId)
      if (!hadCredential && this.blocked.has(providerId)) return
      // A sign-out is durable: without the blocked marker the next read would
      // silently re-adopt the external credential the user just revoked.
      this.blocked.add(providerId)
      await this.persist()
    })
  }
}
