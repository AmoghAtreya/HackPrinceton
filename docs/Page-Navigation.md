# Page navigation

Say or type where you want to go ("take me to my Amazon orders", "open Gmail"). Triage opens that page as a new tab in **your own default browser**, where you are already signed in, and replies:

> Opening your Amazon orders in your web browser. If you can't find something on the page, ask "show me where…" and I'll point to it.

Spoken requests take the same path. A voice message goes to the chatbot, and the chatbot decides to open a page.

## How it works

1. **Routing.** The chatbot's routing prompt in `src/main/assistant/model.ts` has a third response besides `reply` and `flight_search`:
   ```json
   {"kind":"open_page","destination":"amazon_orders"}
   {"kind":"open_page","destination":"web_search","query":"pharmacy near me"}
   ```
2. **The model only picks an ID.** `routeSchema` in `src/shared/flight-contracts.ts` accepts only IDs from the destination list. A URL or any extra field is rejected.
3. **Allowlist check.** `resolveDestination` in `src/shared/destinations.ts` turns the ID into a fixed URL. It checks that the URL is https and that its host is on the allowlist.
4. **Opening.** `AssistantCoordinator.navigate` records a `page_open` activity in history. It then calls `openPage`, which is wired to Electron's `shell.openExternal` in `src/main/index.ts`.

If nothing on the list fits, the model replies that it has no shortcut for that place and offers to search the web. `web_search` is only used when the user asks to search or accepts that offer.

## Why a fixed list

The users are older people who are vulnerable to scams. A misheard word, or instructions hidden in a web page, must never send them to a lookalike site. So the model never supplies a URL.

## Adding a destination

Add an entry to `destinations` in `src/shared/destinations.ts`:

```ts
{ id: 'cvs_pharmacy', name: 'CVS Pharmacy', description: 'CVS pharmacy, prescriptions, refills', url: 'https://www.cvs.com/', opensIn: 'default' }
```

- **`description`**: the model matches on this, so describe what people will ask for.
- **The allowlist** picks up the new host automatically.
- **`opensIn: 'task'`** is reserved for Triage's own automated browser ("do it for me"). It is rejected for now.

## Not built yet

- Destinations added by a caregiver (such as "Mom's pharmacy"). Today the list is fixed in code.
- Opening pages in the task browser.
- A voice shortcut that skips the model for "open X". Every navigation request costs one model call today.
- Nothing here has been tried in the running app.
