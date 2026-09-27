# dsh-manual-retry

DSH 0.1.7-rc.2 + dsh-TUI 0.11.1 port of Pi `/retry`, configured retry exclusions, and pi-retry transient hints. **Partial parity:** DSH's public `followup` opens a new user-role notice turn, not Pi's transactional branch continuation. See [BEHAVIOR.md](BEHAVIOR.md) before enabling daily.

Install: `dsh plugin --profile tui add file:/absolute/path/dsh-manual-retry-0.1.0.tgz --ignore-scripts`. Bundle adds `manual-retry` Host plugin. Existing daily `llm-pi-ai` gateway policy owns 10 retries for `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`; plugin leaves those codes to native policy and prevents configured quota/usage phrases from auto-retrying. It adds 13 pi-retry transient-message hints when classified `PI_AI_ERROR` and no native handler takes ownership. It never retries context overflow or quota/credit/billing failures matching its protected-pattern check.

`/retry` when last turn failed, user-aborted, or crash-interrupted sends one durable model-visible continuation notice, without re-submitting previous human text. Subsequent `/retry` of that same notice turn is blocked, even after another failure; send new human request to reset. No key binding is provided (Pi itself registers `/retry` only). This is **semantic continuation**: model must decide what to repeat; not safe for work where exact Pi side-branch rollback or tool-protocol recovery is necessary.

Optional row override in profile `cordis.patch.yml` (do not add duplicate id):

```yaml
- id: manual-retry
  config:
    maxRetries: 10
    nonRetryableErrorPatterns: ["quota threshold", "使用上限", "insufficient_quota", "quota exceeded", "quota exhausted", "exceeded your current quota", "usage limit reached", "usage limit exceeded", "usage_limit_reached", "spending limit reached", "insufficient balance", "insufficient credits", "credit balance is too low", "credits exhausted"]
```

All settings are applied at plugin load. `retryPrompt` also accepts nonempty string. Defaults match existing Pi `settings.json` (`retry.enabled: true`, `maxRetries: 10`, patterns above) and uncustomized `pi-retry.json` (`{}`). `maxRetries` applies to 13 extra transient hints; native retry budget stays owned by gateway profile.

`@syncended/dsh-retry` 0.2.3 (MIT, Copyright 2026 syncended) was inspected at `/tmp/dshref/syncended-dsh-retry-0.2.3/package`: its `agent/request-error` middleware, `llm/retry` event and session APIs are present at DSH 0.1.7-rc.2, but it has no `/retry`, and its own default retry budget 2 plus `PI_AI_ERROR` fallback do not reproduce Pi's 10 retry budget or explicit exclusions. No code copied or dependency taken.

`pnpm install --ignore-scripts && node --test`; `pnpm pack` creates distributable tarball. No gateway credentials required for tests.

MIT License. Copyright (c) 2026 Xiangzhe.
