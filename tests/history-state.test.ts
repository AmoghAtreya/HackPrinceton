import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendConversations, refreshConversations } from '../src/renderer/src/history-state.ts'
import type { ConversationPage } from '../src/shared/assistant-contracts.ts'

const item = (n: number) => ({ id: String(n).padStart(3, '0'), title: 'Conversation ' + n, updatedAt: n })
const page = (numbers: number[], more: boolean): ConversationPage => ({
  items: numbers.map(item), next: more ? { at: numbers.at(-1)!, id: item(numbers.at(-1)!).id } : null
})

test('live first-page refresh preserves loaded older conversations and their cursor', () => {
  const loaded = appendConversations(page([6, 5, 4], true), page([3, 2, 1], false))
  const refreshed = refreshConversations(loaded, page([7, 6, 5], true))
  assert.deepEqual(refreshed.items.map((value) => value.updatedAt), [7, 6, 5, 4, 3, 2, 1])
  assert.equal(refreshed.next, null)
  const again = refreshConversations(refreshed, page([7, 6, 5], true))
  assert.deepEqual(again, refreshed)
})

test('refresh replaces changed records, removes missing recent items, and honors clear history', () => {
  const loaded = page([6, 5, 4, 3, 2, 1], true)
  const fresh = page([7, 5, 4], true)
  fresh.items[1].title = 'Updated title'
  const refreshed = refreshConversations(loaded, fresh)
  assert.deepEqual(refreshed.items.map((value) => value.id), ['007', '005', '004', '003', '002', '001'])
  assert.equal(refreshed.items[1].title, 'Updated title')
  assert.deepEqual(refreshConversations(refreshed, page([], false)), page([], false))
})

test('overlapping pages deduplicate records and preserve descending order', () => {
  const merged = appendConversations(page([6, 5, 4], true), page([4, 3, 2], true))
  assert.deepEqual(merged.items.map((value) => value.updatedAt), [6, 5, 4, 3, 2])
  assert.deepEqual(merged.next, { at: 2, id: '002' })
})
