/**
 * Optional BYOK mailbox check through the user's own MillionVerifier account (Single API v3).
 * Docs: https://developer.millionverifier.com/  (GET https://api.millionverifier.com/api/v3/?api=KEY&email=..&timeout=..)
 *
 * Secret handling: the key lives only in this object's private field. It is never logged, never written to the
 * dataset, the key-value store or RUN_SUMMARY, and never included in any error message (all errors are our own codes).
 * No SMTP traffic leaves the Actor; MillionVerifier does the mailbox check on its own infrastructure.
 */
import type { MailboxStatus } from './types.js';

export const MV_ENDPOINT = 'https://api.millionverifier.com/api/v3/';
const MAX_BODY_BYTES = 64 * 1024;

export function isPlausibleMvKey(key: unknown): key is string {
    return typeof key === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(key.trim());
}

export interface MvRaw {
    result: string;
    resultcode: number | null;
    subresult: string;
    quality: string;
    livemode: boolean;
}

export interface MailboxOutcome {
    state: 'checked' | 'error';
    status: MailboxStatus | null;
    raw: MvRaw | null;
    /** true when a real (livemode) vendor result came back that MillionVerifier itself bills: ok/invalid/catch_all/disposable */
    billable: boolean;
    verified: boolean;
    error: string | null;
}

const STATUS: Record<string, MailboxStatus> = {
    ok: 'deliverable',
    invalid: 'undeliverable',
    catch_all: 'catch_all',
    disposable: 'disposable',
    unknown: 'unknown',
};
const BILLABLE_RESULTS = new Set(['ok', 'invalid', 'catch_all', 'disposable']);
const fatalCodes = new Set(['MV_INVALID_API_KEY', 'MV_INSUFFICIENT_CREDITS', 'MV_IP_ADDRESS_BLOCKED']);

/** Vendor errors that make every further call pointless: stop the BYOK phase for the rest of the run. */
export function fatalVendorError(error: string): string | null {
    const e = error.toLowerCase();
    if (/api ?key|apikey/.test(e)) return 'MV_INVALID_API_KEY';
    if (/insufficient.?credit/.test(e)) return 'MV_INSUFFICIENT_CREDITS';
    if (/ip.?address.?blocked|ip.?blocked/.test(e)) return 'MV_IP_ADDRESS_BLOCKED';
    return null;
}

export function mapMvResponse(json: unknown, requested: string): MailboxOutcome {
    const j = (json ?? {}) as Record<string, unknown>;
    const err = typeof j.error === 'string' ? j.error : '';
    const result = typeof j.result === 'string' ? j.result : '';
    const raw: MvRaw = {
        result,
        resultcode: typeof j.resultcode === 'number' ? j.resultcode : null,
        subresult: typeof j.subresult === 'string' ? j.subresult.slice(0, 64) : '',
        quality: typeof j.quality === 'string' ? j.quality.slice(0, 16) : '',
        livemode: j.livemode === true,
    };
    if (err || result === '' || result === 'error' || raw.resultcode === 4) {
        return {
            state: 'error',
            status: null,
            raw: null,
            billable: false,
            verified: false,
            error: fatalVendorError(err) ?? 'MV_VENDOR_ERROR',
        };
    }
    if (typeof j.email === 'string' && j.email.trim().toLowerCase() !== requested.toLowerCase()) {
        return {
            state: 'error',
            status: null,
            raw: null,
            billable: false,
            verified: false,
            error: 'MV_RESPONSE_MISMATCH',
        };
    }
    const status = STATUS[result] ?? 'unknown';
    return {
        state: 'checked',
        status,
        raw,
        billable: raw.livemode && BILLABLE_RESULTS.has(result),
        verified: raw.livemode && (result === 'ok' || result === 'invalid'),
        error: null,
    };
}

class Semaphore {
    private active = 0;
    private queue: (() => void)[] = [];
    constructor(private readonly max: number) {}
    async run<T>(fn: () => Promise<T>): Promise<T> {
        if (this.active >= this.max) {
            // The releasing task hands its slot over directly, so `active` is not incremented here.
            await new Promise<void>((r) => {
                this.queue.push(r);
            });
        } else {
            this.active += 1;
        }
        try {
            return await fn();
        } finally {
            const next = this.queue.shift();
            if (next) next();
            else this.active -= 1;
        }
    }
}

const sleep = async (ms: number) =>
    new Promise<void>((r) => {
        setTimeout(r, ms);
    });

export class MillionVerifierClient {
    readonly #key: string;
    stoppedReason: string | null = null;
    attempted = 0;
    billable = 0;
    failed = 0;
    private consecutiveErrors = 0;
    private readonly global: Semaphore;
    private readonly perDomain = new Map<string, Semaphore>();

