# Spec: Turn usage and the context gauge

## Problem

VS Code's Agents window shows a context gauge from the `inputTokens` of a chat's last turn (`usageInfoToChatUsage` in its `stateToProgressAdapter.ts`). The host summed pi's `input` over every model call of a turn and left out the cache. On a provider with prompt caching (Anthropic, Vertex), most of each prompt is a cache read, so a session with about 42K tokens of context showed about 13K; on an uncached provider, a turn with several tool calls counted its shared prefix once per call and overstated the context.

## Behavior

`src/pi/usage.ts` folds pi's per-call usage (on each assistant message) into a turn's, for live turns (`TurnMapper`) and rebuilt history (`turnsFromEntries`) alike:

- **`inputTokens`:** the full prompt of the turn's last model call: `input + cacheRead + cacheWrite`. That is the context the next call starts from.
- **`cacheReadTokens`:** the last call's cache read, omitted when zero.
- **`outputTokens`:** summed over the turn's calls: everything the turn generated.
- **`model`:** the last call's model.
- A turn with no call that reported usage reports none.

## Tests

`test/usage.test.ts`: two calls (the second mostly cached) report the second call's full prompt and the summed output; cache writes count as context; a live turn and the same session rebuilt from its file report the same usage.
