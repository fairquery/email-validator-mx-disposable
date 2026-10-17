/**
 * Domain age via RDAP (RFC 9082/9083), with servers taken ONLY from the IANA RDAP bootstrap registry (RFC 9224).
 * - No user-controlled URLs: the domain is validated (LDH labels) by parseEmail, and the base URL comes from the
 *   bootstrap. Redirects are followed once, and only to another HTTPS origin that is itself in the bootstrap.
 * - Every request has a timeout; the whole phase has a time budget and a lookup cap. Failures return null.
 */
import { RDAP_BOOTSTRAP_SNAPSHOT } from './data/rdap-bootstrap.js';

export const IANA_RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const MAX_BODY_BYTES = 512 * 1024;
const sleep = async (ms: number) =>
    new Promise<void>((r) => {
        setTimeout(r, ms);
    });

export interface RdapResult {
    registeredAt: string | null;
    source: string | null;
    status: 'ok' | 'not_found' | 'no_rdap_server' | 'no_registration_date' | 'error' | 'skipped_budget';
    cached?: boolean;
}

// Second-level labels that are public suffixes under many ccTLDs (example.co.uk -> registrable example.co.uk).
const COMMON_SLDS = new Set([
    'co',
    'com',
    'net',
    'org',
    'gov',
    'edu',
    'ac',
    'ne',
    'or',
    'go',
    'gob',
    'nom',
    'ltd',
    'plc',
    'biz',
    'info',
    'mil',
]);

/** Heuristic registrable domain (no full Public Suffix List bundled). */
export function registrableDomain(domain: string): string {
    const p = domain.toLowerCase().split('.');
    if (p.length <= 2) return p.join('.');
    const tld = p[p.length - 1];
    const sld = p[p.length - 2];
    if (tld.length === 2 && COMMON_SLDS.has(sld)) return p.slice(-3).join('.');
    return p.slice(-2).join('.');
}

export function parseBootstrap(json: unknown): Record<string, string> | null {
    if (!json || typeof json !== 'object') return null;
    const { services } = json as { services?: unknown };
    if (!Array.isArray(services)) return null;
    const out: Record<string, string> = {};
    for (const svc of services) {
        if (!Array.isArray(svc) || svc.length < 2 || !Array.isArray(svc[0]) || !Array.isArray(svc[1])) continue;
        const url = (svc[1] as unknown[]).find((u): u is string => typeof u === 'string' && u.startsWith('https://'));
        if (!url) continue;
        try {
            const u = new URL(url);
            if (u.protocol !== 'https:' || u.username || u.password) continue;
        } catch {
            continue;
        }
        for (const t of svc[0] as unknown[]) {
            if (typeof t === 'string' && /^[a-z0-9-]{2,63}$/i.test(t))
                out[t.toLowerCase()] = url.endsWith('/') ? url : `${url}/`;
        }
    }
    return Object.keys(out).length > 100 ? out : null;
}

export function registrationDate(json: unknown): string | null {
    const events = (json as { events?: unknown })?.events;
    if (!Array.isArray(events)) return null;
    for (const e of events) {
        const ev = e as { eventAction?: unknown; eventDate?: unknown };
        if (ev?.eventAction === 'registration' && typeof ev.eventDate === 'string') {
            const t = Date.parse(ev.eventDate);
            if (Number.isFinite(t) && t > Date.UTC(1984, 0, 1) && t <= Date.now() + 86_400_000)
                return new Date(t).toISOString();
        }
    }
    return null;
}

export function ageDays(registeredAt: string | null, now = Date.now()): number | null {
    if (!registeredAt) return null;
    const t = Date.parse(registeredAt);
    if (!Number.isFinite(t)) return null;
    return Math.max(0, Math.floor((now - t) / 86_400_000));
}

async function readCapped(res: Response): Promise<string | null> {
    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > MAX_BODY_BYTES) return null;
    const text = await res.text();
    return text.length > MAX_BODY_BYTES ? null : text;
}

export class RdapClient {
    servers: Record<string, string> = { ...RDAP_BOOTSTRAP_SNAPSHOT };
    bootstrapSource: 'live' | 'snapshot' = 'snapshot';
    private allowedOrigins = new Set<string>();
    requests = 0;
    failures = 0;
    private perOrigin = new Map<string, number>();

    constructor(
        private readonly fetchImpl: typeof fetch = fetch,
        private readonly timeoutMs = 6_000,
        private readonly perOriginConcurrency = 2,
    ) {
        this.rebuildOrigins();
    }

    private rebuildOrigins() {
        this.allowedOrigins = new Set(Object.values(this.servers).map((u) => new URL(u).origin));
    }

    async loadBootstrap(): Promise<void> {
        try {
            const res = await this.fetchImpl(IANA_RDAP_BOOTSTRAP_URL, {
                signal: AbortSignal.timeout(this.timeoutMs),
                redirect: 'error',
            });
            if (!res.ok) return;
            const text = await readCapped(res);
            const parsed = text ? parseBootstrap(JSON.parse(text)) : null;
            if (parsed) {
                this.servers = parsed;
                this.bootstrapSource = 'live';
                this.rebuildOrigins();
            }
        } catch {
            // keep the bundled snapshot
        }
    }

    isAllowed(url: string): boolean {
        try {
            const u = new URL(url);
            return u.protocol === 'https:' && !u.username && !u.password && this.allowedOrigins.has(u.origin);
        } catch {
            return false;
        }
    }

