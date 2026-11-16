import { isHeldAgentPromptDraft } from '../../../../../../../shared/agent-launch/startup/agent-prompt-injection'

/** Matches the TUI agents' own Enter-retry wait, long enough for a busy composer to repaint. */
export const NATIVE_CHAT_SUBMIT_CHECK_MS = 1200

// Claude collapses a multi-line paste to this label, so the line cannot show the text itself.
const CLAUDE_COLLAPSED_PASTE = /^\[Pasted text #\d+ \+\d+ lines\]$/

/** True only when the line still shows this send's text, so a second Enter cannot submit text the user typed. */
export function nativeChatInputHoldsSentText(
  line: string | null | undefined,
  text: string
): boolean {
  if (!line) {
    return false
  }
  return (
    isHeldAgentPromptDraft(line, text, 1) ||
    (text.includes('\n') && CLAUDE_COLLAPSED_PASTE.test(line.trim()))
  )
}
