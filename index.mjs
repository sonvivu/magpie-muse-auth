// Muse (Meta) provider plugin for Magpie and OpenCode.
//
// Sign-in is Meta's device-code OAuth (the same flow CLIProxyAPI uses),
// then an API key is minted from the DCA token and every chat request goes
// to Meta's Responses API.
//
// The request path is deliberately thin. Magpie's gateway already
// translates whatever the agent sent into the API the model speaks —
// `npm: "@ai-sdk/openai"` makes that the OpenAI Responses API, so the
// request this plugin's `fetch` receives IS a Responses request. The fetch
// only signs it, normalizes two fields Meta is strict about (see below),
// and passes the answer back untouched. There is no hand-rolled
// protocol translation here: the gateway's own translation handles
// messages, tools, images, reasoning summaries and structured output.
//
// Scaffold follows the Nous Portal plugin's shape (config /
// provider.models / auth.loader / auth.refresh / auth.methods), so
// Magpie's host and OpenCode 1.x/2.x load it the same way.
import { ID, API_BASE, BUILD_USER_AGENT, CLIENT_HEADER, AuthError, createAuth, metadata } from "./oauth.mjs"

const NPM = "@ai-sdk/openai"

// The provider's picture, used by the auth hook and package.json's
// magpie.icon. It must be an https URL (or a data:image URI): Magpie's
// host only keeps those, and the bundled name "meta" matches no icon
// Magpie ships, so the provider fell back to the default picture.
// The file is the Meta AI mark (lobehub/icons) vendored into this repo.
const ICON = "https://raw.githubusercontent.com/sonvivu/magpie-muse-auth/main/icon.svg"

// Static model registry — Meta exposes no live catalog for this API, so
// the list mirrors CLIProxyAPI's registry (models.json, "meta" block).
// Context/output token counts are the registry's.
const MODELS = [
  {
    id: "muse-wonder-1.0", name: "Muse Wonder 1.0",
    limit: { context: 1007997, output: 128000 },
    input: ["text", "image", "audio", "video"],
    contributor: true,
  },
  {
    id: "muse-wonder-full-1.0", name: "Muse Wonder Full 1.0",
    limit: { context: 1007997, output: 128000 },
    input: ["text", "image", "audio", "video"],
    contributor: true,
  },
  {
    id: "muse-spark-1.3", name: "Muse Spark 1.3",
    limit: { context: 1048576, output: 65536 },
    input: ["text", "image"],
    contributor: true,
  },
  {
    id: "muse-spark-1.2", name: "Muse Spark 1.2",
    limit: { context: 1048576, output: 65536 },
    input: ["text", "image"],
    contributor: true,
  },
  {
    id: "muse-spark-1.1", name: "Muse Spark 1.1",
    limit: { context: 1048576, output: 65536 },
    input: ["text", "image"],
    contributor: false,
  },
]

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"]

// variants carry the effort the way Magpie itself writes them for
// OpenCode (internal/agent/agents.go: openCodeVariant): the variant's
// key is the level, its setting asks the gateway for that effort. The
// gateway then sends `reasoning: {effort, summary: "auto"}` on the
// Responses request (internal/gateway/responses.go).
function variants() {
  return Object.fromEntries(EFFORTS.map((e) => [e, { reasoningEffort: e }]))
}

// Config-bootstrap model: the docs' simple format (name, limit,
// reasoning, tool_call, modalities, variants). The host normalizes it;
// the models hook below returns the full OpenCode Model shape.
function configModel(base, suffix, name) {
  return {
    name,
    limit: base.limit,
    reasoning: true,
    tool_call: true,
    modalities: { input: base.input },
    variants: variants(),
  }
}

function configCatalog() {
  const out = {}
  for (const base of MODELS) {
    out[base.id] = configModel(base, "", base.name)
    if (base.contributor) out[base.id + "-contributor"] = configModel(base, "-contributor", base.name + " (Contributor)")
  }
  return out
}

