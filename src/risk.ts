/**
 * Risk Score v2 (no SMTP): MX provider class, catch-all ESTIMATE, disposable-infrastructure overlap, risk score.
 * Everything here is a heuristic over DNS + bundled lists. Nothing here contacts a mail server.
 */
import { isDisposable } from './checks.js';
import { DISPOSABLE_MX_HOSTS } from './data/disposable-mx.js';
import type { CatchAllLikelihood, MailboxStatus, MxProviderClass } from './types.js';

interface ProviderRule {
    re: RegExp;
    id: string;
    cls: MxProviderClass;
    /** Catch-all ESTIMATE for a custom (non-consumer) domain on this provider. */
    catchAll: CatchAllLikelihood;
}

// Order matters: first match wins. Catch-all values are priors, documented in the README:
// - google: Gmail / Workspace reject unknown recipients by default (catch-all routing is opt-in) -> low
// - microsoft: published measurements show non-deterministic RCPT answers and many tenants accept-then-bounce -> medium
// - yahoo / aol: accept every recipient at RCPT time and bounce later -> high
// - security gateways: often accept for the whole domain and bounce later, depends on config -> medium
// - everything else: no evidence either way -> unknown
const PROVIDER_RULES: ProviderRule[] = [
    { re: /(^|\.)(google\.com|googlemail\.com)$/, id: 'google', cls: 'business_suite', catchAll: 'low' },
    {
        re: /(^|\.)(outlook\.com|hotmail\.com|outlook\.cn)$/,
        id: 'microsoft',
        cls: 'business_suite',
        catchAll: 'medium',
    },
    { re: /(^|\.)(yahoodns\.net|yahoo\.com|aol\.com)$/, id: 'yahoo', cls: 'consumer_webmail', catchAll: 'high' },
    { re: /(^|\.)icloud\.com$/, id: 'apple', cls: 'business_suite', catchAll: 'unknown' },
    { re: /(^|\.)protonmail\.ch$/, id: 'proton', cls: 'business_suite', catchAll: 'unknown' },
    { re: /(^|\.)zoho\.(com|eu|in|com\.au|jp)$/, id: 'zoho', cls: 'business_suite', catchAll: 'unknown' },
    { re: /(^|\.)messagingengine\.com$/, id: 'fastmail', cls: 'business_suite', catchAll: 'unknown' },
    { re: /(^|\.)yandex\.(net|ru)$/, id: 'yandex', cls: 'business_suite', catchAll: 'unknown' },
    { re: /(^|\.)mail\.ru$/, id: 'mailru', cls: 'consumer_webmail', catchAll: 'unknown' },
    { re: /(^|\.)(pphosted\.com|ppe-hosted\.com)$/, id: 'proofpoint', cls: 'security_gateway', catchAll: 'medium' },
    { re: /(^|\.)mimecast(-offshore)?\.com$/, id: 'mimecast', cls: 'security_gateway', catchAll: 'medium' },
    { re: /(^|\.)barracudanetworks\.com$/, id: 'barracuda', cls: 'security_gateway', catchAll: 'medium' },
    { re: /(^|\.)(iphmx\.com)$/, id: 'cisco_secure_email', cls: 'security_gateway', catchAll: 'medium' },
    {
        re: /(^|\.)(sophos\.com|hornetsecurity\.com|trendmicro\.(com|eu))$/,
        id: 'security_gateway_other',
        cls: 'security_gateway',
        catchAll: 'medium',
    },
    { re: /(^|\.)secureserver\.net$/, id: 'godaddy', cls: 'hosting_or_forwarding', catchAll: 'unknown' },
    { re: /(^|\.)(amazonaws\.com|awsapps\.com)$/, id: 'amazon', cls: 'hosting_or_forwarding', catchAll: 'unknown' },
    {
        re: /(^|\.)mx\.cloudflare\.net$/,
        id: 'cloudflare_email_routing',
        cls: 'hosting_or_forwarding',
        catchAll: 'unknown',
    },
    { re: /(^|\.)(mailgun\.org|sendgrid\.net)$/, id: 'esp_inbound', cls: 'hosting_or_forwarding', catchAll: 'unknown' },
    {
        re: /(^|\.)(registrar-servers\.com|privateemail\.com|improvmx\.com|forwardemail\.net|porkbun\.com|efwd\.spaceship\.net)$/,
        id: 'forwarding',
        cls: 'hosting_or_forwarding',
        catchAll: 'unknown',
    },
    {
        re: /(^|\.)(ovh\.net|hostinger\.com|ionos\.com|ionos\.de|gandi\.net|one\.com|titan\.email|hostgator\.com|bluehost\.com)$/,
        id: 'hosting',
        cls: 'hosting_or_forwarding',
        catchAll: 'unknown',
    },
];

/** Consumer mailbox domains whose catch-all behaviour we estimate from the domain itself. */
const CONSUMER_CATCH_ALL: Record<string, CatchAllLikelihood> = {
    'gmail.com': 'low',
    'googlemail.com': 'low',
    'yahoo.com': 'high',
    'yahoo.co.uk': 'high',
    'yahoo.fr': 'high',
    'ymail.com': 'high',
    'aol.com': 'high',
    'hotmail.com': 'medium',
    'hotmail.co.uk': 'medium',
    'hotmail.fr': 'medium',
    'outlook.com': 'medium',
    'live.com': 'medium',
    'msn.com': 'medium',
};

