# Email Validator for Agents (MX, Disposable, Typo)

**Validates email addresses without sending mail (syntax, MX, disposable, role, typo, SPF/DMARC) for $0.79 per 1,000 emails.** You pay $0.00079 per email row with a verdict, and error rows are free. Example: checking 5,000 signup emails costs 5,000 × $0.00079 = **$3.95**, plus Apify's $0.00005 Actor-start fee.

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
| `emails` | `string[]` | – (required; 6 sample addresses are prefilled in the Console form) | Addresses; entries may be comma/semicolon/newline lists or `Name <addr>` |
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

| Event | Price | When |
| --- | --- | --- |
| `email-checked` | $0.00079 | Each email row with a verdict (`valid`, `risky`, `invalid` or `unknown`) |
| `apify-actor-start` | $0.00005 | Once per run, per GB of memory (Apify default event) |

Error rows (for example `DNS_LOOKUP_FAILED`) are **never charged**. Duplicate addresses are skipped and not charged. Malformed addresses still get an `invalid` verdict row, and that row is charged like any other check.

**Worked example:** 5,000 addresses with 200 duplicates and 30 DNS failures: (5,000 − 200 − 30) × $0.00079 = 4,770 × $0.00079 = **$3.77**, plus $0.00005.

To cap spend, set a maximum cost per run in the run options; the Actor stops cleanly at the limit. `maxEmails` caps how many addresses one run checks. Prices are from the Store pricing tab (October 2026).

## Memory / runtime

Default **128 MB**. No browser, no proxy. About 1,000 emails across a few hundred domains usually finish in under a minute. DNS lookups are cached per domain, 10 domains in parallel.

## MCP / Apify tools

