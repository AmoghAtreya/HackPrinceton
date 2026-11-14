import { Embeddings } from '@langchain/core/embeddings'

/**
 * On-device embeddings by feature hashing (words, word pairs, and character
 * trigrams), with a small synonym table for the vocabulary older adults use
 * for health, money and errands.
 *
 * Why not a hosted embedding model: memories hold personal details (pharmacy,
 * medications, card hints). Nothing here leaves the Mac. The trade-off is that
 * matching is lexical with synonyms, not truly semantic. Because this is a
 * LangChain `Embeddings`, a real local model can replace it without touching
 * the store, the retriever, or the task graphs.
 */

const SYNONYMS: Record<string, string> = {
  medicine: 'medication', medicines: 'medication', meds: 'medication', pills: 'medication', pill: 'medication',
  prescription: 'medication', prescriptions: 'medication', rx: 'medication', refill: 'refill', refills: 'refill',
  drugstore: 'pharmacy', chemist: 'pharmacy', pharmacist: 'pharmacy', cvs: 'pharmacy cvs', walgreens: 'pharmacy walgreens',
  doctor: 'doctor', doc: 'doctor', physician: 'doctor', dr: 'doctor', gp: 'doctor',
  bp: 'blood pressure', hypertension: 'blood pressure',
  card: 'payment', visa: 'payment visa', mastercard: 'payment mastercard', pay: 'payment', paying: 'payment',
  morning: 'morning', am: 'morning', afternoon: 'afternoon', pm: 'afternoon', evening: 'evening',
  pickup: 'pickup', 'pick-up': 'pickup', collect: 'pickup', delivery: 'delivery', deliver: 'delivery',
  daughter: 'family', son: 'family', grandson: 'family', granddaughter: 'family', caregiver: 'family'
}

export const EMBEDDING_DIM = 512

function hash(text: string): number {
  // FNV-1a, 32-bit.
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}

export function tokenize(text: string): string[] {
  const words = text.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean)
  return words.flatMap((word) => (SYNONYMS[word] ?? word).split(' '))
}

export function embedText(text: string, dim = EMBEDDING_DIM): number[] {
  const vector = new Array<number>(dim).fill(0)
  const add = (feature: string, weight: number) => {
    const h = hash(feature)
    vector[h % dim] += (h & 0x80000000 ? -1 : 1) * weight
  }
  const words = tokenize(text)
  for (let i = 0; i < words.length; i++) {
    add('w:' + words[i], 1)
    if (i + 1 < words.length) add('b:' + words[i] + '_' + words[i + 1], 0.7)
    const padded = `#${words[i]}#`
    for (let j = 0; j + 3 <= padded.length; j++) add('c:' + padded.slice(j, j + 3), 0.25)
  }
  const norm = Math.hypot(...vector)
  return norm ? vector.map((value) => value / norm) : vector
}

export class LocalHashEmbeddings extends Embeddings {
  constructor() { super({}) }
  async embedDocuments(documents: string[]): Promise<number[][]> { return documents.map((text) => embedText(text)) }
  async embedQuery(document: string): Promise<number[]> { return embedText(document) }
}
