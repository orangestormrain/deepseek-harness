/**
 * llm domain contract: host-scoped provider topology for configuration
 * surfaces. `llm.providers` merges the configurable-provider directory
 * (which providers CAN be configured, and where their settings live) with the
 * live route registry; `llm.models` is the session-independent model catalog
 * (the same groups as `session.models`, without a per-session selection).
 * Clients invalidate from the forwarded `llm/adapters-updated` and
 * `settings/document-updated` owner events.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'
import type { ModelCatalogFailure, ModelProviderGroup } from './sessions.ts'

/** Wire view of one configurable provider. */
export interface ConfigurableProviderView {
  /** Provider route key (`deepseek-official`, `openai`, …). */
  provider: string
  /** Human-readable name for configuration surfaces. */
  displayName: string
  /** Settings namespace whose section configures this provider. */
  settingsNs: string
  /** Path from that section's root to the provider's profile object (empty = whole section). */
  settingsPath: string[]
  /** Whether the route is currently registered (its models are requestable). */
  active: boolean
  /**
   * Whether the owning adapter knows this route only because configuration
   * declared it. Absent when the adapter draws no such distinction, so a
   * surface must treat absence as "unknown", not as "shipped".
   */
  declared?: boolean
  /**
   * The authentication method the route's adapter resolves, when it states
   * one: `oauth` routes render a login affordance, `api_key` routes the key
   * field. Absent means the adapter draws no such distinction.
   */
  auth?: 'api_key' | 'oauth'
}

/** Wire view of one provider route's durable OAuth state. */
export interface OAuthStatusView {
  /** Provider route key. */
  provider: string
  /** Whether the adapter holds a stored OAuth credential for the route. */
  connected: boolean
  /** Provider-side account identifier disclosed by the login flow. */
  accountId?: string
  /** Epoch milliseconds at which the stored access token expires. */
  expiresAt?: number
}

/** Llm-domain unary methods (the map keys llm.* of RpcMethodMap). */
export interface LlmApi {
  /**
   * List every configurable provider with its live/dormant state, in
   * directory declaration order. Routes registered outside the directory
   * (an adapter that never declared configurability) are appended with their
   * registration identity and no settings address.
   */
  providers(request: RpcRequest<{}>): Promise<RpcResponse<{ providers: ConfigurableProviderView[] }>>

  /**
   * Host-scoped model catalog over every registered provider route: the
   * settings surface's models view, needing no session. Per-provider listing
   * failures ride `failures` without failing the sound groups.
   */
  models(request: RpcRequest<{}>): Promise<RpcResponse<{ groups: ModelProviderGroup[]; failures: ModelCatalogFailure[] }>>

  /**
   * Interrogate a provider endpoint the configuration surface is still
   * drafting, and return the models it advertises for the user to adopt.
   *
   * The payload is the draft, not a stored route: `settingsNs` selects the
   * adapter family that answers, and the rest comes from the form. `provider`
   * names the route being edited when there is one — an adapter that already
   * describes that route answers from its own registry, with better metadata
   * and no network call, and needs no endpoint. A route it does not describe is
   * asked over the wire, which is what `baseURL`, `api`, and `apiKey` are for.
   *
   * Nothing is written — the reply is candidates, and only a later
   * `settings.mutate` decides what a route serves. `apiKey` is accepted here
   * but never stored or returned; a provider whose key is already stored omits
   * it and the endpoint answers unauthenticated or refuses.
   */
  discoverModels(
    request: RpcRequest<{
      settingsNs: string
      provider?: string
      baseURL?: string
      api?: string
      apiKey?: string
    }>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<{ models: DiscoveredModelView[] }>>

  /**
   * Start (or restart) the OAuth login flow for one provider route. The flow
   * runs in the host and can take minutes (the user completes it in a
   * browser), so the call returns once the flow has started; progress and
   * prompts ride the forwarded `llm/oauth-event` host event, and a pending
   * manual-code prompt is answered through `llm.loginInput`. An OAuth route
   * that is not yet registered gets its minimal profile written first, so the
   * login itself activates it.
   */
  login(
    request: RpcRequest<{ provider: string }>,
  ): Promise<RpcResponse<{}>>

  /**
   * Answer a pending manual-code prompt of the live login flow for one
   * provider route with the value the user pasted (an authorization code or
   * the redirect URL).
   */
  loginInput(
    request: RpcRequest<{ provider: string; value: string }>,
  ): Promise<RpcResponse<{}>>

  /**
   * Cancel the live login flow for one provider route without touching a
   * stored credential: a flow the user abandons leaves whatever was already
   * logged in alone.
   */
  cancelLogin(
    request: RpcRequest<{ provider: string }>,
  ): Promise<RpcResponse<{}>>

  /**
   * Cancel the live login flow for one provider route and remove its stored
   * OAuth credential. Cancelling a flow that is not running is a no-op;
   * removing a credential that is not stored is a no-op.
   */
  logout(
    request: RpcRequest<{ provider: string }>,
  ): Promise<RpcResponse<{}>>

  /**
   * Report the durable OAuth state of every OAuth-authenticated configurable
   * provider, or of one named provider. The answer is local (the stored
   * credential); whether the credential still works is only answerable at
   * request time.
   */
  oauthStatus(
    request: RpcRequest<{ provider?: string }>,
  ): Promise<RpcResponse<{ providers: OAuthStatusView[] }>>
}

/** Wire view of one model an interrogated endpoint advertises. */
export interface DiscoveredModelView {
  /** Model id the endpoint accepts. */
  id: string
  /** Human-readable name when the endpoint supplies one. */
  name?: string
  /** Maximum combined request and response context, when disclosed. */
  contextWindow?: number
  /** Maximum output tokens, when disclosed. */
  maxTokens?: number
}
