#!/usr/bin/env node
/**
 * Fairquery Email Validator stdio MCP server.
 * - validate_emails: runs Apify Actor fairquery/email-validator-mx-disposable (APIFY_TOKEN, pay-per-event).
 * - check_email_syntax: free, local syntax/normalization check (no network).
 * initialize and tools/list work without any token.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { READ_ONLY_OPEN_WORLD, compact, proxyActor, rowsOutputSchema, rowsResult } from './common.js';

const ACTOR_ID = 'fairquery~email-validator-mx-disposable';
const EMAIL_RE = /^(?=.{1,254}$)(?=[^@]{1,64}@)[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

function syntaxRow(input: string): Record<string, unknown> {
    const m = input.trim().match(/<([^>]+)>\s*$/);
    const email = (m ? m[1] : input).trim();
    const valid = EMAIL_RE.test(email) && !email.split('@')[0].startsWith('.') && !email.split('@')[0].endsWith('.') && !email.includes('..');
    const [local, domain] = valid ? email.split('@') : [null, null];
    return {
        type: 'email_syntax',
        input,
        email: valid ? `${local}@${domain!.toLowerCase()}` : email,
        syntax_valid: valid,
        local_part: local,
        domain: domain ? domain.toLowerCase() : null,
        reason: valid ? null : 'INVALID_SYNTAX',
    };
}

function createServer(): McpServer {
    const server = new McpServer({ name: 'fairquery-email', version: '1.1.0' });

    server.registerTool(
        'validate_emails',
        {
            title: 'Validate email addresses (syntax, MX, disposable, typo)',
            description: [
                'Validate email addresses for deliverability risk: RFC-style syntax, domain existence and MX records (DNS-over-HTTPS), null MX, disposable/temporary inbox domains, role accounts (info@, sales@), free webmail providers, common domain typos with a "did you mean" suggestion, and optional SPF/DMARC presence and policy.',
                'When to use: cleaning signup or lead lists, checking an address before sending, or flagging throwaway signups. For a quick offline format check with no cost use check_email_syntax instead. Does NOT send email or perform SMTP mailbox probing, so it cannot confirm that a specific mailbox exists.',
                'Behavior: read-only; runs the Fairquery Apify Actor fairquery/email-validator-mx-disposable via the Apify API (DNS lookups via Cloudflare DoH). Requires APIFY_TOKEN. Duplicates (case-insensitive) are skipped. Typical run 3-30 s.',
                'Cost (billed to the Apify account): $0.00005 per run + $0.002 per email row with a verdict; error rows are free. 100 emails ~ $0.20.',
                'Returns {count, items}. email rows: input, email, domain, verdict (valid | risky | invalid | unknown), reasons[] (INVALID_SYNTAX, DOMAIN_NOT_FOUND, NULL_MX, NO_MAIL_SERVER -> invalid; DISPOSABLE_DOMAIN, ROLE_ACCOUNT, FREE_PROVIDER, POSSIBLE_TYPO, IMPLICIT_MX_ONLY -> risky depending on allow* flags; DNS_NOT_CHECKED -> unknown), syntax_valid, is_disposable, is_role_account, is_free_provider, did_you_mean, domain_exists, has_mx, mx_records, mail_provider, has_spf, has_dmarc, dmarc_policy, source_url, checked_at. error rows: code (INPUT_EMPTY, MAX_EMAILS_EXCEEDED, DNS_LOOKUP_FAILED), message, retryable.',
            ].join('\n'),
            inputSchema: {
                emails: z
                    .array(z.string().min(1))
                    .min(1)
                    .max(10000)
                    .describe('Email addresses to validate. Entries may also be comma/semicolon/newline-separated lists or "Name <addr>" forms. Example: ["john.doe@gmail.com","someone@gmial.com"]'),
                checkDns: z
                    .boolean()
                    .optional()
                    .describe('Look up MX/A records to confirm the domain can receive mail (default true). false = syntax/list checks only, verdict may be "unknown".'),
                checkSpfDmarc: z
                    .boolean()
                    .optional()
                    .describe('Also report SPF and DMARC presence and DMARC policy per domain (default true)'),
                allowRoleAccounts: z
                    .boolean()
                    .optional()
                    .describe('Default true. If false, role addresses (info@, sales@, support@...) get verdict "risky".'),
                allowDisposable: z
                    .boolean()
                    .optional()
                    .describe('Default false (disposable domains are "risky"). Set true to not penalize disposable domains.'),
                allowFreeProviders: z
                    .boolean()
                    .optional()
                    .describe('Default true. If false, free webmail (gmail.com, outlook.com...) gets "risky" - useful for B2B lead lists.'),
                maxEmails: z
                    .number()
                    .int()
                    .min(1)
                    .max(100000)
                    .optional()
                    .describe('Safety cap on unique emails per run (default 10000); extras produce a MAX_EMAILS_EXCEEDED error row'),
            },
            outputSchema: rowsOutputSchema,
            annotations: { title: 'Validate email addresses (syntax, MX, disposable, typo)', ...READ_ONLY_OPEN_WORLD },
        },
        async (args) => proxyActor(ACTOR_ID, compact(args)),
    );

    server.registerTool(
        'check_email_syntax',
        {
            title: 'Check email syntax offline (free)',
            description: [
                'Check whether strings are syntactically valid email addresses and normalize them (extracts "Name <addr>", lowercases the domain), entirely locally.',
                'When to use: fast pre-filtering or parsing before calling validate_emails, or when only the format matters. It does not check that the domain exists, has MX records, is disposable or is a typo - use validate_emails for deliverability.',
                'Behavior: pure function, no network, no token, no cost, deterministic.',
                'Returns {count, items}: one "email_syntax" row per input with input, email (normalized), syntax_valid, local_part, domain, reason (null or INVALID_SYNTAX).',
            ].join('\n'),
            inputSchema: {
                emails: z.array(z.string()).min(1).max(10000).describe('Strings to check, e.g. ["Jane <jane@Example.com>","not-an-email"]'),
            },
            outputSchema: rowsOutputSchema,
            annotations: {
                title: 'Check email syntax offline (free)',
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async ({ emails }) => rowsResult(emails.map(syntaxRow)),
    );

    return server;
}

async function main(): Promise<void> {
    await createServer().connect(new StdioServerTransport());
}

main().catch((err) => {
    console.error('fairquery-email MCP server failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
});
