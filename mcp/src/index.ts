#!/usr/bin/env node
/**
 * Fairquery stdio MCP server for Apify Actor fairquery/email-validator-mx-disposable.
 * APIFY_TOKEN is only required for tool calls; initialize and tools/list work without it.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ACTOR_ID = 'fairquery~email-validator-mx-disposable';
const APIFY_BASE = 'https://api.apify.com/v2';
const TOOL_NAME = 'validate_emails';

function jsonText(obj: unknown, isError = false) {
    return {
        content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }],
        ...(isError ? { isError: true } : {}),
    };
}

async function runActor(input: Record<string, unknown>, token: string): Promise<unknown> {
    const url = `${APIFY_BASE}/acts/${ACTOR_ID}/run-sync-get-dataset-items?waitForFinish=120`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(input),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
        body = JSON.parse(text);
    } catch {
        /* keep raw text */
    }
    if (!res.ok) {
        const raw = typeof body === 'string' ? body : JSON.stringify(body);
        throw new Error(`Apify Actor run failed (HTTP ${res.status}): ${raw.slice(0, 2000)}`);
    }
    return body;
}

function createServer(): McpServer {
    const server = new McpServer({ name: 'fairquery-email', version: '1.0.0' });

    server.registerTool(
        TOOL_NAME,
        {
            title: 'Validate email addresses (syntax, MX, disposable)',
            description:
                'Validate email addresses without sending mail: syntax, DNS/MX, null MX, disposable and role detection, free-provider flag, typo suggestion, mail provider, SPF/DMARC. Returns one row per email with verdict valid/risky/invalid/unknown and reason codes. Runs Apify Actor fairquery/email-validator-mx-disposable. Requires APIFY_TOKEN.',
            inputSchema: {
                emails: z.array(z.string().min(1)).min(1).describe('Email addresses to validate'),
                checkDns: z.boolean().optional().describe('MX/A lookups (default true)'),
                checkSpfDmarc: z.boolean().optional().describe('Report SPF/DMARC (default true)'),
                allowRoleAccounts: z.boolean().optional().describe('If false, info@/sales@ etc. become risky'),
                allowDisposable: z.boolean().optional().describe('If true, disposable domains are not risky'),
                allowFreeProviders: z.boolean().optional().describe('If false, free webmail becomes risky'),
                maxEmails: z.number().int().min(1).max(100000).optional(),
            },
        },
        async (args) => {
            const token = process.env.APIFY_TOKEN?.trim();
            if (!token) {
                return jsonText(
                    {
                        error: 'APIFY_TOKEN_MISSING',
                        message:
                            'Set the APIFY_TOKEN environment variable to your Apify API token before calling this tool. Initialize and tools/list work without a token.',
                    },
                    true,
                );
            }
            const input: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(args)) if (v !== undefined) input[k] = v;
            try {
                return jsonText(await runActor(input, token));
            } catch (e) {
                return jsonText({ error: 'APIFY_ACTOR_RUN_FAILED', message: e instanceof Error ? e.message : String(e) }, true);
            }
        },
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
