# Triage
## Product overview and hackathon scope

**A desktop companion that helps you understand your screen and take the next step.**

Status: Proposed hackathon MVP. This document describes intended behavior, not a claim that the capabilities have already been implemented.

## 1. What is Triage?

Triage is a personal desktop assistant represented by a small animated character on your screen. You interact with it through a compact text conversation or by shaking your cursor to trigger an instruction you have configured.

It brings three kinds of help into the place where you are already working:

- **Explain:** interpret the current screen and answer questions about it.
- **Guide:** highlight the relevant control and explain what to do next.
- **Act:** carry out a supported task in the browser and check the result.

Instead of copying an error into another app or describing an unfamiliar interface from memory, you can summon Triage where the problem occurs. The character provides a consistent entry point; screen context makes the help specific; controlled actions let the assistant move a task forward.

The initial version uses an Anthropic model with an API key supplied by the user. Screen capture, gesture detection, and mouse and keyboard execution happen on the computer. Model interpretation requires sending relevant screenshots and instructions to Anthropic; the product is not fully offline.

## 2. The problem it addresses

People often know what they want to accomplish but do not know which button, menu, or sequence of steps will get them there. This happens with unfamiliar websites, confusing settings, error messages, and repetitive forms.

Looking up instructions requires switching contexts, finding an answer that matches the interface, and translating written directions into clicks. A conventional chat assistant can explain a task, but the user may still need to describe the screen and perform every step.

Triage is designed to reduce that friction. It can use the screen as context, point directly at a relevant control, and execute a small set of supported workflows.

## 3. Who it is for and why it is useful

The initial audience is students and everyday computer users who occasionally need help navigating software or completing a browser task.

Typical uses include understanding an unfamiliar page, interpreting a visible error, locating a control, and entering a multistep search without navigating every field manually.

The intended benefits are:

- **Less context switching:** help appears alongside the current task.
- **More specific explanations:** the answer can reference the visible interface.
- **A choice between learning and delegation:** users can ask where to click or ask Triage to complete a supported task.
- **A quick way to request help:** a cursor shake avoids opening and composing a full request when the configured instruction already expresses the need.
- **Clearer task outcomes:** Triage reports observed results, uncertainty, and failures rather than assuming a sequence of clicks succeeded.
- **Reviewable activity:** a saved history lets users revisit conversations and inspect what Triage attempted, completed, or stopped.

The character makes the assistant approachable and easy to find. Its animations also communicate state, so users can distinguish a response being generated from an action being executed.

## 4. The core interaction

The primary loop is **summon → understand → explain, guide, or act → verify**.

1. The user clicks the character, types a message, or shakes the cursor.
2. Triage determines whether it needs screen context or additional information.
3. It captures the relevant screen context when required and sends that context with the request to the model.
4. It responds with an explanation, highlights a target, or starts a supported workflow.
5. If it acts, it checks the resulting interface and reports the observed outcome.

Requests, user-facing replies, and action events are saved to local activity history throughout this loop so the user can review them later.

Triage should ask focused questions when essential information is missing. It should avoid unnecessary questions when the instruction and screen already provide enough context.

## 5. Feature: animated desktop character and chat bubble

**Purpose:** provide a persistent, recognizable entry point without taking over the workspace.

The MVP includes a small movable character, a compact conversation bubble, and basic animations for idle, thinking, and working states. Clicking the character opens or closes the conversation. The user can hide or minimize it when it is in the way.

The bubble contains messages, clarification questions, task status, and a stop control while a task runs. Its layout should keep the current response readable without covering the relevant part of the screen.

Animations should convey useful information. For example, a thinking animation means an interpretation is pending; a working animation means Triage is carrying out a task. Visual polish matters, but elaborate character customization is outside the MVP.

**Completion check:** the user can move the character, open the bubble, send a request, and distinguish idle, thinking, and working states.

## 6. Feature: text input and follow-up conversation

**Purpose:** let users express goals in ordinary language.

Users can type questions such as “What does this error mean?”, “Show me where to click,” or “Find flights on Alaska Airlines.” Triage retains enough context within the current conversation to understand follow-ups such as “Explain that more simply” or “Change the return date.”

Requests route to the appropriate capability: an explanation, a visual guide, or a supported browser task. If the request exceeds the available capabilities, Triage should explain the limitation and offer a useful next step.

Text is the primary input for this version. Voice input and spoken responses are future additions, not requirements for this MVP.

**Completion check:** a user can make a request, answer a clarification, and submit a follow-up without restating the entire task.

## 7. Feature: Shake to Help with a configurable instruction

**Purpose:** turn a simple physical gesture into a fast, personal request for help.

The user moves the cursor back and forth rapidly. Triage detects the deliberate gesture and runs one instruction saved in settings. The default instruction is:

> Explain what is happening near my cursor, using the surrounding window as context.

The cursor position at activation supplies the focal point. Triage acknowledges the gesture immediately, captures the relevant screen, and displays a concise explanation in its bubble. The character should avoid covering the area being discussed.

The user can replace the default with another instruction, such as “Summarize this screen in three sentences” or “Explain any visible error near my cursor.” Configurability means saving a plain-language instruction; it does not require a visual automation builder.

