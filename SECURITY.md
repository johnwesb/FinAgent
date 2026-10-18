# Security Policy

FinQDesk is a **local-first research tool** and is **not hardened for public
internet exposure**. In particular, `/api/admin` (reseed / wipe) and
`/api/mcp` are unauthenticated by design for local use. Do not deploy it
publicly without adding authentication in front of the whole app.

## Reporting a vulnerability

Please report privately through GitHub's
[Report a vulnerability](../../security/advisories/new) form rather than a
public issue. We aim to acknowledge reports within 7 days.

## Scope notes

- **Not financial advice.** Quotes may be delayed or simulated (always
  labelled in the UI and in tool output). Positions are whatever you enter;
  there is no broker link.
- **Secrets** belong in `.env`, which is git-ignored. Never commit database
  URLs or API keys.
- **Data:** the bundled graph is hand-authored synthetic demo data plus
  public market/filing data. Do not load private, paywalled, or personal
  information into the graph.
- **Tenancy** (`x-tenant` header / `--tenant` flag) separates memory,
  threads and positions logically; it is **not** an authentication boundary.
