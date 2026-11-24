# Changelog (MCP server)

## 1.1.3 - 2026-10-18
- Tool text only (Glama conciseness pass): BEHAVIOR no longer restates the read-only annotation; validate_emails RETURNS now explains the reason -> verdict mapping and the error rows (DNS_LOOKUP_FAILED replaces that email's row and is retryable; MAX_EMAILS_EXCEEDED; INPUT_EMPTY) instead of repeating `outputSchema` fields.
- check_email_syntax: states it is synchronous and CPU-bound with no rate limit (10,000 addresses in well under a second).
- No tool names, input or output schemas, limits, behavior or prices changed.
