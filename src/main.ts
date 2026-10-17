import { Actor, log } from 'apify';

import {
    isDisposable,
    isFreeProvider,
    isRole,
    mailProviderOf,
    parseEmail,
    suggestDomain,
    verdictOf,
} from './checks.js';
import { DohClient, dohUrl, type DomainDns, lookupDomain } from './dns.js';
import { Emitter } from './emitter.js';
import { isPlausibleMvKey, type MailboxOutcome, MillionVerifierClient } from './mailbox.js';
import { ageDays, RdapCache, RdapClient, type RdapResult, registrableDomain } from './rdap.js';
import { classifyProvider, disposableInfrastructureMx, riskScore } from './risk.js';
import {
    type ActorInput,
    CHARGE_EVENTS,
    DNS_CONCURRENCY,
    type EmailRow,
    type ErrorRow,
    type NormalisedInput,
    type OutputRow,
    RISK_SCORE_VERSION,
    type RunSummary,
    SCHEMA_VERSION,
    type Verdict,
} from './types.js';

const RDAP_CACHE_STORE = 'fairquery-email-rdap-cache';
const RDAP_CONCURRENCY = 6;
const RDAP_MAX_LOOKUPS = 2_000; // uncached lookups per run
const RDAP_BUDGET_MS = 120_000; // whole RDAP phase
const MAX_RAW_ENTRIES = 200_000;
const MAX_ENTRY_CHARS = 100_000;
const CHUNK = 100;

await Actor.init();

const aborting = { value: false };
const emitter = new Emitter();
Actor.on('aborting', async () => {
    aborting.value = true;
    await emitter.flush();
    log.warning('Aborting — stopping after current batch.');
});

