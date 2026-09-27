/**
 * dsh-manual-retry — pure decision logic.
 *
 * Port of the user's Pi setup:
 *  - patch/manual-retry (`/retry`: continue from the nearest safe boundary)
 *  - pi-retry / settings.retry.nonRetryableErrorPatterns (quota/usage errors
 *    must not be auto-retried)
 *
 * This module has zero imports so unit tests need no DSH runtime.
 */

/** Pi settings.json `retry.nonRetryableErrorPatterns` (verbatim user config). */
export const DEFAULT_NON_RETRYABLE_PATTERNS = Object.freeze([
	"quota threshold",
	"使用上限",
	"insufficient_quota",
	"quota exceeded",
	"quota exhausted",
	"exceeded your current quota",
	"usage limit reached",
	"usage limit exceeded",
	"usage_limit_reached",
	"spending limit reached",
	"insufficient balance",
	"insufficient credits",
	"credit balance is too low",
	"credits exhausted",
]);

/**
 * Model-visible instruction for the one retry turn. Mirrors Pi's recovery cue
 * ("continue ... without repeating completed content or replaying prior tool
 * calls") plus the side-effect caution DSH resume notices carry.
 */
export const DEFAULT_RETRY_PROMPT =
	"The previous request failed or was interrupted before it completed. Retry it now: " +
	"continue the unfinished work from the conversation above without repeating completed " +
	"content. Do not replay tool calls that already produced results, and re-check the " +
	"current state before repeating any action that has side effects.";

const KNOWN_CONFIG_KEYS = new Set(["nonRetryableErrorPatterns", "retryPrompt", "maxRetries"]);

/** pi-retry defaults; only otherwise-unclassified PI_AI_ERROR failures need these hints. */
export const RETRY_HINTS = Object.freeze([
	"OpenAI API error (520): 520 status code (no body)",
	"OpenAI API error (522): 522 status code (no body)",
	"OpenAI API error (530): 530 status code (no body)",
	"unknown certificate verification error",
	"upstream_error: Upstream request failed",
	"Upstream stream failed before completion.",
	"stream disconnected before completion",
	"Service temporarily unavailable due to resource pressure. Retry shortly.",
	"Upstream service temporarily unavailable",
	"are cooling down (reset after 5s)",
	"Responses WebSocket closed (1006): Connection ended",
	"Connection error.",
	"unexpected EOF.",
]);

const PROTECTED_LIMIT = /GoUsageLimitError|FreeUsageLimitError|usage.?limit|available balance|account balance|credit balance|credits?.{0,24}(?:exhausted|depleted)|quota|budget|billing|payment|spending.?(?:cap|limit)|hard.?limit|\b402\b|context.?length|context.?window|reduce the prompt or route to a model with a larger input limit/i;

export function matchesRetryHint(failure, patterns) {
	return failure?.code === "PI_AI_ERROR" && typeof failure.message === "string" &&
		!matchesNonRetryable(failure.message, patterns) && !PROTECTED_LIMIT.test(failure.message) &&
		RETRY_HINTS.some((hint) => failure.message.toLowerCase().includes(hint.toLowerCase()));
}

/** Trimmed, non-blank, case-insensitive substrings — Pi normalize semantics. */
export function normalizePatterns(value) {
	if (!Array.isArray(value)) {
		throw new Error("dsh-manual-retry: nonRetryableErrorPatterns must be an array of strings");
	}
	const patterns = [];
	for (const entry of value) {
		if (typeof entry !== "string") {
			throw new Error("dsh-manual-retry: nonRetryableErrorPatterns entries must be strings");
		}
		const trimmed = entry.trim();
		if (trimmed.length > 0) patterns.push(trimmed);
	}
	return patterns;
}

export function resolveConfig(config = {}) {
	for (const key of Object.keys(config)) {
		if (!KNOWN_CONFIG_KEYS.has(key)) {
			throw new Error(`dsh-manual-retry: unknown config key "${key}"`);
		}
	}
	const patterns =
		config.nonRetryableErrorPatterns === undefined
			? [...DEFAULT_NON_RETRYABLE_PATTERNS]
			: normalizePatterns(config.nonRetryableErrorPatterns);
	const prompt = config.retryPrompt === undefined ? DEFAULT_RETRY_PROMPT : config.retryPrompt;
	const maxRetries = config.maxRetries ?? 10;
	if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
		throw new Error("dsh-manual-retry: maxRetries must be a non-negative safe integer");
	}
	if (typeof prompt !== "string" || prompt.trim().length === 0) {
		throw new Error("dsh-manual-retry: retryPrompt must be a non-empty string");
	}
	return Object.freeze({
		nonRetryableErrorPatterns: Object.freeze(patterns),
		maxRetries,
		retryPrompt: prompt,
	});
}