// Models-hook model: OpenCode's Model shape (docs: "Each account's
// models" — id, name, api, limit, capabilities, cost, variants,
// release_date, status).
function modelEntry(base, suffix, name) {
  const id = base.id + suffix
  const input = { text: true, image: false, audio: false, video: false, pdf: false }
  for (const m of base.input) input[m] = true
  return {
    id, name,
    api: { id, url: API_BASE, npm: NPM },
    status: "active", headers: {}, options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: base.limit,
    capabilities: {
      temperature: true, reasoning: true,
      attachment: base.input.includes("image") || base.input.includes("video") || base.input.includes("audio"),
      toolcall: true,
      input,
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "", variants: variants(),
  }
}

function catalog() {
  const out = {}
  for (const base of MODELS) {
    out[base.id] = modelEntry(base, "", base.name)
    if (base.contributor) out[base.id + "-contributor"] = modelEntry(base, "-contributor", base.name + " (Contributor)")
  }
  return out
}

// Fields Meta's Responses API is known to refuse, per CLIProxyAPI's meta
// executor (which deletes the same five before sending). The gateway's
// own Responses builder only ever emits client_metadata of these, but
// the strip costs nothing and covers anything else that reaches us.
const DROP_FIELDS = ["generate", "prompt_cache_retention", "safety_identifier", "stream_options", "client_metadata"]

// stripReasoningEncryptedContent drops `encrypted_content` from every
// reasoning item in a Responses request body. Pure: takes the parsed body,
// returns a new body. Meta binds each encrypted blob to the caller that
// received it — replaying another account's blob fails with 400
// "reasoning `encrypted_content` was not issued to this caller", which is
// what happens when Magpie switches accounts mid-conversation (routing,
// fallback, or the user switching the active account). The visible
// `summary` and the item `id` are kept, so the model still sees what it
// reasoned — only the opaque blob goes. Used only on the retry after
// that 400, so same-account conversations keep the replay benefit.
// (CLIProxyAPI's Meta executor has the same idea —
// sanitizeOpenAIResponsesReasoningEncryptedContentKeepForeign — but it
// can only drop malformed blobs: Muse's own format is opaque to it, so
// it keeps the blob and the account-switch case still hits Meta's 400.
// The rejection itself is the only signal here.)
export function stripReasoningEncryptedContent(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body
  if (!Array.isArray(body.input)) return body
  let changed = false
  const input = body.input.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item
    if (item.type !== "reasoning" || !("encrypted_content" in item)) return item
    changed = true
    const { encrypted_content: _dropped, ...rest } = item
    return rest
  })
  return changed ? { ...body, input } : body
}

// dropBareReasoningItems removes every reasoning item that has nothing
// sealed in it (no encrypted_content) — unless the request asks the vendor
// to store the turn (store: true), in which case the vendor kept the items
// and a bare id resolves. A bare item is only a server-side reference: its
// summary is the model's notes to itself, which no model reads back, and
// when the vendor has nothing stored for the id the whole request goes
// back 400 "Referenced reasoning item 'rs_…' was not found or has
// expired". An old session collects one such item per turn, so dropping
// one per retry can never heal it — all of them go, up front, in one
// request. Sealed items (with encrypted_content) are kept: the 0.1.6
// retry still heals a blob sealed for another caller, and the retry loop
// below drops all reasoning the moment Meta names a dead item. Mirrors
// Magpie's own withoutBareReasoning (Codex backend, #1008), which the
// plugin path never went through.
export function dropBareReasoningItems(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body
  if (!Array.isArray(body.input)) return body
  if (body.store === true) return body
  let changed = false
  const input = body.input.filter((item) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item) && item.type === "reasoning" &&
        (typeof item.encrypted_content !== "string" || item.encrypted_content.trim() === "")) {
      changed = true
      return false
    }
    return true
  })
  return changed ? { ...body, input } : body
}

// dropAllReasoningItems removes every reasoning item from a Responses
// request body. The summaries are the model's notes to itself, and the
// text history (messages, tool calls and their results) stays, so the
// turn can still proceed — it just cannot replay any prior reasoning.
// Used only after Meta has already refused the request over a reasoning
// reference it cannot resolve: one dead reference per turn collects in
// an old session, and the id Meta names changes from attempt to attempt,
// so chasing them one by one never heals it.
export function dropAllReasoningItems(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body
  if (!Array.isArray(body.input)) return body
  let changed = false
  const input = body.input.filter((item) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item) && item.type === "reasoning") {
      changed = true
      return false
    }
    return true
  })
  return changed ? { ...body, input } : body
}

