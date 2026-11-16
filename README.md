# Adanos Datasource for Budibase

Optional, read-only market sentiment datasource for self-hosted Budibase.

## Status

Source is under review. No public release archive or Budibase catalog listing
has been published. The local build produces an archive for manual installation.

## Build and install

Use Node.js 22 or later and a self-hosted Budibase installation. Custom
datasource plugins are not supported on Budibase Cloud. This package follows the
[official datasource contract](https://docs.budibase.com/docs/custom-datasource)
and bundles the official `finance-sentiment` TypeScript SDK. It does not modify
Budibase or require Singer.

```sh
npm ci --ignore-scripts
npm run check
```

The build writes `dist/budibase-datasource-adanos-0.1.0.tar.gz` and its SHA-256
checksum. In your self-hosted Budibase Settings, open Plugins and import that
archive with File upload. Create an **Adanos Market Sentiment** datasource and
enter your own API key in its password field. The server calls only
`https://api.adanos.com`; no alternate host can be supplied.

Obtain a key at [Adanos](https://adanos.com/register). Restrict datasource and
query access to authorized workspace users. Do not put keys in query bindings,
screen fields, public exports, or source control. Query inputs have no credential
field. Errors retain the HTTP status but omit remote diagnostics that could
contain credentials.

## Queries

Choose a Source for each query:

| Source | Dataset |
| --- | --- |
| `reddit_stocks` | Reddit Stocks |
| `x_stocks` | X/Twitter Stocks |
| `news_stocks` | Financial News Stocks |
| `polymarket_stocks` | Polymarket Stocks |
| `reddit_crypto` | Reddit Crypto |

The Source dropdown is native Budibase extra-query configuration. Budibase saves
it as `query.fields.extra.source`; the adapter reads that nested value, not a
top-level `source` argument.

**Asset detail** requires `symbol`, for example `AAPL` or `BTC`. It returns an
array with one API response object so it can serve a Budibase Data provider.
**Trending assets** returns the API's array unchanged. It accepts `limit` (1-100)
and nonnegative `offset`; defaults come from the API when omitted. Fetch the next
page explicitly by increasing offset. There is no automatic all-pages fetch.

Both queries accept optional `from` and `to` as inclusive UTC dates in
`YYYY-MM-DD` format. For reproducible windows, provide both. Without dates,
trending uses the current UTC day and asset detail uses the API's default
seven-day window. `days` is not accepted. Stock type (`stock`, `etf`, or `all`)
applies only to stock trending. News publisher filtering (for example `reuters`)
applies only to News trending. Other combinations fail before a request.

Use source-specific ticker keys returned by Adanos Search when configuring a
detail query. Exchange suffixes are preserved. Polymarket keys identify companies
or ETFs, not arbitrary share classes: a Reddit ticker is not necessarily a valid
Polymarket key. The plugin does not guess aliases or translate issuer identity.

Nullable metrics, nested evidence, and negative Reddit upvotes remain unchanged.
Buzz describes attention, not price movement. Historical responses are current
snapshots, not point-in-time backtest data. The plugin does not add `observed_at`
or persist records. A current UTC day is incomplete.

## Limits and errors

Requests use the customer's source, history, quota, and retention entitlements.
Consult [API documentation](https://api.adanos.com/docs) and
[pricing](https://adanos.com/pricing) for the current plan restrictions. A plugin
does not bypass those limits or make paid sources free. API responses can be
cached, so repeated calls do not guarantee newly ingested data.

Each query makes one request with a 30-second timeout and no automatic retry.
HTTP 401 indicates a credential failure; 403 can indicate history or source
restrictions; 404 can indicate an unknown asset; 422 indicates invalid API inputs;
429 indicates quota or burst limits. Wait before retrying a rate-limited query.
There is no scheduled refresh or background extraction.

## Verification

`npm run check` typechecks the adapter, builds the CommonJS bundle, and tests the
extracted archive. Tests exercise all five sources through the real bundled SDK
with synthetic HTTP responses and disabled external network access. They cover
pagination, date validation, filters, errors, credential redaction, and timeout.
No live API key is needed. Test scratch files use the operating system temporary
directory; set `TMPDIR` to your disposable test directory to control that location.

Additional local checks against Budibase commit
`ea47fc690d6d84751cc5d12585ad828b040ab3f1` exercise the native builder getter and
setter, field enrichment, official schema validator, and platform loader with
its restricted IPC child. The HTTP transport and timeout configuration are
synthetic fixtures. These checks do not cover the full UI, database, or hosted
plugin import workflow.

The build includes no external runtime dependencies. The archive includes source
package metadata, schema, bundle, documentation, and license. Do not upload an
NPM source tarball in place of this Budibase archive.

License: MIT.
