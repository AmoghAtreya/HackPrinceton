import type { ConversationPage, ConversationSummary } from '../../shared/assistant-contracts.ts'

function order(a: ConversationSummary, b: ConversationSummary): number {
  return b.updatedAt - a.updatedAt || b.id.localeCompare(a.id)
}

/** Keep already loaded older pages when a live request refreshes the first page. */
export function refreshConversations(current: ConversationPage, first: ConversationPage): ConversationPage {
  const boundary = first.items.at(-1)
  if (!first.next || !boundary) return first
  const older = current.items.filter((item) => order(item, boundary) > 0)
  const items = [...new Map([...older, ...first.items].map((item) => [item.id, item])).values()].sort(order)
  return { items, next: older.length ? current.next : first.next }
}

export function appendConversations(current: ConversationPage, page: ConversationPage): ConversationPage {
  return {
    items: [...new Map([...current.items, ...page.items].map((item) => [item.id, item])).values()].sort(order),
    next: page.next
  }
}
