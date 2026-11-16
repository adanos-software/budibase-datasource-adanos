const { test, before, after } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const crypto = require("node:crypto")
const { spawnSync } = require("node:child_process")
const tar = require("tar")
const { MockAgent, setGlobalDispatcher, getGlobalDispatcher } = require("undici")

const key = "synthetic-test-key-not-a-credential"
const agent = new MockAgent()
agent.disableNetConnect()
const pool = agent.get("https://api.adanos.com")
const originalDispatcher = getGlobalDispatcher()
let plugin, unpacked
const routes = [
  ["reddit_stocks", "/reddit/stocks/v1", "stock/AAPL"],
  ["x_stocks", "/x/stocks/v1", "stock/AAPL"],
  ["news_stocks", "/news/stocks/v1", "stock/AAPL"],
  ["polymarket_stocks", "/polymarket/stocks/v1", "stock/AAPL"],
  ["reddit_crypto", "/reddit/crypto/v1", "token/BTC"],
]

before(async () => {
  unpacked = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "adanos-archive-")))
  await tar.x({ file: "dist/budibase-datasource-adanos-0.1.0.tar.gz", cwd: unpacked })
  plugin = require(path.join(unpacked, "plugin.min.js"))
  setGlobalDispatcher(agent)
})

after(async () => {
  setGlobalDispatcher(originalDispatcher)
  await agent.close()
  fs.rmSync(unpacked, { recursive: true, force: true })
})

function datasource() {
  return new plugin.integration({ apiKey: key })
}

function reply(url, result, status = 200) {
  pool.intercept({ path: url, method: "GET", headers: { "x-api-key": key } })
    .reply(status, result, { headers: { "content-type": "application/json" } })
}

