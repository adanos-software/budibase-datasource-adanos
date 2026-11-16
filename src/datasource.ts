import type { IntegrationBase } from "@budibase/types"
import { AdanosClient, ApiError } from "finance-sentiment"

type Source = "reddit_stocks" | "x_stocks" | "news_stocks" | "polymarket_stocks" | "reddit_crypto"

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected datasource configuration or query fields")
  }
  return Object.fromEntries(Object.entries(value))
}

function text(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new Error("Expected a text field")
  return value.trim() || undefined
}

function date(value: unknown): string | undefined {
  const input = text(value)
  if (input === undefined) return undefined
  const parsed = new Date(`${input}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input) || !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== input) {
    throw new Error("Dates must be real inclusive UTC dates in YYYY-MM-DD format")
  }
  return input
}

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === "") return undefined
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error("Invalid pagination: limit must be 1-100 and offset a nonnegative integer")
  }
  return number
}

function source(value: unknown): Source {
  if (value !== "reddit_stocks" && value !== "x_stocks" && value !== "news_stocks" &&
      value !== "polymarket_stocks" && value !== "reddit_crypto") {
    throw new Error("Choose one of the five supported Adanos sources")
  }
  return value
}

function queryFields(value: unknown) {
  const fields = object(value)
  // Switching native query functions retains the other function's input fields.
  const allowed = ["extra", "symbol", "from", "to", "limit", "offset", "stockType", "newsSource"]
  // QueryViewer initializes this empty editor placeholder for fields-type queries.
  if (Object.keys(fields).some(key => !allowed.includes(key) && !(key === "fields" && fields[key] === ""))) {
    throw new Error("Unsupported query fields")
  }
  const from = date(fields.from)
  const to = date(fields.to)
  if (from && to && from > to) throw new Error("From must not be after To")
  const extra = object(fields.extra)
  if (Object.keys(extra).some(key => key !== "source")) throw new Error("Unsupported source fields")
  return { fields, source: source(extra.source), from, to }
}

async function safeRequest<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch (error) {
    // Remote error bodies can echo credentials; never pass them to the builder.
    if (error instanceof ApiError) throw new Error(`Adanos request failed (HTTP ${error.status})`)
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("Adanos request timed out")
    }
    throw new Error("Adanos request failed; check connectivity and datasource credentials")
  }
}

export default class AdanosDatasource implements IntegrationBase {
  #client: AdanosClient

  constructor(config: unknown) {
    const apiKey = text(object(config).apiKey)
    if (!apiKey) throw new Error("An Adanos API key is required in datasource configuration")
    this.#client = new AdanosClient({ apiKey, baseUrl: "https://api.adanos.com", timeout: 30_000 })
  }

  async read(query: unknown) {
    const { fields, source, from, to } = queryFields(query)
    const symbol = text(fields.symbol)
    if (!symbol) throw new Error("A ticker or token symbol is required")
    const result = await safeRequest(async () => {
      switch (source) {
        case "reddit_stocks": return this.#client.reddit.stock(symbol, { from, to })
        case "x_stocks": return this.#client.x.stock(symbol, { from, to })
        case "news_stocks": return this.#client.news.stock(symbol, { from, to })
        case "polymarket_stocks": return this.#client.polymarket.stock(symbol, { from, to })
        case "reddit_crypto": return this.#client.crypto.token(symbol, { from, to })
      }
    })
    return [result]
  }

  async trending(query: unknown) {
    const { fields, source, from, to } = queryFields(query)
    const limit = integer(fields.limit, 1, 100)
    const offset = integer(fields.offset, 0)
    const type = text(fields.stockType)
    const newsSource = text(fields.newsSource)
    if (type && type !== "stock" && type !== "etf" && type !== "all") {
      throw new Error("Stock type must be stock, etf, or all")
    }
    if (type && source === "reddit_crypto") throw new Error("Stock type is not supported for crypto")
    if (newsSource && source !== "news_stocks") throw new Error("Publisher filtering is only supported for News")
    return safeRequest(async () => {
      switch (source) {
        case "reddit_stocks": return this.#client.reddit.trending({ from, to, limit, offset, type })
        case "x_stocks": return this.#client.x.trending({ from, to, limit, offset, type })
        case "news_stocks": return this.#client.news.trending({ from, to, limit, offset, type, source: newsSource })
        case "polymarket_stocks": return this.#client.polymarket.trending({ from, to, limit, offset, type })
        case "reddit_crypto": return this.#client.crypto.trending({ from, to, limit, offset })
      }
    })
  }
}
