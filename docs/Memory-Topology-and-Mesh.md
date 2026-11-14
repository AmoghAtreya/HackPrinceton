# Memory topology and peer-to-peer mesh: exploration

Status: exploration only. Nothing in this document is built. It describes how Triage's data flows today, where the shape of that flow (its topology) could be improved, and what a peer-to-peer mesh between a person's devices and their caregiver would look like.

## Recommendation in short

1. Keep one device as the single writer for now. Fix the local data flow first: it is cheap and makes every later step easier.
2. Add a retrieval graph over memory (who, what, where links between memories) before any networking. It improves lookups on one device and decides what a mesh would need to sync.
3. If a mesh is built, make it a small trusted mesh (the person's own devices plus one or two caregivers), sync a CRDT of memory records, encrypt end to end, and never sync task checkpoints or anything about payment.
4. Do not build a mesh for the hackathon. A caregiver "trusted sites" list over a simple relay shows the same story with a fraction of the risk.

## 1. Data flow today

Everything lives in SQLite files in Triage's data folder on one Mac.

| Store | File | Written by | Read by |
|---|---|---|---|
| Conversations and activity | `history.sqlite` | Coordinator | History tab, model context |
| Layout decisions and rewards | `simplifier.sqlite` | Simplifier engine | Bandit, History tab, off-policy evaluation |
| Personal memory (vectors) | `memory.sqlite` | "Remember…" and task graphs | Task graphs via a LangChain retriever, History tab |
| Task threads and checkpoints | `tasks.sqlite` | LangGraph checkpointer, task runner | Task runner, History tab |

The flow for one refill:

```
chat message ─▶ coordinator (rules pick the route)
                  │
                  ▼
            refill graph ──recall──▶ memory.sqlite (retriever)
                  │   ◀─answers saved──┘
                  ├─ open / fill / submit ─▶ Chrome (Playwright)
                  ├─ checkpoint after every node ─▶ tasks.sqlite
                  └─ each step ─▶ history.sqlite (task_step activity)
```

This is a star: the coordinator sits in the middle and every store hangs off it. Stars are simple and easy to reason about. The costs show up in three places.

- **Lookups scan everything.** Memory search compares the query to every stored vector. That is fine for hundreds of memories and slow for tens of thousands.
- **Stores do not know about each other.** A refill writes to three files with no shared ID beyond the conversation. "Show me everything about my pharmacy" needs three separate queries.
- **Every lookup embeds the query again.** Nothing is cached between steps of the same task.

## 2. Topology improvements on one device

These need no networking and no new privacy decisions.

### 2.1 A memory graph next to the vectors

Store memories as nodes with typed links, in addition to their vectors:

```
(Margaret) ──uses──▶ (CareWell, Main Street) ──fills──▶ (blood pressure, RX-48213)
     │                        ▲
     └──prefers──▶ (morning pickup)   (refill recipe, 8 steps) ──for──┘
```

Retrieval becomes two steps: vector search finds one or two entry nodes, then a short walk along links collects what belongs with them. Asking about "my blood pressure pills" returns the prescription number, the pharmacy that fills it, and the recipe for refilling it, even though only the first one matches the words.

Two measures from graph theory decide what to keep hot:

- **Degree** (how many links a node has): high-degree nodes such as the pharmacy are used by many tasks and should be cached in memory.
- **Recency-weighted paths**: links used by recent successful tasks get a higher weight, so the walk prefers them. The decision log already records which tasks succeeded.

Cost: one `edges` table in `memory.sqlite` and link extraction in the rule-based "remember" parser. No model involved.

### 2.2 One event stream instead of three writes

Have the coordinator emit one event per step (`task_step`, `memory_saved`, `decision_logged`) with a shared `episode_id`, and let each store subscribe. This turns the star into a short pipeline:

```
graph node ─▶ event (episode_id, step) ─▶ history
                                        ├▶ decision log
                                        └▶ memory
```

Benefits: one ID joins a task's history, layout decisions and memories, which is the trajectory format the design doc wants for offline RL; and a mesh, if it ever exists, has one stream to replicate instead of four files.

### 2.3 Smaller wins

- **Cache query embeddings per task.** The refill graph looks up the same request several times.
- **Index by kind and key first, vectors second.** Keyed preferences (`pharmacy`, `name`) are exact lookups; only free-text recall needs vector search. The memory service already does this for preferences.
- **Approximate search (HNSW)** only if memory grows past roughly 10,000 items. Below that the exact scan is faster to build and gives better answers.

## 3. Peer-to-peer mesh

### 3.1 What a mesh would be for

| Use | Who the peers are | Value |
|---|---|---|
| Same person, several devices | Mac, phone, tablet | Memory and preferences follow the person |
| Caregiver safety net | Person and one or two family members | Trusted-site list, scam alerts, approval of risky actions |
| Community scam signals | Many unrelated users | "Three people near you were shown this fake bank page today" |

The first two are small, closed groups of people who already trust each other. The third is an open network of strangers and is a different, much harder problem (spam, poisoning, privacy). It should be a separate project, most likely a conventional server with anonymised reports rather than a mesh.

### 3.2 Topology options for the trusted group

| Topology | How it works | Good | Bad |
|---|---|---|---|
| **Star through a relay** | Every device talks to one always-on relay that stores encrypted blobs | Works when devices are asleep or on different networks; simplest | Needs a server; relay sees metadata (who, when, how much) |
| **Full mesh** | Every device connects directly to every other (WebRTC) | No server holds data; lowest latency on a home network | Both devices must be online together; connection setup is fragile; still needs a signalling server |
| **Hybrid: mesh when near, relay when not** | Direct on the same network, relay otherwise | Best experience | Two code paths to build and secure |

For a group of three to five devices a full mesh has at most ten links, so scale is not the concern. Availability is: an older person's laptop is closed most of the day, and a caregiver's phone is on a different network. That is why a relay holding only end-to-end encrypted data is the practical default, with direct links as an optimisation.

### 3.3 What to sync and how

Sync **memory records**, not databases. Each record is small and self-describing:

```
{ id, kind, key, text, updated_at, device_id, deleted }
```

Use a CRDT so devices can edit offline and merge without conflicts:

- **Keyed preferences** (pharmacy, name): last-writer-wins register per key, with a hybrid logical clock so a wrong device clock cannot silently win.
- **Facts and recipes**: add-wins set, with tombstones for "Forget" so a deleted memory does not come back from another device.
- **Vectors are not synced.** Each device recomputes them locally from the text. This keeps payloads small and lets devices use different embedding models.

Libraries worth evaluating: Yjs or Automerge for the CRDT, and libp2p or plain WebRTC data channels for transport. Electron's main process can run either.

### 3.4 What must never sync

- **Task checkpoints.** A paused "Shall I submit?" must be answered on the device that has the browser page open. Syncing it would let a second device approve an action it cannot see.
- **Layout decisions and rewards as raw rows.** They include page hosts. If cross-device learning is wanted, sync the bandit's summary statistics (the per-arm sums it already keeps), which contain no browsing history.
- **Anything payment or password related.** The app already refuses to store these.
- **Conversation history**, unless the person turns it on. It can contain anything they typed.

### 3.5 Security and consent

- **Pairing:** devices join by scanning a QR code or typing a short code shown on the other device. That exchange sets up a shared key; no account system is needed.
- **Encryption:** end to end with per-group keys. The relay stores ciphertext only. Removing a device rotates the key.
- **Caregiver scope:** a caregiver peer gets a narrower view by design: the trusted-site list, scam alerts and approval requests. Not the person's memory, not their history. The design doc's rule applies: a safety net, not surveillance, and the person can switch it off.
- **Memory poisoning:** a compromised or mistaken peer could write "my pharmacy is evil.example". Mitigations: show which device wrote each memory in the History tab, require local confirmation before a synced memory is used in a task that submits a form, and keep the rule-based risk tiers as the last gate regardless of where memory came from.
- **Legal:** medication names and prescription numbers are health data. Syncing them, even encrypted, raises obligations (HIPAA-adjacent in the US, GDPR special category in the EU) that local-only storage avoids.

## 4. How this connects to LangChain and LangGraph

- **Memory graph (2.1):** a custom LangChain retriever that does vector search followed by a graph walk. The refill graph already calls memory through the retriever interface, so it would not change.
- **Event stream (2.2):** LangGraph's `stream` already emits one update per node. The task runner turns those into history steps today; the same hook can feed the shared event stream.
- **Mesh (3):** the `SqliteVectorStore` stays the local store. Sync sits beside it as a process that applies CRDT changes by calling `addDocuments` and `delete`. Graphs and retrievers never learn that a mesh exists.

## 5. Suggested order

| Step | Effort | Depends on |
|---|---|---|
| 1. Query-embedding cache and shared `episode_id` | Small | Nothing |
| 2. Memory graph with link extraction and a graph-walk retriever | Medium | Step 1 |
| 3. Single event stream feeding all stores | Medium | Step 1 |
| 4. Caregiver trusted-site list over an encrypted relay | Medium | A relay server; pairing flow |
| 5. Multi-device memory sync with a CRDT | Large | Steps 2 to 4; a privacy review |
| 6. Direct device-to-device links | Large | Step 5 |

Steps 1 to 3 are worth doing regardless. Steps 4 to 6 should wait for a decision on whether Triage is meant to be used on more than one device, because they add a server, a pairing flow and health-data obligations that the product does not have today.

## Open questions

- Is a second device (phone or tablet) actually planned? Without one, only the caregiver case justifies any networking.
- Who runs the relay, and what is its retention policy for encrypted blobs?
- Should a caregiver be able to add memories for the person ("Mum's new pharmacy is…"), and how is that shown and confirmed on the person's device?