const startedAt = new Date().toISOString();
const rawInput = ((await Actor.getInput<ActorInput>()) ?? {}) as ActorInput;
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const int = (v: unknown, d: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : d;

// The secret key is read once, validated, and handed to the client. It is never put into `input`, logs or output.
const mvKeyRaw = typeof rawInput.millionVerifierApiKey === 'string' ? rawInput.millionVerifierApiKey.trim() : '';
const input: NormalisedInput = {
    emails: Array.isArray(rawInput.emails)
        ? rawInput.emails.slice(0, MAX_RAW_ENTRIES).map((e) => String(e).slice(0, MAX_ENTRY_CHARS))
        : [],
    checkDns: bool(rawInput.checkDns, true),
    checkSpfDmarc: bool(rawInput.checkSpfDmarc, true),
    allowRoleAccounts: bool(rawInput.allowRoleAccounts, true),
    allowDisposable: bool(rawInput.allowDisposable, false),
    allowFreeProviders: bool(rawInput.allowFreeProviders, true),
    maxEmails: int(rawInput.maxEmails, 10_000, 1, 100_000),
    checkDomainAge: bool(rawInput.checkDomainAge, true),
    cacheDomainAge: bool(rawInput.cacheDomainAge, true),
    mailboxCheckEnabled: mvKeyRaw.length > 0,
    mailboxCheckMaxPerRun: int(rawInput.mailboxCheckMaxPerRun, 1_000, 1, 100_000),
};

const verdictCounts: Record<Verdict, number> = { valid: 0, risky: 0, invalid: 0, unknown: 0 };
const counters = { emails_checked: 0, duplicates_skipped: 0, domains_checked: 0, errors: 0 };
const rdapStats = { rdap_lookups: 0, rdap_cache_hits: 0, rdap_failures: 0 };
const client = new DohClient();
let mv: MillionVerifierClient | null = null;
let mailboxQueued = 0;

if (Array.isArray(rawInput.emails) && rawInput.emails.length > MAX_RAW_ENTRIES) {
    await pushError({
        code: 'INPUT_TOO_LARGE',
        message: `${rawInput.emails.length} input entries; only the first ${MAX_RAW_ENTRIES} were read.`,
        retryable: false,
        context: { found: rawInput.emails.length, max: MAX_RAW_ENTRIES },
    });
}

// Split comma/semicolon/newline separated entries so pasted lists work.
let emails = input.emails
    .flatMap((e) => e.split(/[\n;,]+/))
    .map((e) => e.trim())
    .filter(Boolean);
const seen = new Set<string>();
emails = emails.filter((e) => {
    const k = e.toLowerCase();
    if (seen.has(k)) {
        counters.duplicates_skipped += 1;
        return false;
    }
    seen.add(k);
    return true;
});
if (emails.length > input.maxEmails) {
    await pushError({
        code: 'MAX_EMAILS_EXCEEDED',
        message: `${emails.length} emails supplied; only the first ${input.maxEmails} were checked (raise maxEmails).`,
        retryable: false,
        context: { found: emails.length, max: input.maxEmails },
    });
    emails = emails.slice(0, input.maxEmails);
}
if (!emails.length) {
    await pushError({
        code: 'INPUT_EMPTY',
        message: 'Input.emails must contain at least one email address.',
        retryable: false,
    });
    // Fail fast: never fall back to sample input; error rows are not charged.
    await finish({ exitCode: 1, statusMessage: 'INPUT_EMPTY: emails is required' });
}

if (input.mailboxCheckEnabled) {
    if (isPlausibleMvKey(mvKeyRaw)) {
        mv = new MillionVerifierClient(mvKeyRaw);
        await mv.preflight();
    } else {
        await pushError({
            code: 'MAILBOX_KEY_INVALID_FORMAT',
            message:
                'millionVerifierApiKey does not look like a MillionVerifier API key (8-128 letters, digits, - or _). Mailbox check skipped; nothing was sent to MillionVerifier.',
            retryable: false,
        });
    }
}

log.info('Email validator starting', {
    emails: emails.length,
    checkDns: input.checkDns,
    checkDomainAge: input.checkDomainAge,
    mailboxCheck: Boolean(mv),
});

const parsed = emails.map((raw) => ({ raw, p: parseEmail(raw) }));

// DNS per unique domain
const dnsByDomain = new Map<string, DomainDns | Error>();
if (input.checkDns) {
    const domains = [...new Set(parsed.flatMap((x) => (x.p ? [x.p.domain] : [])))];
    for (let i = 0; i < domains.length; i += DNS_CONCURRENCY) {
        if (aborting.value) break;
        await Promise.all(
            domains.slice(i, i + DNS_CONCURRENCY).map(async (d) => {
                try {
                    dnsByDomain.set(d, await lookupDomain(client, d, input.checkSpfDmarc));
                } catch (e) {
                    dnsByDomain.set(d, e instanceof Error ? e : new Error(String(e)));
                }
            }),
        );
    }
    counters.domains_checked = dnsByDomain.size;
}

// RDAP domain age per unique registrable domain (only for domains that exist and can receive mail).
const rdapByReg = new Map<string, RdapResult>();
if (input.checkDomainAge && input.checkDns && !aborting.value) {
    const regs = [
        ...new Set(
            [...dnsByDomain.values()].flatMap((d) =>
                d instanceof Error || !d.exists || d.nullMx || (!d.mx.length && !d.implicitMx)
                    ? []
                    : [registrableDomain(d.domain)],
            ),
        ),
    ];
    if (regs.length) await runRdap(regs);
}

// Rows, in chunks so the optional mailbox check can run concurrently per chunk.
for (let i = 0; i < parsed.length && !aborting.value; i += CHUNK) {
    const built: { row: EmailRow; mailboxEligible: boolean }[] = [];
    for (const { raw, p } of parsed.slice(i, i + CHUNK)) {
        let dns: DomainDns | null = null;
        if (p && input.checkDns) {
            const d = dnsByDomain.get(p.domain);
            if (!d || d instanceof Error) {
                await pushError({
                    code: 'DNS_LOOKUP_FAILED',
                    message: d ? d.message : 'Not checked (run aborted)',
                    retryable: d ? ((d as { retryable?: boolean }).retryable ?? true) : true,
                    input: raw,
                    domain: p.domain,
                });
                continue;
            }
            dns = d;
        }
        built.push(buildRow(raw, p, dns));
    }

    // Optional BYOK mailbox check (only for rows that are not already invalid or disposable).
    const outcomes = new Map<EmailRow, MailboxOutcome>();
    if (mv) {
        const jobs: Promise<void>[] = [];
        for (const b of built) {
            if (!b.mailboxEligible) continue;
            if (mailboxQueued >= input.mailboxCheckMaxPerRun || !canAffordMailboxCheck(jobs.length)) {
                b.row.mailbox_check = 'skipped_limit';
                continue;
            }
            mailboxQueued += 1;
            const { row } = b;
            jobs.push(
                mv.verify(row.email!, row.domain!).then((o) => {
                    outcomes.set(row, o);
                }),
            );
        }
        await Promise.all(jobs);
    }

    for (const { row } of built) {
        const o = outcomes.get(row);
        const events: string[] = [CHARGE_EVENTS.emailChecked];
        if (o) {
            applyMailbox(row, o);
            if (o.billable) events.push(CHARGE_EVENTS.mailboxCheckedByok);
        }
        finaliseRisk(row);
        await emit(row, events);
        counters.emails_checked += 1;
        verdictCounts[row.verdict] += 1;
        if (aborting.value) break;
    }
}

if (mv?.stoppedReason) {
    await pushError({
        code: 'MAILBOX_CHECK_STOPPED',
        message: `MillionVerifier check stopped: ${mv.stoppedReason}. Rows with mailbox_check "error" were not charged the mailbox-checked-byok event.`,
        retryable: mv.stoppedReason === 'MV_TOO_MANY_ERRORS',
        context: { reason: mv.stoppedReason },
    });
}

log.info('Email validator finished', { ...counters, verdictCounts, ...rdapStats, mailboxChecks: mv?.attempted ?? 0 });
await finish();

// ---------------------------------------------------------------------------------------------------------------

function buildRow(
    raw: string,
    p: ReturnType<typeof parseEmail>,
    dns: DomainDns | null,
): { row: EmailRow; mailboxEligible: boolean } {
    const now = new Date().toISOString();
    const disposable = p ? isDisposable(p.domain) : false;
    const role = p ? isRole(p.local) : false;
    const free = p ? isFreeProvider(p.domain) : false;
    const didYouMean = p ? suggestDomain(p.domain) : null;
    const { verdict, reasons } = verdictOf({
        syntaxValid: Boolean(p),
        disposable,
        role,
        free,
        domainExists: dns ? dns.exists : null,
        hasMx: dns ? dns.mx.length > 0 : null,
        nullMx: dns?.nullMx ?? false,
        implicitMx: dns?.implicitMx ?? false,
        didYouMean,
        allowRole: input.allowRoleAccounts,
        allowDisposable: input.allowDisposable,
        allowFree: input.allowFreeProviders,
    });
    const exchanges = dns?.mx.map((m) => m.exchange) ?? [];
    const infraMx = dns ? disposableInfrastructureMx(exchanges) : null;
    const provider =
        dns && p
            ? classifyProvider({ exchanges, free, disposable, disposableInfra: Boolean(infraMx), domain: p.domain })
            : null;
    const canReceive = Boolean(dns && dns.exists && !dns.nullMx && (dns.mx.length > 0 || dns.implicitMx));
    const rdap = p && dns && canReceive ? rdapByReg.get(registrableDomain(p.domain)) : undefined;
    const registeredAt = rdap?.registeredAt ?? null;
    // Implicit MX (A record only): the host itself receives mail, so it is not 'none'.
    let cls = provider?.cls ?? null;
    if (cls === 'none' && dns?.implicitMx) cls = 'self_hosted_or_unrecognised';
    const row: EmailRow = {
        schema_version: SCHEMA_VERSION,
        type: 'email',
        source_url: p ? dohUrl(p.domain, 'MX') : 'https://www.rfc-editor.org/rfc/rfc5321',
        checked_at: now,
        input: raw,
        email: p?.email ?? null,
        local_part: p?.local ?? null,
        domain: p?.domain ?? null,
        verdict,
        reasons,
        syntax_valid: Boolean(p),
        is_disposable: disposable,
        is_role_account: role,
        is_free_provider: free,
        did_you_mean: didYouMean && p ? `${p.local}@${didYouMean}` : null,
        domain_exists: dns ? dns.exists : null,
        has_mx: dns ? dns.mx.length > 0 : null,
        null_mx: dns?.nullMx ?? false,
        implicit_mx: dns?.implicitMx ?? false,
        mx_records: dns?.mx ?? [],
        mail_provider: dns ? mailProviderOf(exchanges) : null,
        has_spf: dns?.spf ?? null,
        has_dmarc: dns?.dmarc ?? null,
        dmarc_policy: dns?.dmarcPolicy ?? null,
        // v2
        risk_score: 0,
        risk_level: 'low',
        risk_reasons: [],
        risk_score_version: RISK_SCORE_VERSION,
        mail_provider_id: canReceive ? (provider?.id ?? null) : null,
        mx_provider_class: providerClass(Boolean(dns && p), canReceive, cls),
        catch_all_likelihood: canReceive ? (provider?.catchAll ?? null) : null,
        catch_all_basis: canReceive && provider ? 'estimate_from_mx_provider' : null,
        domain_registered_at: registeredAt,
        domain_age_days: ageDays(registeredAt),
        domain_age_source: registeredAt ? (rdap?.source ?? null) : null,
        disposable_infrastructure: Boolean(infraMx),
        disposable_infrastructure_mx: infraMx,
        mailbox_verified: false,
        mailbox_check: mv ? 'skipped_invalid' : 'not_requested',
        mailbox_status: null,
        mailbox_provider: null,
        mailbox_raw: null,
        mailbox_error: null,
    };
    let mailboxEligible = false;
    if (mv && p) {
        if (verdict === 'invalid') row.mailbox_check = 'skipped_invalid';
        else if (disposable || infraMx) row.mailbox_check = 'skipped_disposable';
        else mailboxEligible = true;
    }
    return { row, mailboxEligible };
}

/* eslint-disable no-param-reassign -- rows are built and enriched in place before they are emitted */
function providerClass(
    checked: boolean,
    canReceive: boolean,
    cls: EmailRow['mx_provider_class'],
): EmailRow['mx_provider_class'] {
    if (!checked) return null;
    return canReceive ? cls : 'none';
}

function applyMailbox(row: EmailRow, o: MailboxOutcome): void {
    row.mailbox_provider = 'millionverifier';
    row.mailbox_check = o.state;
    row.mailbox_error = o.error;
    row.mailbox_status = o.status;
    row.mailbox_raw = o.raw;
    row.mailbox_verified = o.verified;
    if (o.state !== 'checked' || !o.raw?.livemode) return; // demo/test keys never change the verdict
    if (o.status === 'undeliverable') {
        row.verdict = 'invalid';
        row.reasons = [...row.reasons, 'MAILBOX_UNDELIVERABLE'];
    } else if (o.status === 'catch_all' || o.status === 'disposable') {
        row.reasons = [...row.reasons, o.status === 'catch_all' ? 'MAILBOX_CATCH_ALL' : 'MAILBOX_DISPOSABLE'];
        if (row.verdict === 'valid' || row.verdict === 'unknown') row.verdict = 'risky';
    }
}

function finaliseRisk(row: EmailRow): void {
    const r = riskScore({
        syntaxValid: row.syntax_valid,
        verdict: row.verdict,
        reasons: row.reasons,
        disposable: row.is_disposable,
        disposableInfra: row.disposable_infrastructure,
        role: row.is_role_account,
        free: row.is_free_provider,
        didYouMean: Boolean(row.did_you_mean),
        implicitMx: row.implicit_mx,
        dnsChecked: row.has_mx !== null,
        hasSpf: row.has_spf,
        hasDmarc: row.has_dmarc,
        catchAll: row.catch_all_likelihood,
        domainAgeDays: row.domain_age_days,
        mailboxStatus: row.mailbox_status,
        mailboxLive: Boolean(row.mailbox_raw?.livemode),
    });
    row.risk_score = r.score;
    row.risk_level = r.level;
    row.risk_reasons = r.reasons;
}

/* eslint-enable no-param-reassign */

function canAffordMailboxCheck(inFlight: number): boolean {
    if (!emitter.isPpe()) return true;
    try {
        const max = Actor.getChargingManager().calculateMaxEventChargeCountWithinLimit(
            CHARGE_EVENTS.mailboxCheckedByok,
        );
        return max - emitter.pending(CHARGE_EVENTS.mailboxCheckedByok) - inFlight > 0;
    } catch {
        return true;
    }
}

async function runRdap(regs: string[]): Promise<void> {
    const rdap = new RdapClient();
    let kv = null;
    if (input.cacheDomainAge) {
        try {
            kv = await Actor.openKeyValueStore(RDAP_CACHE_STORE);
        } catch {
            kv = null;
        }
    }
    const cache = new RdapCache(kv);
    const deadline = Date.now() + RDAP_BUDGET_MS;
    const todo: string[] = [];
    for (const reg of regs) {
        const hit = await cache.get(reg);
        if (hit) rdapByReg.set(reg, hit);
        else todo.push(reg);
    }
    if (todo.length) {
        await rdap.loadBootstrap();
        let next = 0;
        const limit = Math.min(todo.length, RDAP_MAX_LOOKUPS);
        const worker = async () => {
            while (next < limit && Date.now() < deadline && !aborting.value) {
                const reg = todo[next++];
                const res = await rdap.lookup(reg);
                rdapByReg.set(reg, res);
                await cache.set(reg, res);
            }
        };
        await Promise.all(Array.from({ length: RDAP_CONCURRENCY }, worker));
    }
    await cache.flush();
    rdapStats.rdap_lookups = rdap.requests;
    rdapStats.rdap_cache_hits = cache.hits;
    rdapStats.rdap_failures = rdap.failures;
    log.info('RDAP domain age', {
        domains: regs.length,
        ...rdapStats,
        bootstrap: todo.length ? rdap.bootstrapSource : 'not_needed',
    });
}

async function finish(exitOptions?: { exitCode: number; statusMessage: string }): Promise<never> {
    await emitter.flush();
    const { emails: inEmails, ...rest } = input;
    const summary: RunSummary = {
        schema_version: SCHEMA_VERSION,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        emails_requested: inEmails.length,
        ...counters,
        verdict_counts: verdictCounts,
        dns_requests: client.requestCount,
        // Secret-free echo of the input: the API key is never included, only whether a mailbox check was requested.
        input: { ...rest, emails: inEmails.length > 50 ? [`<${inEmails.length} emails>`] : inEmails },
        ...rdapStats,
        mailbox_checks_attempted: mv?.attempted ?? 0,
        mailbox_checks_billable: mv?.billable ?? 0,
        mailbox_checks_failed: mv?.failed ?? 0,
        mailbox_check_stopped_reason: mv?.stoppedReason ?? null,
        charged_events: { ...emitter.charged },
    };
    await Actor.setValue('RUN_SUMMARY', summary);
    await Actor.exit(exitOptions);
    return undefined as never;
}

async function emit(row: OutputRow, events: string | string[]): Promise<void> {
    // Batched push + charge; Actor.charge only runs when the run is pay-per-event (see emitter.ts).
    await emitter.emit(row, events);
    if (emitter.limitReached) aborting.value = true;
}

/** Error rows are never charged. */
async function pushError(
    partial: Omit<ErrorRow, 'schema_version' | 'type' | 'source_url' | 'checked_at'>,
): Promise<void> {
    counters.errors += 1;
    const row: ErrorRow = {
        schema_version: SCHEMA_VERSION,
        type: 'error',
        source_url: partial.domain ? dohUrl(partial.domain, 'MX') : 'https://www.rfc-editor.org/rfc/rfc5321',
        checked_at: new Date().toISOString(),
        ...partial,
    };
    await emitter.emit(row, null); // error rows are never charged
}
