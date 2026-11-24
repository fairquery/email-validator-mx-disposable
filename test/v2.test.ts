import { describe, expect, it, vi } from 'vitest';

import {
    fatalVendorError,
    isPlausibleMvKey,
    mapMvResponse,
    MillionVerifierClient,
    MV_ENDPOINT,
} from '../src/mailbox.js';
import {
    ageDays,
    parseBootstrap,
    RDAP_CACHE_TTL_MS,
    RdapCache,
    RdapClient,
    registrableDomain,
    registrationDate,
} from '../src/rdap.js';
import { classifyProvider, disposableInfrastructureMx, riskScore, type RiskInput } from '../src/risk.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('classifyProvider (catch-all is an ESTIMATE)', () => {
    const c = (exchanges: string[], domain: string, free = false, disposable = false) =>
        classifyProvider({ exchanges, domain, free, disposable, disposableInfra: false });
    it('consumer webmail', () => {
        expect(c(['gmail-smtp-in.l.google.com'], 'gmail.com', true)).toEqual({
            id: 'google',
            cls: 'consumer_webmail',
            catchAll: 'low',
        });
        expect(c(['mta5.am0.yahoodns.net'], 'yahoo.com', true).catchAll).toBe('high');
        expect(c(['hotmail-com.olc.protection.outlook.com'], 'hotmail.com', true).catchAll).toBe('medium');
    });
    it('business suites and gateways', () => {
        expect(c(['aspmx.l.google.com'], 'acme.io')).toEqual({ id: 'google', cls: 'business_suite', catchAll: 'low' });
        expect(c(['acme-io.mail.protection.outlook.com'], 'acme.io')).toEqual({
            id: 'microsoft',
            cls: 'business_suite',
            catchAll: 'medium',
        });
        expect(c(['mxa-001.pphosted.com'], 'bigcorp.com')).toEqual({
            id: 'proofpoint',
            cls: 'security_gateway',
            catchAll: 'medium',
        });
        expect(c(['eu-smtp-inbound-1.mimecast.com'], 'bigcorp.eu').cls).toBe('security_gateway');
        expect(c(['mx.yahoodns.net'], 'smallbiz.com').catchAll).toBe('high');
    });
    it('self-hosted, none, disposable', () => {
        expect(c(['mail.example.org'], 'example.org')).toEqual({
            id: null,
            cls: 'self_hosted_or_unrecognised',
            catchAll: 'unknown',
        });
        expect(c([], 'example.org').cls).toBe('none');
        expect(c(['mail.mailinator.com'], 'mailinator.com', false, true)).toEqual({
            id: 'disposable',
            cls: 'disposable_service',
            catchAll: 'high',
        });
    });
});

describe('disposableInfrastructureMx', () => {
    it('flags MX shared with disposable services', () => {
        expect(disposableInfrastructureMx(['mail.mailinator.com'])).toBe('mail.mailinator.com');
        expect(disposableInfrastructureMx(['generator.email'])).toBe('generator.email');
        expect(disposableInfrastructureMx(['mx.something.yopmail.com'])).toBe('mx.something.yopmail.com');
    });
    it('never flags shared general-purpose infrastructure', () => {
        for (const mx of [
            'aspmx.l.google.com',
            'gmail-smtp-in.l.google.com',
            'acme.mail.protection.outlook.com',
            'route1.mx.cloudflare.net',
            'mxa.mailgun.org',
            'inbound-smtp.us-east-1.amazonaws.com',
            'eforward1.registrar-servers.com',
            'mx1.privateemail.com',
            'mx.zoho.com',
            'mx1.improvmx.com',
            'mta5.am0.yahoodns.net',
            'mxa-001.pphosted.com',
            'smtp.secureserver.net',
            'mail.protonmail.ch',
            'mx1.hostinger.com',
            'park-mx.above.com',
        ]) {
            expect(disposableInfrastructureMx([mx]), mx).toBeNull();
        }
    });
});

const baseRisk: RiskInput = {
    syntaxValid: true,
    verdict: 'valid',
    reasons: [],
    disposable: false,
    disposableInfra: false,
    role: false,
    free: false,
    didYouMean: false,
    implicitMx: false,
    dnsChecked: true,
    hasSpf: true,
    hasDmarc: true,
    catchAll: 'low',
    domainAgeDays: 5000,
    mailboxStatus: null,
    mailboxLive: false,
};

