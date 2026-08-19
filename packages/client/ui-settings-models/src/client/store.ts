/**
 * Models settings page store: one snapshot joining the configurable-provider
 * directory (`llm.providers`), the settings namespaces (`settings.describe`),
 * the referenced credentials (`credentials.describe`), and the OAuth login
 * state (`llm.oauthStatus` + the forwarded `llm/oauth-event` stream). The
 * host stays the single fact source — every mutation writes through the wire
 * and the page re-renders from the next describe, pushed or refetched.
 */

import type {
  ConfigurableProviderView, CredentialView, IApiClient, LlmOAuthEvent, OAuthStatusView, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { getPath, hasPath, nodeAtPath, rehydrateSchema } from '@deepseek-ai/dsh-client-schema-form'

/**
 * Any route key walks a dict schema to the same profile node, so the lookup
 * names one that cannot collide with a configured route.
 */
const PROBE_ROUTE = '\u0000probe'

/** One provider row the page renders. */
export interface ProviderRow {
  /** The directory entry (route id, display name, settings address, live state). */
  entry: ConfigurableProviderView
  /** Whether any layer configures this provider (its profile resolves). */
  configured: boolean
  /** Whether the user layer alone carries the profile (removal restores the base). */
  removable: boolean
  /** The credential reference the resolved profile names, when one does. */
  apiKeyEnv: string | undefined
  /** Credential state for {@link apiKeyEnv}, once described. */
  credential: CredentialView | undefined
  /** Durable OAuth state for an oauth-authenticated route, once described. */
  oauth?: OAuthStatusView
}

/**
 * One provider route's login-flow state as the page sees it: what the host
 * relayed through `llm/oauth-event` since the flow started. `idle` covers
 * both "never started" and "finished" (the finished flow is removed on its
 * `complete` event).
 */
export type OAuthFlowState =
  | { status: 'idle' }
  | { status: 'starting' }
  | {
    status: 'waiting'
    /** Browser-login authorization URL, when the flow opened one. */
    url?: string
    instructions?: string
    /** Device-code login code, when the flow is a device flow. */
    deviceCode?: string
    verificationUri?: string
    /** Manual-code prompt copy, when the flow is waiting for pasted input. */
    manualMessage?: string
    manualPlaceholder?: string
  }
  | { status: 'error'; message: string }

/** Page snapshot. */
export interface ModelsSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; row-level write failures stay in the editor. */
  error: string | null
  /** Credential enrichment failure; provider/settings rows remain usable. */
  credentialError: string | null
  /** OAuth status enrichment failure; rows keep their last known state. */
  oauthError: string | null
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** Every configurable provider joined with its configured/credential state. */
  rows: readonly ProviderRow[]
  /** Namespace views by ns, for the editor's schema/layers/secrets. */
  namespaces: ReadonlyMap<string, SettingsNamespaceView>
  /** Login-flow state by provider route. */
  oauthFlows: Readonly<Record<string, OAuthFlowState>>
}

/**
 * Human text for a rejected wire call. A transport failure rejects with an
 * Error; a host or a runtime can reject with anything, and the page still has
 * to say something.
 * @param error - the rejection value.
 * @returns the message to show.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Derive the conventional credential reference for a provider route: the v1
 * page never asks for an environment-variable name, so a typed key stores
 * under this derived reference and the profile records it as `apiKeyEnv`.
 * @param provider - provider route id (e.g. `anthropic`, `minimax-cn`).
 * @returns the derived reference name (e.g. `MINIMAX_CN_API_KEY`).
 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * The wire protocols a hand-declared route may name, read out of the owning
 * namespace's own schema. This stays a schema read rather than a wire field so
 * the choices the page offers cannot drift from the ones the adapter accepts:
 * both come from the same `Config`.
 * @param namespace - the namespace view whose schema declares the profile shape.
 * @returns the protocol identifiers, or an empty list when the schema has none.
 */
export function protocolChoices(namespace: SettingsNamespaceView | undefined): string[] {
  if (namespace === undefined) return []
  const node = nodeAtPath(rehydrateSchema(namespace.schema), ['providers', PROBE_ROUTE, 'api'])
  const list = (node as { type?: string; list?: readonly { value?: unknown }[] } | undefined)
  if (list?.type !== 'union' || list.list === undefined) return []
  return list.list.map(entry => entry.value).filter((value): value is string => typeof value === 'string')
}

