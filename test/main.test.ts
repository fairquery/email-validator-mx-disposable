import { describe, expect, it } from 'vitest';
import {
    isDisposable,
    isFreeProvider,
    isRole,
    levenshtein,
    mailProviderOf,
    parseEmail,
    suggestDomain,
    verdictOf,
} from '../src/checks.js';
import { DohClient, lookupDomain, parseMx, txtValue } from '../src/dns.js';

const base = {
    syntaxValid: true,
    disposable: false,
    role: false,
    free: false,
    domainExists: true,
    hasMx: true,
    nullMx: false,
    implicitMx: false,
    didYouMean: null,
    allowRole: true,
    allowDisposable: false,
    allowFree: true,
};

describe('parseEmail', () => {
    it('accepts and normalizes valid addresses', () => {
        expect(parseEmail(' John.Doe+tag@Example.COM ')).toEqual({
            email: 'John.Doe+tag@example.com',
            local: 'John.Doe+tag',
            domain: 'example.com',
        });
        expect(parseEmail('Jane <jane@acme.io>')?.email).toBe('jane@acme.io');
        expect(parseEmail('mailto:a@b.co')?.domain).toBe('b.co');
        expect(parseEmail('a@münchen.de')?.domain).toBe('xn--mnchen-3ya.de');
    });
    it('rejects invalid addresses', () => {
        for (const bad of [
            'not-an-email',
            'a@b',
            '@b.com',
            'a@',
            'a..b@c.com',
            '.a@c.com',
            'a@-c.com',
            'a@c.1',
            `${'x'.repeat(65)}@c.com`,
            'a b@c.com',
        ]) {
            expect(parseEmail(bad), bad).toBeNull();
        }
    });
});

describe('classifiers', () => {
    it('disposable incl. subdomains', () => {
        expect(isDisposable('mailinator.com')).toBe(true);
        expect(isDisposable('x.mailinator.com')).toBe(true);
        expect(isDisposable('gmail.com')).toBe(false);
    });
    it('role / free / typo / provider', () => {
        expect(isRole('Info')).toBe(true);
        expect(isRole('sales+eu')).toBe(true);
        expect(isRole('jane')).toBe(false);
        expect(isFreeProvider('gmail.com')).toBe(true);
        expect(suggestDomain('gmial.com')).toBe('gmail.com');
        expect(suggestDomain('hotmail.con')).toBe('hotmail.com');
        expect(suggestDomain('gmail.com')).toBeNull();
        expect(suggestDomain('acme-industries.com')).toBeNull();
        expect(levenshtein('kitten', 'sitting')).toBe(3);
        expect(mailProviderOf(['aspmx.l.google.com'])).toBe('Google Workspace / Gmail');
        expect(mailProviderOf(['acme-com.mail.protection.outlook.com'])).toBe('Microsoft 365 / Outlook');
    });
});

describe('verdictOf', () => {
    it('valid / invalid / risky / unknown', () => {
        expect(verdictOf(base).verdict).toBe('valid');
        expect(verdictOf({ ...base, syntaxValid: false })).toEqual({ verdict: 'invalid', reasons: ['INVALID_SYNTAX'] });
        expect(verdictOf({ ...base, domainExists: false, hasMx: false }).reasons).toContain('DOMAIN_NOT_FOUND');
        expect(verdictOf({ ...base, hasMx: false }).reasons).toEqual(['NO_MAIL_SERVER']);
        expect(verdictOf({ ...base, hasMx: false, nullMx: true }).reasons).toEqual(['NULL_MX']);
        expect(verdictOf({ ...base, disposable: true }).verdict).toBe('risky');
        expect(verdictOf({ ...base, disposable: true, allowDisposable: true }).verdict).toBe('valid');
        expect(verdictOf({ ...base, role: true }).verdict).toBe('valid');
        expect(verdictOf({ ...base, role: true, allowRole: false }).verdict).toBe('risky');
        expect(verdictOf({ ...base, free: true, allowFree: false }).verdict).toBe('risky');
        expect(verdictOf({ ...base, didYouMean: 'gmail.com' }).verdict).toBe('risky');
        expect(verdictOf({ ...base, hasMx: false, implicitMx: true }).verdict).toBe('risky');
        expect(verdictOf({ ...base, domainExists: null, hasMx: null }).verdict).toBe('unknown');
    });
});

describe('dns', () => {
    it('parses MX and TXT', () => {
        expect(
            parseMx([
                { name: 'x', type: 15, data: '10 b.example.com.' },
                { name: 'x', type: 15, data: '5 A.example.com.' },
            ]),
        ).toEqual([
            { priority: 5, exchange: 'a.example.com' },
            { priority: 10, exchange: 'b.example.com' },
        ]);
        expect(txtValue('"v=spf1 " "include:_spf.google.com ~all"')).toBe('v=spf1 include:_spf.google.com ~all');
    });
    it('lookupDomain handles NXDOMAIN, null MX, implicit MX, SPF/DMARC, retries', async () => {
        const zone: Record<string, { Status: number; Answer?: unknown[] }> = {
            'nx.test|MX': { Status: 3 },
            'null.test|MX': { Status: 0, Answer: [{ name: 'null.test', type: 15, data: '0 .' }] },
            'a.test|MX': { Status: 0 },
            'a.test|A': { Status: 0, Answer: [{ name: 'a.test', type: 1, data: '1.2.3.4' }] },
            'a.test|AAAA': { Status: 0 },
            'ok.test|MX': { Status: 0, Answer: [{ name: 'ok.test', type: 15, data: '1 aspmx.l.google.com.' }] },
            'ok.test|TXT': { Status: 0, Answer: [{ name: 'ok.test', type: 16, data: '"v=spf1 -all"' }] },
            '_dmarc.ok.test|TXT': {
                Status: 0,
                Answer: [{ name: '_dmarc.ok.test', type: 16, data: '"v=DMARC1; p=reject"' }],
            },
        };
        let first = true;
        const fake = (async (url: string) => {
            if (first) {
                first = false;
                return new Response('x', { status: 503 });
            }
            const u = new URL(url);
            return Response.json(zone[`${u.searchParams.get('name')}|${u.searchParams.get('type')}`] ?? { Status: 0 });
        }) as unknown as typeof fetch;
        const c = new DohClient(fake);
        expect((await lookupDomain(c, 'nx.test', true)).exists).toBe(false);
        const n = await lookupDomain(c, 'null.test', false);
        expect(n.nullMx).toBe(true);
        expect(n.mx).toEqual([]);
        expect((await lookupDomain(c, 'a.test', false)).implicitMx).toBe(true);
        const ok = await lookupDomain(c, 'ok.test', true);
        expect(ok).toMatchObject({ spf: true, dmarc: true, dmarcPolicy: 'reject', implicitMx: false });
    });
});

describe('typo domains of major providers', () => {
    it.each(['gmial.com', 'gmal.com', 'hotmial.com', 'yaho.com'])('%s is a typo, not disposable', (d) => {
        expect(isDisposable(d)).toBe(false);
        expect(suggestDomain(d)).toMatch(/^(gmail|hotmail|yahoo)\.com$/);
    });
});
