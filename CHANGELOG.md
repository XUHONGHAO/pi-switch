# Changelog

## Unreleased

### Added

- **Explicit cache domains**: bindings may declare `cacheDomain` to mark routes the user expects to share prompt cache. On failover, candidates are ordered same-binding accounts -> same cache domain -> remaining routes; it never changes initial selection. Config validation rejects empty values and warns when a domain spans multiple API protocols or hosts. See ADR 0009.
- **Host-level affinity E2E**: `tests/host-session-affinity.integration.test.ts` loads the real extension through pi's `DefaultResourceLoader`, drives real `AgentSession` turns, and verifies that a post-failover route is persisted as a Custom Entry and restored by a fresh extension instance via `SessionManager.open`. Harness details in ADR 0010.
- **Deferred scope documented**: account quota automation and TUI-owned native cache switches remain explicitly deferred with entry criteria in ADR 0007.
- **Routing hardening**: connection errors such as `Connection error.` now classify as network failures; invalid external reloads are rejected without replacing the last valid config; duplicate implicit binding identities are rejected; and abnormal streams update the last failed route correctly.
- **Phase E current batch**: verifies Custom Entry affinity restoration for resumed/tree branches, uses the latest persisted entry, and prevents `/new`, `/fork` and `/clone` sessions from inheriting the parent session's route or account.
- **Phase E second batch**: classifies timeout cost risk by request phase; connection/setup timeouts remain low risk, while timeouts after HTTP response use context length and policy to detect high-cost retries. Any received HTTP response now advances diagnostics to `awaiting-response`, including non-2xx responses.
- **Phase E first batch**: persists the latest attempt's HTTP status, `Retry-After`, request phase, failure scope, action, cost risk, reason, cooldown, circuit decision and attempt budget; `/switch status` now exposes the diagnostic summary alongside usage telemetry.
- **Phase D second batch**: preserves non-2xx HTTP status and `Retry-After` metadata through the native fetch path, so 403 account recovery is classified as unknown risk instead of being reported as a generic medium-risk auth failure.
- **Account/line hierarchy (Phase D first batch)**: bindings can restrict their account pool with `accounts`; 401/429 failover prefers another account on the same binding, and successful account switches remain session-affine and `/resume`-restorable.
- **Cost-aware failover (Phase B/C first batch)**: records context usage, cache read/write, cost and affinity telemetry; adds structured failure decisions with `failureCostPolicy`, `maxAttempts`, `maxHighCostFailovers` and conservative unknown-error handling.
- Session affinity is persisted as a pi Custom Entry using only a SHA-256 session id hash, so `/resume` restores the line without exposing the raw session id.
- **Session affinity (Phase A)**: `balance` now defaults to session-scoped distribution using rendezvous hashing, keeping each pi session on the same binding for better cache hit rates. `failover` also sticks to the switched binding within the same session. Add `"balanceScope": "request"` to `routing.json` to restore legacy round-robin behavior.
- Protocol-level regression tests pinning the pi-native passthrough contract: `options.sessionId`, `options.cacheRetention` and the routed model `compat` reach pi-ai transports intact, and pi's own session id is what aliases forward.

### Changed

- **Breaking (minor)**: `balance` strategy now distributes sessions rather than individual requests by default. This improves cache efficiency but changes observable load distribution. Use `"balanceScope": "request"` for the old behavior.

### Documentation

- Added `docs/architecture/pi-native-passthrough.md` describing which cache and session-affinity fields each pi-ai transport generates, and under which `compat` preconditions.

## 0.3.2 - 2026-08-13

### Fixed

- `/config strategy` now merges into the existing `routing.json` instead of wiping `failureThreshold` / `cooldownMs` / `rateLimitCooldownMs`.
- Deleting a Provider checks dependents and can cascade-clean related accounts and alias bindings instead of failing validation silently.
- Startup model discovery and `refreshModels` resolve the same secret syntax as request paths (`$ENV`, `$!`, `!command`).
- Alias models pass through configured `input` modalities so vision aliases are no longer forced text-only.
- Provider apiKey edit prompt now matches account semantics: empty input keeps the current value; use explicit “清除 apiKey” to remove it.

### Changed

- `ModelAliasConfig` accepts optional `input: ("text" | "image")[]`.

## 0.3.1 - 2026-08-12

### Changed

- Circuit-breaker and attempt-stat identities now operate at binding level instead of only provider/account level.
- Structured HTTP status and `Retry-After` headers take precedence over message-based error parsing.
- Added `authProvider` delegation for custom provider ids and binding-level overrides.
- Compatibility validation is protocol-aware; `thinkingLevelMap` accepts pi-ai's `max` level.
- Added AliasProvider + ModelRegistry header-only auth + OpenAI Responses integration coverage.
- Added explicit npm publish exclusions, MIT license, changelog, and automatic prepack checks.

### Compatibility

- Existing bindings remain valid. Their generated attempt-stat keys change to the new binding identity format.
- Existing `stats.json` entries are retained; new attempts are written under binding-level keys.

## 0.3.0

- Added native OpenAI Responses, Anthropic Messages, and Google Generative AI alias transports.
- Added binding-level protocol/endpoint/compat overrides and pi ModelRegistry authentication delegation.
