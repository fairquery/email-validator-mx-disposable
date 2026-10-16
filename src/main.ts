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
import {
    type ActorInput,
    CHARGE_EVENTS,
    DNS_CONCURRENCY,
    type EmailRow,
    type ErrorRow,
    type OutputRow,
    type RunSummary,
    SCHEMA_VERSION,
    type Verdict,
} from './types.js';

await Actor.init();

const aborting = { value: false };
const emitter = new Emitter();
Actor.on('aborting', async () => {
    aborting.value = true;
    await emitter.flush();
    log.warning('Aborting — stopping after current batch.');
});

const startedAt = new Date().toISOString();
const rawInput = (await Actor.getInput<ActorInput>()) ?? {};
const input: Required<ActorInput> = {
    emails: Array.isArray(rawInput.emails) ? rawInput.emails.map(String) : [],
    checkDns: rawInput.checkDns ?? true,
    checkSpfDmarc: rawInput.checkSpfDmarc ?? true,
    allowRoleAccounts: rawInput.allowRoleAccounts ?? true,
    allowDisposable: rawInput.allowDisposable ?? false,
    allowFreeProviders: rawInput.allowFreeProviders ?? true,
    maxEmails: rawInput.maxEmails ?? 10000,
};

const verdictCounts: Record<Verdict, number> = { valid: 0, risky: 0, invalid: 0, unknown: 0 };
const counters = { emails_checked: 0, duplicates_skipped: 0, domains_checked: 0, errors: 0 };
const client = new DohClient();

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
    await finish();
}

log.info('Email validator starting', { emails: emails.length, checkDns: input.checkDns });

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

for (const { raw, p } of parsed) {
    if (aborting.value) break;
    const now = new Date().toISOString();
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
        mail_provider: dns ? mailProviderOf(dns.mx.map((m) => m.exchange)) : null,
        has_spf: dns?.spf ?? null,
        has_dmarc: dns?.dmarc ?? null,
        dmarc_policy: dns?.dmarcPolicy ?? null,
    };
    await emit(row, CHARGE_EVENTS.emailChecked);
    counters.emails_checked += 1;
    verdictCounts[verdict] += 1;
}

log.info('Email validator finished', { ...counters, verdictCounts });
await finish();

async function finish(): Promise<never> {
    const summary: RunSummary = {
        schema_version: SCHEMA_VERSION,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        emails_requested: input.emails.length,
        ...counters,
        verdict_counts: verdictCounts,
        dns_requests: client.requestCount,
        input: { ...input, emails: input.emails.length > 50 ? [`<${input.emails.length} emails>`] : input.emails },
    };
    await emitter.flush();
    await Actor.setValue('RUN_SUMMARY', summary);
    await Actor.exit();
    return undefined as never;
}

async function emit(row: OutputRow, eventName: string): Promise<void> {
    // Batched push + charge; Actor.charge only runs when the run is pay-per-event (see emitter.ts).
    await emitter.emit(row, eventName);
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