export interface ProviderInfo {
    id: string | null;
    cls: MxProviderClass;
    catchAll: CatchAllLikelihood;
}

export function classifyProvider(opts: {
    exchanges: string[];
    free: boolean;
    disposable: boolean;
    disposableInfra: boolean;
    domain: string;
}): ProviderInfo {
    if (opts.disposable || opts.disposableInfra) {
        // Throwaway inbox services accept any local part by design.
        return { id: 'disposable', cls: 'disposable_service', catchAll: 'high' };
    }
    if (!opts.exchanges.length) return { id: null, cls: 'none', catchAll: 'unknown' };
    let rule: ProviderRule | undefined;
    for (const ex of opts.exchanges) {
        rule = PROVIDER_RULES.find((r) => r.re.test(ex.toLowerCase()));
        if (rule) break;
    }
    const consumer = CONSUMER_CATCH_ALL[opts.domain];
    if (opts.free) {
        return { id: rule?.id ?? null, cls: 'consumer_webmail', catchAll: consumer ?? rule?.catchAll ?? 'unknown' };
    }
    if (rule) return { id: rule.id, cls: rule.cls, catchAll: rule.catchAll };
    return { id: null, cls: 'self_hosted_or_unrecognised', catchAll: 'unknown' };
}

/** MX host shared with known disposable-inbox infrastructure (or the MX host itself is on the disposable list). */
export function disposableInfrastructureMx(exchanges: string[]): string | null {
    for (const raw of exchanges) {
        const ex = raw.toLowerCase().replace(/\.$/, '');
        if (!ex) continue;
        if (DISPOSABLE_MX_HOSTS.has(ex)) return ex;
        if (ex.includes('.') && isDisposable(ex)) return ex;
    }
    return null;
}

export interface RiskInput {
    syntaxValid: boolean;
    verdict: string;
    reasons: string[];
    disposable: boolean;
    disposableInfra: boolean;
    role: boolean;
    free: boolean;
    didYouMean: boolean;
    implicitMx: boolean;
    dnsChecked: boolean;
    hasSpf: boolean | null;
    hasDmarc: boolean | null;
    catchAll: CatchAllLikelihood | null;
    domainAgeDays: number | null;
    mailboxStatus: MailboxStatus | null;
    mailboxLive: boolean;
}

export const NEW_DOMAIN_DAYS = 30;
export const YOUNG_DOMAIN_DAYS = 180;

/**
 * Additive, capped 0..100 score. Higher = riskier. Weights are deliberately simple and documented in the README.
 */
export function riskScore(r: RiskInput): { score: number; level: 'low' | 'medium' | 'high'; reasons: string[] } {
    const reasons: string[] = [];
    let s = 0;
    const add = (pts: number, code: string) => {
        s += pts;
        reasons.push(code);
    };
    if (r.verdict === 'invalid') {
        reasons.push(...r.reasons);
        if (r.mailboxStatus === 'undeliverable' && r.mailboxLive && !reasons.includes('MAILBOX_UNDELIVERABLE'))
            reasons.push('MAILBOX_UNDELIVERABLE');
        return { score: 100, level: 'high', reasons };
    }
    if (r.disposable) add(70, 'DISPOSABLE_DOMAIN');
    if (r.disposableInfra && !r.disposable) add(60, 'DISPOSABLE_INFRASTRUCTURE');
    if (r.didYouMean) add(45, 'POSSIBLE_TYPO');
    if (r.implicitMx) add(20, 'IMPLICIT_MX_ONLY');
    if (!r.dnsChecked) add(25, 'DNS_NOT_CHECKED');
    if (r.domainAgeDays !== null && r.domainAgeDays < NEW_DOMAIN_DAYS) add(35, 'NEW_DOMAIN');
    else if (r.domainAgeDays !== null && r.domainAgeDays < YOUNG_DOMAIN_DAYS) add(10, 'YOUNG_DOMAIN');
    if (r.role) add(10, 'ROLE_ACCOUNT');
    if (r.catchAll === 'high' && !r.disposable && !r.disposableInfra) add(15, 'CATCH_ALL_LIKELY_ESTIMATE');
    else if (r.catchAll === 'medium') add(8, 'CATCH_ALL_POSSIBLE_ESTIMATE');
    else if (r.catchAll === 'unknown' && r.dnsChecked) add(5, 'CATCH_ALL_UNKNOWN');
    if (r.dnsChecked && r.hasSpf === false && !r.free) add(5, 'NO_SPF');
    if (r.dnsChecked && r.hasDmarc === false && !r.free) add(3, 'NO_DMARC');
    if (r.mailboxLive) {
        if (r.mailboxStatus === 'catch_all') add(10, 'MAILBOX_CATCH_ALL');
        else if (r.mailboxStatus === 'disposable' && !r.disposable) add(60, 'MAILBOX_DISPOSABLE');
        else if (r.mailboxStatus === 'deliverable') {
            s -= 15;
            reasons.push('MAILBOX_DELIVERABLE');
        }
    }
    const score = Math.max(0, Math.min(100, s));
    let level: 'low' | 'medium' | 'high' = 'low';
    if (score >= 60) level = 'high';
    else if (score >= 25) level = 'medium';
    return { score, level, reasons };
}
