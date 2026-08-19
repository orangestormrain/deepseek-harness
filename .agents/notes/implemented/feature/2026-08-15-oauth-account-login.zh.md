# Agent Note: pi-ai 路由的 ChatGPT 账号 OAuth 登录

Status: implemented

[English](2026-08-15-oauth-account-login.md) | 中文

## 问题

pi-ai 适配器的可配置提供方目录刻意不列出任何仅以 OAuth 认证的提供方，已安装 catalog 中只有 `openai-codex` 属于此类。pi-ai 的 OAuth 只从*已存储*的凭据解析，适配器构造 `Models` 集合时不注入凭据存储，也没有任何环节运行登录流程——于是 ChatGPT（Plus/Pro）账号——正是 `openai-codex` 用来认证的东西——完全无法使用，这类路由的每个请求都在发出之前以 `Provider is not configured` 失败。Web 模型页只能配置 API 密钥，账号订阅用户想用这些模型，只能去拿一枚可能并不存在的 API key。

缺失的是四样东西：一个 pi-ai 可以从中解析 OAuth 凭据的持久化凭据存储；一个在浏览器可以完成的地方运行的登录流程（提供方流程需要 Node.js 本地回调服务器，所以它属于宿主，不属于页面）；一条从模型页到该流程的 wire 路径；以及一条告诉页面渲染登录卡片而非密钥字段的目录声明。

## 决策

**适配器持有持久化 OAuth 凭据存储。** `FileOAuthStore`（位于 `llm-pi-ai`）基于 `$DSH_HOME/.oauth.json` 实现 pi-ai 的 `CredentialStore`——每个提供方路由一条凭据、仅属主 0600 权限、原子整文件重写、单一写链。每个快照的 `Models` 集合都带着它构建（`createModels({ credentials })`），于是请求时的 OAuth 解析与 pi-ai store 锁内的 token 刷新完全按 pi-ai 的设计工作。API 密钥继续留在 name→secret 凭据 seam；两个平面永不相交。

**`llm` seam 新增 OAuth 操作。** `LlmAdapter` 增加可选的 `login`/`logout`/`oauthStatus`；`LlmRuntime` 把它们分发到所属适配器（`login`/`logout` 以 `OAUTH_UNSUPPORTED` 拒绝，`oauthStatus` 对无适配器拥有的路由回答 `connected: false`）。交互对象是 DSH 的 `LlmLoginInteraction`——与 pi-ai 的 `AuthInteraction` 结构同构（相同的 prompt/event 词汇），适配器无需转换即可透传——流程步骤经由类型化宿主事件 `llm/oauth-event(provider, event)` 转发。可配置提供方目录为每条路由声明其认证方式（`auth: 'api_key' | 'oauth'`），profile 自己的 `apiKeyEnv` 优先于 catalog 原生方式（被改指向密钥的 Codex 路由就是密钥路由）。

**Web 宿主运行流程，页面观察它。** `llm.login` 先写入该路由最小的无引用 profile（这次 settings 写入正是注册路由的动作），等待注册完成，再以自动选择浏览器方式的交互对象启动提供方流程，把每一步转发到 `llm/oauth-event`，并把挂起的 manual-code prompt 留给 `llm.loginInput` 应答。宿主还会在流程索要授权页的那一刻用系统浏览器打开该 URL（`openNativeUrl`，仅 https）：页面做不到——流程由 wire 调用启动，页面侧 `window.open` 会被当作非用户手势拦截——因此页面保留链接作为无桌面环境时的兜底。`llm.cancelLogin` 中止流程但不碰已存凭据（用户放弃的重新登录不会把之前的会话登出）；`llm.logout` 中止流程并移除凭据。模型页把转发来的事件折进按路由区分的流程状态，渲染 `OAuthCard`——登录、流程中进度（浏览器链接、设备码或粘贴授权码输入框）、已登录账号与退出登录。

**已有的 Codex CLI 登录是被采纳，而非重新创建。** 本机已通过 `codex login` 登录 ChatGPT（`~/.codex/auth.json` 中 `auth_mode: chatgpt`）即视为已绑定：OAuth store 对该路由的首次读取会采纳这份凭据——拷贝进 OAuth 文档，此后由 store 独立持有并刷新——模型页无需任何流程即显示该账号。退出登录写入 `null` 文档条目，持久屏蔽 codex 来源，因此「退出登录」之后不会再次自动采纳，直到真正登录一次；`oauthCodexHome` 用于指定采纳所读取的 OS home。采纳的副本独立刷新，因此 DSH 与 codex-cli 交替使用可能轮换共享的 refresh token；若此后请求失败，退出登录再登录一次即可恢复。

**新增 wire 方法属于配置平面。** `llm.login`、`llm.loginInput`、`llm.cancelLogin`、`llm.logout`、`llm.oauthStatus` 全部进入环回钉死的特权集合：它们会改动已存凭据存储、驱动宿主的网络/浏览器活动，其读操作本身也是凭据状态侦察。

## 备选方案

- **默认设备码流程**——不需要本地回调端口，也无需输入即可完成，但浏览器流程才是该提供方 CLI 的默认，且设备端点可能被服务端关闭；故选择浏览器流程，设备码与粘贴授权码作为流程自带的回退。
- **在页面里运行流程**——pi-ai 的浏览器流程要启动 Node.js `node:http` 回调服务器；页面做不到，所以由宿主运行、页面观察事件。提供方自带的 manual-code prompt 是回调无法完成时的逃生通道。
- **把 OAuth token 存进凭据 seam**——该 seam 是给环境式引用的 name→secret；含 access/refresh/expiry 的结构化按提供方凭据不符合它的模型，混用两个平面会模糊脱敏与归属。
- **用轮询代替事件获取流程状态**——转发事件白名单已经存在，并且本来就是页面的失效通道；状态轮询只会增加延迟和第二个事实源。

## 后果

模型页为 `openai-codex` 提供登录卡片；完成登录——或采纳已有的 Codex CLI 登录——后凭据持久化保存，后续请求在 store 锁内自动刷新认证，退出登录只移除凭据、不解除路由配置。非 OAuth 路由上的无密钥 profile 依旧表示未认证（完全不点名凭据的 profile 才由提供方自带的环境发现应答），而 refresh token 已失效时请求会以提供方自己的错误失败，直到重新登录——没有任何环节带外监控吊销。`llm/oauth-event` 白名单条目、四个 RPC schema 以及 `ConfigurableProviderView` 上的 `auth` wire 视图都是新的 wire 契约，必须与它们镜像的 seam 类型保持同步。