Gesture detection should look for repeated direction changes within a short interval, rather than speed alone. A cooldown prevents one shake from generating multiple requests. The gesture can be disabled; a sensitivity control can be added if needed during testing.

The initial gesture action should remain focused on explanation or guidance. General saved workflows and arbitrary gesture-triggered actions are outside the committed scope.

**Completion check:** a deliberate shake triggers the saved instruction once, ordinary cursor movement does not routinely trigger it, and changing the instruction changes the next response.

## 8. Feature: screenshot analysis

**Purpose:** answer questions using the interface the user is actually viewing.

When the user requests screen help, Triage captures the active window or a supported screen region. The model interprets the screenshot together with the user's question and, where relevant, cursor position.

It can describe the visible page, explain an error message, summarize readable text, and identify a likely next step. Responses should begin with the part relevant to the user's question instead of narrating every element on screen.

Triage must distinguish visible evidence from inference. If text is unreadable, the relevant menu is closed, or a dialog hides the target, it should say what is missing and request a better view when necessary. It cannot claim to know hidden application state from a screenshot alone.

Screen capture is triggered by the user's request or configured gesture. Continuous screen recording and background monitoring are outside the MVP.

**Completion check:** Triage provides relevant explanations across a small set of test screens and acknowledges cases where it lacks enough visual information.

## 9. Feature: visual highlighting

**Purpose:** make instructions actionable by showing the user exactly where to look.

When asked “Show me where to click,” Triage identifies a target from the current screen and draws a temporary ring, outline, or pointer around it. A short explanation accompanies the highlight.

Highlighting alone does not click the target. It gives users a way to follow instructions themselves. The overlay should be dismissible, avoid blocking interaction, and disappear or refresh when the window changes.

The implementation must translate screenshot coordinates into desktop coordinates correctly, including display scaling. For the hackathon, support one operating system and a tested display configuration before attempting broad multi-monitor support.

If a target cannot be located confidently, Triage should ask the user to expose it or explain the next step in text. It should not highlight an arbitrary location.

**Completion check:** the highlight aligns with the intended control in the tested environment and can be dismissed without interfering with the app.

## 10. Feature: one complete browser workflow

**Purpose:** demonstrate that Triage can move from understanding a request to producing a useful result.

The flagship workflow is a flight search on Alaska Airlines. This is a proposed integration to build and test, not a guarantee of current route availability or website behavior.

Example request:

> Find Alaska Airlines flights from Seattle to New Jersey.

Expected flow:

1. Identify required details that the user has not supplied: travel dates, trip type, passenger count, and destination airport where clarification is needed.
2. Ask a compact clarification question before entering the search.
3. Open the airline's website in the browser.
4. Navigate to its flight-search form.
5. Enter the provided airports, dates, trip type, and passengers.
6. Submit the search and wait for the results or an explicit error.
7. Inspect the resulting page.
8. Tell the user whether results appeared, no flights were shown, or the search could not be completed. Leave the browser on the relevant page.

The core deliverable ends at the results page. Booking tickets, entering payment information, creating accounts, and guaranteeing the cheapest fare are outside this version. Follow-up changes such as a new date or a nonstop filter are optional extensions after the main workflow is reliable.

The browser implementation may use structured page controls, screenshot-based interaction, or a combination. The product requirement is a real, visible browser flow with a checked outcome.

Pop-ups, date pickers, loading delays, verification challenges, and layout changes are practical risks. Triage should use bounded retries and stop with a clear explanation if blocked. If user intervention is required, it should identify the point where help is needed.

**Completion check:** given valid user-supplied search details, Triage reaches and verifies the results page in the tested environment, or accurately reports the blocking condition.

## 11. Feature: task status and stop button

**Purpose:** make computer control understandable and interruptible.

While a task runs, Triage shows brief status messages such as “Opening the airline website,” “Entering your dates,” and “Checking the results.” These describe actual progress rather than guessed completion percentages.

A visible stop button cancels further execution. The action runner must check for cancellation between steps and after pending operations finish. Stopping does not undo actions already completed or necessarily cancel a page request already submitted.

At the end, the assistant distinguishes completed, stopped, and failed outcomes. For example: “The search results are open,” “Stopped before submitting the search,” or “The date picker did not respond, so I could not finish.”

The MVP should run one action task at a time to avoid conflicting mouse and keyboard operations.

**Completion check:** the user can see the current stage, stop a task, and receive an accurate final status without further queued actions continuing.

## 12. Feature: saved conversations and activity history

**Purpose:** give the user a persistent record of what they asked, what Triage said, and what it actually did. This supports security review, accountability, and returning to useful past conversations.

History is saved automatically on the Mac and remains available after the app closes and reopens. It covers ordinary questions and screen explanations as well as browser tasks; a request does not need to execute an action to appear in history.

Each conversation or task records:

