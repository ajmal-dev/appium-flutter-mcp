# Security Policy

## Supported versions

This project is at v1.x. Security fixes will be issued on the latest minor release.

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, open a [GitHub Security Advisory](../../security/advisories/new) on this repository — that creates a private channel where the maintainers can triage and patch before public disclosure.

If you can't use GitHub Security Advisories, contact the maintainer directly through the email listed on the project's GitHub profile.

When reporting, please include:
- A clear description of the vulnerability and its potential impact
- Steps to reproduce (a minimal proof-of-concept is ideal)
- Affected version(s)
- Any suggested mitigation

We aim to acknowledge reports within 72 hours and ship a fix or mitigation within 30 days for high-severity issues.

## Scope

This MCP server runs locally and brokers between an MCP client (e.g. Claude Code) and an Appium server. In-scope concerns include:

- Command injection in tool handlers
- Path-traversal in any path-handling code (CUA test files, baseline storage, source scanners)
- Logic flaws that could cause an agent to leak credentials passed in env vars
- Dependencies with known CVEs

Out of scope:
- Vulnerabilities in Appium itself or in `appium-flutter-integration-driver` (report those upstream)
- Security of the target Flutter app being tested
