// Offline tests for the thin request path: the gateway-built Responses
// request is signed, normalized and forwarded untouched; the answer
// passes back untouched. Network is fully mocked. Run: node --test test/
import test from "node:test"
import assert from "node:assert/strict"
import { MuseAuthPlugin, normalizeRequest, stripReasoningEncryptedContent, parseReferencedReasoningId, dropBareReasoningItems, dropAllReasoningItems, parseSubscriptionUsage, subscriptionWindows, subscriptionUsageStream, ensureMuseToolNamespace } from "../index.mjs"

test("normalizeRequest: adds missing instructions, drops refused fields", () => {
  const out = normalizeRequest({
    model: "muse-spark-1.3", input: "hi", stream: true,
    client_metadata: { x: 1 }, prompt_cache_retention: "in-memory",
    safety_identifier: "s", stream_options: {}, generate: true,
  })
  assert.equal(out.instructions, "")
  assert.equal("client_metadata" in out, false)
  assert.equal("prompt_cache_retention" in out, false)
  assert.equal("safety_identifier" in out, false)
  assert.equal("stream_options" in out, false)
  assert.equal("generate" in out, false)
  assert.equal(out.model, "muse-spark-1.3")
  assert.equal(out.stream, true)
})

test("normalizeRequest: keeps an instructions that is there, keeps reasoning", () => {
  const out = normalizeRequest({
    model: "muse-wonder-1.0", input: [], instructions: "Behave.",
    reasoning: { effort: "high", summary: "auto" }, store: false,
  })
  assert.equal(out.instructions, "Behave.")
  assert.deepEqual(out.reasoning, { effort: "high", summary: "auto" })
  assert.equal(out.store, false)
})

const stubClient = {
  auth: { set: async () => ({}) },
  app: { log: async () => {} },
  config: { get: async () => ({ data: {} }) },
}

function fakeSignIn() {
  return {
    type: "oauth", access: "key-abc",
    refresh: JSON.stringify({ version: 1, token: "dca:token123", tokenType: "Bearer", baseURL: "https://api.meta.ai/v1", email: "a@b.c", name: "A B", tier: "Pro" }),
    expires: Date.now() + 3600_000,
  }
}