test("archive has standalone CommonJS code, matching metadata, hashes, and no runtime imports", async () => {
  const entries = []
  const archive = "dist/budibase-datasource-adanos-0.1.0.tar.gz"
  await tar.t({ file: archive, onReadEntry: entry => {
    assert.equal(entry.type, "File")
    entries.push(entry.path)
  } })
  assert.deepEqual(entries.sort(), ["LICENSE", "README.md", "package.json", "plugin.min.js", "schema.json"])
  const schema = JSON.parse(fs.readFileSync(path.join(unpacked, "schema.json")))
  const pkg = JSON.parse(fs.readFileSync(path.join(unpacked, "package.json")))
  assert.equal(schema.version, pkg.version)
  assert.equal(schema.hash, crypto.createHash("sha1").update(fs.readFileSync(path.join(unpacked, "plugin.min.js"))).digest("hex"))
  assert.equal(fs.readFileSync(archive + ".sha256", "utf8").split(" ")[0],
    crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex"))
  const child = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${unpacked}`,
    "-e", `const p=require(${JSON.stringify(unpacked)}); if(typeof p.integration!=='function')process.exit(1)`],
    { cwd: unpacked, env: {}, encoding: "utf8" })
  assert.equal(child.status, 0, child.stderr)
})

test("schema exposes only native read operations and a password datasource credential", () => {
  assert.equal(plugin.schema.type, "datasource")
  assert.deepEqual(plugin.schema.schema.datasource, {
    apiKey: { type: "password", required: true, display: "Adanos API key" },
  })
  assert.deepEqual(Object.keys(plugin.schema.schema.query).sort(), ["read", "trending"])
  for (const method of ["read", "trending"]) {
    assert.equal(typeof datasource()[method], "function")
    assert.deepEqual(plugin.schema.schema.extra.source.data[method], routes.map(([source]) => source))
    assert(!("apiKey" in plugin.schema.schema.query[method].fields))
  }
  assert.equal(JSON.stringify(datasource()), "{}")
})

for (const [source, prefix, detail] of routes) {
  test(`${source}: trending preserves nullable and nested data, dates, and explicit pagination`, async () => {
    const rows = [{ ticker: "AAPL", symbol: "BTC", buzz_score: null, sentiment_score: null,
      trend_history: [0, 2.5], top_mentions: [{ title: "synthetic evidence" }] }]
    reply(`${prefix}/trending?from=2026-11-01&to=2026-11-02&limit=2&offset=3`, rows)
    assert.deepEqual(await datasource().trending({ extra: { source }, from: "2026-11-01", to: "2026-11-02", limit: 2, offset: 3 }), rows)
    agent.assertNoPendingInterceptors()
  })

  test(`${source}: detail returns a single Budibase row without changing API identity`, async () => {
    const row = { ticker: "AAPL", symbol: "BTC", buzz_score: null, total_upvotes: -2,
      top_mentions: [{ text: "synthetic evidence" }], daily_trend: [] }
    reply(`${prefix}/${detail}?from=2026-11-01&to=2026-11-02`, row)
    assert.deepEqual(await datasource().read({ extra: { source }, symbol: source === "reddit_crypto" ? "BTC" : "AAPL",
      from: "2026-11-01", to: "2026-11-02" }), [row])
    agent.assertNoPendingInterceptors()
  })
}

test("optional dates and blank builder fields are omitted; API defaults remain authoritative", async () => {
  reply("/reddit/stocks/v1/trending", [])
  assert.deepEqual(await datasource().trending({ extra: { source: "reddit_stocks" }, from: "", to: "", limit: "", offset: "", stockType: "", newsSource: "" }), [])
})

test("accepts the native builder's empty fields editor placeholder", async () => {
  reply("/reddit/stocks/v1/trending", [])
  assert.deepEqual(await datasource().trending({ fields: "", extra: { source: "reddit_stocks" } }), [])
  await assert.rejects(datasource().trending({ fields: "unexpected", extra: { source: "reddit_stocks" } }), /Unsupported/)
})

test("News supports publisher filtering and stock type with builder numeric strings", async () => {
  reply("/news/stocks/v1/trending?from=2026-11-01&limit=10&offset=0&type=etf&source=reuters", [])
  assert.deepEqual(await datasource().trending({ extra: { source: "news_stocks" }, from: "2026-11-01",
    limit: "10", offset: "0", stockType: "etf", newsSource: "reuters" }), [])
})

for (const [source, prefix] of routes.filter(([source]) => source !== "reddit_crypto")) {
  test(`${source}: stock type filter is forwarded`, async () => {
    reply(`${prefix}/trending?type=stock`, [])
    assert.deepEqual(await datasource().trending({ extra: { source }, stockType: "stock" }), [])
  })
}

test("exchange suffixes are preserved and path characters are encoded by the SDK", async () => {
  reply("/news/stocks/v1/stock/ABX.DE", { ticker: "ABX.DE" })
  assert.deepEqual(await datasource().read({ extra: { source: "news_stocks" }, symbol: "ABX.DE" }), [{ ticker: "ABX.DE" }])
  reply("/reddit/stocks/v1/stock/A%2FB", { found: false })
  assert.deepEqual(await datasource().read({ extra: { source: "reddit_stocks" }, symbol: "A/B" }), [{ found: false }])
})

const invalidTrending = [
  [null, /Expected/],
  [[], /Expected/],
  [{ source: "crypto" }, /five supported/],
  [{ source: "reddit_stocks", from: "2026-02-30" }, /real inclusive UTC/],
  [{ source: "reddit_stocks", from: "2026-1-02" }, /real inclusive UTC/],
  [{ source: "reddit_stocks", to: 42 }, /text field/],
  [{ source: "reddit_stocks", from: "2026-11-03", to: "2026-11-02" }, /From/],
  [{ source: "reddit_stocks", limit: 0 }, /pagination/],
  [{ source: "reddit_stocks", limit: 101 }, /pagination/],
  [{ source: "reddit_stocks", limit: 1.5 }, /pagination/],
  [{ source: "reddit_stocks", offset: -1 }, /pagination/],
  [{ source: "reddit_stocks", offset: Number.MAX_SAFE_INTEGER + 1 }, /pagination/],
  [{ source: "reddit_stocks", stockType: "bond" }, /Stock type/],
  [{ source: "reddit_crypto", stockType: "all" }, /not supported for crypto/],
  [{ source: "x_stocks", newsSource: "reuters" }, /only supported for News/],
  [{ source: "reddit_stocks", days: 7 }, /Unsupported query fields/],
  [{ source: "reddit_stocks", baseUrl: "https://example.com" }, /Unsupported query fields/],
  [{ source: "reddit_stocks", apiKey: key }, /Unsupported query fields/],
]
for (const [input, error] of invalidTrending) {
  test(`rejects invalid trending fields: ${JSON.stringify(input)}`, async t => {
    const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("invalid input made an HTTP request"))
    const query = input && !Array.isArray(input)
      ? { ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== "source")), extra: { source: input.source } }
      : input
    await assert.rejects(datasource().trending(query), error)
    assert.equal(fetch.mock.callCount(), 0)
  })
}

for (const input of [undefined, null, {}, { apiKey: " " }, { apiKey: 3 }]) {
  test(`requires datasource credentials: ${JSON.stringify(input)}`, () => {
    assert.throws(() => new plugin.integration(input), /configuration|API key|text field/)
  })
}

for (const query of [{ source: "reddit_stocks" }, { source: "reddit_stocks", symbol: " " },
  { source: "reddit_stocks", symbol: "AAPL", limit: 1 }]) {
  test(`detail rejects invalid fields: ${JSON.stringify(query)}`, async () => {
    const { source, ...fields } = query
    await assert.rejects(datasource().read({ ...fields, extra: { source } }), /symbol is required|Unsupported query fields/)
  })
}

for (const status of [401, 403, 404, 422, 429, 500, 503]) {
  test(`HTTP ${status} remains an error without exposing echoed credentials`, async () => {
    reply("/reddit/stocks/v1/trending", { detail: `remote body echo ${key}` }, status)
    await assert.rejects(datasource().trending({ extra: { source: "reddit_stocks" } }), error => {
      assert.equal(error.message, `Adanos request failed (HTTP ${status})`)
      assert(!JSON.stringify(error).includes(key))
      assert(!error.stack.includes(key))
      assert.equal(error.cause, undefined)
      return true
    })
  })
}

test("transport failures do not expose remote diagnostics", async () => {
  pool.intercept({ path: "/reddit/stocks/v1/trending", method: "GET" }).replyWithError(new Error(key))
  await assert.rejects(datasource().trending({ extra: { source: "reddit_stocks" } }),
    { message: "Adanos request failed; check connectivity and datasource credentials" })
})

test("SDK timeout is bounded to 30 seconds and reported without credentials", async t => {
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert(options.signal instanceof AbortSignal)
    await assert.rejects(new Promise((_, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
      // AbortSignal.timeout uses an unreferenced timer; keep this transport alive.
      const keepAlive = setTimeout(() => {}, 31_000)
      options.signal.addEventListener("abort", () => clearTimeout(keepAlive), { once: true })
    }), { name: "TimeoutError" })
    throw new DOMException(key, "TimeoutError")
  })
  await assert.rejects(datasource().trending({ extra: { source: "reddit_stocks" } }), { message: "Adanos request timed out" })
})

test("only the native nested extra.source selection is accepted", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("invalid source made an HTTP request"))
  for (const query of [{ source: "reddit_stocks" }, { extra: {} }, { extra: { source: "reddit_stocks", apiKey: key } }]) {
    await assert.rejects(datasource().trending(query), /Unsupported|supported Adanos sources/)
  }
  assert.equal(fetch.mock.callCount(), 0)
})