describe('riskScore', () => {
    it('clean address is low', () => {
        expect(riskScore(baseRisk)).toEqual({ score: 0, level: 'low', reasons: [] });
    });
    it('invalid is always 100', () => {
        expect(riskScore({ ...baseRisk, verdict: 'invalid', reasons: ['NULL_MX'] })).toEqual({
            score: 100,
            level: 'high',
            reasons: ['NULL_MX'],
        });
    });
    it('disposable, new domain, infrastructure', () => {
        expect(riskScore({ ...baseRisk, disposable: true, catchAll: 'high' }).level).toBe('high');
        const nd = riskScore({ ...baseRisk, domainAgeDays: 3 });
        expect(nd.reasons).toContain('NEW_DOMAIN');
        expect(nd.level).toBe('medium');
        expect(riskScore({ ...baseRisk, disposableInfra: true }).reasons).toContain('DISPOSABLE_INFRASTRUCTURE');
        expect(riskScore({ ...baseRisk, domainAgeDays: null }).reasons).not.toContain('NEW_DOMAIN');
    });
    it('catch-all estimate is labelled as an estimate', () => {
        expect(riskScore({ ...baseRisk, catchAll: 'high' }).reasons).toEqual(['CATCH_ALL_LIKELY_ESTIMATE']);
        expect(riskScore({ ...baseRisk, catchAll: 'medium' }).reasons).toEqual(['CATCH_ALL_POSSIBLE_ESTIMATE']);
    });
    it('mailbox results only count with a live key', () => {
        expect(
            riskScore({ ...baseRisk, catchAll: 'unknown', mailboxStatus: 'catch_all', mailboxLive: false }).reasons,
        ).toEqual(['CATCH_ALL_UNKNOWN']);
        expect(
            riskScore({ ...baseRisk, catchAll: 'unknown', mailboxStatus: 'catch_all', mailboxLive: true }).reasons,
        ).toContain('MAILBOX_CATCH_ALL');
    });
    it('is bounded 0..100', () => {
        const r = riskScore({
            ...baseRisk,
            disposable: true,
            didYouMean: true,
            role: true,
            domainAgeDays: 1,
            implicitMx: true,
        });
        expect(r.score).toBe(100);
    });
});

describe('RDAP helpers', () => {
    it('registrableDomain', () => {
        expect(registrableDomain('mail.example.com')).toBe('example.com');
        expect(registrableDomain('example.co.uk')).toBe('example.co.uk');
        expect(registrableDomain('a.b.example.com.au')).toBe('example.com.au');
        expect(registrableDomain('example.de')).toBe('example.de');
    });
    it('parseBootstrap keeps https only', () => {
        const services = Array.from({ length: 120 }, (_, i) => [[`t${i}x`], [`https://rdap${i}.example/`]]);
        services.push([['insecure'], ['http://rdap.insecure.example/']]);
        services.push([['mixed'], ['http://a.example/', 'https://b.example/rdap']]);
        const b = parseBootstrap({ services })!;
        expect(b.insecure).toBeUndefined();
        expect(b.mixed).toBe('https://b.example/rdap/');
        expect(parseBootstrap({ services: 'nope' })).toBeNull();
    });
    it('registrationDate / ageDays', () => {
        expect(registrationDate({ events: [{ eventAction: 'registration', eventDate: '2009-06-02T17:14:10Z' }] })).toBe(
            '2009-06-02T17:14:10.000Z',
        );
        expect(
            registrationDate({ events: [{ eventAction: 'expiration', eventDate: '2030-01-01T00:00:00Z' }] }),
        ).toBeNull();
        expect(registrationDate({ events: [{ eventAction: 'registration', eventDate: 'garbage' }] })).toBeNull();
        expect(ageDays('2026-10-07T00:00:00Z', Date.parse('2026-10-17T00:00:00Z'))).toBe(10);
        expect(ageDays(null)).toBeNull();
    });
});

