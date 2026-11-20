import { type FSWatcher, watch } from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	type ActionOrigin,
	ActionType,
	type BackgroundSubagentWork,
	type ChatAction,
	ChatInteractivity,
	ChatOriginKind,
	type ChatState,
	type ChatSummary,
	SessionStatus,
	type StateAction,
	type ToolCallCompletedState,
} from "@microsoft/agent-host-protocol";
import type { Logger } from "../core/logger.ts";
import type { StateStore } from "../core/state-store.ts";
import type { PiEvent } from "./agent.ts";
import { turnsFromEntries } from "./history.ts";
import {
	childrenFromSessionFiles,
	isFinished,
	mergeChildren,
	NO_PROGRESS,
	notifiedChildren,
	parseRunStatus,
	readText,
	SUBAGENT_TOOL,
	type SubagentChild,
	type SubagentRun,
	subagentCallId,
	subagentCalls,
	subagentChatId,
	subagentChatUri,
	subagentRunFromResult,
	subagentTitle,
	subagentWork,
	type TranscriptProgress,
	transcriptActions,
} from "./subagents.ts";

/** Why a client action on a subagent chat was refused. */
export const SUBAGENT_CHAT_READ_ONLY = "Subagent chats are read-only";

/** How often status and session files are re-read when `fs.watch` gives no events (or misses some). */
export const SUBAGENT_POLL_MS = 2_000;

/** What the tracker needs from the chat that started the subagents. */
export interface SubagentHost {
	readonly store: StateStore;
	readonly logger: Logger;
	/** The AHP session the parent chat belongs to. */
	readonly sessionId: string;
	/** Set for a forked chat (its pi session id), so its subagent chats don't collide with its source's. */
	readonly scope?: string;
	/** The parent chat's URI. */
	readonly parentChat: string;
	/** pi's session file of the parent chat, when it has one. */
	sessionFile(): string | undefined;
	/** Publishes the session's chat catalog after chats were added or changed. */
	catalogChanged(): void;
	/** The subagents' background work changed. */
	backgroundWorkChanged(): void;
	now(): number;
}

interface TrackedChild {
	readonly chatId: string;
	readonly chat: string;
	child: SubagentChild;
	progress: TranscriptProgress;
	/** Size of the session file when last read, to skip re-parsing an unchanged file. */
	fileSize: number;
	/** Whether its chat exists yet (a restore builds children before publishing them). */
	published: boolean;
}

interface TrackedRun {
	run: SubagentRun;
	readonly children: Map<string, TrackedChild>;
	watcher: FSWatcher | undefined;
	finished: boolean;
}

/**
 * Shows the subagents a pi chat starts with pi-subagents' `subagent` tool as
 * read-only chats of its session (`origin: { kind: "tool" }`), linked from
 * the tool call, listed as `subagent` background work while they run, and
 * streaming each child's session file into its chat. See specs/subagents.md.
 */
export class SubagentTracker {
	readonly #host: SubagentHost;
	readonly #runs = new Map<string, TrackedRun>();
	/** Arguments of `subagent` tool calls, by tool call id, until their result arrives. */
	readonly #args = new Map<string, unknown>();
	#timer: NodeJS.Timeout | undefined;
	#disposed = false;
	/** False while a restore builds children whose chats `publish()` adds later. */
	#publishing = true;

	constructor(host: SubagentHost) {
		this.#host = host;
	}

	/** True if `chat` is one of this tracker's subagent chats. */
	owns(chatId: string): boolean {
		for (const run of this.#runs.values()) if (run.children.has(chatId)) return true;
		return false;
	}

	/**
	 * Applies what a client may change on a subagent chat it can't type into:
	 * whether it has been read and the input's draft. Anything else is
	 * refused; `undefined` means the action was applied.
	 */
	clientAction(chatId: string, action: StateAction, origin: ActionOrigin | undefined): string | undefined {
		if (action.type !== ActionType.ChatIsReadChanged && action.type !== ActionType.ChatDraftChanged) {
			return SUBAGENT_CHAT_READ_ONLY;
		}
		const tracked = this.#tracked(chatId);
		if (!tracked?.published) return SUBAGENT_CHAT_READ_ONLY;
		const { store } = this.#host;
		if (!store.dispatch(tracked.chat, action, origin) || action.type !== ActionType.ChatIsReadChanged) return undefined;
		const chat = store.chat(chatId);
		if (chat) {
			store.dispatch(store.sessionResource(this.#host.sessionId), {
				type: ActionType.SessionChatUpdated,
				chat: tracked.chat,
				changes: { status: chat.status },
			});
			this.#host.catalogChanged();
		}
		return undefined;
	}

	#tracked(chatId: string): TrackedChild | undefined {
		for (const run of this.#runs.values()) {
			const tracked = run.children.get(chatId);
			if (tracked) return tracked;
		}
		return undefined;
	}