test("signedFetch: Responses request forwarded as-is, answer passed back", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const seen = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init })
    const done = {
      id: "resp_9", object: "response", created_at: 1700000001, status: "completed", model: "muse-spark-1.3",
      output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello", annotations: [] }] }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    }
    return new Response(JSON.stringify(done), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3", input: [{ role: "user", content: "hi" }], stream: false, store: false,
        reasoning: { effort: "high", summary: "auto" }, client_metadata: { agent: "x" },
      }),
    })
    assert.equal(res.status, 200)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, "https://api.meta.ai/v1/responses")
    const headers = new Headers(seen[0].init.headers)
    assert.equal(headers.get("Authorization"), "Bearer key-abc")
    assert.equal(headers.get("X-Client-Id"), "tbh:exec")
    assert.match(headers.get("User-Agent"), /^muse-build\/1\.4\.14 \(non-interactive; [a-z0-9]+-[a-z0-9_]+; build dec7d7497fecdad135ec5835a8161dbc92e55b58\)$/)
    const sent = JSON.parse(seen[0].init.body)
    assert.equal(sent.model, "muse-spark-1.3")
    assert.equal(sent.instructions, "")
    assert.equal("client_metadata" in sent, false)
    assert.deepEqual(sent.reasoning, { effort: "high", summary: "auto" })
    assert.equal(sent.store, false)
    const out = await res.json()
    assert.equal(out.status, "completed")
    assert.equal(out.output[0].content[0].text, "hello")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("signedFetch: stream passes through untouched", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    const sse = 'data: {"type":"response.output_text.delta","delta":"hello"}\n\n'
      + 'data: {"type":"response.completed","response":{"id":"resp_9","status":"completed","output":[],"usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\n\n'
    return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "muse-spark-1.3", input: "hi", stream: true }),
    })
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.match(text, /response\.output_text\.delta/)
    assert.match(text, /response\.completed/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("signedFetch: past DCA deadline still mints and serves (no unusable_sign_in)", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  let minted = 0
  globalThis.fetch = async (url, init) => {
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
    if (String(url).includes("/muse-code/key")) {
      minted++
      return json({ api_key: "key-fresh", base_url: "https://api.meta.ai/v1", user_email: "a@b.c", user_full_name: "A B", subs_tier_name: "Pro", is_subs_active: true })
    }
    return json({ id: "r", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] })
  }
  try {
    // A sign-in whose stamped DCA deadline passed an hour ago, while the
    // DCA token itself still mints (Meta accepts it past the stamped
    // deadline). Regression (seen live 09/11): renew() kept the stale
    // deadline, so fresh() threw unusable_sign_in on every request even
    // though a fresh key had just been minted.
    const stale = fakeSignIn()
    stale.expires = Date.now() - 3600_000
    const loader = await hooks.auth.loader(async () => stale)
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "muse-spark-1.3", input: "hi", stream: false }),
    })
    assert.equal(res.status, 200)
    assert.equal(minted, 1)
    const out = await res.json()
    assert.equal(out.output[0].content[0].text, "ok")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("signedFetch: 401 re-mints once and retries", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  let n = 0
  const keys = []
  globalThis.fetch = async (url, init) => {
    n++
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
    if (String(url).includes("/muse-code/key")) {
      return json({ api_key: "key-new", base_url: "https://api.meta.ai/v1", user_email: "a@b.c", user_full_name: "A B", subs_tier_name: "Pro", is_subs_active: true })
    }
    keys.push(new Headers(init.headers).get("Authorization"))
    if (n === 1) return new Response("", { status: 401 })
    return json({ id: "r", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "muse-wonder-1.0", input: "hi", stream: false }),
    })
    assert.equal(res.status, 200)
    const out = await res.json()
    assert.equal(out.output[0].content[0].text, "ok")
    assert.equal(n, 3) // 401, mint, retry
    assert.deepEqual(keys, ["Bearer key-abc", "Bearer key-new"])
    assert.equal(res.headers.get("X-Magpie-Sign-In"), "renewed")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("signedFetch: persistent 401 marks the sign-in expired", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes("/muse-code/key")) {
      return new Response(JSON.stringify({ api_key: "key-new", base_url: "https://api.meta.ai/v1" }), { status: 200, headers: { "Content-Type": "application/json" } })
    }
    return new Response("", { status: 401 })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "muse-wonder-1.0", input: "hi", stream: false }),
    })
    assert.equal(res.status, 401)
    assert.equal(res.headers.get("X-Magpie-Sign-In"), "expired")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("signedFetch: refuses foreign destinations", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const loader = await hooks.auth.loader(async () => fakeSignIn())
  await assert.rejects(
    () => loader.fetch("https://evil.test/v1/responses", { method: "POST", body: "{}" }),
    /refusing_inference_destination/,
  )
  await assert.rejects(
    () => loader.fetch("https://api.meta.ai/v1/chat/completions", { method: "POST", body: "{}" }),
    /refusing_inference_destination/,
  )
})

test("stripReasoningEncryptedContent: drops the blob, keeps summary and id", () => {
  const out = stripReasoningEncryptedContent({
    model: "muse-spark-1.3",
    input: [
      { type: "message", role: "user", content: "hi" },
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thought" }], encrypted_content: "opaque-blob" },
      { type: "reasoning", summary: [], encrypted_content: "another-blob" },
    ],
  })
  assert.equal(out.model, "muse-spark-1.3")
  assert.deepEqual(out.input[0], { type: "message", role: "user", content: "hi" })
  assert.equal("encrypted_content" in out.input[1], false)
  assert.equal(out.input[1].id, "rs_1")
  assert.deepEqual(out.input[1].summary, [{ type: "summary_text", text: "thought" }])
  assert.equal("encrypted_content" in out.input[2], false)
})

