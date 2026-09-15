# Changelog

## Unreleased

### Added

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
