/**
 * Host-side OAuth login flow orchestration for the web GUI carrier. The flow
 * itself is the provider's (pi-ai's openai-codex browser/device flows); this
 * module owns the interaction surface: it starts the flow on the llm seam,
 * relays its prompts and progress events to the forwarded `llm/oauth-event`
 * host event, auto-answers the method-choice prompt with the browser flow,
 * and answers manual-code prompts that surfaces resolve through
 * `llm.loginInput`.
 *
 * @module dsh-host-apiproxy/oauth-login
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmLoginInteraction, LlmOAuthEvent } from '@deepseek-ai/dsh-llm'

/** One in-flight login flow, keyed by provider route. */
export interface RunningOauthFlow {
  /** Abort the flow and its pending prompts. */
  controller: AbortController
  /** Settles when the flow finished; rejection is contained by the starter. */
  settled: Promise<void>
  /** Answer a pending manual-code prompt; false when none is pending. */
  answer(value: string): boolean
}

/** Live flows by provider route; a restart replaces its provider's entry. */
const flows = new Map<string, RunningOauthFlow>()

/** The live flow for one provider route, if any. */
export function oauthFlow(provider: string): RunningOauthFlow | undefined {
  return flows.get(provider)
}

/** Abort the live flow for one provider route, if any. */
export function abortOauthFlow(provider: string): void {
  flows.get(provider)?.controller.abort('login cancelled by the surface')
}

/** Relay one flow step to every `llm/oauth-event` consumer. */
function relay(ctx: Context, provider: string, event: LlmOAuthEvent): void {
  ctx.emit('llm/oauth-event', provider, event)
}

/** Options of {@link startOauthLogin}. */
export interface StartOauthLoginOptions {
  /**
   * Open one authorization URL in the user's browser when the flow produces
   * one. The web page cannot open the URL itself (the flow starts on a wire
   * call, so a page-side `window.open` would be blocked as not-a-gesture);
   * the host owns the browser hand-off exactly like a CLI login would.
   */
  openBrowser?: (url: string) => void
}

/**
 * Start the OAuth login flow for one provider route and register it as that
 * route's live flow. The route's adapter must already own the route. The
 * returned handle is registered before the flow's first await, so a
 * `llm.loginInput` arriving right after `llm.login` still finds it.
 * @param ctx - host context carrying the llm seam.
 * @param provider - registered provider route to log into.
 * @param options - browser hand-off hook.
 * @returns the running flow handle.
 */
export function startOauthLogin(
  ctx: Context,
  provider: string,
  options: StartOauthLoginOptions = {},
): RunningOauthFlow {
  const controller = new AbortController()
  let pending: { resolve(value: string): void; reject(error: unknown): void } | undefined
  const interaction: LlmLoginInteraction = {
    signal: controller.signal,
    prompt: (prompt) => {
      if (prompt.type === 'select') {
        // The web page has no seat for a method choice, so the browser flow —
        // the one Codex CLI defaults to and the only one that completes
        // without typing — is picked automatically.
        const preferred = prompt.options.find(option => option.id === 'browser')
        return Promise.resolve(preferred?.id ?? prompt.options[0]?.id ?? '')
      }
      if (prompt.type === 'manual_code') {
        relay(ctx, provider, {
          type: 'manual_code',
          message: prompt.message,
          ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
        })
        return new Promise((resolve, reject) => { pending = { resolve, reject } })
      }
      return Promise.reject(new Error(
        `llm login flow for "${provider}" requested a ${prompt.type} prompt, which the web GUI cannot answer`,
      ))
    },
    notify: (event) => {
      relay(ctx, provider, event)
      if (event.type !== 'auth_url' || options.openBrowser === undefined) return
      try {
        options.openBrowser(event.url)
      } catch (error) {
        // The browser hand-off is a convenience beside the page link, never a
        // flow failure: a headless host still completes through the card.
        ctx.logger.warn(`llm login: could not open the authorization page for "${provider}"; use the Models page link instead`)
        ctx.logger.warn(error)
      }
    },
  }
  const settled = ctx.llm.login(provider, interaction).then(
    (result) => {
      relay(ctx, provider, {
        type: 'complete',
        ...result.accountId === undefined ? {} : { accountId: result.accountId },
      })
    },
    (error: unknown) => {
      // Cancellation is announced by the cancelling surface; everything else
      // is the user's next move and belongs on the page.
      if (controller.signal.aborted) return
      relay(ctx, provider, { type: 'error', message: error instanceof Error ? error.message : String(error) })
    },
  )
  const flow: RunningOauthFlow = {
    controller,
    settled,
    answer: (value) => {
      const pendingPrompt = pending
      if (pendingPrompt === undefined) return false
      pending = undefined
      pendingPrompt.resolve(value)
      return true
    },
  }
  flows.set(provider, flow)
  void settled.finally(() => {
    // Only the current flow removes itself: a restart that replaced it keeps
    // the newer entry serving `llm.oauthStatus` and `llm.loginInput`.
    if (flows.get(provider) === flow) flows.delete(provider)
  })
  return flow
}
