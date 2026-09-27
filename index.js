/**
 * dsh-manual-retry — manual `/retry` command + non-retryable error veto for
 * DeepSeek Harness. Port of the user's Pi manual-retry behavior:
 *
 *  - `/retry` after a failed/aborted turn opens exactly one retry turn over
 *    the durable history, without duplicating the user message.
 *  - Errors matching `retry.nonRetryableErrorPatterns` (Pi settings) are
 *    never auto-retried; ordinary rate limits / 5xx stay retryable through
 *    the provider's own retryPolicy (dsh-llm-retry).
 *
 * Runtime service injections come from Cordis. `@deepseek-ai/schemastery`
 * exposes user-editable defaults; `zod` validates durable projection state.
 *
 * @module dsh-manual-retry
 */

import { z } from "zod";
import schema from "@deepseek-ai/schemastery";
import {
	DEFAULT_NON_RETRYABLE_PATTERNS,
	DEFAULT_RETRY_PROMPT,
	RETRY_HINTS,
	buildRetryMessage,
	initialRetryFold,
	matchesRetryHint,
	matchesNonRetryable,
	resolveConfig,
	retryDecision,
	retryFold,
} from "./core.js";

export const name = "dsh-manual-retry";
export const inject = ["commands", "sessionProjections"];

export const Config = schema.object({
	maxRetries: schema.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(10),
	nonRetryableErrorPatterns: schema.array(schema.string()).default([...DEFAULT_NON_RETRYABLE_PATTERNS]),
	retryPrompt: schema.string().min(1).default(DEFAULT_RETRY_PROMPT),
});

export const USAGE = "Usage: /retry (no arguments)";

const retryFoldSchema = z.object({
	turn: z.number().int().nonnegative(),
	open: z.boolean(),
	end: z.string().nullable(),
	retryTurn: z.boolean(),
	errorMessage: z.string().nullable(),
	queued: z.array(z.object({ id: z.string(), kind: z.string().nullable(), content: z.array(z.unknown()) })),
	lost: z.array(z.object({ id: z.string(), content: z.array(z.unknown()) })),
});

export function apply(ctx, config = {}) {
	const resolved = resolveConfig(config);

	// Pi `retry.nonRetryableErrorPatterns`: prepended (outermost) so the veto
	// runs before dsh-llm-retry's policy listener; not calling next() leaves
	// the failure terminal, exactly Pi's "skip auto-retry" outcome.
	ctx.on(
		"agent/request-error",
		(payload, next) => {
			if (matchesNonRetryable(payload?.failure?.message, resolved.nonRetryableErrorPatterns)) {
				ctx.logger.info(
					"dsh-manual-retry: auto-retry vetoed by nonRetryableErrorPatterns (code %s)",
					payload?.failure?.code ?? "UNKNOWN",
				);
				return undefined;
			}
			return next();
		},
		true,
	);

	ctx.sessionProjections.register({
		key: "manualRetryHints",
		stateVersion: 1,
		stateSchema: z.object({ attempt: z.number().int().nonnegative() }),
		init: () => ({ attempt: 0 }),
		apply: (state, event) => event.type === "step/start" || event.type === "turn/end"
			? { attempt: 0 }
			: event.type === "llm/retry" && event.data?.policyKey === "dsh-manual-retry/hints-v1"
				? { attempt: event.data.retry }
				: state,
	});

	// Pi pi-retry's extra transient phrases: defer to native DSH policies first,
	// then retry only explicitly recognized generic failures, never protected limits.
	ctx.on("agent/request-error", async (payload, next) => {
		const decision = await next();
		if (decision || !matchesRetryHint(payload.failure, resolved.nonRetryableErrorPatterns) ||
			payload.retryPolicy?.mode === "always" || payload.signal.aborted) return decision;
		const attempt = (ctx.sessionProjections.stateOf(payload.agent.session, "manualRetryHints")?.attempt ?? 0) + 1;
		if (attempt > resolved.maxRetries) return;
		const delayMs = Math.min(500 * 2 ** Math.min(attempt - 1, 20), 60_000);
		const retryId = `dsh-manual-retry:hint:${payload.turn}:${payload.step}`;
		payload.agent.session.append("llm/retry", {
			retryId, turn: payload.turn, step: payload.step, provider: payload.provider,
			mode: "normal", policyKey: "dsh-manual-retry/hints-v1",
			retry: attempt, maxRetries: resolved.maxRetries, delayMs, failure: payload.failure,
		});
		const started = await new Promise((resolve) => {
			if (payload.signal.aborted) return resolve(false);
			const onAbort = () => { clearTimeout(timer); resolve(false); };
			const timer = setTimeout(() => {
				payload.signal.removeEventListener("abort", onAbort);
				resolve(true);
			}, delayMs);
			payload.signal.addEventListener("abort", onAbort, { once: true });
		});
		if (!started || payload.signal.aborted) return;
		payload.agent.session.append("llm/retry-started", { retryId, turn: payload.turn, step: payload.step, retry: attempt });
		return { kind: "retry" };
	});

	ctx.sessionProjections.register({
		key: "manualRetry",
		stateVersion: 3,
		stateSchema: retryFoldSchema,
		init: () => initialRetryFold,
		apply: retryFold,
	});

	// Double-submission guard: followup() wakes an idle agent synchronously,
	// so this only covers reentrant dispatch inside one tick.
	const submitting = new Set();

	ctx.commands.register({
		name: "retry",
		description: "Retry the last failed or interrupted request",
		handler: (invocation) => {
			if (invocation.rawInput.trim().length > 0 || invocation.attachments.length > 0) {
				return { kind: "error", text: USAGE };
			}
			const agent = invocation.agent;
			if (agent.status !== "idle") {
				return { kind: "error", text: "Cannot retry while the agent is running." };
			}
			if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) {
				return { kind: "error", text: "Cannot retry while messages are queued." };
			}
			const state = ctx.sessionProjections.stateOf(agent.session, "manualRetry") ?? initialRetryFold;
			const decision = retryDecision(state);
			if (!decision.ok) {
				return { kind: "error", text: decision.text };
			}
			if (submitting.has(agent.id)) {
				return { kind: "error", text: "A retry is already being submitted." };
			}
			submitting.add(agent.id);
			try {
				agent.followup(buildRetryMessage(agent.id, decision.turn, resolved.retryPrompt, decision.summary, state.lost ?? []));
			} finally {
				submitting.delete(agent.id);
			}
			return { kind: "success", text: decision.text };
		},
	});
}

export {
	DEFAULT_NON_RETRYABLE_PATTERNS,
	DEFAULT_RETRY_PROMPT,
	RETRY_HINTS,
	resolveConfig,
	matchesNonRetryable,
	retryDecision,
	retryFold,
	initialRetryFold,
	buildRetryMessage,
};