// parseReferencedReasoningId pulls the reasoning item id(s) out of Meta's
// "Referenced reasoning item '...' was not found or has expired." refusal.
// The quoted id can hold two tokens joined by ':' (rs_…:rs_…). The ids
// themselves are not acted on — the caller only needs to know the error
// is this refusal — but they are returned for the message. Returns null
// when the text is not that refusal.
export function parseReferencedReasoningId(errorText) {
  if (typeof errorText !== "string") return null
  const m = /Referenced reasoning item '([^']+)' was not found or has expired/i.exec(errorText)
  if (!m) return null
  const ids = m[1].split(":").map((s) => s.trim()).filter(Boolean)
  return ids.length ? ids : null
}

// isEncryptedContentCallerError is Meta's 400 when a Responses request
// replays a reasoning `encrypted_content` blob issued to another caller
// (another account/key). The blob is opaque — only Meta knows who it was
// issued to — so the rejection itself is the signal.
function isEncryptedContentCallerError(status, text) {
  return status === 400 && text.includes("encrypted_content") && text.includes("was not issued to this caller")
}

// normalizeRequest applies the two normalizations Meta needs on a
// gateway-built Responses request. Pure: takes the parsed body, returns
// the body to send. (1) Drop the fields above. (2) Ensure `instructions`
// exists: CLIProxyAPI's normalizeCodexInstructions sets it to "" when
// absent, and the gateway only sends it when there is a system prompt.
// The canonical Muse namespace tool, captured from the Muse Code 1.4.12
// reminder agent (the same blob CLIProxyAPI appends). Subscription-key
// tool requests can require it even with current client headers: Meta
// treats a tool-bearing request without it as not from Muse Code, and
// answers "Muse Code subscriptions cover requests from the Muse Code
// client only". The real CLI always carries it in its own tool-bearing
// requests, so a client that sends its own tools (a VS Code agent over
// Chat Completions) needs the plugin to append it.
const MUSE_NAMESPACE_JSON = `{"type":"namespace","name":"muse","description":"Muse Code tool set.","tools":[{"type":"function","name":"submit_reminder_decision","description":"Submit this reminder child's explicit decision.","parameters":{"additionalProperties":false,"properties":{"advisory_text":{"description":"Short text to deliver to the main agent when reminding.","type":["null","string"]},"confidence":{"description":"Confidence in the decision.","enum":["low","medium","high"],"type":["null","string"]},"decision":{"enum":["remind","none"],"type":"string"},"priority":{"description":"Requested reminder priority.","enum":["low","normal","high"],"type":["null","string"]},"reason":{"description":"Brief reason for reminding or staying silent.","type":"string"},"skill_id":{"description":"The listed skill id to remind when needs_reminder is true.","type":["null","string"]},"visible_for_steps":{"description":"Requested ephemeral visibility length in main model steps.","maximum":8,"minimum":1,"type":["null","integer"]}},"required":["advisory_text","confidence","decision","priority","reason","skill_id","visible_for_steps"],"type":"object"},"strict":true}]}`

// ensureMuseToolNamespace appends the canonical `muse` namespace tool to
// a tool-bearing Responses request that lacks one, preserving the caller's
// tools (their names and schemas stay untouched). Tool-less requests and
// requests that already carry the namespace are returned unchanged.
export function ensureMuseToolNamespace(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body
  const tools = body.tools
  if (!Array.isArray(tools) || tools.length === 0) return body
  if (tools.some((t) => t !== null && typeof t === "object" && !Array.isArray(t) && t.type === "namespace" && t.name === "muse")) return body
  let namespace
  try { namespace = JSON.parse(MUSE_NAMESPACE_JSON) } catch { return body }
  return { ...body, tools: [...tools, namespace] }
}

export function normalizeRequest(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body
  const out = { ...body }
  for (const f of DROP_FIELDS) delete out[f]
  if (!("instructions" in out) || out.instructions == null) out.instructions = ""
  return ensureMuseToolNamespace(out)
}