    /** domain must already be validated (LDH labels); registrable domain is derived here. */
    async lookup(domain: string): Promise<RdapResult> {
        const reg = registrableDomain(domain);
        const tld = reg.split('.').pop() ?? '';
        const base = this.servers[tld];
        if (!base || !/^[a-z0-9.-]+$/.test(reg)) return { registeredAt: null, source: null, status: 'no_rdap_server' };
        const url = `${base}domain/${encodeURIComponent(reg)}`;
        const { origin } = new URL(base);
        await this.acquire(origin);
        try {
            return await this.fetchRdap(url, 0);
        } finally {
            this.release(origin);
        }
    }

    private async fetchRdap(url: string, hop: number, retry429 = true): Promise<RdapResult> {
        if (!this.isAllowed(url)) return { registeredAt: null, source: null, status: 'error' };
        this.requests += 1;
        try {
            const res = await this.fetchImpl(url, {
                headers: { accept: 'application/rdap+json, application/json' },
                redirect: 'manual',
                signal: AbortSignal.timeout(this.timeoutMs),
            });
            if (res.status >= 300 && res.status < 400) {
                const loc = res.headers.get('location');
                if (!loc || hop >= 1) return this.fail();
                const next = new URL(loc, url).toString();
                return this.isAllowed(next) ? this.fetchRdap(next, hop + 1, retry429) : this.fail();
            }
            if (res.status === 404) return { registeredAt: null, source: url, status: 'not_found' };
            if (res.status === 429 && retry429) {
                // Registries rate-limit RDAP (e.g. rdap.org: 10 req/10 s). Back off once, then fail soft.
                await res.body?.cancel().catch(() => undefined);
                const ra = Number(res.headers.get('retry-after'));
                await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3) * 1000 : 1500);
                return this.fetchRdap(url, hop, false);
            }
            if (!res.ok) return this.fail();
            const text = await readCapped(res);
            if (!text) return this.fail();
            const date = registrationDate(JSON.parse(text));
            return { registeredAt: date, source: url, status: date ? 'ok' : 'no_registration_date' };
        } catch {
            return this.fail();
        }
    }

    private fail(): RdapResult {
        this.failures += 1;
        return { registeredAt: null, source: null, status: 'error' };
    }

    private async acquire(origin: string) {
        while ((this.perOrigin.get(origin) ?? 0) >= this.perOriginConcurrency) {
            await new Promise<void>((r) => {
                setTimeout(r, 50);
            });
        }
        this.perOrigin.set(origin, (this.perOrigin.get(origin) ?? 0) + 1);
    }

    private release(origin: string) {
        this.perOrigin.set(origin, Math.max(0, (this.perOrigin.get(origin) ?? 1) - 1));
    }
}

/** Minimal KV interface so the cache is testable without the platform. */
export interface KvLike {
    getValue<T>(key: string): Promise<T | null>;
    setValue(key: string, value: unknown): Promise<void>;
}

interface CacheEntry {
    r: string; // registration date ISO
    s: string; // source URL
    t: number; // cached at (ms)
}

export const RDAP_CACHE_TTL_MS = 30 * 86_400_000;
const SHARDS = 64;
const MAX_ENTRIES_PER_SHARD = 5_000;

/* eslint-disable no-bitwise -- FNV-1a hash for cache sharding */
function shardOf(domain: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < domain.length; i++) {
        h ^= domain.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `rdap-v1-${(h % SHARDS).toString(16).padStart(2, '0')}`;
}
/* eslint-enable no-bitwise */

/**
 * Sharded cache of successful RDAP registration dates (domain names and dates only, no email addresses).
 * 64 shard records keep KV operations per run small (at most 64 reads + 64 writes).
 */
export class RdapCache {
    private shards = new Map<string, Record<string, CacheEntry>>();
    private dirty = new Set<string>();
    hits = 0;

    constructor(
        private readonly kv: KvLike | null,
        private readonly now = () => Date.now(),
    ) {}

    private async shard(key: string): Promise<Record<string, CacheEntry>> {
        let s = this.shards.get(key);
        if (!s) {
            let loaded: Record<string, CacheEntry> | null = null;
            try {
                loaded = this.kv ? await this.kv.getValue<Record<string, CacheEntry>>(key) : null;
            } catch {
                loaded = null;
            }
            s = loaded && typeof loaded === 'object' ? loaded : {};
            this.shards.set(key, s);
        }
        return s;
    }

    async get(reg: string): Promise<RdapResult | null> {
        const s = await this.shard(shardOf(reg));
        const e = s[reg];
        if (!e || typeof e.r !== 'string' || this.now() - e.t > RDAP_CACHE_TTL_MS) return null;
        this.hits += 1;
        return { registeredAt: e.r, source: e.s, status: 'ok', cached: true };
    }

    async set(reg: string, r: RdapResult): Promise<void> {
        if (r.status !== 'ok' || !r.registeredAt) return;
        const key = shardOf(reg);
        const s = await this.shard(key);
        s[reg] = { r: r.registeredAt, s: r.source ?? '', t: this.now() };
        this.dirty.add(key);
    }

    async flush(): Promise<void> {
        if (!this.kv) return;
        const cutoff = this.now() - RDAP_CACHE_TTL_MS;
        for (const key of this.dirty) {
            const s = this.shards.get(key) ?? {};
            const entries = Object.entries(s)
                .filter(([, e]) => e.t >= cutoff)
                .sort((a, b) => b[1].t - a[1].t)
                .slice(0, MAX_ENTRIES_PER_SHARD);
            try {
                await this.kv.setValue(key, Object.fromEntries(entries));
            } catch {
                // cache is best effort
            }
        }
        this.dirty.clear();
    }
}
