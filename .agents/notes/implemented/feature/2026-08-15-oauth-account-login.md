# Agent Note: ChatGPT account login through OAuth for pi-ai routes

Status: implemented

English | [中文](2026-08-15-oauth-account-login.zh.md)

## Problem

The pi-ai adapter's configurable-provider directory withheld every provider that authenticates through OAuth alone, `openai-codex` being the only one the installed catalog ships. pi-ai resolves OAuth only from a *stored* credential, the adapter built its `Models` collection with no credential store, and nothing ran a login flow — so a ChatGPT (Plus/Pro) account, which is exactly what `openai-codex` authenticates with, could not be used at all, and every request on such a route failed `Provider is not configured` before it went out. The web Models page could configure API keys and nothing else, so an account subscriber had no path to those models short of an API key they may not have.

The missing pieces were four: a durable credential store pi-ai could resolve OAuth credentials from, a login flow run somewhere a browser can complete (the provider's flow needs a Node.js local callback server, so it belongs in the host, not the page), a wire path from the Models page to that flow, and a directory declaration that told the page to render a login card instead of a key field.

## Decision

**The adapter owns a durable OAuth credential store.** `FileOAuthStore` (in `llm-pi-ai`) implements pi-ai's `CredentialStore` over `$DSH_HOME/.oauth.json` — one credential per provider route, owner-only mode 0600, atomic whole-file rewrite, one write chain. Every snapshot's `Models` collection is built with it (`createModels({ credentials })`), so request-time OAuth resolution and token refresh under pi-ai's store lock work exactly as pi-ai designed. API keys stay in the name→secret credentials seam; the two planes never meet.

**The `llm` seam gains OAuth operations.** `LlmAdapter` gets optional `login`/`logout`/`oauthStatus`; `LlmRuntime` dispatches them to the owning adapter (`login`/`logout` refuse with `OAUTH_UNSUPPORTED`, `oauthStatus` answers `connected: false` for routes no adapter owns). The interaction is DSH's `LlmLoginInteraction` — structurally the same prompt/event vocabulary as pi-ai's `AuthInteraction`, so an adapter hands it through without translation — and flow steps are relayed through the typed `llm/oauth-event(provider, event)` host event. The configurable-provider directory declares each route's authentication method (`auth: 'api_key' | 'oauth'`), with a profile's own `apiKeyEnv` outranking the catalog's native method (a repointed Codex route is a key route).

**The web host runs the flow; the page observes it.** `llm.login` writes the route's minimal reference-free profile first (the settings write is what registers the route), waits for registration, then starts the provider's flow with an interaction that auto-selects the browser method, relays every step to `llm/oauth-event`, and keeps a pending manual-code prompt answerable through `llm.loginInput`. The host also opens the authorization URL in the system browser the moment the flow asks for it (`openNativeUrl`, https-only): the page cannot, because the flow started on a wire call and a page-side `window.open` would be blocked as not-a-gesture — the page keeps its link as the fallback when no desktop is reachable. `llm.cancelLogin` aborts a flow without touching a stored credential (a re-login the user abandons leaves the previous session signed in); `llm.logout` aborts the flow and removes the credential. The Models page folds the forwarded events into per-route flow state and renders the `OAuthCard` — sign-in, in-flow progress (browser link, device code, or paste-the-code field), signed-in account, and sign-out.

**An existing Codex CLI login is adopted, not recreated.** A machine that already signed ChatGPT in through `codex login` (`~/.codex/auth.json`, `auth_mode: chatgpt`) is already bound: the OAuth store's first read of the route adopts that credential — copied into the OAuth document, so the store then owns and refreshes its own copy — and the Models page shows the account without any flow. Sign-out writes a `null` document entry that blocks the codex source durably, so "退出登录" stays off until a real login; `oauthCodexHome` names the OS home the adoption reads. The adopted copy refreshes independently, so alternating between DSH and codex-cli can rotate the shared refresh token; a failed request after such rotation is fixed by signing out and logging in once more.

**The new wire methods are configuration-plane work.** `llm.login`, `llm.loginInput`, `llm.cancelLogin`, `llm.logout`, and `llm.oauthStatus` join the loopback-pinned privileged set: they mutate the stored credential store, drive host network/browser activity, and their read is credential-state reconnaissance.

## Alternatives considered

- **Device-code flow by default** — needs no local callback port and completes without typing, but the browser flow is what the provider's CLI defaults to and the device endpoint can be disabled server-side; the browser flow is chosen, with device code and paste-the-code as the flow's own fallbacks.
- **Running the flow in the page** — pi-ai's browser flow starts a Node.js `node:http` callback server; the page cannot, so the host runs it and the page observes events. The provider's own manual-code prompt is the escape hatch when the callback cannot complete.
- **Storing OAuth tokens in the credentials seam** — the seam is name→secret for environment-style references; a structured per-provider credential with access/refresh/expiry does not fit its model, and mixing planes would blur redaction and ownership.
- **Polling for flow state instead of events** — the forwarded-event allowlist already exists and is the page's invalidation channel; a status poll would add latency and a second fact source.

## Consequences

The Models page offers `openai-codex` with a login card; a completed login — or an adopted Codex CLI login — persists the credential durably, later requests authenticate with automatic refresh under the store lock, and sign-out removes the credential without unconfiguring the route. A keyless profile on any non-OAuth route still means unauthenticated (provider-native ambient discovery answers only a profile that names no credential), and an expired *refresh* token fails requests with the provider's own error until re-login — nothing watches for revocation out of band. The `llm/oauth-event` allowlist entry, the four RPC schemas, and the wire view of `auth` on `ConfigurableProviderView` are new wire contracts that must stay in step with the seam types they mirror.
