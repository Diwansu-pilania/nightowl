# Phase 1 — Streaming AI chat

This is a study guide for Phase 1: what was built, how every piece works, why
it was built that way, and what to say about it in an interview.

---

## 1. What Phase 1 adds (the user's view)

- Type a message, press **Enter**, and the AI's reply **streams in word by word**.
- Works with **OpenRouter** (cloud, hundreds of models) or **Ollama** (local, free, offline).
- **Esc** stops a reply mid-stream; the partial text stays, marked `(stopped)`.
- **/new** clears the conversation and returns to the home screen.
- **Ctrl+C** quits.
- The status bar shows the real provider + model (e.g. `llama3.2 ollama`), and `esc to stop` while a reply is streaming.
- Problems (no API key, Ollama not running, unknown model) appear as a **readable red message in the chat**, never a crash.

---

## 2. Architecture

The code is split into **layers**. Each layer only talks to the one below it.

```
 index.tsx            entry point: load config, create the terminal renderer
     │
 app.tsx  Root        wraps the app in its context providers
     │      App       picks the layout: home screen  vs  conversation
     │
 components/          what you see
   header.tsx           NIGHTOWL logo
   message-list.tsx     scrollable conversation
   input-bar.tsx        text box + command menu + keyboard shortcuts
   status-bar.tsx       agent · model · provider
     │  (read state with useChat() / useToast())
     ▼
 providers/           shared state (React Context)
   chat/                messages, status, send / stop / reset
   toast/               pop-up notifications
     │
     ▼
 lib/                 plain TypeScript — no React, no UI
   config.ts            env vars → { provider, model, baseURL, apiKey }
   ai/model.ts          config → AI SDK LanguageModel
   ai/chat.ts           streamReply(): send history, stream text back
     │
     ▼
 Vercel AI SDK  ──HTTP──▶  OpenRouter  or  Ollama   (same OpenAI-compatible API)
```

**Why layers?** `lib/` has no UI code, so it can be unit-tested in milliseconds
and reused later (Phase 3 tools, a future server). The UI never talks to
OpenRouter or Ollama directly. It only calls `send()`, so swapping or adding a
provider doesn't touch any screen.

---

## 3. The life of one message

What happens between pressing Enter and seeing the reply:

1. **InputBar** (`components/input-bar.tsx`): the textarea's `onSubmit` fires.
   If the command menu is open, Enter runs the highlighted command. Otherwise
   it calls `chat.send(text)`.
2. **ChatProvider.send** (`providers/chat/index.tsx`):
   - If a reply is already streaming, return `false`. InputBar keeps your text
     and shows a toast.
   - Add your message **and an empty assistant message** to state at once, so
     the screen updates instantly.
   - Create an `AbortController` (the cancel button for this request) and set
     `status = "streaming"`.
   - Start `streamReply(...)` in the background and return `true`, so the UI
     stays responsive.
3. **streamReply** (`lib/ai/chat.ts`) calls the AI SDK's `streamText()` with:
   - `instructions`: the system prompt ("You are NightOwl…").
   - `messages`: the whole conversation so far. The model has no memory, so we
     resend the history every time.
   - `abortSignal`: lets Esc cancel the HTTP request.
4. **AI SDK → provider**: an HTTP POST to `/chat/completions` with
   `stream: true`. The server answers with **Server-Sent Events (SSE)**: a
   response that stays open and sends many small `data: {...}` chunks.
5. **fullStream loop**: the SDK turns those chunks into typed events. We handle
   three of them:
   - `text-delta` → call `onText(chunk)`.
   - `error` → throw it.
   - `abort` → return `{ aborted: true }`.
6. **onText → React state**: each chunk runs
   `setMessages(prev => prev.map(m => m.id === id ? {...m, content: m.content + delta} : m))`.
   React re-renders, so the assistant message grows on screen.
7. **MessageList** (`components/message-list.tsx`) is a `<scrollbox stickyScroll stickyStart="bottom">`:
   it keeps scrolling to the bottom as text arrives, unless you've scrolled up to read.
8. **Finish**: in a `finally` block the provider clears the AbortController and
   sets `status = "idle"`. If something failed, `describeError()` turns the
   error into advice (see §5) and it's saved on the message as `error`.

---

## 4. File-by-file guide