// parseSubscriptionUsage validates and normalizes one `subscription`
// object from Meta's `response.subscription_usage` event. The event is
// the only place the allowance lives: `weekly` and `window` each carry
// `used_percent` (0-100) and `resets_at` (Unix seconds); the window also
// carries `window_duration_mins`. Returns null when nothing usable is
// in it. Pure: takes the parsed object, returns a normalized entry.
// (CLIProxyAPI knows the event too but strips it from the stream and
// never reads it — its Meta executor only counts tokens per request and
// reacts to a 429. There is no separate Meta usage endpoint to ask.)
export function parseSubscriptionUsage(subscription) {
  if (!subscription || typeof subscription !== "object" || Array.isArray(subscription)) return null
  const readWindow = (w) => {
    if (!w || typeof w !== "object" || Array.isArray(w)) return null
    const used = typeof w.used_percent === "number" && isFinite(w.used_percent) ? Math.max(0, w.used_percent) : null
    const resetsAt = typeof w.resets_at === "number" && isFinite(w.resets_at) && w.resets_at > 0
      ? new Date(w.resets_at * 1000).toISOString() : null
    const spanSecs = typeof w.window_duration_mins === "number" && isFinite(w.window_duration_mins) && w.window_duration_mins > 0
      ? w.window_duration_mins * 60 : null
    if (used === null && resetsAt === null) return null
    return { used, resetsAt, spanSecs }
  }
  const weekly = readWindow(subscription.weekly)
  const window = readWindow(subscription.window)
  if (!weekly && !window) return null
  return {
    tier: typeof subscription.tier === "string" && subscription.tier ? subscription.tier : null,
    weekly, window,
  }
}

// subscriptionWindows turns a cached subscription entry (from
// parseSubscriptionUsage) into the windows Magpie's `usage` hook returns:
// the 5-hour window and the weekly window, each with its used percent
// and reset time. Magpie's host turns `used` into the card's meter and
// routing reads the allowance from it; a window with no reading would
// show as "No allowance reported", so only windows with a reading are
// returned.
export function subscriptionWindows(cached) {
  if (!cached || typeof cached !== "object") return []
  const out = []
  if (cached.window) {
    const w = { name: "5-hour window", used: cached.window.used ?? null }
    if (cached.window.resetsAt) w.resetsAt = cached.window.resetsAt
    if (cached.window.spanSecs) w.span = cached.window.spanSecs
    out.push(w)
  }
  if (cached.weekly) {
    const w = { name: "Weekly", used: cached.weekly.used ?? null }
    if (cached.weekly.resetsAt) w.resetsAt = cached.weekly.resetsAt
    out.push(w)
  }
  return out
}

// subscriptionUsageStream returns a TransformStream that watches an SSE
// response body for Meta's `response.subscription_usage` event and records
// the latest subscription payload for the account (in `store`, keyed by
// `email`). Every chunk passes through unchanged — the plugin only
// observes, never filters — so the client still sees the event. Only
// `data:` lines mentioning "subscription" are parsed, and scanning stops
// after the first event (Meta sends one per response, first). A line may
// split across chunks, so lines are buffered until complete.
export function subscriptionUsageStream(store, email) {
  const decoder = new TextDecoder()
  let buf = ""
  let done = false
  const scanLine = (line) => {
    if (done || !line.startsWith("data:")) return
    const payload = line.slice(5)
    if (!payload.includes("subscription")) return
    let parsed
    try { parsed = JSON.parse(payload.trim()) } catch { return }
    if (!parsed || typeof parsed !== "object" || !parsed.subscription || typeof parsed.subscription !== "object") return
    const entry = parseSubscriptionUsage(parsed.subscription)
    if (entry && store && typeof email === "string" && email !== "") {
      store.set(email, entry)
      done = true
    }
  }
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      if (done) return
      let text
      try { text = decoder.decode(chunk, { stream: true }) } catch { return }
      buf += text
      let idx
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        scanLine(line)
        if (done) break
      }
    },
    flush() {
      if (done) return
      let tail = ""
      try { tail = decoder.decode() } catch { tail = "" }
      const line = (buf + tail).trim()
      if (line) scanLine(line)
    },
  })
}

// subscriptionAccountKey is the cache key for one sign-in: its email,
// falling back to its display name. Returns null when neither is known,
// in which case usage is not recorded for that account.
function subscriptionAccountKey(signIn) {
  try {
    const m = metadata(signIn)
    if (typeof m.email === "string" && m.email) return m.email
    if (typeof m.name === "string" && m.name) return m.name
  } catch {}
  return null
}

