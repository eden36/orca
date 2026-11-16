import { sendRuntimePtyInputVerified } from '@/runtime/hosted-terminals/input/runtime-terminal-verified-input'
import { enqueueNativeChatPtySend } from './native-chat-pty-send-queue'
import { NATIVE_CHAT_SUBMIT } from '../../../../../../../shared/native-chat/input/composer/native-chat-paste-bytes'
import {
  NATIVE_CHAT_SUBMIT_CHECK_MS,
  nativeChatInputHoldsSentText
} from './native-chat-submit-check'
import {
  clearConfirmDurationMs,
  clearThenWrite,
  clearUnsubmittedAgentInput,
  type NativeChatSendOptions
} from './native-chat-input-clear'

export function sendNativeChatObservedWrites(
  ptyId: string,
  writes: readonly { data: string; delayBeforeMs: number }[],
  options: NativeChatSendOptions & { stopOnUnconfirmed?: boolean; settleDelayMs?: number }
) {
  // Dismiss answer cards only after provider acknowledgment.
  const writeOptions = options.onDeliverySettled
    ? ({ requireWriteSettlement: true } as const)
    : undefined
  return enqueueNativeChatPtySend(
    ptyId,
    writes.reduce((total, write) => total + write.delayBeforeMs, 0) +
      clearConfirmDurationMs(options) +
      (options.settleDelayMs ?? 0) +
      (options.confirmSubmit ? NATIVE_CHAT_SUBMIT_CHECK_MS : 0),
    ({ isCancelled, delay, markSubmitted, markWriteStarted }) => {
      let reportedUnconfirmed = false
      let acknowledged = true
      const writeAt = (index: number): void => {
        if (isCancelled()) {
          return
        }
        const write = writes[index]
        if (!write) {
          const finish = (): void => {
            options.onDeliverySettled?.(acknowledged)
            markSubmitted(acknowledged ? 'submitted' : 'uncertain')
          }
          const settle = (): void => {
            if (options.settleDelayMs) {
              delay(options.settleDelayMs, finish)
            } else {
              finish()
            }
          }
          const confirmSubmit = options.confirmSubmit
          if (!confirmSubmit || !acknowledged) {
            settle()
            return
          }
          // An acknowledged Enter can still be dropped by a busy TUI; check the line, not the write.
          const checkSubmitted = (resubmitted: boolean): void => {
            delay(NATIVE_CHAT_SUBMIT_CHECK_MS, () => {
              let held = false
              try {
                held = nativeChatInputHoldsSentText(confirmSubmit.readInputLine(), confirmSubmit.text)
              } catch {
                // An unreadable terminal cannot prove a dropped Enter.
              }
              if (!held) {
                settle()
                return
              }
              if (resubmitted) {
                options.onWriteRejected?.()
                options.onDeliverySettled?.(false)
                markSubmitted('not-submitted')
                return
              }
              void sendRuntimePtyInputVerified(ptyId, NATIVE_CHAT_SUBMIT, 'driving', writeOptions)
                .then((accepted) => {
                  if (isCancelled()) {
                    return
                  }
                  if (accepted) {
                    checkSubmitted(true)
                    return
                  }
                  options.onWriteRejected?.()
                  options.onDeliverySettled?.(false)
                  markSubmitted('not-submitted')
                })
                .catch(() => {
                  if (!isCancelled()) {
                    options.onWriteUnconfirmed?.()
                    options.onDeliverySettled?.(false)
                    markSubmitted('uncertain')
                  }
                })
            })
          }
          checkSubmitted(false)
          return
        }
        const send = (): void => {
          if (isCancelled()) {
            return
          }
          markWriteStarted()
          void sendRuntimePtyInputVerified(ptyId, write.data, 'driving', writeOptions)
            .then((accepted) => {
              if (isCancelled()) {
                return
              }
              if (!accepted) {
                options.onWriteRejected?.()
                options.onDeliverySettled?.(false)
                markSubmitted(index === 0 ? 'not-submitted' : 'uncertain')
                return
              }
              writeAt(index + 1)
            })
            // Lost acknowledgments must not replay bytes; submit the possibly delivered body as on the unobserved path.
            .catch(() => {
              if (isCancelled()) {
                return
              }
              acknowledged = false
              if (!reportedUnconfirmed) {
                reportedUnconfirmed = true
                options.onWriteUnconfirmed?.()
              }
              if (options.stopOnUnconfirmed) {
                options.onDeliverySettled?.(false)
                markSubmitted('uncertain')
                return
              }
              writeAt(index + 1)
            })
        }
        if (write.delayBeforeMs > 0) {
          delay(write.delayBeforeMs, send)
        } else {
          send()
        }
      }
      clearThenWrite(ptyId, options, delay, () => writeAt(0), markSubmitted)
    },
    { onCancelUnsubmitted: () => clearUnsubmittedAgentInput(ptyId, options) }
  )
}