test("stripReasoningEncryptedContent: no-op without reasoning blobs", () => {
  const body = { model: "muse-spark-1.3", input: [{ type: "message", role: "user", content: "hi" }] }
  assert.equal(stripReasoningEncryptedContent(body), body)
  assert.equal(stripReasoningEncryptedContent({ model: "m", input: "just a string" }).input, "just a string")
  assert.equal(stripReasoningEncryptedContent(null), null)
})

test("signedFetch: 400 encrypted_content caller error strips the blob and retries once", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body))
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
    if (seen.length === 1) {
      return json({ error: { message: "reasoning `encrypted_content` was not issued to this caller", type: "invalid_request_error", code: "invalid_request_error" } }, 400)
    }
    return json({ id: "r", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3",
        input: [
          { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thought" }], encrypted_content: "blob-from-another-account" },
          { type: "message", role: "user", content: "continue" },
        ],
        stream: false,
      }),
    })
    assert.equal(res.status, 200)
    assert.equal(seen.length, 2)
    assert.equal(seen[0].input[0].encrypted_content, "blob-from-another-account")
    assert.equal("encrypted_content" in seen[1].input[0], false)
    assert.equal(seen[1].input[0].id, "rs_1")
    assert.deepEqual(seen[1].input[0].summary, [{ type: "summary_text", text: "thought" }])
    const out = await res.json()
    assert.equal(out.output[0].content[0].text, "ok")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("signedFetch: other 400s are returned as-is, no retry", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  let n = 0
  globalThis.fetch = async () => {
    n++
    return new Response(JSON.stringify({ error: { message: "model not found", type: "invalid_request_error", code: "model_not_found" } }), { status: 400, headers: { "Content-Type": "application/json" } })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "muse-spark-1.3", input: "hi", stream: false }),
    })
    assert.equal(res.status, 400)
    assert.equal(n, 1)
    const out = await res.json()
    assert.equal(out.error.code, "model_not_found")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("signedFetch: 400 caller error with a non-JSON request body is returned as-is", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  let n = 0
  globalThis.fetch = async () => {
    n++
    return new Response(JSON.stringify({ error: { message: "reasoning `encrypted_content` was not issued to this caller", type: "invalid_request_error" } }), { status: 400, headers: { "Content-Type": "application/json" } })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{{{",
    })
    assert.equal(res.status, 400)
    assert.equal(n, 1)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("parseReferencedReasoningId: both tokens of a compound id, null otherwise", () => {
  assert.deepEqual(
    parseReferencedReasoningId("Referenced reasoning item 'rs_6af2fb9e996548e8c5154a60:rs_01a1c526e4497502ab42d1996c19b6da' was not found or has expired."),
    ["rs_6af2fb9e996548e8c5154a60", "rs_01a1c526e4497502ab42d1996c19b6da"],
  )
  assert.deepEqual(
    parseReferencedReasoningId("Referenced reasoning item 'rs_single' was not found or has expired."),
    ["rs_single"],
  )
  assert.equal(parseReferencedReasoningId("reasoning `encrypted_content` was not issued to this caller"), null)
  assert.equal(parseReferencedReasoningId("model not found"), null)
  assert.equal(parseReferencedReasoningId(""), null)
  assert.equal(parseReferencedReasoningId(undefined), null)
})

test("signedFetch: 400 expired reasoning item drops ALL reasoning and retries once", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body))
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
    if (seen.length === 1) {
      return json({ error: { message: "Referenced reasoning item 'rs_dead' was not found or has expired.", type: "invalid_request_error", code: "invalid_request_error" } }, 400)
    }
    return json({ id: "r", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3",
        input: [
          { type: "reasoning", id: "rs_dead", summary: [{ type: "summary_text", text: "old" }] },
          { type: "reasoning", id: "rs_live", summary: [{ type: "summary_text", text: "kept" }] },
          { type: "message", role: "user", content: "continue" },
        ],
        // store: true keeps the bare items past the 0.1.8 preemptive drop, so this test exercises the retry loop.
        store: true,
        stream: false,
      }),
    })
    assert.equal(res.status, 200)
    assert.equal(seen.length, 2)
    // The first refusal drops ALL reasoning at once — rs_live goes too:
    // every item in the history belongs to the old account/store, so
    // dropping only the named one would just surface the next dead id.
    assert.equal(seen[1].input.length, 1)
    assert.equal(seen[1].input[0].role, "user")
    const out = await res.json()
    assert.equal(out.output[0].content[0].text, "ok")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("signedFetch: compound expired-item id drops all reasoning at once", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body))
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
    if (seen.length === 1) {
      return json({ error: { message: "Referenced reasoning item 'rs_first:rs_second' was not found or has expired.", type: "invalid_request_error" } }, 400)
    }
    return json({ id: "r", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3",
        input: [
          { type: "reasoning", id: "rs_second", summary: [{ type: "summary_text", text: "old" }] },
          { type: "message", role: "user", content: "continue" },
        ],
        // store: true keeps the bare items past the 0.1.8 preemptive drop, so this test exercises the retry loop.
        store: true,
        stream: false,
      }),
    })
    assert.equal(res.status, 200)
    assert.equal(seen.length, 2)
    assert.equal(seen[1].input.length, 1)
    assert.equal(seen[1].input[0].role, "user")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("signedFetch: caller error then expired item heals in two resends", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body))
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
    if (seen.length === 1) {
      return json({ error: { message: "reasoning `encrypted_content` was not issued to this caller", type: "invalid_request_error" } }, 400)
    }
    if (seen.length === 2) {
      return json({ error: { message: "Referenced reasoning item 'rs_dead' was not found or has expired.", type: "invalid_request_error" } }, 400)
    }
    return json({ id: "r", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3",
        input: [
          { type: "reasoning", id: "rs_dead", summary: [{ type: "summary_text", text: "old" }] },
          { type: "reasoning", id: "rs_sealed", summary: [{ type: "summary_text", text: "kept" }], encrypted_content: "blob-from-another-account" },
          { type: "message", role: "user", content: "continue" },
        ],
        // store: true keeps the bare items past the 0.1.8 preemptive drop, so this test exercises the retry loop.
        store: true,
        stream: false,
      }),
    })
    assert.equal(res.status, 200)
    assert.equal(seen.length, 3)
    assert.equal(seen[1].input.length, 3)
    assert.equal("encrypted_content" in seen[1].input[1], false) // blob stripped first
    assert.equal(seen[1].input[0].id, "rs_dead")
    // The expired-item refusal then drops ALL reasoning at once.
    assert.equal(seen[2].input.length, 1)
    assert.equal(seen[2].input[0].role, "user")
    const out = await res.json()
    assert.equal(out.output[0].content[0].text, "ok")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("signedFetch: sealed blob then expired item heals in the other order", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body))
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
    if (seen.length === 1) {
      return json({ error: { message: "reasoning `encrypted_content` was not issued to this caller", type: "invalid_request_error" } }, 400)
    }
    if (seen.length === 2) {
      return json({ error: { message: "Referenced reasoning item 'rs_dead' was not found or has expired.", type: "invalid_request_error" } }, 400)
    }
    return json({ id: "r", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3",
        input: [
          { type: "reasoning", id: "rs_dead", summary: [{ type: "summary_text", text: "old" }] },
          { type: "reasoning", id: "rs_sealed", summary: [{ type: "summary_text", text: "kept" }], encrypted_content: "blob-from-another-account" },
          { type: "message", role: "user", content: "continue" },
        ],
        // store: true keeps the bare items past the 0.1.8 preemptive drop, so this test exercises the retry loop.
        store: true,
        stream: false,
      }),
    })
    assert.equal(res.status, 200)
    assert.equal(seen.length, 3)
    assert.equal("encrypted_content" in seen[1].input[1], false) // blob stripped first
    assert.equal(seen[1].input[0].id, "rs_dead")
    assert.equal(seen[2].input.length, 1) // expired item drops ALL reasoning second
    assert.equal(seen[2].input[0].role, "user")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("signedFetch: expired item with no matching input is returned, no retry", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  let n = 0
  globalThis.fetch = async () => {
    n++
    return new Response(JSON.stringify({ error: { message: "Referenced reasoning item 'rs_ghost' was not found or has expired.", type: "invalid_request_error" } }), { status: 400, headers: { "Content-Type": "application/json" } })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3",
        input: [{ type: "message", role: "user", content: "continue" }],
        stream: false,
      }),
    })
    assert.equal(res.status, 400)
    assert.equal(n, 1)
    const out = await res.json()
    assert.match(out.error.message, /rs_ghost/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("dropBareReasoningItems: drops every bare item, keeps sealed ones", () => {
  const out = dropBareReasoningItems({
    model: "muse-spark-1.3", store: false,
    input: [
      { type: "reasoning", id: "rs_dead1", summary: [{ type: "summary_text", text: "old" }] },
      { type: "reasoning", id: "rs_dead2", summary: [] },
      { type: "reasoning", id: "rs_sealed", summary: [{ type: "summary_text", text: "kept" }], encrypted_content: "blob" },
      { type: "reasoning", id: "rs_empty_blob", summary: [], encrypted_content: "   " },
      { type: "message", role: "user", content: "hi" },
      { type: "function_call", id: "fc_1", call_id: "c1", name: "read", arguments: "{}" },
    ],
  })
  assert.equal(out.input.length, 3)
  assert.equal(out.input[0].id, "rs_sealed")
  assert.equal(out.input[1].role, "user")
  assert.equal(out.input[2].id, "fc_1")
})

test("dropBareReasoningItems: no-op without bare items, and keeps them when store is true", () => {
  const sealed = { model: "m", input: [{ type: "reasoning", id: "rs_1", encrypted_content: "blob" }] }
  assert.equal(dropBareReasoningItems(sealed), sealed)
  const stored = { model: "m", store: true, input: [{ type: "reasoning", id: "rs_1", summary: [] }] }
  assert.equal(dropBareReasoningItems(stored), stored)
  assert.equal(dropBareReasoningItems({ model: "m", input: "just a string" }).input, "just a string")
  assert.equal(dropBareReasoningItems(null), null)
})

test("signedFetch: several bare reasoning items are all dropped before the first send", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ id: "r", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3",
        input: [
          { type: "reasoning", id: "rs_dead1", summary: [{ type: "summary_text", text: "old" }] },
          { type: "reasoning", id: "rs_dead2", summary: [] },
          { type: "reasoning", id: "rs_dead3", summary: [{ type: "summary_text", text: "older" }] },
          { type: "reasoning", id: "rs_sealed", summary: [{ type: "summary_text", text: "kept" }], encrypted_content: "blob-from-this-account" },
          { type: "message", role: "user", content: "continue" },
        ],
        stream: false,
      }),
    })
    assert.equal(res.status, 200)
    assert.equal(seen.length, 1) // no 400, no retry: the dead items never went out
    assert.equal(seen[0].input.length, 2)
    assert.equal(seen[0].input[0].id, "rs_sealed")
    assert.equal(seen[0].input[1].role, "user")
    const out = await res.json()
    assert.equal(out.output[0].content[0].text, "ok")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("signedFetch: store true keeps bare reasoning items in the sent body", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ id: "r", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3", store: true,
        input: [
          { type: "reasoning", id: "rs_kept", summary: [{ type: "summary_text", text: "stored" }] },
          { type: "message", role: "user", content: "continue" },
        ],
        stream: false,
      }),
    })
    assert.equal(res.status, 200)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].input.length, 2)
    assert.equal(seen[0].input[0].id, "rs_kept")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("dropAllReasoningItems: removes every reasoning item, keeps the rest", () => {
  const out = dropAllReasoningItems({
    model: "muse-spark-1.3",
    input: [
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "a" }], encrypted_content: "blob" },
      { type: "reasoning", id: "rs_2", summary: [] },
      { type: "message", role: "user", content: "hi" },
      { type: "function_call", id: "fc_1", call_id: "c1", name: "read", arguments: "{}" },
    ],
  })
  assert.equal(out.input.length, 2)
  assert.equal(out.input[0].role, "user")
  assert.equal(out.input[1].id, "fc_1")
  const none = { model: "m", input: [{ type: "message", role: "user", content: "hi" }] }
  assert.equal(dropAllReasoningItems(none), none)
  assert.equal(dropAllReasoningItems(null), null)
})