	/** Chat ids of every subagent chat. */
	chatIds(): string[] {
		return [...this.#runs.values()].flatMap((run) => [...run.children.keys()]);
	}

	/**
	 * Rebuilds the subagent runs of a chat loaded from its session file: every
	 * `subagent` tool result on its branch, read from its status file, or from
	 * the session files when `/tmp` was cleaned. Their chats are added by
	 * `publish()`, once the parent chat is in the store; `callsFor` works
	 * before that, so the parent's history can carry the rows.
	 */
	restore(entries: readonly SessionEntry[]): void {
		this.#publishing = false;
		const args = new Map<string, unknown>();
		const runs: SubagentRun[] = [];
		const notices: unknown[] = [];
		for (const entry of entries) {
			if (entry.type === "custom_message" && (entry as { customType?: string }).customType === "subagent-notify") {
				notices.push((entry as { details?: unknown }).details);
			}
			if (entry.type !== "message") continue;
			const message = entry.message as {
				role?: string;
				content?: unknown;
				toolCallId?: string;
				toolName?: string;
				details?: unknown;
			};
			if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const block of message.content as { type?: string; id?: string; name?: string; arguments?: unknown }[]) {
					if (block.type === "toolCall" && block.name === SUBAGENT_TOOL && block.id)
						args.set(block.id, block.arguments);
				}
			}
			if (message.role === "toolResult" && message.toolName === SUBAGENT_TOOL && message.toolCallId) {
				const run = subagentRunFromResult(message.toolCallId, args.get(message.toolCallId), message.details);
				if (run) runs.push(run);
			}
		}
		for (const run of runs) {
			const statusText = run.asyncDir ? readText(`${run.asyncDir}/status.json`) : undefined;
			if (!run.asyncDir || statusText !== undefined) {
				this.#track(run);
				continue;
			}
			// The status file is gone (`/tmp` cleaned, or a new machine): read the children's session files.
			const parentFile = this.#host.sessionFile();
			const notified = notices.flatMap((details) => notifiedChildren(details, run.runId));
			const children = parentFile ? childrenFromSessionFiles(parentFile, run, notified) : [];
			if (children.length > 0) this.#track({ toolCallId: run.toolCallId, runId: run.runId, children });
		}
	}

	/** Adds the chats of restored children and starts following the runs still going. */
	publish(): void {
		if (this.#publishing) return;
		this.#publishing = true;
		let added = false;
		for (const run of this.#runs.values()) {
			for (const tracked of run.children.values()) {
				if (tracked.published) continue;
				this.#addChat(tracked, run.run.toolCallId);
				added = true;
			}
			if (!run.finished) this.#watch(run);
			for (const child of run.children.values()) this.#refreshChild(child);
		}
		if (added) this.#host.catalogChanged();
		this.#schedule();
		this.#host.backgroundWorkChanged();
	}

	/** Follows a live pi event stream: records `subagent` calls' arguments and tracks the runs their results start. */
	handle(event: PiEvent): void {
		if (event.type === "tool_execution_start" && event.toolName === SUBAGENT_TOOL) {
			this.#args.set(event.toolCallId, event.args);
			return;
		}
		if (event.type !== "tool_execution_end" || event.toolName !== SUBAGENT_TOOL) return;
		const args = this.#args.get(event.toolCallId);
		this.#args.delete(event.toolCallId);
		if (event.isError) return;
		const details = (event.result as { details?: unknown } | undefined)?.details;
		const run = subagentRunFromResult(event.toolCallId, args, details);
		if (!run) return;
		this.#track(run);
		this.#host.logger.debug("subagents started", {
			session: this.#host.sessionId,
			run: run.runId,
			children: this.#runs.get(run.runId)?.children.size ?? 0,
		});
	}

	/**
	 * The rows, one per subagent, that follow the parent's `subagent` tool call
	 * in its turn. Undefined for calls that started no subagents.
	 */
	callsFor(toolCallId: string): ToolCallCompletedState[] | undefined {
		const run = [...this.#runs.values()].find((candidate) => candidate.run.toolCallId === toolCallId);
		if (!run) return undefined;
		return subagentCalls(this.#host.store.sessionResource(this.#host.sessionId), this.#runOf(run), this.#host.scope);
	}

	/** The `subagent` background work entries of the children still running. */
	runningWork(): BackgroundSubagentWork[] {
		return [...this.#runs.values()].flatMap((run) =>
			[...run.children.values()]
				.filter((tracked) => !isFinished(tracked.child.status))
				.map((tracked) =>
					subagentWork(
						tracked.chatId,
						tracked.chat,
						subagentTitle(tracked.child),
						new Date(tracked.child.startedAt ?? this.#host.now()).toISOString(),
					),
				),
		);
	}

	/** Re-reads every unfinished run's status file and every child's session file. */
	refresh(): void {
		if (this.#disposed) return;
		for (const run of this.#runs.values()) this.#refreshRun(run);
		this.#schedule();
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
		for (const run of this.#runs.values()) run.watcher?.close();
	}

	#runOf(run: TrackedRun): SubagentRun {
		return { ...run.run, children: [...run.children.values()].map((tracked) => tracked.child) };
	}

	#track(run: SubagentRun): void {
		if (this.#disposed) return;
		const existing = this.#runs.get(run.runId);
		const tracked: TrackedRun = existing ?? { run, children: new Map(), watcher: undefined, finished: !run.asyncDir };
		if (!existing) this.#runs.set(run.runId, tracked);
		this.#addChildren(tracked, run.children);
		this.#refreshRun(tracked);
		if (!this.#publishing) return;
		if (!tracked.finished) this.#watch(tracked);
		this.#schedule();
		this.#host.backgroundWorkChanged();
	}

	/** Adds chats for children not seen yet and updates the known ones. */
	#addChildren(run: TrackedRun, children: readonly SubagentChild[]): void {
		const known = [...run.children.values()].map((tracked) => tracked.child);
		const merged = mergeChildren(known, children);
		let added = false;
		for (const child of merged) {
			const chatId = subagentChatId(run.run.runId, child.key, this.#host.scope);
			const tracked = run.children.get(chatId);
			if (tracked) {
				this.#updateChild(tracked, child);
				continue;
			}
			const chat = subagentChatUri(this.#host.store.sessionResource(this.#host.sessionId), chatId);
			const created: TrackedChild = { chatId, chat, child, progress: NO_PROGRESS, fileSize: -1, published: false };
			run.children.set(chatId, created);
			if (!this.#publishing) continue;
			this.#addChat(created, run.run.toolCallId);
			added = true;
		}
		if (added) this.#host.catalogChanged();
	}

	#addChat(tracked: TrackedChild, toolCallId: string): void {
		tracked.published = true;
		const { chatId, chat, child } = tracked;
		const { store } = this.#host;
		const now = new Date(child.startedAt ?? this.#host.now()).toISOString();
		const summary: ChatSummary = {
			resource: chat,
			title: subagentTitle(child),
			// Until its first turn, a child is shown working; its turns decide from then on.
			status: SessionStatus.InProgress | SessionStatus.IsRead,
			modifiedAt: now,
			// Its row in the parent's turn (see `subagentCalls`).
			origin: {
				kind: ChatOriginKind.Tool,
				chat: this.#host.parentChat,
				toolCallId: subagentCallId(toolCallId, child.key),
			},
			interactivity: ChatInteractivity.ReadOnly,
		};
		const state: ChatState = { ...summary, turns: [] };
		store.addForkedChat({ kind: "chat", sessionId: this.#host.sessionId, chatId }, chat, state);
		store.dispatch(store.sessionResource(this.#host.sessionId), { type: ActionType.SessionChatAdded, summary });
	}

	#updateChild(tracked: TrackedChild, child: SubagentChild): void {
		const before = tracked.child;
		tracked.child = child;
		const { store } = this.#host;
		const title = subagentTitle(child);
		const current = tracked.published ? store.chat(tracked.chatId) : undefined;
		if (current && current.title !== title) {
			store.setChatTitle(tracked.chatId, title);
			store.dispatch(store.sessionResource(this.#host.sessionId), {
				type: ActionType.SessionChatUpdated,
				chat: tracked.chat,
				changes: { title },
			});
			this.#host.catalogChanged();
		}
		if (before.status !== child.status) {
			this.#host.logger.debug("subagent status changed", {
				session: this.#host.sessionId,
				chat: tracked.chatId,
				status: child.status,
			});
			if (isFinished(child.status) !== isFinished(before.status)) this.#host.backgroundWorkChanged();
		}
	}

	#refreshRun(run: TrackedRun): void {
		if (this.#disposed) return;
		if (run.run.asyncDir && !run.finished) {
			const text = readText(`${run.run.asyncDir}/status.json`);
			const status = text === undefined ? undefined : parseRunStatus(text);
			if (status) {
				this.#addChildren(run, status.children);
				if (isFinished(status.state)) {
					run.finished = true;
					run.watcher?.close();
					run.watcher = undefined;
					if (this.#publishing) this.#host.backgroundWorkChanged();
				}
			} else if (text === undefined && run.children.size > 0) {
				// The status file went away (cleaned up): the run is over as far as anyone can tell.
				run.finished = true;
				run.watcher?.close();
				run.watcher = undefined;
				for (const tracked of run.children.values()) {
					if (!isFinished(tracked.child.status)) this.#updateChild(tracked, { ...tracked.child, status: "stopped" });
				}
				if (this.#publishing) this.#host.backgroundWorkChanged();
			}
		}
		if (!this.#publishing) return;
		for (const child of run.children.values()) this.#refreshChild(child);
	}

	/** Streams new entries of a child's session file into its chat. */
	#refreshChild(tracked: TrackedChild): void {
		if (!tracked.published) return;
		const { child } = tracked;
		const text = child.sessionFile ? readText(child.sessionFile) : undefined;
		// An unchanged (or missing) file needs no work, unless the child's end must still be shown:
		// its open turn closed, or a turn saying it ended without a transcript.
		const mustEnd =
			isFinished(child.status) && (tracked.progress.open !== undefined || tracked.progress.ended.size === 0);
		const unchanged = text === undefined || text.length === tracked.fileSize;
		if (unchanged && !mustEnd) return;
		tracked.fileSize = text?.length ?? -1;
		const entries = text === undefined ? [] : parseEntries(text);
		const turns = turnsFromEntries(entries);
		const { actions, progress } = transcriptActions(
			turns,
			tracked.progress,
			child,
			tracked.chatId,
			new Date(this.#host.now()).toISOString(),
		);
		tracked.progress = progress;
		this.#dispatch(tracked, actions);
	}

	#dispatch(tracked: TrackedChild, actions: readonly ChatAction[]): void {
		const { store } = this.#host;
		for (const action of actions) store.dispatch(tracked.chat, action);
		if (actions.length === 0) return;
		const chat = store.chat(tracked.chatId);
		if (!chat) return;
		store.dispatch(store.sessionResource(this.#host.sessionId), {
			type: ActionType.SessionChatUpdated,
			chat: tracked.chat,
			changes: { status: chat.status, modifiedAt: chat.modifiedAt },
		});
		this.#host.catalogChanged();
	}

	#watch(run: TrackedRun): void {
		if (run.watcher || !run.run.asyncDir) return;
		try {
			const watcher = watch(run.run.asyncDir, { persistent: false }, (_event, file) => {
				if (file === "status.json") this.#refreshRun(run);
			});
			watcher.on("error", () => {
				watcher.close();
				if (run.watcher === watcher) run.watcher = undefined;
			});
			run.watcher = watcher;
		} catch {
			// No watch (the directory is gone, or no inotify watches left): polling covers it.
		}
	}

	/** Polls while anything can still change: an unfinished run, or a child whose chat has an open turn. */
	#schedule(): void {
		if (this.#disposed || this.#timer) return;
		const live = [...this.#runs.values()].some(
			(run) => !run.finished || [...run.children.values()].some((child) => child.progress.open),
		);
		if (!live) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.refresh();
		}, SUBAGENT_POLL_MS);
		this.#timer.unref();
	}
}

/** Session file lines as entries; a half-written last line (pi still appending) is skipped. */
function parseEntries(text: string): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as SessionEntry);
		} catch {
			// The line pi is writing right now; the next read gets it whole.
		}
	}
	return entries;
}
