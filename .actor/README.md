# Bulk Email Validator: MX, Disposable & Typo Check

## What does it do?

**Bulk Email Validator** checks email addresses **without sending any email and without SMTP probing**. For each address it checks syntax, **DNS/MX** and null MX, **disposable domains** (9,800+ bundled), **role accounts** (info@, sales@), free webmail, **typos** ("gamil.com" → "gmail.com"), the mail provider and **SPF/DMARC**. You get a `valid` / `risky` / `invalid` / `unknown` verdict, machine-readable reason codes and a **0–100 risk score**.

Use it to clean a lead, CRM or signup list before you send or before you pay for mailbox verification. On its own it does **not** confirm that a mailbox exists; for that you can add your own MillionVerifier key (optional, billed by MillionVerifier).

## How much does it cost?

Pay per event, no subscription. Prices per 1,000 emails:

| Event | Free plan | Starter (Bronze) | Scale (Silver) | Business (Gold) |
|---|---|---|---|---|
| `email-checked` (primary) | $0.79 | $0.75 | $0.69 | $0.59 |
| `mailbox-checked-byok` (optional) | $0.19 | $0.19 | $0.19 | $0.19 |

The [Apify Free plan](https://apify.com/pricing) includes **$5 of usage every month**, no credit card needed, and this Actor's event charges come out of that $5. That covers about **6,300 emails a month** ($5 ÷ $0.00079), plus a $0.00005 start fee per run. Error rows and skipped duplicates are never charged.

**Example (Free-plan prices):** 5,000 signup emails: 5,000 × $0.00079 = **$3.95**.

Paid Apify plans get the Store discount automatically: Starter = Bronze, Scale = Silver, Business = Gold. Set a maximum cost per run in the run options and the Actor stops cleanly at that limit.

## How to use it

1. Paste your addresses into **Emails** (one per line), or send them as a JSON array through the API.
2. Keep the defaults (DNS and SPF/DMARC checks on, disposable addresses flagged) or adjust the allow options.
3. Click **Start**. Each email becomes one dataset row; export it as CSV, Excel or JSON, or call the Actor from Make, Zapier, n8n or an AI agent through Apify's MCP server.

**Example input**

```json
{
  "emails": [
    "hello@apify.com",
    "someone@gamil.com"
  ],
  "allowRoleAccounts": false
}
```

**Example output** (one row from a real run on 2026-10-18, shortened to the main fields):

```json
{
  "email": "someone@gamil.com",
  "verdict": "risky",
  "reasons": [
    "POSSIBLE_TYPO"
  ],
  "did_you_mean": "someone@gmail.com",
  "has_mx": true,
  "mx_records": [
    {
      "priority": 0,
      "exchange": "mail.gamil.com"
    }
  ],
  "has_spf": true,
  "has_dmarc": false,
  "risk_score": 53,
  "risk_level": "medium",
  "risk_reasons": [
    "POSSIBLE_TYPO",
    "CATCH_ALL_UNKNOWN",
    "NO_DMARC"
  ],
  "mailbox_check": "not_requested"
}
```

## FAQ

### How do I validate emails without sending mail?

Run the list through this Actor. It reads public DNS (MX, SPF, DMARC) and bundled lists only, so no message is ever sent and the recipient's server is never contacted.

### Does it confirm that a mailbox exists?

No. A `valid` verdict means the address is well formed, the domain can receive mail and no risk flags fired. Mailbox-level checks need SMTP, which this Actor does not do; add your own MillionVerifier key if you need them.

### How many emails can I check for free?

About 6,300 per month on Apify's Free plan, which includes $5 of usage.

### Can it detect disposable and temporary email addresses?

Yes. It flags domains on the bundled disposable list (9,800+ entries) and domains whose mail servers belong to known disposable providers.

## Limits

DNS- and list-based checks reduce bounces but cannot guarantee delivery. Follow anti-spam law (CAN-SPAM, GDPR/ePrivacy) when you email anyone.

## When to use this Actor (LLM / tool selection)

Use it when an agent needs to:

- Pre-filter a lead / CRM / signup list before outreach, import or paid verification
- Decide whether an address *can* receive mail (domain exists, has MX, no null MX)
- Flag disposable inboxes (including new ones on disposable infrastructure), brand-new domains, role addresses and free webmail
- Suggest a fix for a mistyped domain
- See the mail provider, its type, and the DMARC policy

On its own it does **not** confirm that a specific mailbox exists. That needs an SMTP conversation, and this Actor does none (see the FAQ). If you need mailbox-level results, add your own MillionVerifier key (optional). `valid` means "well-formed, the domain can receive mail, no risk flags". It does not mean "mailbox confirmed".

## How it works

| Check | Source |
| --- | --- |
| Syntax | Pragmatic RFC 5321/5322 subset; IDN domains → punycode |
| MX / A / AAAA / TXT | DNS-over-HTTPS `https://cloudflare-dns.com/dns-query` (cached per domain, 10 domains in parallel) |
| Disposable domains | Bundled CC0 list from `disposable-email-domains` (9,800+ domains; subdomains matched) |
| Disposable infrastructure | 88 MX hosts that each served ≥5 listed disposable domains (resolved 2026-10-17), plus any MX host that is itself on the disposable list. Shared general-purpose infrastructure (Google, Microsoft, Cloudflare Email Routing, Mailgun, Amazon SES, registrar forwarding, hosting and parking MX) is excluded, so legitimate domains on those providers are never flagged. |
| Domain age | RDAP (RFC 9083). Servers come **only** from the [IANA RDAP bootstrap](https://data.iana.org/rdap/dns.json), with a bundled snapshot as fallback. 6 s timeout per request, at most 2 parallel requests per registry, one back-off on HTTP 429, a 120 s budget and 2,000 uncached lookups per run. Failures give `null`. Some ccTLDs (for example `.de`) have no RDAP service, so their age is `null`. |
| Role / free provider / typo | Built-in lists, plus edit distance against popular providers. The disposable list is checked first: a listed domain (for example `yopmail.com`, `mail.tm` or look-alikes such as `hotmial.com`) is always reported as disposable and never as a typo of a real provider. |

### Catch-all estimate (prior, not measured)

| MX provider | `catch_all_likelihood` | Basis |
| --- | --- | --- |
| Gmail / Google Workspace | `low` | Unknown recipients are rejected by default; catch-all routing must be switched on by an admin |
| Microsoft 365 / Outlook.com | `medium` | Published measurements show RCPT answers that vary from attempt to attempt, and many tenants accept mail and bounce it later |
| Yahoo / AOL (including custom domains on Yahoo MX) | `high` | They accept every recipient at RCPT time and bounce later |
| Proofpoint, Mimecast, Barracuda, Cisco and other security gateways | `medium` | They often accept for the whole domain; this depends on configuration |
| Disposable-inbox services | `high` | They accept any local part by design |
| Everything else (self-hosted, Zoho, iCloud, hosting, forwarding…) | `unknown` | No evidence either way |

### Risk score v2 (additive, capped 0–100)

| Signal | Points |
| --- | --- |
| `invalid` verdict (bad syntax, no domain, null MX, no mail server) | 100 (score fixed) |
| Disposable domain (`DISPOSABLE_DOMAIN`) | +70 |
| Disposable infrastructure, not listed (`DISPOSABLE_INFRASTRUCTURE`) | +60 |
| Possible typo (`POSSIBLE_TYPO`) | +45 |
| Domain under 30 days old (`NEW_DOMAIN`) / under 180 days (`YOUNG_DOMAIN`) | +35 / +10 |
| DNS not checked (`DNS_NOT_CHECKED`) | +25 |
| A record only, no MX (`IMPLICIT_MX_ONLY`) | +20 |
| Catch-all estimate `high` / `medium` / `unknown` | +15 / +8 / +5 |
| Role account (`ROLE_ACCOUNT`) | +10 |
| No SPF / no DMARC (custom domains only) | +5 / +3 |
| BYOK result `catch_all` / `disposable` / `deliverable` (live key only) | +10 / +60 / −15 |

`risk_level`: `low` < 25 ≤ `medium` < 60 ≤ `high`. Treat this score as a pre-send filter, not as proof of deliverability. The `verdict` and `reasons` fields work exactly as in v1. The new signals only change them when the BYOK check runs: an `invalid` result from MillionVerifier makes the verdict `invalid`, and `catch_all` or `disposable` make it `risky`.

## Input

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `emails` | `string[]` | – (required; sample addresses are only prefilled in the Console form) | Addresses. An entry may be a comma, semicolon or newline separated list, or `Name <addr>` |
| `checkDns` | `bool` | `true` | MX/A lookups (turn off for syntax-only checks) |
| `checkSpfDmarc` | `bool` | `true` | SPF/DMARC presence and DMARC policy |
| `allowRoleAccounts` | `bool` | `true` | If `false`, role addresses → `risky` |
| `allowDisposable` | `bool` | `false` | If `true`, disposable domains are not `risky` |
| `allowFreeProviders` | `bool` | `true` | If `false`, free webmail → `risky` (B2B lists) |
| `maxEmails` | `int` | `10000` | Safety cap per run (1–100,000) |
| `checkDomainAge` | `bool` | `true` | RDAP domain age (fails soft to `null`) |
| `cacheDomainAge` | `bool` | `true` | Keep RDAP registration dates for 30 days in a named key-value store, `fairquery-email-rdap-cache`, in your account. It holds domain names and dates only, never email addresses. Turn this off to keep nothing between runs. |
| `millionVerifierApiKey` | secret `string` | – | Optional. Your own MillionVerifier API key (BYOK). |
| `mailboxCheckMaxPerRun` | `int` | `1000` | Hard cap on MillionVerifier calls per run |

```json
{ "emails": ["jane@acme.com", "info@apify.com", "bob@gamil.com"], "allowFreeProviders": false }
```

## Output

Every row has `schema_version` (`1.1.0`; v1 rows were `1.0.0`, and v2 only adds fields), `type` (`email` | `error`), `source_url` (the DoH MX query URL) and `checked_at`.

Real row from beta run `TzHumKQWvIqfKfdRm` (2026-10-17):

```json
{
  "type": "email", "input": "someone@yahoo.com", "email": "someone@yahoo.com", "domain": "yahoo.com",
  "verdict": "valid", "reasons": ["FREE_PROVIDER"],
  "syntax_valid": true, "is_disposable": false, "is_role_account": false, "is_free_provider": true,
  "did_you_mean": null, "domain_exists": true, "has_mx": true, "null_mx": false, "implicit_mx": false,
  "mx_records": [{ "priority": 1, "exchange": "mta5.am0.yahoodns.net" }, …], "mail_provider": "Yahoo",
  "has_spf": true, "has_dmarc": true, "dmarc_policy": "reject",
  "risk_score": 15, "risk_level": "low", "risk_reasons": ["CATCH_ALL_LIKELY_ESTIMATE"], "risk_score_version": 2,
  "mail_provider_id": "yahoo", "mx_provider_class": "consumer_webmail",
  "catch_all_likelihood": "high", "catch_all_basis": "estimate_from_mx_provider",
  "domain_registered_at": "1995-01-18T05:00:00.000Z", "domain_age_days": 11595,
  "domain_age_source": "https://rdap.verisign.com/com/v1/domain/yahoo.com",
  "disposable_infrastructure": false, "disposable_infrastructure_mx": null,
  "mailbox_verified": false, "mailbox_check": "not_requested", "mailbox_status": null,
  "mailbox_provider": null, "mailbox_raw": null, "mailbox_error": null
}
```

v1 reason codes (`reasons`) are unchanged: `INVALID_SYNTAX`, `DOMAIN_NOT_FOUND`, `NULL_MX` and `NO_MAIL_SERVER` (→ `invalid`); `DISPOSABLE_DOMAIN`, `ROLE_ACCOUNT`, `FREE_PROVIDER`, `POSSIBLE_TYPO` and `IMPLICIT_MX_ONLY` (→ `risky`, depending on the allow* flags); `DNS_NOT_CHECKED` (→ `unknown`). With BYOK there are also `MAILBOX_UNDELIVERABLE`, `MAILBOX_CATCH_ALL` and `MAILBOX_DISPOSABLE`.

`mailbox_check` is one of `not_requested`, `checked`, `skipped_invalid`, `skipped_disposable`, `skipped_limit` or `error`. `mailbox_status` is one of `deliverable`, `undeliverable`, `catch_all`, `disposable` or `unknown`, mapped 1:1 from MillionVerifier's `result` field (`ok`, `invalid`, `catch_all`, `disposable`, `unknown`). `mailbox_raw` keeps `result`, `resultcode`, `subresult`, `quality` and `livemode`. It never contains your key.

### Error rows (machine-readable, never charged)

```json
{ "type": "error", "code": "DNS_LOOKUP_FAILED", "message": "DoH MX acme.com -> HTTP 503", "retryable": true, "input": "jane@acme.com", "domain": "acme.com" }
```

Codes: `INPUT_EMPTY`, `INPUT_TOO_LARGE`, `MAX_EMAILS_EXCEEDED`, `DNS_LOOKUP_FAILED`, `MAILBOX_KEY_INVALID_FORMAT` and `MAILBOX_CHECK_STOPPED` (for example a wrong key or no credits left). Duplicate addresses (case-insensitive) are skipped and counted in the summary.

### Run summary

The key-value store record **`RUN_SUMMARY`** has: emails checked, duplicates skipped, verdict counts, domains checked, DNS and RDAP request counts, RDAP cache hits, mailbox checks attempted, billable and failed, charged events, and the echoed input. The API key is never echoed; the summary shows only `mailboxCheckEnabled: true/false`.

## Pricing

| Event | Price | When |
| --- | --- | --- |
| `email-checked` | $0.00079 | Each email row with a verdict (`valid`, `risky`, `invalid` or `unknown`). Risk Score v2 is included. |
| `mailbox-checked-byok` | $0.00019 | Only with your own MillionVerifier key, and only when MillionVerifier returns a real (live-key) `ok`, `invalid`, `catch_all` or `disposable` result for the row |
| `apify-actor-start` | $0.00005 | Once per run, per GB of memory (Apify default event) |

These are **never charged**:

- error rows
- skipped duplicates
- rows skipped before the mailbox check (already `invalid`, disposable, or over `mailboxCheckMaxPerRun`)
- MillionVerifier `unknown` / `unverified` results
- vendor errors, timeouts and rate limits
- demo keys (`API_KEY_FOR_*`, `livemode: false`)

Malformed addresses still get an `invalid` verdict row, and that row is charged like any other check.

**Worked examples**
- 5,000 addresses with 200 duplicates and 30 DNS failures: 4,770 × $0.00079 = **$3.77**, plus $0.00005.
- 5,000 addresses with BYOK, where 3,600 survivors get a real MillionVerifier result: 5,000 × $0.00079 + 3,600 × $0.00019 = $3.95 + $0.68 = **$4.63**, plus your MillionVerifier credits.

To cap spend, set a maximum cost per run in the run options; the Actor stops cleanly at the limit and does not start mailbox checks it could not charge for. `maxEmails` and `mailboxCheckMaxPerRun` cap each run.

## Optional mailbox check: bring your own MillionVerifier key

- **How:** put your key from https://app.millionverifier.com/api into `millionVerifierApiKey`. Only rows that are not already `invalid` or disposable are sent, which saves your credits. A free pre-flight call to MillionVerifier's credits endpoint stops the phase at once if the key is wrong or the account has no credits.
- **API used:** MillionVerifier Single API v3, `GET https://api.millionverifier.com/api/v3/?api=…&email=…&timeout=10` ([API docs](https://developer.millionverifier.com/), OpenAPI 3.1.0, checked 2026-10-17). We use a 15 s request timeout, at most 10 parallel requests and 2 per recipient domain, back-off and retry on HTTP 429/503, and the hard `mailboxCheckMaxPerRun` cap. Timeouts are **not** retried, because the vendor may already have used a credit.
- **Vendor limits and billing (from MillionVerifier's help center, checked 2026-10-17):**
  - The Single API is limited to **160 requests per second per account**.
  - MillionVerifier does **not** deduct credits for risky (`unknown`, `catch_all`) results.
  - It **does** deduct credits again if the same address is verified again.
  - Credits used appear in your account in one-minute batches.
  - Source: [Real-Time API](https://help.millionverifier.com/email-verification-api/real-time-api).
  - Within one run, each address is checked once (duplicates are removed first). Nothing is cached across runs.
- **Terms (checked 2026-10-17):**
  - MillionVerifier explicitly allows integrating its API into other products and reselling it ([Resellers](https://help.millionverifier.com/millionverifier/resellers); the API docs say "You may also use our API to resell our services").
  - Its [Terms of Service](https://www.millionverifier.com/policies/terms-of-service/) (published 20 July 2026) treat use through your API key or an integration as your use. You must protect your key and use the data lawfully.
  - The service is for business use only.
  - With BYOK you use your own account, so nothing is resold.
- **Your key:**
  - It is a secret input, encrypted by Apify.
  - The Actor never logs it.
  - It is never written to the dataset, the key-value store or `RUN_SUMMARY`.
  - Error messages contain only our own codes, never the key.
- **Privacy:** with BYOK, the email addresses you submit are sent to MillionVerifier, which acts as **your** processor under its [DPA](https://www.millionverifier.com/policies/data-processing-agreement/). Without a key, no full address leaves the Actor.
- **Demo keys:** MillionVerifier's documented test keys (for example `API_KEY_FOR_OK`) return fake results with `livemode: false`. They never change the verdict, never set `mailbox_verified`, and are never charged.
- "Deliverable" does not mean inbox placement.

## Memory / runtime

Default **128 MB**. No browser and no proxy. About 1,000 emails across a few hundred domains usually finish in about a minute. The first run on new domains is slower because of RDAP lookups; later runs reuse the 30-day cache.

## MCP / Apify tools

Call from agents via [Apify MCP](https://mcp.apify.com) (`https://mcp.apify.com`, authenticated with your Apify token), Actor `fairquery/email-validator-mx-disposable`:

```json
{ "actor": "fairquery/email-validator-mx-disposable", "input": { "emails": ["jane@acme.com"] } }
```

Read dataset items (`type == "email"`) and the `RUN_SUMMARY` record.

## Works well after

- [Google Maps Scraper](https://apify.com/compass/crawler-google-places), [Contact Details Scraper](https://apify.com/vdrmota/contact-info-scraper) or [Website Contact & Company Enricher](https://apify.com/fairquery/website-contact-company-enricher): pass the emails they find into `emails` to drop dead domains, disposable inboxes and typos before outreach.
- Before a CRM import or a newsletter send: run your export through this Actor and drop `invalid` rows. Review the `risky` rows by hand.
- Then screen the people or companies with the [Sanctions & Watchlist Screener](https://apify.com/fairquery/sanctions-watchlist-screener) if you onboard customers or suppliers.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Run fails at once with `INPUT_EMPTY` | `emails` was empty. The sample addresses in the Console form are prefill only. They are not sent with API calls, so an empty API call fails fast and costs nothing. |
| Some rows are `DNS_LOOKUP_FAILED` errors | The DNS-over-HTTPS lookup failed or timed out (`retryable: true`). These rows are free; re-run just those addresses. |
| `MAX_EMAILS_EXCEEDED` error row | You sent more addresses than `maxEmails`. Only the first `maxEmails` were checked; raise the cap or split the list. |
| `domain_age_days` is `null` | The TLD has no RDAP service in the IANA bootstrap (for example `.de`), or the registry timed out or rate-limited the lookup. The score just leaves the age out. |
| `MAILBOX_CHECK_STOPPED` with `MV_INVALID_API_KEY` / `MV_INSUFFICIENT_CREDITS` | Check your key or your MillionVerifier credits. Rows without a mailbox result were not charged the BYOK event. |
| A `valid` address bounced | `valid` means the address is well-formed, the domain receives mail, and there are no risk flags. Without BYOK it does not confirm that the mailbox exists. |
| Free webmail marked `risky` | `allowFreeProviders` is `false`. Set it to `true` for B2C lists. |

## FAQ

**Why no SMTP probing?**

Three reasons.

1. **It is not possible from Apify.** We tested it on 2026-10-17 with a private, throwaway test Actor (run `OYO4B7Rqdl3lGAtJv`, 128 MB, 33 s):
   - TCP port 25 to Gmail, Outlook and Yahoo MX hosts timed out. Ports 587 and 465 timed out too.
   - Port 443 connected in 4 ms.
   - Apify Proxy refused `CONNECT host:25` on both the datacenter group (`590 UPSTREAM502`) and the residential group (`590 UPSTREAM453`).
   - The egress IP was in AWS address space, and AWS blocks outbound port 25 by default.
   - The probe only opened TCP connections and sent `QUIT`. It never sent `RCPT TO`, and it has since been deleted.
2. **The workarounds have real costs.** You would need your own relay host or a rotating "SMTP proxy" pool, and that creates IP-reputation and blocklist risk. Spamhaus describes unsolicited probing as potentially hostile.
3. **Even with port 25 open, many answers carry little information.** Catch-all domains accept every recipient, Yahoo accepts every recipient at RCPT time, Microsoft's answers vary, and greylisting delays answers.

Mailbox-level verifiers on Apify generally run the SMTP step outside Apify. If you need that step, use the optional MillionVerifier BYOK check: the SMTP work happens on MillionVerifier's infrastructure, under your account.

**Does it send email or connect to mail servers?**

No. It uses DNS-over-HTTPS (MX, A/AAAA, TXT), RDAP (registry web APIs) and bundled lists. There is no SMTP handshake, and nothing is sent to the address. With BYOK, MillionVerifier does its own checks on its infrastructure.

**Does `valid` or a low `risk_score` mean the mailbox exists?**

No. `mailbox_verified` is `false` unless the BYOK check returned a live `ok` or `invalid` result.

**Is `catch_all_likelihood` measured?**

No. It is an estimate from the mail provider type (see the table above). Only the BYOK result `catch_all` comes from an actual check, done by MillionVerifier.

**How much does a run cost?**

$0.00079 per email row with a verdict, plus a $0.00005 start fee. 1,000 emails ≈ $0.79. BYOK adds $0.00019 per real MillionVerifier result. Error rows and skipped duplicates are free.

**How do I limit spend?**

Set a maximum cost per run in the run options, and/or lower `maxEmails` and `mailboxCheckMaxPerRun`.

**Can an AI agent call it?**

Yes. Use [Apify MCP](https://mcp.apify.com) with Actor `fairquery/email-validator-mx-disposable`.

**Is my list stored?**

Results are written only to your run's dataset and `RUN_SUMMARY` in your Apify account. Two things are sent elsewhere:

- Domain names (not full addresses) go to the Cloudflare DNS-over-HTTPS resolver and to the registry RDAP servers.
- If `cacheDomainAge` is on, registration dates for domains (no email addresses) are kept for 30 days in the `fairquery-email-rdap-cache` store in your account.

Full addresses leave the Actor only when you add a MillionVerifier key.

## Fairquery family

Other Fairquery tools on the Apify Store. Each one returns structured rows with machine-readable error codes, and error rows are never charged:

- [Website Contact & Company Enricher](https://apify.com/fairquery/website-contact-company-enricher): domain in, public business emails, phones, socials and company details out; $3 per 1,000 domains
- [Website Tech, SEO & llms.txt Check for Agents](https://apify.com/fairquery/website-tech-seo-ai-readiness): tech stack, SEO score, AI-crawler rules and llms.txt per site; $1.50 per 1,000 sites
- [Sanctions & Watchlist Screener (OFAC, EU, UK, UN)](https://apify.com/fairquery/sanctions-watchlist-screener): fuzzy name screening against official sanctions lists; $3 per 1,000 names + $0.007 per run
- [LLM Data Guard: PII & Secret Redactor](https://apify.com/fairquery/llm-data-guard-pii-secrets): redact PII and secrets before text reaches an LLM; $1.50 per 1,000 documents + $0.20 per 1,000 findings
- [Dependency Vulnerability Check for Agents](https://apify.com/fairquery/osv-dependency-vulnerability-check): packages and lockfiles against OSV.dev; $0.50 per 1,000 packages + $1.50 per 1,000 vulnerabilities
- [EDGAR Company Facts & Filings for Agents](https://apify.com/fairquery/edgar-company-facts-filings): SEC filings and XBRL facts by ticker, CIK or name; $1.50 per 1,000 companies on the free plan; lower on paid Apify plans
- [Company Jobs Feed: Greenhouse, Lever & Ashby](https://apify.com/fairquery/company-jobs-feed): live jobs from employers' own ATS boards with age and repost signals; $0.99 per 1,000 jobs + $0.0005 per board

All Fairquery Actors: https://apify.com/fairquery

## Disclaimer

DNS- and registry-based validation cannot guarantee that a mailbox exists or accepts mail. Use the results to reduce bounces, not as proof of deliverability. Comply with anti-spam law (CAN-SPAM, GDPR/ePrivacy) when you send email. MillionVerifier is a third-party service under its own terms; Fairquery is not affiliated with it.

## Links

- Apify Store: https://apify.com/fairquery/email-validator-mx-disposable
- Contact: info@getfairquery.com
- License: MIT