test("signedFetch: first expired-item refusal drops ALL reasoning at once", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body))
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
    // The id Meta names changes from attempt to attempt, so dropping
    // only the named item can never heal it — all reasoning goes on
    // the first refusal, and the turn proceeds in two sends.
    if (seen.length === 1) {
      return json({ error: { message: "Referenced reasoning item 'rs_dead1' was not found or has expired.", type: "invalid_request_error", code: "invalid_request_error" } }, 400)
    }
    return json({ id: "r", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3", store: true,
        input: [
          { type: "reasoning", id: "rs_dead1", summary: [{ type: "summary_text", text: "old" }], encrypted_content: "blob1" },
          { type: "reasoning", id: "rs_dead2", summary: [{ type: "summary_text", text: "older" }], encrypted_content: "blob2" },
          { type: "reasoning", id: "rs_live", summary: [{ type: "summary_text", text: "kept" }], encrypted_content: "blob3" },
          { type: "message", role: "user", content: "continue" },
        ],
        stream: false,
      }),
    })
    assert.equal(res.status, 200)
    assert.equal(seen.length, 2)
    assert.equal(seen[1].input.length, 1)
    assert.equal(seen[1].input[0].role, "user")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("signedFetch: expired-item id not in input drops all reasoning at once", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body))
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
    if (seen.length === 1) {
      return json({ error: { message: "Referenced reasoning item 'rs_ghost:rs_other' was not found or has expired.", type: "invalid_request_error", code: "invalid_request_error" } }, 400)
    }
    return json({ id: "r", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3", store: true,
        input: [
          { type: "reasoning", id: "rs_kept", summary: [{ type: "summary_text", text: "kept" }], encrypted_content: "blob" },
          { type: "message", role: "user", content: "continue" },
        ],
        stream: false,
      }),
    })
    assert.equal(res.status, 200)
    assert.equal(seen.length, 2)
    assert.equal(seen[1].input.length, 1)
    assert.equal(seen[1].input[0].role, "user")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("signedFetch: expired-item with no reasoning left drops previous_response_id", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body))
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
    if (seen.length === 1) {
      return json({ error: { message: "Referenced reasoning item 'rs_old' was not found or has expired.", type: "invalid_request_error", code: "invalid_request_error" } }, 400)
    }
    return json({ id: "r", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3", previous_response_id: "resp_prev",
        input: [{ type: "message", role: "user", content: "continue" }],
        stream: false,
      }),
    })
    assert.equal(res.status, 200)
    assert.equal(seen.length, 2)
    assert.equal(seen[0].previous_response_id, "resp_prev")
    assert.equal("previous_response_id" in seen[1], false)
    assert.equal(seen[1].input.length, 1)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("signedFetch: caller error, then expired item heals in two resends", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body))
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
    if (seen.length === 1) {
      return json({ error: { message: "reasoning encrypted_content was not issued to this caller", type: "invalid_request_error", code: "invalid_request_error" } }, 400)
    }
    if (seen.length === 2) {
      return json({ error: { message: "Referenced reasoning item 'rs_a' was not found or has expired.", type: "invalid_request_error", code: "invalid_request_error" } }, 400)
    }
    return json({ id: "r", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3",
        input: [
          { type: "reasoning", id: "rs_a", summary: [{ type: "summary_text", text: "a" }], encrypted_content: "blob-a" },
          { type: "reasoning", id: "rs_b", summary: [{ type: "summary_text", text: "b" }], encrypted_content: "blob-b" },
          { type: "message", role: "user", content: "continue" },
        ],
        stream: false,
      }),
    })
    assert.equal(res.status, 200)
    assert.equal(seen.length, 3)
    // Send 2 stripped the blobs; send 3 dropped ALL reasoning at once.
    assert.equal(seen[1].input.filter((i) => i.type === "reasoning").every((i) => !("encrypted_content" in i)), true)
    assert.equal(seen[2].input.length, 1)
    assert.equal(seen[2].input[0].role, "user")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("parseSubscriptionUsage: reads weekly and window percents and resets", () => {
  const out = parseSubscriptionUsage({
    tier: "1234567890123456",
    weekly: { resets_at: 1792368000, used_percent: 80 },
    window: { resets_at: 1792272519, used_percent: 10, window_duration_mins: 300 },
  })
  assert.equal(out.tier, "1234567890123456")
  assert.equal(out.weekly.used, 80)
  assert.equal(out.weekly.resetsAt, new Date(1792368000 * 1000).toISOString())
  assert.equal(out.window.used, 10)
  assert.equal(out.window.resetsAt, new Date(1792272519 * 1000).toISOString())
  assert.equal(out.window.spanSecs, 18000)
  assert.equal(parseSubscriptionUsage({}), null)
  assert.equal(parseSubscriptionUsage(null), null)
  assert.equal(parseSubscriptionUsage({ weekly: { used_percent: "80" } }), null)
  // A window with only a reset time still counts as a reading.
  assert.deepEqual(parseSubscriptionUsage({ window: { resets_at: 1792272519 } }).window, { used: null, resetsAt: new Date(1792272519 * 1000).toISOString(), spanSecs: null })
})

