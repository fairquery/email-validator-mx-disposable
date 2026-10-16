# Email Validator for Agents (MX, Disposable, Typo)

**Fairquery** Apify Actor that validates email addresses **without sending any email or probing SMTP servers**: syntax, DNS/MX, null MX, disposable-domain and role-account detection, free-provider flag, typo suggestions ("gmial.com" → "gmail.com"), mail provider, and SPF/DMARC. Each address gets a clear **`valid` / `risky` / `invalid` / `unknown`** verdict with machine-readable reason codes.

## When to use this Actor (LLM / tool selection)

Use it when an agent needs to:

- Clean a lead / CRM / signup list before outreach or import
- Decide whether an address *can* receive mail (domain exists, has MX, no null MX)
- Flag disposable/temporary inboxes, role addresses (info@, sales@) or free webmail on B2B forms
- Suggest a fix for a mistyped domain
- See which mail provider (Google Workspace, Microsoft 365, …) and DMARC policy a domain uses

Do **not** use it to confirm a specific mailbox exists — that requires SMTP probing, which this Actor deliberately avoids (privacy, IP reputation and ToS reasons). `valid` means "well-formed, deliverable domain, no risk flags", not "mailbox confirmed".

## How it works

| Check | Source |
| --- | --- |
| Syntax | RFC 5321/5322 pragmatic subset, IDN domains → punycode |
| MX / A / AAAA / TXT | DNS-over-HTTPS `https://cloudflare-dns.com/dns-query` (cached per domain, 10 domains in parallel) |
| Disposable domains | Bundled CC0 list from `disposable-email-domains` (~9.9k domains, subdomains matched) |
| Role / free provider / typo | Built-in lists + edit-distance against popular providers |

## Input

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `emails` | `string[]` | 6 sample addresses | Addresses; entries may be comma/semicolon/newline lists or `Name <addr>` |
| `checkDns` | `bool` | `true` | MX/A lookups (turn off for syntax-only) |
| `checkSpfDmarc` | `bool` | `true` | Report SPF/DMARC presence and DMARC policy |
| `allowRoleAccounts` | `bool` | `true` | If `false`, role addresses → `risky` |
| `allowDisposable` | `bool` | `false` | If `true`, disposable domains are not `risky` |
| `allowFreeProviders` | `bool` | `true` | If `false`, free webmail → `risky` (B2B lists) |
| `maxEmails` | `int` | `10000` | Safety cap per run |

```json
{ "emails": ["jane@acme.com", "info@apify.com", "bob@gmial.com"], "allowFreeProviders": false }
```

## Output

Every row has `schema_version` (`1.0.0`), `type` (`email` | `error`), `source_url` (the DoH MX query URL), `checked_at`.

```json
{
  "type": "email", "input": "someone@gmial.com", "email": "someone@gmial.com", "domain": "gmial.com",
  "verdict": "risky", "reasons": ["DISPOSABLE_DOMAIN", "POSSIBLE_TYPO", "IMPLICIT_MX_ONLY"],
  "syntax_valid": true, "is_disposable": true, "is_role_account": false, "is_free_provider": false,
  "did_you_mean": "someone@gmail.com", "domain_exists": true, "has_mx": false, "null_mx": false,
  "implicit_mx": true, "mx_records": [], "mail_provider": null, "has_spf": false, "has_dmarc": false, "dmarc_policy": null,
  "source_url": "https://cloudflare-dns.com/dns-query?name=gmial.com&type=MX"
}
```

Reason codes: `INVALID_SYNTAX`, `DOMAIN_NOT_FOUND`, `NULL_MX`, `NO_MAIL_SERVER` (→ `invalid`); `DISPOSABLE_DOMAIN`, `ROLE_ACCOUNT`, `FREE_PROVIDER`, `POSSIBLE_TYPO`, `IMPLICIT_MX_ONLY` (→ `risky` depending on the allow* flags); `DNS_NOT_CHECKED` (→ `unknown`).

### Error rows (machine-readable, never charged)

```json
{ "type": "error", "code": "DNS_LOOKUP_FAILED", "message": "DoH MX acme.com -> HTTP 503", "retryable": true, "input": "jane@acme.com", "domain": "acme.com" }
```

Codes: `INPUT_EMPTY`, `MAX_EMAILS_EXCEEDED`, `DNS_LOOKUP_FAILED`. Duplicate addresses (case-insensitive) are skipped and counted in the summary.

### Run summary

Key-value store record **`RUN_SUMMARY`**: emails checked, duplicates skipped, verdict counts, domains checked, DNS request count, echoed input.

## Pricing

Pay per event: `email-checked` per email row. Error rows are never charged. See the Store pricing tab.

## Memory / runtime

Default **256 MB**. No browser, no proxy. ~1,000 emails across a few hundred domains finish in well under a minute.

## MCP / Apify tools

Call from agents via [Apify MCP](https://mcp.apify.com) (`https://mcp.apify.com`, authenticated with your Apify token), Actor `fairquery/email-validator-mx-disposable`:

```json
{ "actor": "fairquery/email-validator-mx-disposable", "input": { "emails": ["jane@acme.com"] } }
```

Read dataset items (`type == "email"`) and the `RUN_SUMMARY` record. A standalone stdio MCP server lives in the GitHub repo under `mcp/`.

## Local stdio MCP server

This repo ships a **stdio MCP server** (TypeScript, `@modelcontextprotocol/sdk`) under [`mcp/`](./mcp) exposing one tool, `validate_emails`, which runs this Actor through the Apify API. `initialize` and `tools/list` work **without** a token; tool calls require `APIFY_TOKEN` (billed per the Store pricing).

```bash
cd mcp && npm install && npm run build
node scripts/smoke-test.mjs                          # initialize + tools/list, no token
APIFY_TOKEN=... node scripts/smoke-test.mjs --call   # real tool call
```

```json
{ "mcpServers": { "fairquery-email": { "command": "node", "args": ["/path/to/email-validator-mx-disposable/mcp/dist/index.js"], "env": { "APIFY_TOKEN": "<your Apify token>" } } } }
```

Docker: `docker build -f Dockerfile.mcp -t fairquery-email-mcp .` (build context = repo root; also the Dockerfile for Glama). `glama.json` lists `fairquery` as maintainer.

## Links

- Apify Store: https://apify.com/fairquery/email-validator-mx-disposable
- License: MIT

## Local development

```bash
npm install
npx apify run      # uses input defaults, or storage/key_value_stores/default/INPUT.json
npm test
```

## Kits & templates

Optional guides from Fairquery for wiring this Actor into agents and automations (the Actor works fine without them):

- [AI Agent Data Toolkit Quick-Start](https://fairquery.gumroad.com/l/qayngz) (PDF): MCP setup for Claude Desktop and Cursor, API calls, recipes, cost estimates.
- [n8n + Zapier Workflow Template Pack](https://fairquery.gumroad.com/l/koffbf): 10 importable n8n workflows for the four Fairquery Actors, plus Zapier setup guides.
- [Agent Prompt Pack for Research & Lead Ops](https://fairquery.gumroad.com/l/djdilu): 69 prompts for company research, lead cleaning, SEO and security reviews.
- [Fairquery Starter Kit](https://fairquery.gumroad.com/l/idvrck) ($5): a low-cost starting point with setup notes and sample inputs for the four Fairquery Actors.

## Disclaimer

DNS-based validation cannot guarantee a mailbox exists or accepts mail. Use results to reduce bounces, not as proof of deliverability. Comply with anti-spam law (CAN-SPAM, GDPR/ePrivacy) when emailing.