Call from agents via [Apify MCP](https://mcp.apify.com) (`https://mcp.apify.com`, authenticated with your Apify token), Actor `fairquery/email-validator-mx-disposable`:

```json
{ "actor": "fairquery/email-validator-mx-disposable", "input": { "emails": ["jane@acme.com"] } }
```

Read dataset items (`type == "email"`) and the `RUN_SUMMARY` record. A standalone stdio MCP server lives in the GitHub repo under `mcp/`.

## Local stdio MCP server

This repo ships a **stdio MCP server** (TypeScript, `@modelcontextprotocol/sdk`) under [`mcp/`](./mcp) exposing `validate_emails` (runs this Actor through the Apify API) and the free offline `check_email_syntax`. `initialize` and `tools/list` work **without** a token; tool calls require `APIFY_TOKEN` (billed per the Store pricing).

```bash
cd mcp && npm install && npm run build
node scripts/smoke-test.mjs                          # initialize + tools/list, no token
APIFY_TOKEN=... node scripts/smoke-test.mjs --call   # real tool call
```

```json
{ "mcpServers": { "fairquery-email": { "command": "node", "args": ["/path/to/email-validator-mx-disposable/mcp/dist/index.js"], "env": { "APIFY_TOKEN": "<your Apify token>" } } } }
```

Docker: `docker build -t fairquery-email-mcp .` (the repo-root `Dockerfile` builds this MCP server and is what Glama uses; the Apify Actor image is built from `.actor/Dockerfile`). `glama.json` lists `fairquery` as maintainer.

## Works well after

- [Google Maps Scraper](https://apify.com/compass/crawler-google-places), [Contact Details Scraper](https://apify.com/vdrmota/contact-info-scraper) or [Website Contact & Company Enricher](https://apify.com/fairquery/website-contact-company-enricher): pass the emails they find into `emails` to drop dead domains, disposable inboxes and typos before outreach.
- Before a CRM import or a newsletter send: run your export through this Actor and drop `invalid` rows. Review the `risky` rows by hand.
- Then screen the people or companies with the [Sanctions & Watchlist Screener](https://apify.com/fairquery/sanctions-watchlist-screener) if you onboard customers or suppliers.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Run fails at once with `INPUT_EMPTY` | `emails` was empty. The sample addresses in the Console form are prefill only. They are not sent with API calls, so an empty API call fails fast and costs nothing. |
| Some rows are `DNS_LOOKUP_FAILED` errors | The DNS-over-HTTPS lookup failed or timed out (`retryable: true`). These rows are free; re-run just those addresses. |
| `MAX_EMAILS_EXCEEDED` error row | More addresses than `maxEmails`. Only the first `maxEmails` were checked; raise the cap or split the list. |
| Fewer rows than input lines | Duplicates (case-insensitive) are skipped and counted in `RUN_SUMMARY`. One entry can hold several addresses (comma, semicolon or newline separated). |
| A `valid` address bounced | `valid` means well-formed, the domain receives mail, and no risk flags. It does not confirm the mailbox exists, because the Actor does no SMTP probing. |
| Free webmail marked `risky` | `allowFreeProviders` is `false`. Set it to `true` for B2C lists. |

## FAQ

**Does it send email or connect to mail servers?**

No. It uses DNS-over-HTTPS lookups (MX, A/AAAA, TXT) and bundled lists only. There is no SMTP handshake and nothing is sent to the address.

**Does `valid` mean the mailbox exists?**

No. It means the address is well-formed and its domain can receive mail, with no disposable, role or typo flags (depending on your `allow*` settings). Mailbox-level checks need SMTP probing, which this Actor avoids for privacy and IP-reputation reasons.

**How much does a run cost?**

$0.00079 per email row with a verdict, plus a $0.00005 start fee. 1,000 emails ≈ $0.79. Error rows and skipped duplicates are free.

**How do I limit spend?**

Set a maximum cost per run in the run options (the Actor stops cleanly at the limit) and/or lower `maxEmails`.

**Can an AI agent call it?**

Yes: through [Apify MCP](https://mcp.apify.com) with Actor `fairquery/email-validator-mx-disposable`, or through the Fairquery MCP server (`npx -y @fairquery/agent-trust-mcp`). Its free `email_check_syntax` tool runs locally; `email_validate_deliverability` calls this Actor.

**Is my list stored?**

Results are written only to your run's dataset and `RUN_SUMMARY` in your Apify account; the Actor keeps no other copy. Only domain names (not full addresses) are sent to the Cloudflare DNS-over-HTTPS resolver.

## Fairquery family

Other Fairquery tools on the Apify Store. Each one returns structured rows with machine-readable error codes, and error rows are never charged:

- [Website Contact & Company Enricher](https://apify.com/fairquery/website-contact-company-enricher): domain in, public business emails, phones, socials and company details out; $3 per 1,000 domains
- [Website Tech, SEO & llms.txt Check for Agents](https://apify.com/fairquery/website-tech-seo-ai-readiness): tech stack, SEO score, AI-crawler rules and llms.txt per site; $1.50 per 1,000 sites
- [Sanctions & Watchlist Screener (OFAC, EU, UK, UN)](https://apify.com/fairquery/sanctions-watchlist-screener): fuzzy name screening against official sanctions lists; $3 per 1,000 names + $0.007 per run
- [LLM Data Guard: PII & Secret Redactor](https://apify.com/fairquery/llm-data-guard-pii-secrets): redact PII and secrets before text reaches an LLM; $1.50 per 1,000 documents + $0.20 per 1,000 findings
- [Dependency Vulnerability Check for Agents](https://apify.com/fairquery/osv-dependency-vulnerability-check): packages and lockfiles against OSV.dev; $0.50 per 1,000 packages + $1.50 per 1,000 vulnerabilities
- [EDGAR Company Facts & Filings for Agents](https://apify.com/fairquery/edgar-company-facts-filings): SEC filings and XBRL facts by ticker, CIK or name; from $1.50 per 1,000 companies
- **MCP server** [`@fairquery/agent-trust-mcp`](https://www.npmjs.com/package/@fairquery/agent-trust-mcp): one MCP server for Claude Desktop, Cursor and VS Code (`npx -y @fairquery/agent-trust-mcp`). It has 7 free tools that need no token, plus paid tools that call the PII, email, sanctions and OSV Actors with your own Apify token.

All Fairquery Actors: https://apify.com/fairquery

## Kits & templates

Optional guides from Fairquery for wiring this Actor into agents and automations (the Actor works fine without them):

- [AI Agent Data Toolkit Quick-Start](https://fairquery.gumroad.com/l/qayngz) (PDF): MCP setup for Claude Desktop and Cursor, API calls, recipes, cost estimates.
- [n8n + Zapier Workflow Template Pack](https://fairquery.gumroad.com/l/koffbf): 10 importable n8n workflows for the four Fairquery Actors, plus Zapier setup guides.
- [Agent Prompt Pack for Research & Lead Ops](https://fairquery.gumroad.com/l/djdilu): 69 prompts for company research, lead cleaning, SEO and security reviews.
- [Agent Starter Kit: 10 copy-paste MCP + n8n recipes](https://fairquery.gumroad.com/l/idvrck) ($5): 10 copy-paste MCP + n8n recipes, with ready-made Claude/Cursor configs and 3 starter workflows.

## Disclaimer

DNS-based validation cannot guarantee a mailbox exists or accepts mail. Use results to reduce bounces, not as proof of deliverability. Comply with anti-spam law (CAN-SPAM, GDPR/ePrivacy) when emailing.

## Links

- Apify Store: https://apify.com/fairquery/email-validator-mx-disposable
- GitHub: https://github.com/fairquery/email-validator-mx-disposable
- Contact: fairquery@proton.me
- License: MIT

## Development

Local development, tests and deployment notes are in [DEVELOPMENT.md](./DEVELOPMENT.md). The Apify Store README is [`.actor/README.md`](./.actor/README.md).