| File | What it does | Key idea |
|---|---|---|
| `src/index.tsx` | Loads config, creates the renderer, renders `<Root>`, exits the process when the renderer is destroyed | Keep the entry point tiny; all UI lives in `app.tsx` so tests can render it |
| `src/app.tsx` | `Root` = providers; `App` = switches between home and conversation layouts | `<InputBar>` stays in the same tree position in both layouts, so React keeps the same instance and the textarea keeps focus |
| `src/lib/config.ts` | Reads env vars, picks provider, applies defaults; `getConfigProblem()` reports mistakes | Pure function with `env` as a parameter, so it's easy to test |
| `src/lib/ai/model.ts` | Builds an AI SDK model with `createOpenAICompatible` | One adapter for both providers, because both speak the OpenAI API |
| `src/lib/ai/chat.ts` | `streamReply()`, `toModelMessages()`, `describeError()`, system prompt | Framework-agnostic: no React here |
| `src/providers/chat/index.tsx` | Chat state + `send` / `stop` / `reset` via React Context | Refs for synchronous checks, immutable state updates, AbortController |
| `src/components/message-list.tsx` | Renders messages; "Thinking...", red errors, "(stopped)" | Sticky-bottom scrollbox |
| `src/components/input-bar.tsx` | Text box, command menu, Esc / Ctrl+C handling, blocks double-send | Global keyboard listeners need explicit guards (see §6) |
| `src/components/status-bar.tsx` | Shows agent, model, provider, "esc to stop" | Reads from `useChat()` instead of hardcoded text |
| `src/components/command-menu/*` | The `/` menu; `/new` now calls `ctx.chat.reset()` | Commands receive a context object instead of importing globals |
| `src/test/mock-model.ts` | A fake streaming model for tests | No network or API key in tests |
| `*.test.ts(x)` | 19 tests: config, AI layer, full UI | See §7 |
| `.env.example` | Documents every setting | `.env` is git-ignored, so keys are never committed |

---

## 5. Key concepts (be ready to explain these)

### Streaming and Server-Sent Events
Without streaming you'd wait 10+ seconds and then see the whole answer at
once. With `stream: true` the server sends tokens as soon as the model produces
them, over one long-lived HTTP response (SSE). The AI SDK parses those chunks
for us and exposes them as an async iterable: `for await (const part of result.fullStream)`.

### OpenAI-compatible APIs
OpenAI's `/v1/chat/completions` format became a de-facto standard. OpenRouter
and Ollama both implement it, so `@ai-sdk/openai-compatible` talks to either.
Only `baseURL` and `apiKey` differ:
- OpenRouter: `https://openrouter.ai/api/v1` + API key
- Ollama: `http://localhost:11434/v1`, no key

### Cancelling with AbortController
`new AbortController()` gives a `signal` we pass to `streamText`. Calling
`controller.abort()` (on Esc, `/new`, or exit) closes the HTTP connection. The
stream ends with an `abort` event, or sometimes a thrown AbortError, so
`streamReply` treats both as "aborted", not as a failure.

### React Context (providers)
`ChatProvider` holds the state once. Any component calls `useChat()` to read it,
with no prop drilling through every layer. `useChat()` throws if it's used outside
the provider, so that mistake fails loudly.

### State vs refs
- **State** (`useState`) causes a re-render when it changes. Use it for things on screen (messages, status).
- **Refs** (`useRef`) hold a value without re-rendering, and the value is updated **synchronously**.
  `abortRef` decides "is a reply already running?" because React state updates
  are asynchronous: two quick Enter presses could both see `status === "idle"`.
  The ref can't be stale.

### Immutable updates
`setMessages(prev => prev.map(...))` builds a **new array** instead of
modifying the old one. React compares by reference, so mutating in place would
not trigger a re-render. The functional form `prev => ...` always works on the
latest state, even when many chunks arrive quickly.

### Configuration through environment variables
Secrets don't belong in source code. Bun automatically loads `.env`.
`.env` is in `.gitignore`, and `.env.example` documents the settings without
real values. A bad config is reported in the UI instead of crashing at startup.

### Dependency injection (for testability)
- `loadConfig(env = process.env)`: tests pass a fake env object.
- `<ChatProvider model={...}>`: tests pass a mock model; the real app builds one from config.

This is why the tests need no network, no API key and no global mocking.

---

## 6. Problems hit while building (good interview stories)

1. **The AI SDK printed errors over the UI.** By default `streamText` calls
   `console.error` on failure, which would scribble text over the terminal
   interface. Fix: pass `onError: () => {}` and handle the `error` event from
   the stream ourselves, showing it as a chat message.

2. **One Esc press could do two things.** OpenTUI runs *every* keyboard
   listener for each key, and `preventDefault()` only stops the focused text
   box from receiving it. So pressing Esc to close the command menu would also
   have stopped the AI reply. Fix: the Esc handler checks `showCommandMenu`
   first.

3. **The input box shrank.** The old status bar had a hardcoded `width={80}`
   that was secretly stretching the whole input box. Changing it to `100%`
   made the box collapse to its text. Fix: give the bordered box `width="100%"`
   itself, so the layout no longer depends on a child's magic number.

4. **The app couldn't be quit, and `/exit` hung.** The renderer was created
   with `exitOnCtrlC: false` and nothing handled Ctrl+C. Also,
   `renderer.destroy()` restores the terminal but the stdin listener keeps the
   process alive. Fix: Ctrl+C calls `destroy()`, and `index.tsx` runs
   `process.exit(0)` on the renderer's `destroy` event. That fixes `/exit` too.