export async function MuseAuthPlugin({ client }) {
  const auth = createAuth(client)
  // Latest subscription usage per account, from the `response.subscription_usage`
  // events Meta sends in its response streams. The `usage` hook reads it;
  // a restart clears it until the account's next request.
  const subscriptionUsage = new Map()

  async function signedFetch(getAuth, input, init) {
    const req = new Request(input, init)
    // Refuse foreign destinations before even refreshing: the minted key
    // must only ever go to Meta's own API. The gateway sends Responses
    // requests to the loader's baseURL + "/responses".
    const u = new URL(req.url)
    if (u.origin !== new URL(API_BASE).origin || u.pathname !== "/v1/responses") {
      throw new AuthError("refusing_inference_destination")
    }
    req.signal.throwIfAborted()
    // Keep the exact request bytes for at most one 401 replay, with bare
    // reasoning already out: reasoning items with nothing sealed in them
    // are server-side references the vendor may no longer have, and one
    // dead reference 400s the whole turn.
    const bodyText = req.body ? await req.text() : undefined
    let sendBody = bodyText
    if (bodyText) {
      try { sendBody = JSON.stringify(dropBareReasoningItems(normalizeRequest(JSON.parse(bodyText)))) } catch { /* not JSON: forward as-is */ }
    }

    let a = await auth.fresh(getAuth)
    const send = (current) => {
      req.signal.throwIfAborted()
      const headers = new Headers()
      headers.set("Authorization", "Bearer " + current.access)
      headers.set("User-Agent", BUILD_USER_AGENT)
      headers.set("X-Client-Id", CLIENT_HEADER)
      headers.set("Content-Type", "application/json")
      headers.set("Accept", "text/event-stream")
      return fetch(API_BASE + "/responses", {
        method: "POST", headers,
        body: sendBody,
        signal: req.signal, redirect: "error",
      })
    }
    let renewed = a.signIn === "renewed"
    let res = await send(a)
    if (res.status === 401) {
      await res.body?.cancel()
      a = await auth.fresh(getAuth, a.access)
      renewed ||= a.signIn === "renewed"
      res = await send(a)
    }
    // The 400s Meta answers about replayed reasoning, healed in order:
    // a blob sealed for another caller (strip it), a reasoning item it
    // can no longer resolve ("Referenced reasoning item 'rs_…' was not
    // found or has expired"), and — when the reference lives in the
    // previous response the request points at instead of in `input` —
    // the `previous_response_id` itself. The expired-item refusal only
    // shows up when the account switched mid-conversation (or the
    // vendor's store expired), and then EVERY reasoning item in the
    // history belongs to the old account/store — chasing them one by
    // one just names the next dead id, as three consecutive retries of
    // one session proved (a different id each time). So the first
    // expired-item refusal drops ALL reasoning items at once, no
    // named drop, no second chance for a single item. At most three
    // resends (four sends total); a rejection no fix applies to is
    // rebuilt below so nothing is lost.
    let resends = 0
    let healedSealed = false
    let droppedAllReasoning = false
    let droppedPrevResponse = false
    while (res.status === 400 && resends < 3) {
      const errorText = await res.text().catch(() => "")
      let nextBody
      if (!droppedAllReasoning && sendBody && parseReferencedReasoningId(errorText)) {
        let dropped
        try { dropped = JSON.stringify(dropAllReasoningItems(JSON.parse(sendBody))) } catch { dropped = undefined }
        if (dropped && dropped !== sendBody) { nextBody = dropped; droppedAllReasoning = true }
      }
      if (nextBody === undefined && !healedSealed && sendBody) {
        if (isEncryptedContentCallerError(res.status, errorText)) {
          let stripped
          try { stripped = JSON.stringify(stripReasoningEncryptedContent(JSON.parse(sendBody))) } catch { stripped = undefined }
          if (stripped && stripped !== sendBody) { nextBody = stripped; healedSealed = true }
        }
      }
      if (nextBody === undefined && !droppedPrevResponse && sendBody) {
        // No reasoning left in `input` and Meta still names a dead item:
        // the reference lives in the previous response this request
        // points at. Dropping the pointer makes Meta read only `input`,
        // which carries the full history.
        if (parseReferencedReasoningId(errorText)) {
          let parsed
          try { parsed = JSON.parse(sendBody) } catch { parsed = undefined }
          if (parsed && typeof parsed.previous_response_id === "string" && parsed.previous_response_id !== "") {
            const { previous_response_id: _dropped, ...rest } = parsed
            nextBody = JSON.stringify(rest)
            droppedPrevResponse = true
          }
        }
      }
      if (nextBody === undefined) {
        res = new Response(errorText, { status: res.status, statusText: res.statusText, headers: res.headers })
        break
      }
      sendBody = nextBody
      resends++
      res = await send(a)
    }
    const headers = new Headers(res.headers)
    // The answer goes back as it came, streamed chunk by chunk; the
    // host re-streams it, so the upstream wire encoding and size no
    // longer apply.
    headers.delete("content-encoding")
    headers.delete("content-length")
    if (res.ok) {
      headers.set("X-Magpie-Sign-In", renewed ? "renewed" : "kept")
    } else if (res.status === 401) {
      // A 401 that survived a fresh mint is the sign-in itself: mark
      // the account so Magpie stops sending to it until it is signed
      // in again. Any other failure is left for the gateway to judge
      // (a 401 about a model the account may not use reads as `kept`).
      headers.set("X-Magpie-Sign-In", "expired")
    }
    // Watch the answer's stream for the subscription_usage event: it is
    // the only place Meta tells the allowance, and the `usage` hook
    // reads what was last seen. The stream itself passes through
    // untouched.
    let body = res.body
    if (res.ok && body) {
      const key = subscriptionAccountKey(a)
      if (key) body = body.pipeThrough(subscriptionUsageStream(subscriptionUsage, key))
    }
    return new Response(body, { status: res.status, statusText: res.statusText, headers })
  }

  return {
    config: async (config) => {
      config.provider ??= {}
      const p = config.provider[ID] ??= {}
      p.name ??= "Muse (Meta)"
      p.npm ??= NPM
      p.api ??= API_BASE
      // Meta runs the hosted web search tool itself (its Responses API
      // takes {type: "web_search"}), so a client's web search reaches
      // this fetch as it was sent instead of going through Magpie's own
      // search.
      p.searches ??= true
      p.models = { ...configCatalog(), ...(p.models ?? {}) }
    },
    provider: {
      id: ID,
      async models(provider, { auth: saved }) {
        // Static registry: Meta exposes no live catalog for this API.
        // The bootstrap models from config() are returned as-is; the
        // sign-in snapshot is only checked, never redeemed here.
        if (saved?.type !== "oauth") return provider.models
        return catalog()
      },
    },
    auth: {
      provider: ID, icon: ICON, refreshLead: 120000,
      refresh: auth.refresh,
      async loader(getAuth) {
        if ((await auth.read(getAuth))?.type !== "oauth") return {}
        return {
          baseURL: API_BASE, apiKey: "muse-oauth",
          fetch: (input, init) => signedFetch(getAuth, input, init),
        }
      },
      async usage(getAuth) {
        try {
          const a = await auth.read(getAuth)
          if (a?.type !== "oauth") return {}
          const m = metadata(a)
          // The allowance comes from the last subscription_usage event
          // this account's stream carried; until its first request
          // there is no reading, and the card says so.
          const windows = subscriptionWindows(subscriptionUsage.get(subscriptionAccountKey(a)))
          return {
            plan: m.tier || undefined,
            user: m.name || m.email || undefined,
            ...(windows.length ? { windows } : {}),
          }
        } catch { return {} }
      },
      methods: [
        { type: "oauth", label: "Muse (Meta) — device code", authorize: auth.authorize },
        {
          type: "oauth", label: "Import CLIProxyAPI auth file", authorize: auth.authorizeImport,
          // One prompt, typed unseen (type "password"): the whole
          // CLIProxyAPI Meta auth file, or just its dca_token. Magpie
          // asks it before the sign-in starts and validate() checks the
          // paste parses before anything is minted.
          prompts: [{
            key: "auth", type: "password",
            message: "Paste the CLIProxyAPI Meta auth file (JSON), or just its dca_token",
            placeholder: "dca:… or the whole auth JSON",
            validate: auth.validateImport,
          }],
        },
      ],
    },
  }
}
