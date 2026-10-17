/** Shared types for Email Validator for Agents (Fairquery) */

export const SCHEMA_VERSION = '1.1.0';
export const RISK_SCORE_VERSION = 2;
export const DOH_URL = 'https://cloudflare-dns.com/dns-query';
export const DNS_CONCURRENCY = 10;

export type Verdict = 'valid' | 'risky' | 'invalid' | 'unknown';

export interface ActorInput {
    emails?: string[];
    checkDns?: boolean;
    checkSpfDmarc?: boolean;
    allowRoleAccounts?: boolean;
    allowDisposable?: boolean;
    allowFreeProviders?: boolean;
    maxEmails?: number;
    /** v2: RDAP domain-age lookup (fails soft to null). */
    checkDomainAge?: boolean;
    /** v2: cache RDAP results in a named key-value store in the runner's account (30 days). */
    cacheDomainAge?: boolean;
    /** v2 BYOK: the user's own MillionVerifier API key (secret input). Never logged, stored or output. */
    millionVerifierApiKey?: string;
    /** v2 BYOK: hard cap on MillionVerifier calls per run. */
    mailboxCheckMaxPerRun?: number;
}

/** Normalised input (secret key removed; only a boolean is kept). */
export interface NormalisedInput {
    emails: string[];
    checkDns: boolean;
    checkSpfDmarc: boolean;
    allowRoleAccounts: boolean;
    allowDisposable: boolean;
    allowFreeProviders: boolean;
    maxEmails: number;
    checkDomainAge: boolean;
    cacheDomainAge: boolean;
    mailboxCheckEnabled: boolean;
    mailboxCheckMaxPerRun: number;
}

export type CatchAllLikelihood = 'low' | 'medium' | 'high' | 'unknown';
export type MxProviderClass =
    | 'consumer_webmail'
    | 'business_suite'
    | 'security_gateway'
    | 'hosting_or_forwarding'
    | 'disposable_service'
    | 'self_hosted_or_unrecognised'
    | 'none';
export type MailboxCheckState =
    'not_requested' | 'checked' | 'skipped_invalid' | 'skipped_disposable' | 'skipped_limit' | 'error';
export type MailboxStatus = 'deliverable' | 'undeliverable' | 'catch_all' | 'disposable' | 'unknown';

export type RowType = 'email' | 'error';

export interface BaseRow {
    schema_version: string;
    type: RowType;
    source_url: string;
    checked_at: string;
}

export interface EmailRow extends BaseRow {
    type: 'email';
    input: string;
    email: string | null;
    local_part: string | null;
    domain: string | null;
    verdict: Verdict;
    reasons: string[];
    syntax_valid: boolean;
    is_disposable: boolean;
    is_role_account: boolean;
    is_free_provider: boolean;
    did_you_mean: string | null;
    domain_exists: boolean | null;
    has_mx: boolean | null;
    null_mx: boolean;
    implicit_mx: boolean;
    mx_records: { priority: number; exchange: string }[];
    mail_provider: string | null;
    has_spf: boolean | null;
    has_dmarc: boolean | null;
    dmarc_policy: string | null;
    // ---- v2 additions (Risk Score v2). Added fields only; nothing above was renamed or removed. ----
    /** 0 (lowest risk) to 100 (highest). Heuristic, no SMTP. */
    risk_score: number;
    risk_level: 'low' | 'medium' | 'high';
    risk_reasons: string[];
    risk_score_version: number;
    mail_provider_id: string | null;
    mx_provider_class: MxProviderClass | null;
    /** ESTIMATE from the MX provider type, not a measurement. See catch_all_basis. */
    catch_all_likelihood: CatchAllLikelihood | null;
    catch_all_basis: 'estimate_from_mx_provider' | null;
    domain_registered_at: string | null;
    domain_age_days: number | null;
    domain_age_source: string | null;
    disposable_infrastructure: boolean;
    disposable_infrastructure_mx: string | null;
    /** true only when the optional BYOK MillionVerifier check (live key) returned ok or invalid. */
    mailbox_verified: boolean;
    mailbox_check: MailboxCheckState;
    mailbox_status: MailboxStatus | null;
    mailbox_provider: 'millionverifier' | null;
    mailbox_raw: {
        result: string;
        resultcode: number | null;
        subresult: string;
        quality: string;
        livemode: boolean;
    } | null;
    mailbox_error: string | null;
}

export interface ErrorRow extends BaseRow {
    type: 'error';
    code: string;
    message: string;
    retryable: boolean;
    input?: string;
    domain?: string;
    context?: Record<string, unknown>;
}

export type OutputRow = EmailRow | ErrorRow;

export interface RunSummary {
    schema_version: string;
    started_at: string;
    finished_at: string;
    emails_requested: number;
    emails_checked: number;
    duplicates_skipped: number;
    verdict_counts: Record<Verdict, number>;
    domains_checked: number;
    errors: number;
    dns_requests: number;
    input: Omit<NormalisedInput, 'emails'> & { emails: string[] };
    // v2 additions
    rdap_lookups: number;
    rdap_cache_hits: number;
    rdap_failures: number;
    mailbox_checks_attempted: number;
    mailbox_checks_billable: number;
    mailbox_checks_failed: number;
    mailbox_check_stopped_reason: string | null;
    charged_events: Record<string, number>;
}

export const CHARGE_EVENTS = {
    emailChecked: 'email-checked',
    mailboxCheckedByok: 'mailbox-checked-byok',
} as const;