    constructor(
        key: string,
        private readonly fetchImpl: typeof fetch = fetch,
        private readonly opts = {
            timeoutMs: 15_000,
            vendorTimeoutSecs: 10,
            concurrency: 10,
            perDomain: 2,
            maxRetries: 2,
        },
    ) {
        this.#key = key.trim();
        this.global = new Semaphore(opts.concurrency);
    }

    /** Never expose the key through inspection/serialisation. */
    toJSON() {
        return { provider: 'millionverifier' };
    }

    /**
     * Free pre-flight via the documented credits endpoint, so a wrong key or an empty account stops the BYOK phase
     * before any verification call. Demo keys (API_KEY_FOR_*) are not accepted by this endpoint, so they skip it.
     * Network problems here are ignored (the per-call error handling still applies).
     */
    async preflight(): Promise<void> {
        if (this.#key.startsWith('API_KEY_FOR_')) return;
        const url = new URL(`${MV_ENDPOINT}credits`);
        url.searchParams.set('api', this.#key);
        try {
            const res = await this.fetchImpl(url, {
                redirect: 'error',
                signal: AbortSignal.timeout(this.opts.timeoutMs),
            });
            if (!res.ok) {
                await res.body?.cancel().catch(() => undefined);
                return;
            }
            const text = await res.text();
            if (text.length > MAX_BODY_BYTES) return;
            const j = JSON.parse(text) as { error?: unknown; credits?: unknown; renewing_credits?: unknown };
            const fatal = typeof j.error === 'string' && j.error ? fatalVendorError(j.error) : null;
            if (fatal) this.stoppedReason = fatal;
            else if (j.credits === 0 && (j.renewing_credits === 0 || j.renewing_credits === undefined))
                this.stoppedReason = 'MV_INSUFFICIENT_CREDITS';
        } catch {
            // ignore: fall through to per-call handling
        }
    }

    async verify(email: string, domain: string): Promise<MailboxOutcome> {
        let sem = this.perDomain.get(domain);
        if (!sem) {
            sem = new Semaphore(this.opts.perDomain);
            this.perDomain.set(domain, sem);
        }
        return this.global.run(async () => sem.run(async () => this.verifyNow(email)));
    }

    private stopped(): MailboxOutcome {
        return { state: 'error', status: null, raw: null, billable: false, verified: false, error: this.stoppedReason };
    }

    private async verifyNow(email: string): Promise<MailboxOutcome> {
        if (this.stoppedReason) return this.stopped();
        this.attempted += 1;
        const out = await this.request(email);
        if (out.state === 'error') {
            this.failed += 1;
            this.consecutiveErrors += 1;
            const fatal = out.error !== null && fatalCodes.has(out.error);
            if (fatal) this.stoppedReason = out.error;
            else if (this.consecutiveErrors >= 20) this.stoppedReason = 'MV_TOO_MANY_ERRORS';
        } else {
            this.consecutiveErrors = 0;
            if (out.billable) this.billable += 1;
        }
        return out;
    }

    private async request(email: string, attempt = 0): Promise<MailboxOutcome> {
        const url = new URL(MV_ENDPOINT);
        url.searchParams.set('api', this.#key);
        url.searchParams.set('email', email);
        url.searchParams.set('timeout', String(this.opts.vendorTimeoutSecs));
        const err = (code: string): MailboxOutcome => ({
            state: 'error',
            status: null,
            raw: null,
            billable: false,
            verified: false,
            error: code,
        });
        let res: Response;
        try {
            res = await this.fetchImpl(url, {
                redirect: 'error',
                signal: AbortSignal.timeout(this.opts.timeoutMs),
                headers: { accept: 'application/json' },
            });
        } catch (e) {
            const name = e instanceof Error ? e.name : '';
            // Do not retry timeouts: the vendor may have processed (and billed the user's credits for) the request.
            if (name === 'TimeoutError' || name === 'AbortError') return err('MV_TIMEOUT');
            const code = (e as { cause?: { code?: string } })?.cause?.code ?? '';
            if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code) && attempt < this.opts.maxRetries) {
                await sleep(1000 * 2 ** attempt);
                return this.request(email, attempt + 1);
            }
            return err('MV_NETWORK_ERROR');
        }
        if (res.status === 429 || res.status === 503) {
            await res.body?.cancel().catch(() => undefined);
            if (attempt < this.opts.maxRetries) {
                const ra = Number(res.headers.get('retry-after'));
                await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 10) * 1000 : 1000 * 2 ** attempt);
                return this.request(email, attempt + 1);
            }
            return err(res.status === 429 ? 'MV_RATE_LIMITED' : 'MV_UNAVAILABLE');
        }
        if (!res.ok) {
            await res.body?.cancel().catch(() => undefined);
            return err(`MV_HTTP_${res.status}`);
        }
        try {
            const text = await res.text();
            if (text.length > MAX_BODY_BYTES) return err('MV_BAD_RESPONSE');
            return mapMvResponse(JSON.parse(text), email);
        } catch {
            return err('MV_BAD_RESPONSE');
        }
    }
}