describe('RdapClient (no SSRF, fails soft)', () => {
    const mk = (impl: (url: string, init?: RequestInit) => Promise<Response>) => {
        const f = vi.fn(async (u: string | URL | Request, init?: RequestInit) => impl(String(u), init));
        const c = new RdapClient(f as unknown as typeof fetch, 500);
        c.servers = { com: 'https://rdap.verisign.example/com/v1/', org: 'https://rdap.org-registry.example/' };
        (c as unknown as { rebuildOrigins: () => void }).rebuildOrigins();
        return { c, f };
    };
    it('looks up via the bootstrap server', async () => {
        const { c, f } = mk(async () =>
            json({ events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }] }),
        );
        const r = await c.lookup('mail.acme.com');
        expect(r.status).toBe('ok');
        expect(r.registeredAt).toBe('2020-01-01T00:00:00.000Z');
        expect(f.mock.calls[0][0]).toBe('https://rdap.verisign.example/com/v1/domain/acme.com');
        expect((f.mock.calls[0][1] as RequestInit).redirect).toBe('manual');
    });
    it('unknown TLD makes no request', async () => {
        const { c, f } = mk(async () => json({}));
        expect((await c.lookup('acme.zz')).status).toBe('no_rdap_server');
        expect(f).not.toHaveBeenCalled();
    });
    it('refuses redirects to hosts outside the bootstrap', async () => {
        const { c, f } = mk(
            async () =>
                new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }),
        );
        expect((await c.lookup('acme.com')).status).toBe('error');
        expect(f).toHaveBeenCalledTimes(1);
    });
    it('follows one redirect to another bootstrap server', async () => {
        const { c, f } = mk(async (u) =>
            u.includes('verisign')
                ? new Response(null, {
                      status: 301,
                      headers: { location: 'https://rdap.org-registry.example/domain/acme.com' },
                  })
                : json({ events: [{ eventAction: 'registration', eventDate: '2021-05-05T00:00:00Z' }] }),
        );
        expect((await c.lookup('acme.com')).status).toBe('ok');
        expect(f).toHaveBeenCalledTimes(2);
    });
    it('backs off once on 429', async () => {
        let n = 0;
        const { c, f } = mk(async () => {
            n += 1;
            return n === 1
                ? new Response('', { status: 429, headers: { 'retry-after': '1' } })
                : json({ events: [{ eventAction: 'registration', eventDate: '2021-05-05T00:00:00Z' }] });
        });
        expect((await c.lookup('acme.com')).status).toBe('ok');
        expect(f).toHaveBeenCalledTimes(2);
    });
    it('404, 5xx and network errors fail soft', async () => {
        expect((await mk(async () => new Response('', { status: 404 })).c.lookup('acme.com')).status).toBe('not_found');
        expect((await mk(async () => new Response('', { status: 503 })).c.lookup('acme.com')).registeredAt).toBeNull();
        expect(
            (
                await mk(async () => {
                    throw new Error('boom');
                }).c.lookup('acme.com')
            ).registeredAt,
        ).toBeNull();
    });
});

describe('RdapCache', () => {
    it('caches ok results only, with TTL, and flushes shards', async () => {
        const store = new Map<string, unknown>();
        const kv = {
            getValue: async <T>(k: string) => (store.get(k) as T) ?? null,
            setValue: async (k: string, v: unknown) => {
                store.set(k, v);
            },
        };
        let now = 1_000_000_000_000;
        const c1 = new RdapCache(kv, () => now);
        await c1.set('acme.com', { registeredAt: '2020-01-01T00:00:00.000Z', source: 'https://x/', status: 'ok' });
        await c1.set('bad.com', { registeredAt: null, source: null, status: 'error' });
        await c1.flush();
        expect(store.size).toBe(1);
        const c2 = new RdapCache(kv, () => now);
        expect((await c2.get('acme.com'))?.cached).toBe(true);
        expect(await c2.get('bad.com')).toBeNull();
        now += RDAP_CACHE_TTL_MS + 1;
        expect(await new RdapCache(kv, () => now).get('acme.com')).toBeNull();
        // nothing in the cache looks like an email address
        expect(JSON.stringify([...store.values()])).not.toContain('@');
    });
});

