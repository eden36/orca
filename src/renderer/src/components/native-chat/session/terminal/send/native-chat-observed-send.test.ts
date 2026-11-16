import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sendRuntimePtyInputVerified: vi.fn((..._args: unknown[]) => Promise.resolve(true)),
  sendRuntimePtyInput: vi.fn()
}))

vi.mock('@/runtime/hosted-terminals/input/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: (...args: unknown[]) => mocks.sendRuntimePtyInputVerified(...args)
}))
vi.mock('@/runtime/hosted-terminals/input/runtime-terminal-input-send', () => ({
  sendRuntimePtyInput: (...args: unknown[]) => mocks.sendRuntimePtyInput(...args)
}))

import { sendNativeChatMessage } from './native-chat-runtime-send'
import { resetNativeChatPtySendQueuesForTests } from './native-chat-pty-send-queue'

const TEXT = 'explain the cache'

function send(readInputLine: () => string | null) {
  const onWriteRejected = vi.fn()
  const handle = sendNativeChatMessage('pty-1', TEXT, {
    clearInput: '',
    onWriteRejected,
    confirmSubmit: { text: TEXT, readInputLine }
  })
  return { handle, onWriteRejected }
}

function enterWrites(): number {
  return mocks.sendRuntimePtyInputVerified.mock.calls.filter((call) => call[1] === '\r').length
}

describe('native chat send confirms Enter took', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.sendRuntimePtyInputVerified.mockClear()
  })
  afterEach(() => {
    resetNativeChatPtySendQueuesForTests()
    vi.useRealTimers()
  })

  it('presses Enter once more when the sent text is still on the input line', async () => {
    const lines = [TEXT, '']
    const { handle, onWriteRejected } = send(() => lines.shift() ?? '')
    await vi.runAllTimersAsync()
    expect(enterWrites()).toBe(2)
    expect(onWriteRejected).not.toHaveBeenCalled()
    expect(await handle.outcome).toBe('submitted')
  })

  it('reports the message not sent when the second Enter is also dropped', async () => {
    const { handle, onWriteRejected } = send(() => TEXT)
    await vi.runAllTimersAsync()
    expect(enterWrites()).toBe(2)
    expect(onWriteRejected).toHaveBeenCalledTimes(1)
    expect(await handle.outcome).toBe('not-submitted')
  })

  it('never presses Enter on text the user typed', async () => {
    const { handle, onWriteRejected } = send(() => 'my own draft')
    await vi.runAllTimersAsync()
    expect(enterWrites()).toBe(1)
    expect(onWriteRejected).not.toHaveBeenCalled()
    expect(await handle.outcome).toBe('submitted')
  })
})
