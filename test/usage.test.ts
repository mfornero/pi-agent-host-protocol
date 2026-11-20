import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ChatAction } from "@microsoft/agent-host-protocol";
import type { PiEvent } from "../src/pi/agent.ts";
import { turnsFromEntries } from "../src/pi/history.ts";
import { TurnMapper } from "../src/pi/turn-mapper.ts";
import { addCall, usageInfo } from "../src/pi/usage.ts";

// Two model calls in one turn, as a tool call makes: the second's prompt
// repeats the first's (mostly from the cache) and adds the tool result.
const FIRST = { input: 11_000, output: 200, cacheRead: 0, cacheWrite: 30_000 };
const SECOND = { input: 1_222, output: 300, cacheRead: 30_879, cacheWrite: 0 };
const EXPECTED = { inputTokens: 32_101, outputTokens: 500, cacheReadTokens: 30_879, model: "m" };

describe("turn usage", () => {
	test("reports the last call's full prompt and the turn's summed output", () => {
		const turn = addCall(addCall(undefined, FIRST, "m"), SECOND, undefined);
		assert.ok(turn);
		assert.deepEqual(usageInfo(turn), EXPECTED);
	});

	test("counts cache writes as context and omits a zero cache read", () => {
		const turn = addCall(undefined, { input: 5, output: 1, cacheWrite: 7 }, undefined);
		assert.ok(turn);
		assert.deepEqual(usageInfo(turn), { inputTokens: 12, outputTokens: 1 });
	});

	test("has nothing to report until a call reports usage", () => {
		assert.equal(addCall(undefined, undefined, "m"), undefined);
	});

	test("live turns and rebuilt history agree", () => {
		const actions: ChatAction[] = [];
		const mapper = new TurnMapper("t", (action) => actions.push(action));
		for (const usage of [FIRST, SECOND]) {
			const message = { role: "assistant", content: [], usage, model: "m" };
			mapper.handle({ type: "message_end", message } as unknown as PiEvent);
		}
		mapper.finish({ kind: "complete" }, 0);
		const live = actions.find((action) => action.type === "chat/usage");
		assert.deepEqual(live && "usage" in live ? live.usage : undefined, EXPECTED);

		const at = "2026-01-01T00:00:00.000Z";
		const entries = [
			{ type: "message", id: "u", timestamp: at, message: { role: "user", content: "hi" } },
			...[FIRST, SECOND].map((usage, index) => ({
				type: "message",
				id: `a${index}`,
				timestamp: at,
				message: { role: "assistant", content: [], usage, model: "m" },
			})),
		] as unknown as SessionEntry[];
		assert.deepEqual(turnsFromEntries(entries)[0]?.usage, EXPECTED);
	});
});