test("subscriptionWindows: two windows, weekly only, or none", () => {
  const full = subscriptionWindows(parseSubscriptionUsage({
    tier: "t",
    weekly: { resets_at: 1792368000, used_percent: 80 },
    window: { resets_at: 1792272519, used_percent: 10, window_duration_mins: 300 },
  }))
  assert.equal(full.length, 2)
  assert.equal(full[0].name, "5-hour window")
  assert.equal(full[0].used, 10)
  assert.equal(full[0].resetsAt, new Date(1792272519 * 1000).toISOString())
  assert.equal(full[0].span, 18000)
  assert.equal(full[1].name, "Weekly")
  assert.equal(full[1].used, 80)
  assert.equal(full[1].resetsAt, new Date(1792368000 * 1000).toISOString())
  assert.equal(subscriptionWindows(parseSubscriptionUsage({ weekly: { resets_at: 1792368000, used_percent: 80 } })).length, 1)
  assert.deepEqual(subscriptionWindows(null), [])
  assert.deepEqual(subscriptionWindows({}), [])
})

test("subscriptionUsageStream: records the event, passes the stream through unchanged", async () => {
  const store = new Map()
  const sse = 'event: response.subscription_usage\n'
    + 'data: {"subscription":{"tier":"1234567890123456","weekly":{"resets_at":1792368000,"used_percent":80},"window":{"resets_at":1792272519,"used_percent":10,"window_duration_mins":300}},"type":"response.subscription_usage"}\n\n'
    + 'data: {"type":"response.completed","response":{"id":"resp_9","status":"completed","output":[]}}\n\n'
  const res = new Response(new ReadableStream({
    start(c) {
      // Split mid-line, so the event's data line spans two chunks.
      const mid = Math.floor(sse.length / 2)
      c.enqueue(new TextEncoder().encode(sse.slice(0, mid)))
      c.enqueue(new TextEncoder().encode(sse.slice(mid)))
      c.close()
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } })
  const out = await new Response(res.body.pipeThrough(subscriptionUsageStream(store, "a@b.c"))).text()
  assert.equal(out, sse)
  const entry = store.get("a@b.c")
  assert.equal(entry.window.used, 10)
  assert.equal(entry.weekly.used, 80)
  assert.equal(entry.tier, "1234567890123456")
})

test("signedFetch: a streamed reply's subscription_usage reaches the usage hook", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    const sse = 'event: response.subscription_usage\n'
      + 'data: {"subscription":{"tier":"1234567890123456","weekly":{"resets_at":1792368000,"used_percent":80},"window":{"resets_at":1792272519,"used_percent":10,"window_duration_mins":300}},"type":"response.subscription_usage"}\n\n'
      + 'data: {"type":"response.completed","response":{"id":"resp_9","status":"completed","output":[],"usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\n\n'
    return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "muse-spark-1.3", input: "hi", stream: true }),
    })
    assert.equal(res.status, 200)
    // The client still sees the event: the plugin only observes.
    const text = await res.text()
    assert.match(text, /response\.subscription_usage/)
    assert.match(text, /response\.completed/)
    const u = await hooks.auth.usage(async () => fakeSignIn())
    assert.equal(u.plan, "Pro")
    assert.equal(u.user, "A B")
    assert.equal(u.windows.length, 2)
    assert.equal(u.windows[0].name, "5-hour window")
    assert.equal(u.windows[0].used, 10)
    assert.equal(u.windows[0].resetsAt, new Date(1792272519 * 1000).toISOString())
    assert.equal(u.windows[0].span, 18000)
    assert.equal(u.windows[1].name, "Weekly")
    assert.equal(u.windows[1].used, 80)
    assert.equal(u.windows[1].resetsAt, new Date(1792368000 * 1000).toISOString())
  } finally {
    globalThis.fetch = realFetch
  }
})