describe('MillionVerifier BYOK', () => {
    const live = (result: string, extra: Record<string, unknown> = {}) => ({
        email: 'a@acme.com',
        quality: 'good',
        result,
        resultcode: 1,
        subresult: 'ok',
        error: '',
        livemode: true,
        credits: 10,
        ...extra,
    });
    it('key format check', () => {
        expect(isPlausibleMvKey('API_KEY_FOR_TEST')).toBe(true);
        expect(isPlausibleMvKey('short')).toBe(false);
        expect(isPlausibleMvKey('abc def ghi jkl')).toBe(false);
        expect(isPlausibleMvKey('https://evil.example/?x=1')).toBe(false);
    });
    it('maps documented results; bills only real decisive/catch-all results', () => {
        expect(mapMvResponse(live('ok'), 'a@acme.com')).toMatchObject({
            status: 'deliverable',
            billable: true,
            verified: true,
        });
        expect(mapMvResponse(live('invalid'), 'a@acme.com')).toMatchObject({
            status: 'undeliverable',
            billable: true,
            verified: true,
        });
        expect(mapMvResponse(live('catch_all'), 'a@acme.com')).toMatchObject({
            status: 'catch_all',
            billable: true,
            verified: false,
        });
        expect(mapMvResponse(live('disposable'), 'a@acme.com')).toMatchObject({
            status: 'disposable',
            billable: true,
            verified: false,
        });
        expect(mapMvResponse(live('unknown'), 'a@acme.com')).toMatchObject({
            status: 'unknown',
            billable: false,
            verified: false,
        });
        expect(mapMvResponse(live('unverified', { resultcode: 0 }), 'a@acme.com')).toMatchObject({
            status: 'unknown',
            billable: false,
        });
        expect(mapMvResponse(live('ok', { livemode: false }), 'a@acme.com')).toMatchObject({
            status: 'deliverable',
            billable: false,
            verified: false,
        });
        expect(mapMvResponse(live('ok', { email: 'other@x.com' }), 'a@acme.com')).toMatchObject({
            state: 'error',
            billable: false,
        });
    });
    it('vendor errors are not billable and fatal ones are recognised', () => {
        for (const e of ['Apikey not found', 'Insufficient credits', 'IP address blocked', 'Internal error']) {
            const o = mapMvResponse(
                { email: 'a@acme.com', result: '', resultcode: 4, error: e, livemode: false },
                'a@acme.com',
            );
            expect(o.billable).toBe(false);
            expect(o.state).toBe('error');
        }
        expect(fatalVendorError('Apikey not found')).toBe('MV_INVALID_API_KEY');
        expect(fatalVendorError('apikey_not_found')).toBe('MV_INVALID_API_KEY');
        expect(fatalVendorError('Insufficient credits')).toBe('MV_INSUFFICIENT_CREDITS');
        expect(fatalVendorError('Internal error')).toBeNull();
    });
    const SECRET = 'SECRETkey_1234567890';
    it('stops after a fatal error, never leaks the key', async () => {
        const f = vi.fn(async () =>
            json({ email: 'a@acme.com', result: '', resultcode: 4, error: 'Apikey not found', livemode: false }),
        );
        const c = new MillionVerifierClient(SECRET, f as unknown as typeof fetch);
        const o1 = await c.verify('a@acme.com', 'acme.com');
        const o2 = await c.verify('b@acme.com', 'acme.com');
        expect(o1.error).toBe('MV_INVALID_API_KEY');
        expect(o2.error).toBe('MV_INVALID_API_KEY');
        expect(f).toHaveBeenCalledTimes(1);
        expect(c.stoppedReason).toBe('MV_INVALID_API_KEY');
        expect(JSON.stringify([o1, o2, c])).not.toContain(SECRET);
        expect(String(f.mock.calls[0][0])).toMatch(new RegExp(`^${MV_ENDPOINT.replace(/[.?/]/g, '\\$&')}`));
    });
    it('pre-flight stops a wrong key before any verification call', async () => {
        const f = vi.fn(async () => json({ result: 'error', error: 'apikey_not_found' }));
        const c = new MillionVerifierClient(SECRET, f as unknown as typeof fetch);
        await c.preflight();
        expect(c.stoppedReason).toBe('MV_INVALID_API_KEY');
        expect((await c.verify('a@acme.com', 'acme.com')).error).toBe('MV_INVALID_API_KEY');
        expect(f).toHaveBeenCalledTimes(1);
        expect(String(f.mock.calls[0][0])).toContain('/api/v3/credits');
    });
    it('pre-flight is skipped for demo keys and ignores network errors', async () => {
        const f = vi.fn(async () => {
            throw new Error('down');
        });
        const demo = new MillionVerifierClient('API_KEY_FOR_OK', f as unknown as typeof fetch);
        await demo.preflight();
        expect(f).not.toHaveBeenCalled();
        const c = new MillionVerifierClient(SECRET, f as unknown as typeof fetch);
        await c.preflight();
        expect(c.stoppedReason).toBeNull();
    });
    it('retries 429 then gives up without billing', async () => {
        const f = vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '0' } }));
        const c = new MillionVerifierClient(SECRET, f as unknown as typeof fetch, {
            timeoutMs: 1000,
            vendorTimeoutSecs: 2,
            concurrency: 2,
            perDomain: 1,
            maxRetries: 1,
        });
        const o = await c.verify('a@acme.com', 'acme.com');
        expect(o).toMatchObject({ state: 'error', error: 'MV_RATE_LIMITED', billable: false });
        expect(f).toHaveBeenCalledTimes(2);
    });
    it('does not retry timeouts (the vendor may already have used a credit)', async () => {
        const f = vi.fn(async () => {
            throw Object.assign(new Error('t'), { name: 'TimeoutError' });
        });
        const c = new MillionVerifierClient(SECRET, f as unknown as typeof fetch);
        expect(await c.verify('a@acme.com', 'acme.com')).toMatchObject({ error: 'MV_TIMEOUT', billable: false });
        expect(f).toHaveBeenCalledTimes(1);
    });
    it('caps concurrency per domain', async () => {
        let active = 0;
        let peak = 0;
        const f = vi.fn(async (u: string | URL | Request) => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((r) => {
                setTimeout(r, 20);
            });
            active -= 1;
            const email = new URL(String(u)).searchParams.get('email');
            return json(live('ok', { email }));
        });
        const c = new MillionVerifierClient(SECRET, f as unknown as typeof fetch);
        const outs = await Promise.all(
            Array.from({ length: 8 }, async (_, i) => c.verify(`u${i}@acme.com`, 'acme.com')),
        );
        expect(peak).toBeLessThanOrEqual(2);
        expect(outs.every((o) => o.billable)).toBe(true);
        expect(c.billable).toBe(8);
    });
});
