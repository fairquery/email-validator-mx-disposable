// Offline helper (not part of the Actor runtime): resolves MX for every bundled disposable domain
// via Cloudflare DoH and writes counts per MX host. Output: /tmp/disposable-mx.json
import { readFileSync, writeFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/data/disposable.ts', import.meta.url), 'utf8');
const domains = [...src.matchAll(/^\s+'([^']+)',$/gm)].map((m) => m[1]);
console.log('domains', domains.length);
const out = {};
let i = 0;
async function q(d) {
    for (let a = 0; a < 3; a++) {
        try {
            const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(d)}&type=MX`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000) });
            if (!r.ok) { await new Promise((s) => setTimeout(s, 500 * (a + 1))); continue; }
            const j = await r.json();
            return (j.Answer ?? []).filter((x) => x.type === 15).map((x) => (x.data.split(/\s+/)[1] ?? '').replace(/\.$/, '').toLowerCase()).filter(Boolean);
        } catch { await new Promise((s) => setTimeout(s, 500 * (a + 1))); }
    }
    return null;
}
async function worker() { while (i < domains.length) { const d = domains[i++]; out[d] = await q(d); } }
await Promise.all(Array.from({ length: 30 }, worker));
writeFileSync('/tmp/disposable-mx.json', JSON.stringify(out));
console.log('done', Object.values(out).filter((v) => v && v.length).length, 'with MX');
