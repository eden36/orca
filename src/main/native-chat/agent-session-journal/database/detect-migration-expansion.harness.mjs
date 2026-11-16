#!/usr/bin/env node
// Read-only: which tabs and chats in a chat store the faulty #42783 pass created.
// usage: node detect-migration-expansion.mjs <legacy agent-session-journal.db copy> <domain store copy> [--ids]
// Opens both files read-only. Run it on copies only; it never writes either file.
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const [legacyPath, domainPath, ...flags] = process.argv.slice(2)
if (!legacyPath || !domainPath) {
  console.error('usage: detect-migration-expansion.mjs <legacy.db> <domain.db> [--ids]')
  process.exit(2)
}
const started = performance.now()
const legacy = new DatabaseSync(legacyPath, { readOnly: true })
const domain = new DatabaseSync(domainPath, { readOnly: true })
const has = (db, table) =>
  db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table) !== undefined
const meta = (key) =>
  domain.prepare('SELECT value FROM agent_session_store_meta WHERE key=?').get(key)?.value

const legacyIds = legacy
  .prepare('SELECT session_id FROM agent_session_records ORDER BY rowid')
  .all()
  .map((row) => String(row.session_id))
const rank = new Map(legacyIds.map((id, index) => [id, index]))
const legacyTabbed = new Set(
  legacy
    .prepare('SELECT session_id FROM agent_session_tabs')
    .all()
    .map((row) => String(row.session_id))
)
const domainRecords = new Set(
  domain
    .prepare('SELECT session_id FROM agent_session_records')
    .all()
    .map((row) => String(row.session_id))
)

// Copies: the pass names a copy sha256(original id NUL revision) with the revision it recorded.
const copyOf = new Map()
for (const id of legacyIds) {
  const revision = meta(`journal.legacy-revision:${id}`)
  if (revision === undefined) continue
  const copy = createHash('sha256').update(`${id}\0${revision}`).digest('hex').slice(0, 32)
  if (domainRecords.has(copy)) copyOf.set(copy, id)
}

// A copy holds an older build's turns only if it has an item its original here never held
// (removing an item here leaves its tombstone).
const itemsOf = (id, withTombstones) => {
  const held = new Set()
  for (const table of withTombstones ? ['journal_items', 'journal_item_tombstones'] : ['journal_items']) {
    if (!has(domain, table)) continue
    for (const row of domain.prepare(`SELECT item_id AS id FROM ${table} WHERE session_id=?`).iterate(id)) {
      held.add(String(row.id))
    }
  }
  return held
}
const neededCopies = new Set(
  [...copyOf]
    .filter(([copy, id]) => {
      const held = itemsOf(id, true)
      return [...itemsOf(copy, false)].some((item) => !held.has(item))
    })
    .map(([copy]) => copy)
)

// Where the original chat's history stands: its epoch and tip.
const sourceTip = (id) => {
  const session = legacy.prepare('SELECT epoch FROM journal_sessions WHERE session_id=?').get(id)
  if (!session) return { epoch: null, tip: 0 }
  const tip = legacy
    .prepare('SELECT seq FROM journal_rows WHERE session_id=? AND epoch=? ORDER BY seq DESC LIMIT 1')
    .get(id, session.epoch)
  return { epoch: String(session.epoch), tip: Number(tip?.seq ?? 0) }
}
const chatState = (id) =>
  domain.prepare('SELECT epoch,last_sequence FROM journal_chat_state WHERE session_id=?').get(id)
// Nothing written here since the pass: never converted, or still at the original's tip.
const untouched = (session) => {
  const original = copyOf.get(session) ?? session
  const state = chatState(session)
  if (!state || state.epoch === null) return true
  const { epoch, tip } = sourceTip(original)
  return String(state.epoch) === epoch && Number(state.last_sequence) === tip
}

// The pass appended its tabs at the tail in the original's record order (a copy at its
// original's place). The longest run of tabs, by position, of original chats or copies in strictly
// increasing original order is that block, minus any the user moved or closed since.
const tabs = domain
  .prepare('SELECT tab_id,session_id,position FROM agent_session_tabs ORDER BY position')
  .all()
  .map((row) => ({ tab: String(row.tab_id), session: String(row.session_id), position: Number(row.position) }))
const closedInOriginal = (session) => {
  const original = copyOf.get(session) ?? session
  return rank.has(original) && (copyOf.has(session) || !legacyTabbed.has(original))
}
let best = []
let run = []
let last = -1
for (const tab of tabs) {
  const original = copyOf.get(tab.session) ?? tab.session
  const r = rank.get(original)
  if (r === undefined) {
    run = []
    last = -1
    continue
  }
  if (r <= last) run = []
  run.push(tab)
  last = r
  if (run.length > best.length) best = [...run]
}
const block = best
const blockCopies = block.filter((tab) => copyOf.has(tab.session))
const blockOriginals = block.filter((tab) => !copyOf.has(tab.session))
const untouchedOriginals = blockOriginals.filter((tab) => untouched(tab.session))
const untouchedCopies = blockCopies.filter((tab) => untouched(tab.session))
const spuriousCopies = [...copyOf.keys()].filter((copy) => !neededCopies.has(copy))
const tabbedSessions = new Set(tabs.map((tab) => tab.session))

const result = {
  legacy: { records: legacyIds.length, tabbed: legacyTabbed.size },
  domain: {
    records: domainRecords.size,
    tabs: tabs.length,
    revisionsKept: meta('journal.legacy-revisions-kept.v1') !== undefined
  },
  legacyClosedNowTabbed: legacyIds.filter((id) => !legacyTabbed.has(id) && tabbedSessions.has(id)).length,
  copies: {
    total: copyOf.size,
    tabbed: [...copyOf.keys()].filter((copy) => tabbedSessions.has(copy)).length,
    holdingOlderBuildTurns: neededCopies.size,
    duplicatesOnly: spuriousCopies.length,
    duplicatesOnlyTabbedUntouched: spuriousCopies.filter(
      (copy) => tabbedSessions.has(copy) && untouched(copy)
    ).length
  },
  migrationTabBlock: {
    tabs: block.length,
    firstPosition: block[0]?.position ?? null,
    lastPosition: block.at(-1)?.position ?? null,
    originals: blockOriginals.length,
    originalsClosedInOriginal: blockOriginals.filter((tab) => closedInOriginal(tab.session)).length,
    originalsUntouched: untouchedOriginals.length,
    copies: blockCopies.length,
    copiesUntouched: untouchedCopies.length
  },
  ms: Math.round(performance.now() - started)
}
if (flags.includes('--ids')) {
  result.ids = {
    duplicateCopies: spuriousCopies,
    untouchedOriginalTabs: untouchedOriginals.map((tab) => tab.tab),
    untouchedCopyTabs: untouchedCopies.map((tab) => tab.tab)
  }
}
console.log(JSON.stringify(result, null, 2))
legacy.close()
domain.close()