- The user's messages and follow-up instructions.
- Every user-facing assistant reply, including explanations, clarification questions, status messages, and final reports.
- The time of each event and whether the request came from text input or Shake to Help. For a gesture request, save the configured instruction used at that moment.
- Actions Triage attempts, such as opening a website, filling a search field, clicking a control, or showing a highlight, with relevant non-secret details.
- Action results and errors, distinguishing an intended action from an attempted action and a verified outcome.
- Any confirmation requested and the user's response.
- Stops, cancellations, failures, and the task's final status. If the app exits before a task finishes, mark it as interrupted when history is reopened.

**Review experience:** an Activity History view, accessible from the chat bubble, lists past conversations and tasks by date with a short title and status. Opening an entry shows its saved conversation and an ordered action timeline. The user can see which steps completed before a task stopped and return to earlier explanations. Reopening an entry does not rerun the task.

For example, a flight-search entry could show the original request, the clarification about dates, the user's answer, the website being opened, search fields being filled, submission of the search, and the observed result. If the user stopped before submission, the history should show that boundary explicitly.

The task runner should record an action as pending before execution and append its result afterward. Associate events with a conversation ID, task ID where applicable, timestamp, and sequence number. Save events as they occur rather than only when a task completes. If recording fails, show an explicit warning and pause further automated actions until the issue is resolved; do not imply that an unrecorded action has an audit record.

**Storage boundaries:** save user-visible messages and structured action events locally. Do not save hidden model reasoning. Exclude API keys, passwords, authentication tokens, and payment secrets from action payloads and redact recognized secrets from saved messages. History may still contain personal information from the user's requests or Triage's replies, so explain this during setup. Screenshots and full page contents are not retained by default; screenshot analysis can be recorded as an event without storing the image.

Users can delete an individual history entry or clear all history. Local deletion does not retract information already sent to Anthropic. For the MVP, this is a user-controlled activity record, not a tamper-proof security audit system, and it does not guarantee that every action was safe or correct.

**Completion check:** after a conversation, completed task, stopped task, and failed task, restarting Triage preserves the relevant messages and ordered action events with accurate statuses. Deleting an entry removes its associated local messages and events. Secret values are excluded from stored action payloads.

## 13. Privacy and setup boundaries

The user supplies an Anthropic API key through app settings. The key should be kept in operating-system credential storage and excluded from logs and shared files.

Local components handle gesture detection, screen capture, overlay rendering, and input execution. Relevant screenshots, instructions, and conversation context are sent to Anthropic for model responses. The app should explain that boundary during setup.

Users grant the operating-system permissions needed for screen capture and computer control. The MVP should choose one target operating system and document the permissions required there.

Capture only the context needed for the current request. Avoid persistent screenshot storage by default, and keep API keys and sensitive screen content out of diagnostic logs. User-facing conversations and task events are retained locally in Activity History, subject to the exclusions described above. Users can delete individual entries or clear all history.

## 14. Suggested implementation structure

This is an implementation outline, not a fixed choice of libraries:

- **Desktop interface:** character, chat bubble, configuration, and task status.
- **Gesture detector:** local cursor movement analysis and trigger cooldown.
- **Screen context layer:** screenshot capture, cursor position, and display-coordinate mapping.
- **Model adapter:** Anthropic requests for explanations and supported action decisions.
- **Highlight overlay:** renders visual guidance over the desktop.
- **Browser action runner:** executes the supported search workflow, checks page state, and honors cancellation.
- **Task coordinator:** tracks progress and routes clarifications, results, and errors back to the interface.
- **Local history store and viewer:** persists messages and ordered action events, supports review and deletion, and records interrupted tasks accurately after a restart.

Build one end-to-end path early: text request → screen capture → explanation. Then add gesture triggering, highlighting, and the browser workflow. Test the browser workflow early because it carries the greatest integration uncertainty.

## 15. Proposed demo

**Moment one: help where you are.** Open an unfamiliar page, shake the cursor near a confusing section, and let Triage explain it.

**Moment two: guidance on the actual interface.** Ask where to click and show the highlight on the correct control.

**Moment three: task completion.** Ask Triage to search Alaska Airlines flights, provide the missing details, and watch it reach the results while displaying progress.

**Moment four: review the record.** Open Activity History to show the request, conversation, action timeline, and verified outcome saved for later review.

The central message is that the same companion can explain, guide, and act. A clear stop control and an accurate final report make the computer interaction credible.

## 16. Scope and definition of success

The committed MVP contains eight features: the animated character and chat bubble, text input, configurable Shake to Help, screenshot analysis, visual highlighting, one complete browser task, visible status with cancellation, and saved conversations and activity history.

It succeeds when a user can summon Triage, get a relevant explanation of a real screen, locate a control through a highlight, complete the tested flight-search workflow with an observed result, and review the saved conversation and action history after restarting the app.

Voice, spoken replies, reminders, calendar integration, folder search, arbitrary saved workflows, extensive character customization, and general control of every app or website remain future work.

The goal is a small, coherent assistant that works convincingly within its stated scope. Reliability of the complete experience matters more than the number of listed capabilities.

## 17. Short pitch

> Triage is a small animated desktop companion that helps you understand your screen and get things done. Shake your cursor when you are stuck, ask it to show you where to click, or give it a task such as finding flights. It uses the current screen as context, guides or acts within supported workflows, and saves your conversations and task activity so you can review what happened.
