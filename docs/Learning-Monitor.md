# Learning Monitor

A separate view that shows, live, what Triage's models are doing: every LangGraph node and LangChain pipeline step that runs, each memory lookup with its match scores, the layout model's odds for each layout, and the rewards that update it. It is built for demos: one person uses Triage while the audience watches the learning on a second screen or device.

## What it shows

| Panel | Source | What changes during a run |
|---|---|---|
| Task graph | LangGraph `refill_prescription`, via LangChain callbacks | Each node lights up as it runs, ticks when done, and shows ⏸ when the graph pauses for the person (checkpoint saved) |
| Simplifier pipeline | LangChain `RunnableSequence` `simplify_page` | Four steps (classify, choose layout, rewrite, log) with timings |
| Layout learning | Thompson-sampling bandit | Bars show the chance of choosing each layout; the chosen one is highlighted with its mode (exploit, explore, frozen, shielded) |
| Reward history | Ratings from the History tab | Each rating adds a point; the average reward updates |
| Memory retrieval | LangChain `VectorStoreRetriever` | Query and the memories it matched, with similarity bars |
| Live trace | All of the above | Newest-first log of every step |

The counters at the top count real LangChain and LangGraph runs reported by LangChain's own callback system, not estimates.

## Opening it

- **Same computer:** Triage menu-bar icon → **Show learning monitor**, or start Triage with `TRIAGE_MONITOR=1`.
- **Second device:** start Triage with `TRIAGE_MONITOR_SHARE=1`. The monitor's header then shows a link like `http://192.168.1.20:53211/?t=…`; open it in any browser on the same network. The link includes a random secret that changes every launch; without it the server answers "not found".

```
env -u ELECTRON_RUN_AS_NODE TRIAGE_MONITOR_SHARE=1 npm run dev
```

## Privacy

- Prescription numbers, card and account numbers, dates of birth and email addresses are masked before they enter the monitor (`RX-•••13`).
- Sharing is off unless `TRIAGE_MONITOR_SHARE=1` is set; otherwise the server only listens on this computer.
- The monitor is read-only: nothing on the page can change Triage, and events are never read back to make decisions.
- Venue Wi-Fi often stops devices from reaching each other. Put both devices on a phone hotspot if the link does not load.

## Demo script (about 3 minutes)

1. Start Triage with `TRIAGE_MONITOR_SHARE=1` and open the monitor link on the judges' screen.
2. In chat: "remember that my pharmacy is CareWell on Main Street", "remember my blood pressure medication is RX-48213" (and name, date of birth, pickup time). The memory counter rises; the trace shows each save, masked.
3. "Refill my blood pressure medicine". The task graph lights up recall → gather → open → fill → confirm; the retrieval panel shows the medication memory matched; the graph pauses at confirm.
4. Reply "yes". Submit and remember complete; the confirmation is masked.
5. "Simplify this page" on the cluttered news page. The pipeline runs its four steps and the layout panel shows the chosen layout and the odds.
6. Rate the simplified page in History. A reward point appears and the layout odds shift on the next simplification.