/** Pi: errorMessage containing any pattern (case-insensitive) is never auto-retried. */
export function matchesNonRetryable(message, patterns) {
	const text = String(message ?? "").toLowerCase();
	return patterns.some((pattern) => text.includes(pattern.toLowerCase()));
}

/** Fold state for the latest turn: enough to decide whether /retry has a target. */
export const initialRetryFold = Object.freeze({
	turn: 0,
	open: false,
	end: null,
	errorMessage: null,
	retryTurn: false,
});

/**
 * Pure projection fold over session events.
 * Tracks only the latest turn's lifecycle; same-reference returns for
 * irrelevant events keep the projection drive cheap.
 */
export function retryFold(state, event) {
	switch (event.type) {
		case "turn/start": {
			const turn = event.data?.turn;
			if (typeof turn !== "number") return state;
			return { turn, open: true, end: null, errorMessage: null, retryTurn: false };
		}
		case "user/message":
			return event.data?.source?.kind === "dsh-manual-retry"
				? { ...state, retryTurn: true }
				: state;
		case "turn/end": {
			const reason = event.data?.reason;
			if (!reason || typeof reason.kind !== "string") return state;
			const turn = typeof event.data?.turn === "number" ? event.data.turn : state.turn;
			const end = reason.kind === "aborted" ? `aborted:${reason.reason?.kind ?? "legacy"}` : reason.kind;
			return {
				turn,
				open: false,
				end,
				retryTurn: state.retryTurn,
				errorMessage: reason.kind === "error" ? String(reason.error?.message ?? "") : null,
			};
		}
		default:
			return state;
	}
}

function ellipsize(text, max = 80) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Whether the latest session state justifies one retry turn.
 * Pi equivalents: planner rejections (assistant_eof / nothing_to_continue)
 * and the interrupted_assistant / aborted continuation acceptance.
 */
export function retryDecision(state) {
	if (state.turn === 0) {
		return { ok: false, text: "Nothing to retry: this session has no request yet." };
	}
	if (state.open) {
		return { ok: false, text: "Cannot retry: the current turn has not finished." };
	}
	if (state.retryTurn) {
		return { ok: false, text: "This request already had its one manual retry. Send a new request instead." };
	}
	switch (state.end) {
		case "error":
			return {
				ok: true,
				turn: state.turn,
				summary: `Manual retry of turn ${state.turn}.`,
				text: `Retrying the failed request (${ellipsize(state.errorMessage ?? "unknown error")}).`,
			};
		case "interrupted":
			return {
				ok: true,
				turn: state.turn,
				summary: `Manual retry of interrupted turn ${state.turn}.`,
				text: "Retrying the interrupted request.",
			};
		case "aborted:user":
		case "aborted:legacy":
			return {
				ok: true,
				turn: state.turn,
				summary: `Manual retry of aborted turn ${state.turn}.`,
				text: "Retrying the aborted request.",
			};
		case "completed":
			return { ok: false, text: "Nothing to retry: the last request completed." };
		case "max-tokens":
			return {
				ok: false,
				text: "Cannot retry: the last response stopped at the output-token limit. Ask the model to continue instead.",
			};
		case "blocked":
			return { ok: false, text: "Cannot retry: the last turn was blocked." };
		default:
			return { ok: false, text: "Nothing to retry." };
	}
}

function deepFreeze(value) {
	if (Array.isArray(value)) {
		for (const item of value) deepFreeze(item);
	} else if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) deepFreeze(item);
	}
	return Object.freeze(value);
}

/**
 * The one retry message: deterministic id so a double submission for the same
 * turn cannot produce two distinct inbox items; plugin notice source so the
 * turn is not rendered as a fresh user prompt.
 */
export function buildRetryMessage(sessionId, turn, prompt, summary) {
	return deepFreeze({
		id: `dsh-manual-retry:retry:${sessionId}:${turn}`,
		role: "user",
		content: [{ type: "text", text: prompt }],
		source: { kind: "dsh-manual-retry", form: "notice", summary },
	});
}