test("signedFetch: usage hook reports no windows before any request", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const u = await hooks.auth.usage(async () => fakeSignIn())
  assert.equal(u.plan, "Pro")
  assert.equal(u.user, "A B")
  assert.equal("windows" in u, false)
})

test("ensureMuseToolNamespace: appends the muse namespace, keeps caller tools, skips the rest", () => {
  const withTools = ensureMuseToolNamespace({ model: "muse-spark-1.3", tools: [{ type: "function", name: "read_file", description: "Read a file.", parameters: { type: "object", properties: {} }, strict: true }] })
  assert.equal(withTools.tools.length, 2)
  assert.equal(withTools.tools[0].name, "read_file")
  assert.equal(withTools.tools[1].type, "namespace")
  assert.equal(withTools.tools[1].name, "muse")
  assert.equal(withTools.tools[1].description, "Muse Code tool set.")
  assert.equal(withTools.tools[1].tools[0].name, "submit_reminder_decision")
  assert.deepEqual(ensureMuseToolNamespace({ model: "muse-spark-1.3" }), { model: "muse-spark-1.3" })
  assert.deepEqual(ensureMuseToolNamespace({ model: "muse-spark-1.3", tools: [] }), { model: "muse-spark-1.3", tools: [] })
  const already = { tools: [{ type: "namespace", name: "muse", tools: [] }] }
  assert.equal(ensureMuseToolNamespace(already).tools.length, 1)
  assert.equal(ensureMuseToolNamespace(null), null)
})

test("signedFetch: a tool-bearing request gains the muse namespace before Meta sees it", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  let sentBody
  globalThis.fetch = async (url, init) => {
    sentBody = init.body
    return new Response(JSON.stringify({ id: "resp_1", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3",
        input: "hi",
        tools: [{ type: "function", name: "read_file", description: "Read a file.", parameters: { type: "object", properties: {}, required: [] }, strict: true }],
      }),
    })
    assert.equal(res.status, 200)
    await res.text()
    const sent = JSON.parse(sentBody)
    assert.equal(sent.tools.length, 2)
    assert.equal(sent.tools[0].name, "read_file")
    assert.equal(sent.tools[1].type, "namespace")
    assert.equal(sent.tools[1].name, "muse")
  } finally {
    globalThis.fetch = realFetch
  }
})
