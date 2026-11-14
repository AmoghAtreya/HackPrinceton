// Simulated users for the "it adapts to each person" demo (design doc, demo step 4).
// Two personas with different hidden preferences use the bandit for N sessions;
// prints the rolling average reward and each persona's most-chosen arm.
//
// Run: node --experimental-strip-types scripts/simulate-simplifier.ts [sessions]
import { allowedArms, ARMS } from '../src/main/simplifier/arms.ts'
import { contextVector } from '../src/main/simplifier/features.ts'
import { seededRandom } from '../src/main/simplifier/linalg.ts'
import { ThompsonPolicy } from '../src/main/simplifier/thompson.ts'
import type { DistilledPage, PresentationArm, UserTraits } from '../src/shared/simplifier-contracts.ts'

const sessions = Number(process.argv[2] ?? 200)
const random = seededRandom(42)
const policy = new ThompsonPolicy({ freezeAfter: 1e9 }, random)

interface Persona { id: string; traits: UserTraits; voice: boolean; likes: (arm: PresentationArm) => number }
const personas: Persona[] = [
  { id: 'low-vision, likes voice', voice: true, traits: { visionSupport: 0.9, readingSupport: 0.6, voicePreference: 0.9, techConfidence: 0.2 },
    likes: (arm) => 0.25 + (arm.fontScale === 2 ? 0.3 : arm.fontScale === 1.5 ? 0.1 : 0) + (arm.voiceNarration ? 0.3 : 0) + (arm.maxActions === 3 ? 0.05 : 0) },
  { id: 'confident reader', voice: false, traits: { visionSupport: 0.2, readingSupport: 0.2, voicePreference: 0.1, techConfidence: 0.8 },
    likes: (arm) => 0.3 + (arm.maxActions === 6 ? 0.3 : 0) + (arm.fontScale === 1.25 ? 0.2 : 0) + (arm.plainLanguage ? -0.05 : 0.05) }
]
const page: DistilledPage = {
  url: 'https://news.example/article', title: 'News', lang: 'en', elements: [], mainText: 'x'.repeat(3000),
  stats: { totalElements: 900, interactiveElements: 140, maxNavDepth: 3, textLength: 9000, hiddenRemoved: 12 }, capturedAt: 0
}

for (const persona of personas) {
  const counts = new Map<string, number>()
  let window: number[] = []
  const curve: string[] = []
  for (let s = 0; s < sessions; s++) {
    const x = contextVector(page, 'article', { userId: persona.id, now: s * 3_600_000, voiceEnabled: persona.voice, recentErrorRate: 0 }, persona.traits)
    const input = { userId: persona.id, x, arms: allowedArms(persona.voice), pageType: 'article' as const, sensitive: false }
    const { armId } = policy.choose(input)
    const arm = ARMS.find((a) => a.id === armId)!
    const reward = Math.max(0, Math.min(1, persona.likes(arm) + (random() - 0.5) * 0.2))
    policy.learn(input, armId, reward)
    if (s >= sessions - 50) counts.set(armId, (counts.get(armId) ?? 0) + 1)
    window.push(reward)
    if (window.length === 20) { curve.push((window.reduce((a, b) => a + b, 0) / 20).toFixed(2)); window = [] }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  const optimal = allowedArms(persona.voice).reduce((a, b) => (persona.likes(b) > persona.likes(a) ? b : a))
  console.log(`\n${persona.id}`)
  console.log(`  avg reward per 20 sessions: ${curve.join(' → ')}`)
  console.log(`  most chosen arm (last 50): ${best[0]} (${best[1]}x)   true best arm: ${optimal.id}`)
}
