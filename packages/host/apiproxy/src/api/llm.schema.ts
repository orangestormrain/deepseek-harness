/**
 * llm domain zod schemas (names derived from map keys: llmProvidersRequestSchema /
 * llmProvidersValueSchema / llmModelsRequestSchema / llmModelsValueSchema).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { ConfigurableProviderView, DiscoveredModelView, OAuthStatusView } from './llm.ts'
import { modelCatalogFailureSchema, modelProviderGroupSchema } from './sessions.schema.ts'

/** ConfigurableProviderView row of llm.providers. */
export const configurableProviderViewSchema = z.object({
  provider: z.string().min(1),
  displayName: z.string().min(1),
  settingsNs: z.string(),
  settingsPath: z.array(z.string()),
  active: z.boolean(),
  declared: z.boolean().optional(),
  auth: z.enum(['api_key', 'oauth']).optional(),
}) satisfies z.ZodType<Wire<ConfigurableProviderView>>

/** llm.providers request payload. */
export const llmProvidersRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'llm.providers'>>>

/** llm.providers response value. */
export const llmProvidersValueSchema = z.object({
  providers: z.array(configurableProviderViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.providers'>>>

/** llm.models request payload. */
export const llmModelsRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'llm.models'>>>

/** llm.models response value. */
export const llmModelsValueSchema = z.object({
  groups: z.array(modelProviderGroupSchema),
  failures: z.array(modelCatalogFailureSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.models'>>>

/** DiscoveredModelView row of llm.discoverModels. */
export const discoveredModelViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
}) satisfies z.ZodType<Wire<DiscoveredModelView>>

/** llm.discoverModels request payload. */
export const llmDiscoverModelsRequestSchema = z.object({
  settingsNs: z.string().min(1),
  provider: z.string().min(1).optional(),
  baseURL: z.string().min(1).optional(),
  api: z.string().min(1).optional(),
  // Write-only at the host: used for this one interrogation, never stored and
  // never returned. It does ride the client's outgoing envelope like every
  // other secret-bearing payload (`credentials.set`, `settings.update`), which
  // `subscribeEnvelopes()` observers can see — redacting that tap is a
  // configuration-plane-wide change, not this method's to make alone.
  apiKey: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.discoverModels'>>>

/** llm.discoverModels response value. */
export const llmDiscoverModelsValueSchema = z.object({
  models: z.array(discoveredModelViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.discoverModels'>>>

/** OAuthStatusView row of llm.oauthStatus. */
export const oauthStatusViewSchema = z.object({
  provider: z.string().min(1),
  connected: z.boolean(),
  accountId: z.string().min(1).optional(),
  expiresAt: z.number().positive().optional(),
}) satisfies z.ZodType<Wire<OAuthStatusView>>

/** llm.login request payload. */
export const llmLoginRequestSchema = z.object({
  provider: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.login'>>>

/** llm.login response value. */
export const llmLoginValueSchema = z.object({}) satisfies z.ZodType<Wire<ResponseValue<'llm.login'>>>

/** llm.loginInput request payload. */
export const llmLoginInputRequestSchema = z.object({
  provider: z.string().min(1),
  value: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.loginInput'>>>

/** llm.loginInput response value. */
export const llmLoginInputValueSchema = z.object({}) satisfies z.ZodType<Wire<ResponseValue<'llm.loginInput'>>>

/** llm.cancelLogin request payload. */
export const llmCancelLoginRequestSchema = z.object({
  provider: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.cancelLogin'>>>

/** llm.cancelLogin response value. */
export const llmCancelLoginValueSchema = z.object({}) satisfies z.ZodType<Wire<ResponseValue<'llm.cancelLogin'>>>

/** llm.logout request payload. */
export const llmLogoutRequestSchema = z.object({
  provider: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.logout'>>>

/** llm.logout response value. */
export const llmLogoutValueSchema = z.object({}) satisfies z.ZodType<Wire<ResponseValue<'llm.logout'>>>

/** llm.oauthStatus request payload. */
export const llmOauthStatusRequestSchema = z.object({
  provider: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.oauthStatus'>>>

/** llm.oauthStatus response value. */
export const llmOauthStatusValueSchema = z.object({
  providers: z.array(oauthStatusViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.oauthStatus'>>>