/** The credential reference a resolved profile names (its `apiKeyEnv` field). */
function apiKeyEnvOf(namespace: SettingsNamespaceView | undefined, path: readonly string[]): string | undefined {
  if (namespace === undefined) return undefined
  const profile = getPath(namespace.value, path)
  if (typeof profile !== 'object' || profile === null) return undefined
  const ref = (profile as { apiKeyEnv?: unknown }).apiKeyEnv
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/** The models settings page controller (one per settings surface). */
export class ModelsSettingsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<ModelsSettingsState> = createSnapshotStore<ModelsSettingsState>({
    status: 'idle', error: null, credentialError: null, oauthError: null, writable: false, rows: [],
    namespaces: new Map(), oauthFlows: {},
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0

  /**
   * @param api - the wire face (settings/credentials/llm domains).
   */
  constructor(private readonly api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>) {}

  /**
   * Refresh the whole page snapshot: directory, namespaces, and OAuth status
   * in parallel, then one batched credential describe over every referenced
   * ref. OAuth status is an enrichment like credentials: neither a business
   * rejection nor a transport failure fails the load — the oauth rows just
   * read disconnected, with the failure surfaced on the page.
   * @returns nothing; the snapshot carries the outcome.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    let providers: ConfigurableProviderView[]
    let writable: boolean
    let views: SettingsNamespaceView[]
    try {
      const [providersResponse, settingsResponse] = await Promise.all([
        this.api.llm.providers({}),
        this.api.settings.describe({}),
      ])
      if (!providersResponse.result.ok) throw new Error(providersResponse.result.error.message)
      if (!settingsResponse.result.ok) throw new Error(settingsResponse.result.error.message)
      providers = providersResponse.result.value.providers
      writable = settingsResponse.result.value.writable
      views = settingsResponse.result.value.namespaces
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((s) => {
        s.status = 'error'
        s.error = error instanceof Error ? error.message : String(error)
      })
      return
    }
    let oauthStatus: OAuthStatusView[] | undefined
    let oauthError: string | null = null
    try {
      const oauthResponse = await this.api.llm.oauthStatus({})
      if (oauthResponse.result.ok) oauthStatus = oauthResponse.result.value.providers
      else oauthError = oauthResponse.result.error.message
    } catch (error) {
      oauthError = messageOf(error)
    }
    if (generation !== this.generation) return
    const statusByProvider = new Map((oauthStatus ?? []).map(status => [status.provider, status]))
    const namespaces = new Map(views.map(view => [view.ns, view]))
    const rows: ProviderRow[] = providers.map((entry) => {
      const namespace = namespaces.get(entry.settingsNs)
      const configured = namespace !== undefined
        && (entry.settingsPath.length === 0 || getPath(namespace.value, entry.settingsPath) !== undefined)
      const removable = namespace !== undefined
        && entry.settingsPath.length > 0
        && hasPath(namespace.user, entry.settingsPath)
        && !hasPath(namespace.base, entry.settingsPath)
      const oauth = statusByProvider.get(entry.provider)
      return {
        entry,
        configured,
        removable,
        apiKeyEnv: apiKeyEnvOf(namespace, entry.settingsPath),
        credential: undefined,
        ...oauth === undefined ? {} : { oauth },
      }
    })
    const refs = [...new Set(rows.flatMap(row => row.apiKeyEnv === undefined ? [] : [row.apiKeyEnv]))]
    let credentials: Record<string, CredentialView> = {}
    let credentialError: string | null = null
    if (refs.length > 0) {
      try {
        const response = await this.api.credentials.describe({ refs })
        // Credential state is an enrichment for the Models page: neither a
        // business rejection nor a transport failure fails the load. The
        // onboarding projection below retains the failure distinction.
        if (response.result.ok) credentials = response.result.value.credentials
        else credentialError = response.result.error.message
      } catch (error) {
        credentialError = messageOf(error)
      }
    }
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.credentialError = credentialError
      s.oauthError = oauthError
      s.writable = writable
      s.rows = rows.map(row => ({
        ...row,
        ...row.apiKeyEnv !== undefined && credentials[row.apiKeyEnv] !== undefined
          ? { credential: credentials[row.apiKeyEnv] }
          : {},
      }))
      s.namespaces = namespaces
    })
  }

  /** Replace one route's flow state, keeping every other route's untouched. */
  private setFlow(provider: string, flow: OAuthFlowState): void {
    this.store.update((s) => {
      s.oauthFlows = { ...s.oauthFlows, [provider]: flow }
    })
  }

  /**
   * Fold one forwarded `llm/oauth-event` into the page snapshot. A completed
   * flow refreshes the whole page (the host may have written the route's
   * profile and stored its credential); everything else just updates the
   * flow panel.
   * @param provider - the provider route the event belongs to.
   * @param event - the relayed flow step.
   */
  handleOAuthEvent(provider: string, event: LlmOAuthEvent): void {
    switch (event.type) {
      case 'auth_url':
        this.setFlow(provider, {
          status: 'waiting',
          url: event.url,
          ...event.instructions === undefined ? {} : { instructions: event.instructions },
        })
        return
      case 'device_code':
        this.setFlow(provider, {
          status: 'waiting',
          deviceCode: event.userCode,
          verificationUri: event.verificationUri,
        })
        return
      case 'manual_code':
        this.setFlow(provider, {
          status: 'waiting',
          manualMessage: event.message,
          ...event.placeholder === undefined ? {} : { manualPlaceholder: event.placeholder },
        })
        return
      case 'progress':
        // Progress keeps whatever the flow is waiting on; the message is the
        // waiting copy's companion, and the state union has no seat for it.
        return
      case 'info':
        return
      case 'complete':
        this.setFlow(provider, { status: 'idle' })
        void this.load()
        return
      case 'error':
        this.setFlow(provider, { status: 'error', message: event.message })
        return
    }
  }

  /**
   * Start the host login flow for one provider route. The flow itself runs in
   * the host and may take minutes; progress arrives through
   * {@link handleOAuthEvent}.
   * @param provider - oauth-authenticated provider route to log into.
   */
  async login(provider: string): Promise<void> {
    this.setFlow(provider, { status: 'starting' })
    try {
      const response = await this.api.llm.login({ provider })
      if (!response.result.ok) throw new Error(response.result.error.message)
    } catch (error) {
      this.setFlow(provider, { status: 'error', message: messageOf(error) })
    }
  }

  /**
   * Answer the live flow's manual-code prompt with the value the user pasted.
   * @param provider - provider route whose flow is waiting for input.
   * @param value - pasted authorization code or redirect URL.
   */
  async loginInput(provider: string, value: string): Promise<void> {
    try {
      const response = await this.api.llm.loginInput({ provider, value })
      if (!response.result.ok) throw new Error(response.result.error.message)
    } catch (error) {
      this.setFlow(provider, { status: 'error', message: messageOf(error) })
    }
  }

  /**
   * Cancel the live login flow without touching a stored credential.
   * @param provider - provider route whose flow to cancel.
   */
  async cancelLogin(provider: string): Promise<void> {
    try {
      const response = await this.api.llm.cancelLogin({ provider })
      if (!response.result.ok) throw new Error(response.result.error.message)
    } catch (error) {
      this.setFlow(provider, { status: 'error', message: messageOf(error) })
    }
    this.setFlow(provider, { status: 'idle' })
  }

  /**
   * Remove the stored OAuth credential of one provider route and refresh.
   * @param provider - oauth-authenticated provider route to sign out of.
   */
  async logout(provider: string): Promise<void> {
    try {
      const response = await this.api.llm.logout({ provider })
      if (!response.result.ok) throw new Error(response.result.error.message)
    } catch (error) {
      this.setFlow(provider, { status: 'error', message: messageOf(error) })
    }
    await this.load()
  }
}

/**
 * Whether a joined row can serve model requests as it stands: the route is
 * registered with the adapter registry, and whatever credential its resolved
 * profile names is stored. An oauth route is usable when its stored
 * credential is present; a profile naming no reference authenticates through
 * the provider's own path (the Bedrock chain, Vertex ADC, a gateway that needs
 * nothing), as does a live route with no settings address at all, so neither
 * owes this page a key.
 * @param row - one joined provider row.
 * @returns whether the user already has this provider to talk to.
 */
export function providerUsable(row: ProviderRow): boolean {
  if (!row.entry.active) return false
  if (row.entry.auth === 'oauth') return row.oauth?.connected === true
  if (row.apiKeyEnv === undefined) return true
  return row.credential?.configured === true
}

/** First-run onboarding readiness derived only from the shared Models join. */
export type OnboardingReadiness =
  | { kind: 'loading' }
  | { kind: 'adapter-absent' }
  | { kind: 'provider-ready' }
  | { kind: 'credential-missing' }
  | {
    kind: 'unavailable'
    reason:
      | 'load-failed'
      | 'provider-inactive'
      | 'credentials-unavailable'
      | 'settings-read-only'
      | 'credential-read-only'
  }

/**
 * Project first-run readiness from the provider/settings/credential join used
 * by the Models page. The step exists to leave the user with a model to talk
 * to, so ANY usable provider ends it; only when none exists does the official
 * DeepSeek route — the one route the prompt can offer a key field for — decide
 * whether prompting can help. A missing official configurable-provider
 * declaration means the adapter is not repairable by navigating to Models.
 * @param state - current shared Models join snapshot.
 * @returns the onboarding state without reading a parallel fact source.
 */
export function onboardingReadiness(state: ModelsSettingsState): OnboardingReadiness {
  if ((state.status === 'idle' || state.status === 'loading') && state.rows.length === 0) {
    return { kind: 'loading' }
  }
  if (state.status === 'error') {
    return {
      kind: 'unavailable',
      reason: 'load-failed',
    }
  }
  if (state.rows.some(providerUsable)) return { kind: 'provider-ready' }
  const row = state.rows.find(candidate =>
    candidate.entry.provider === 'deepseek-official'
    && candidate.entry.settingsNs === 'llm-deepseek'
    && candidate.entry.settingsPath.length === 0)
  if (row === undefined) return { kind: 'adapter-absent' }
  if (!row.entry.active) {
    return {
      kind: 'unavailable',
      reason: 'provider-inactive',
    }
  }
  // Past the usable gate an active route names a reference it has no stored
  // credential for, so the remaining questions are all about that credential.
  if (state.credentialError !== null || row.credential === undefined) {
    return {
      kind: 'unavailable',
      reason: 'credentials-unavailable',
    }
  }
  if (!state.writable) {
    return {
      kind: 'unavailable',
      reason: 'settings-read-only',
    }
  }
  if (!row.credential.writable) {
    return {
      kind: 'unavailable',
      reason: 'credential-read-only',
    }
  }
  return { kind: 'credential-missing' }
}
