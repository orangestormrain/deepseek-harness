/**
 * One OAuth-authenticated provider's card: sign-in, in-flow progress, and
 * sign-out. Unlike the key editor it has no form — the credential lives in
 * the adapter's own store, produced by the login flow the host runs — so the
 * card's only concerns are the durable state (`connected`, the disclosed
 * account) and the live flow the page is watching (`OAuthFlowState`).
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { OAuthFlowState } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link OAuthCard}. */
export interface OAuthCardProps {
  /** Display name for the card title. */
  displayName: string
  /** Whether the adapter holds a stored credential for the route. */
  connected: boolean
  /** Whether the route is registered with the adapter registry. */
  active: boolean
  /** Provider-side account id disclosed by the login flow, when it has one. */
  accountId?: string
  /** The live login-flow state the page is watching. */
  flow: OAuthFlowState
  /** Disable writes (read-only settings provider). */
  readOnly: boolean
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Start the host login flow, or enable the route when it is already signed in. */
  onLogin: () => void
  /** Remove the stored credential. */
  onLogout: () => void
  /** Cancel the live login flow. */
  onCancel: () => void
  /** Answer the flow's manual-code prompt with the pasted value. */
  onManualCode: (value: string) => void
}

/** Whether a flow is still in flight (started, not yet finished or failed). */
function flowActive(flow: OAuthFlowState): boolean {
  return flow.status === 'starting' || flow.status === 'waiting'
}

/**
 * Render one OAuth provider's card.
 * @param props - durable state, live flow, and the page's actions.
 * @returns the card.
 */
export function OAuthCard(props: OAuthCardProps): ReactNode {
  const { displayName, connected, active, accountId, flow, readOnly, t, onLogin, onLogout, onCancel, onManualCode } = props
  const [manualDraft, setManualDraft] = useState('')
  const flowRunning = flowActive(flow)
  const waiting = flow.status === 'waiting'
  const errorText = flow.status === 'error' ? flow.message : undefined

  return (
    <div className={styles['rowCard']}>
      <div className={styles['rowHead']}>
        <span className={styles['rowIdentity']}>
          <span className={styles['rowName']}>{displayName}</span>
          <span
            className={`${styles['credentialDot']} ${connected ? styles['credentialDotConfigured'] : styles['credentialDotMissing']}`}
            role="img"
            aria-label={connected ? t('oauthConnected') : t('oauthDisconnected')}
            title={connected ? t('oauthConnected') : t('oauthDisconnected')}
          />
        </span>
        <span className={styles['rowActions']}>
          {connected && active
            ? (
              <button
                type="button"
                className={styles['secondaryButton']}
                disabled={readOnly}
                onClick={onLogout}
              >
                {t('oauthSignOut')}
              </button>
            )
            : (
              <button
                type="button"
                className={connected ? styles['secondaryButton'] : styles['primaryButton']}
                disabled={readOnly || flowRunning}
                onClick={onLogin}
              >
                {connected ? t('oauthEnable') : t('oauthSignIn')}
              </button>
            )}
        </span>
      </div>
      {connected && accountId !== undefined
        ? <p className={styles['oauthStatus']}>{t('oauthSignedInAs').replace('{account}', accountId)}</p>
        : null}
      {flow.status === 'starting'
        ? (
          <div className={styles['oauthFlow']}>
            <p className={styles['oauthHint']}>{t('oauthStarting')}</p>
            <button type="button" className={styles['linkButton']} onClick={onCancel}>
              {t('oauthCancel')}
            </button>
          </div>
        )
        : null}
      {waiting
        ? (
          <div className={styles['oauthFlow']}>
            {flow.url !== undefined
              ? (
                <>
                  <p className={styles['oauthHint']}>{flow.instructions ?? t('oauthBrowserHint')}</p>
                  <a className={styles['oauthLink']} href={flow.url} target="_blank" rel="noreferrer">
                    {t('oauthOpenBrowser')}
                  </a>
                </>
              )
              : null}
            {flow.deviceCode !== undefined && flow.verificationUri !== undefined
              ? (
                <>
                  <p className={styles['oauthHint']}>
                    {t('oauthDeviceHint').replace('{uri}', flow.verificationUri)}
                  </p>
                  <code className={styles['oauthCode']}>{flow.deviceCode}</code>
                </>
              )
              : null}
            {flow.manualMessage !== undefined
              ? (
                <div className={styles['field']}>
                  <span className={styles['fieldLabel']}>{flow.manualMessage}</span>
                  <div className={styles['oauthManualRow']}>
                    <input
                      className={styles['input']}
                      value={manualDraft}
                      placeholder={flow.manualPlaceholder}
                      aria-label={flow.manualMessage}
                      onChange={(event) => { setManualDraft(event.target.value) }}
                    />
                    <button
                      type="button"
                      className={styles['secondaryButton']}
                      disabled={manualDraft.length === 0}
                      onClick={() => { onManualCode(manualDraft) }}
                    >
                      {t('oauthSubmit')}
                    </button>
                  </div>
                </div>
              )
              : null}
            <button type="button" className={styles['linkButton']} onClick={onCancel}>
              {t('oauthCancel')}
            </button>
          </div>
        )
        : null}
      {errorText !== undefined ? <p className={styles['error']}>{errorText}</p> : null}
    </div>
  )
}
