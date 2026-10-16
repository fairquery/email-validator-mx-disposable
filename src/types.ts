/** Shared types for Email Validator for Agents (Fairquery) */

export const SCHEMA_VERSION = '1.0.0';
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
}

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
    input: ActorInput;
}

export const CHARGE_EVENTS = {
    emailChecked: 'email-checked',
} as const;