5. **The UI tests saw a frozen screen.** OpenTUI's test renderer has no render
   loop; it only draws when the test calls `renderOnce()`. React also needs
   state updates wrapped in `act()`. Fix: a `waitForScreen()` helper that
   lets a little time pass inside `act()`, re-renders, and checks the frame,
   repeating until it matches or times out.

---

## 7. Testing

Run `bun run test` from the repo root (19 tests, under a second).

- **`lib/config.test.ts`** (7 tests): provider auto-detection, overrides,
  defaults, and that the OpenRouter key is never sent to Ollama.
- **`lib/ai/chat.test.ts`** (7 tests): chunks arrive in order; stream errors
  throw; abort stops early; failed or empty messages are filtered from history;
  friendly error messages.
- **`app.test.tsx`** (5 tests, **headless end-to-end UI tests**): renders the
  real app in a virtual 100×30 terminal, types with simulated key presses, and
  checks the characters on screen:
  - home screen shows the model
  - a message streams a full reply
  - Esc stops a long reply partway through
  - `/new` clears the chat
  - a config problem is shown and the model is **not** called

The fake model (`test/mock-model.ts`) uses the AI SDK's `MockLanguageModelV4`
and `simulateReadableStream`. It produces the same event sequence a real
provider would (`stream-start → text-delta… → finish`), optionally with delays
or an error.

---

## 8. Known limitations (honest trade-offs)

- **One re-render per text chunk.** Fine for chat-sized replies. For very long
  outputs you'd batch updates, e.g. flush every ~30 ms.
- **No Markdown rendering yet.** Code blocks show as plain text. The system
  prompt asks the model for plain text for now.
- **History isn't saved.** Quitting loses the conversation (Phase 4: sessions).
- **No context-window management.** A very long chat will eventually exceed the
  model's limit. A later fix is to trim or summarise old messages.
- **Model/provider are set by env vars only.** Phase 2 adds the `/models` picker.
- **Failed requests are attempted 3 times** (1 try + 2 retries, the SDK
  default), so an unreachable Ollama takes a moment before the error appears.

---

## 9. How to run it

```bash
cp .env.example .env        # then add OPENROUTER_API_KEY, or install Ollama
bun install
bun run dev:cli             # run from the repo root so Bun finds .env
```

| Variable | Meaning |
|---|---|
| `OPENROUTER_API_KEY` | Enables OpenRouter (auto-selected when set) |
| `NIGHTOWL_PROVIDER` | Force `openrouter` or `ollama` |
| `NIGHTOWL_MODEL` | Model id. Defaults: `anthropic/claude-sonnet-5.5` (OpenRouter), `llama3.2` (Ollama). OpenRouter models ending in `:free` cost nothing |
| `OLLAMA_BASE_URL` | Ollama on another port or machine |

---

## 10. Interview practice

**"Walk me through what happens when the user presses Enter."**
Go through §3: the input calls `send`, which adds optimistic messages, creates
an AbortController and starts `streamText`. The SSE chunks become `text-delta`
events, each one is an immutable state update, React re-renders, and the
scrollbox sticks to the bottom.

**"How do you support two different AI providers?"**
Both expose the OpenAI-compatible API, so one adapter with a different
`baseURL` and key handles both. The rest of the app depends only on the
SDK's `LanguageModel` interface. Adding Groq or LM Studio is just another
config entry.

**"How does cancelling work?"**
An AbortController per request. Esc calls `abort()`, the SDK closes the HTTP
stream, and `streamReply` reports `aborted` instead of throwing. The partial
answer is kept and marked as stopped.

**"Why a ref *and* state for the streaming status?"**
State drives the UI but updates asynchronously. The ref gives a synchronous,
always-current answer to "is a request running?", which prevents double-sends.

**"How did you test a terminal UI?"**
OpenTUI's headless test renderer plus a mock model. The tests type real
keystrokes and assert on the drawn characters. No network, no API key, and
they run in under a second.

**"What would you improve?"**
Pick from §8: batching renders, Markdown, persistence, context-window trimming.

---

## 11. Resume bullets (pick and adapt)

- Built a **terminal AI coding assistant** in **TypeScript, React and Bun** using the OpenTUI renderer, with **real-time token streaming** and mid-response cancellation (AbortController).
- Designed a **provider-agnostic AI layer** on the **Vercel AI SDK** supporting cloud (**OpenRouter**) and local (**Ollama**) models through one OpenAI-compatible adapter.
- Wrote **headless end-to-end UI tests** that drive the app with simulated keystrokes and a mock streaming model (19 tests, under 1 s, no network).
- Separated the code into config, AI and UI layers with **React Context** state and dependency injection, making the core logic unit-testable without the UI.
