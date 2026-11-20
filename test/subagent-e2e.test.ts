import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	BackgroundWorkKind,
	ChatInteractivity,
	ChatOriginKind,
	type ResponsePart,
	SessionStatus,
	ToolResultContentType,
	TurnState,
} from "@microsoft/agent-host-protocol";
import { SUBAGENT_POLL_MS } from "../src/pi/subagent-tracker.ts";
import { newSession, startHost, startTurn, TestClient, type TestHost, waitUntil } from "./helpers.ts";

const SUBAGENT_EXTENSION = fileURLToPath(new URL("./fixtures/subagent-extension.ts", import.meta.url));
const CHILD_SESSION = readFileSync(new URL("./fixtures/subagents/child-0.84.session.jsonl", import.meta.url), "utf8");
const TIMEOUT = SUBAGENT_POLL_MS * 4;

interface Step {
	agent: string;
	label: string;
	workflowKey: string;
	status: string;
	runId: string;
	sessionFile: string;
}

describe("subagent chats (rpc)", () => {
	let host: TestHost;
	let client: TestClient;
	let runs: string;
	const previousDir = process.env.PI_AGENT_HOST_PROTOCOL_SUBAGENT_DIR;

	before(async () => {
		runs = await mkdtemp(join(tmpdir(), "pi-agent-host-protocol-subagents-"));
		process.env.PI_AGENT_HOST_PROTOCOL_SUBAGENT_DIR = runs;
		host = await startHost({ mode: "rpc", extensions: [SUBAGENT_EXTENSION] });
		client = await TestClient.connect(host.url);
		await client.initialize();
	});

	after(async () => {
		client.close();
		await host.cleanup();
		rmSync(runs, { recursive: true, force: true });
		if (previousDir === undefined) delete process.env.PI_AGENT_HOST_PROTOCOL_SUBAGENT_DIR;
		else process.env.PI_AGENT_HOST_PROTOCOL_SUBAGENT_DIR = previousDir;
	});

	const latest = () =>
		JSON.parse(readFileSync(join(runs, "latest.json"), "utf8")) as { asyncDir: string; steps: Step[] };
	const writeStatus = (asyncDir: string, state: string, steps: Step[]) =>
		writeFileSync(join(asyncDir, "status.json"), JSON.stringify({ runId: "r", mode: "workflow", state, steps }));
	const writeChild = (step: Step, lines: number) => {
		mkdirSync(dirname(step.sessionFile), { recursive: true });
		writeFileSync(step.sessionFile, `${CHILD_SESSION.split("\n").slice(0, lines).join("\n")}\n`);
	};

	test("subagents become read-only chats linked from the tool call, with live transcripts and background work", async () => {
		const { session, chat } = await newSession(host, client);
		host.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"subagent",
						{
							workflow: "parallel",
							args: {
								tasks: [
									{ agent: "delegate", task: "Run sleep 20" },
									{ agent: "scout", task: "List /tmp" },
								],
							},
							async: true,
						},
						{ id: "call-sub" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Started two subagents."),
		]);
		const turnId = startTurn(client, chat, "start subagents");
		await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === turnId);

		// Two chats with the tool origin, read-only, in the session's catalog.
		const catalog = () =>
			client.sessions.get(session)!.chats.filter((entry) => entry.origin?.kind === ChatOriginKind.Tool);
		await waitUntil(() => catalog().length === 2, TIMEOUT);
		for (const entry of catalog()) {
			assert.deepEqual(entry.origin, { kind: ChatOriginKind.Tool, chat, toolCallId: "call-sub" });
			assert.equal(entry.interactivity, ChatInteractivity.ReadOnly);
		}
		assert.deepEqual(
			catalog().map((entry) => entry.title),
			["task-1 (delegate)", "task-2 (scout)"],
		);

		// The parent's tool call links both chats.
		const toolPart = client.chats
			.get(chat)!
			.turns.find((turn) => turn.id === turnId)!
			.responseParts.find((part: ResponsePart) => part.kind === "toolCall");
		const links =
			toolPart?.kind === "toolCall" && toolPart.toolCall.status === "completed"
				? (toolPart.toolCall.content ?? []).filter((item) => item.type === ToolResultContentType.Subagent)
				: [];
		assert.deepEqual(
			links.map((link) => link.type === ToolResultContentType.Subagent && link.resource),
			catalog().map((entry) => entry.resource),
		);

		// Running children are subagent background work.
		await waitUntil(
			() =>
				client.chats.get(chat)!.backgroundWork?.filter((work) => work.kind === BackgroundWorkKind.Subagent).length ===
				2,
			TIMEOUT,
		);

		// A child's transcript streams into its chat as its session file grows.
		const { asyncDir, steps } = latest();
		const [first, second] = steps as [Step, Step];
		const firstChat = catalog()[0]!.resource;
		await client.subscribe(firstChat);
		writeChild(first, 7);
		await waitUntil(() => client.chats.get(firstChat)?.activeTurn !== undefined, TIMEOUT);
		assert.match(client.chats.get(firstChat)!.activeTurn!.message.text, /^Task: Run 'sleep 20'/);
		writeChild(first, 99);
		await waitUntil(
			() =>
				client.chats
					.get(firstChat)
					?.activeTurn?.responseParts.some((part) => part.kind === "markdown" && part.content.startsWith("done")) ??
				false,
			TIMEOUT,
		);

		// Typing into a subagent chat is rejected.
		const rejected = client.dispatch(firstChat, {
			type: "chat/turnStarted",
			turnId: "nope",
			startedAt: new Date().toISOString(),
			message: { text: "hi", origin: { kind: "user" } },
		});
		const rejection = await client.waitFor(
			(m) => m.method === "action" && m.params.origin?.clientSeq === rejected && m.params.rejectionReason !== undefined,
		);
		assert.equal(rejection.params.rejectionReason, "Subagent chats are read-only");

		// Status flips: the first finishes, the second fails; the run ends and the work is gone.
		writeStatus(asyncDir, "complete", [
			{ ...first, status: "completed" },
			{ ...second, status: "failed" },
		]);
		await waitUntil(() => client.chats.get(firstChat)?.turns[0]?.state === TurnState.Complete, TIMEOUT);
		await waitUntil(
			() => !client.chats.get(chat)!.backgroundWork?.some((work) => work.kind === BackgroundWorkKind.Subagent),
			TIMEOUT,
		);
		const secondEntry = () => catalog().find((entry) => entry.title === "task-2 (scout)");
		await waitUntil(() => ((secondEntry()?.status ?? 0) & SessionStatus.Error) === SessionStatus.Error, TIMEOUT);

		// After a restart the chats come back from the status file, linked again.
		await host.stop();
		host = await startHost({ mode: "rpc", extensions: [SUBAGENT_EXTENSION], dir: host.dir });
		client.close();
		client = await TestClient.connect(host.url);
		await client.initialize();
		await client.subscribe(session);
		await client.subscribe(chat);
		const restored = client.sessions.get(session)!.chats.filter((entry) => entry.origin?.kind === ChatOriginKind.Tool);
		assert.deepEqual(
			restored.map((entry) => entry.resource),
			links.map((link) => link.type === ToolResultContentType.Subagent && link.resource),
		);
		const reopened = await client.subscribe(firstChat);
		const state = reopened.state as { turns: { state: TurnState }[]; interactivity?: string };
		assert.equal(state.turns[0]?.state, TurnState.Complete);
		assert.equal(state.interactivity, ChatInteractivity.ReadOnly);

		// Without the status file (a cleaned /tmp), the chats come back from the session files,
		// found through pi-subagents' completion notice.
		const notifyTurn = startTurn(client, chat, "/subagent-notify");
		await client.waitFor(
			(m) => m.params?.action?.turnId === notifyTurn && m.params.action.type === "chat/turnComplete",
		);
		await host.stop();
		rmSync(asyncDir, { recursive: true, force: true });
		host = await startHost({ mode: "rpc", extensions: [SUBAGENT_EXTENSION], dir: host.dir });
		client.close();
		client = await TestClient.connect(host.url);
		await client.initialize();
		// A subagent chat's URI loads its session.
		const fromFiles = await client.subscribe(firstChat);
		assert.equal((fromFiles.state as { turns: unknown[] }).turns.length, 1);
	});
});
