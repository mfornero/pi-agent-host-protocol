# Spec: Subagent chats

Status: **implemented** (`rpc` and `embedded` modes; pi-subagents 0.73 and 0.84).

## Problem

pi-subagents' `subagent` tool starts subagents, often in the background (`async`). The host showed none of it: the parent's tool call said only "Async workflow [run id]", and the runners pi-subagents starts were listed as background shells, so VS Code's Agents window said "5 Background Shells" for five reviewer subagents. A subagent stuck for 13 minutes on `find /` was found only by reading files on disk.

AHP has a place for this. A chat whose origin is a tool call in another chat (`ChatOrigin { kind: "tool", chat, toolCallId }`) is a worker chat; VS Code's Subagents list shows every such chat of the session whose origin is a tool call in the chat being viewed, with its title and status, and opens it beside the parent on click. The `toolCallId` must match a `ToolResultSubagentContent` on that tool call. Worker chats you can watch but not type into are `ChatInteractivity.ReadOnly`, and background work can be `{ kind: "subagent", chat }`.

## What pi-subagents leaves behind

Seen with pi-subagents 0.73.1 (the installed Bolt) and 0.84.0 (Bolt's `master`); fixtures in `test/fixtures/subagents/`.

- **The `subagent` tool result's `details`:** `mode` (`single`, `parallel`, `chain`, `workflow`, or `management` for `status`/`list`/...), `runId` (also `asyncId`), and for async runs `asyncDir`, the run's directory. 0.84 adds `toolCallId` and `workflowChildren` (`parentToolCallId`, `workflowRunId`, `children[]`), which is still empty when the tool returns. A foreground run's `results[]` carry each child's `agent`, `exitCode` and `sessionFile`.
- **`<asyncDir>/status.json`** (`/tmp/pi-subagents-<scope>/async-subagent-runs/<runId>/`): `runId`, `state` (`running`, `complete`, `failed`), `mode`, `pid`, and `steps[]` with `agent`, `status` (`pending`, `running`, `complete`/`completed`, `failed`), `startedAt`, `sessionFile`, `error`, and for workflow children `label`/`workflowKey` (`task-1`, ...) and their own `runId`. Each workflow child is also a run of its own, with its own directory. 0.84 writes `toolCallId`; 0.73 doesn't. A workflow lists its children in `workflowChildren.children[]` (`childId`, `state`, `runId`, `agent`) before their steps exist.
- **Each child's transcript** is a pi session file, appended as it works. 0.84 puts it at `<parent session file without .jsonl>/<child run id>/run-0/session.jsonl` and records the parent in its header (`parentSession`); 0.73 uses another per-launch directory under the same folder (the path is only in `status.json`).
- **Completion notices:** a `subagent-notify` custom message in the parent's session file when a run ends. 0.84's `details.runs[].childRuns[]` list a workflow's children with their run ids and keys; 0.73's have no details.
- **Processes:** each async run is a process pi starts (`node .../pi-subagents/.../subagent-runner-bootstrap.js <cfg>`, or with a standalone binary `<binary> --no-extensions ... --extension .../pi-subagents/.../binary-bootstrap.js`), so it is one of pi's direct children.
- Workflow children are named as pi-subagents' workflow scripts name them: `task-<n>` for `tasks` and the `parallel` workflow, `step-<n>` and `step-<n>-<m>` for chains.

## Design

### Spotting a run (`src/pi/subagents.ts`, pure)

`SubagentTracker` (`src/pi/subagent-tracker.ts`) follows each chat's pi events. It keeps a `subagent` call's arguments from `tool_execution_start`, and on its `tool_execution_end` reads the run from the result (`subagentRunFromResult`): the run id, `asyncDir`, and the children the arguments name (`childrenFromArgs`), so their chats exist before pi-subagents writes their steps. Management calls and failed calls start nothing. A foreground run's children come from `results[]`, finished, with their session files.

The tracker subscribes to the agent before any turn mapper does, so by the time the mapper publishes the tool call's result, the run is known. Right after the `subagent` call completes, the mapper adds one completed tool call per child to the turn (`subagentCalls`): id `<call id>.<child key>`, tool name `subagent`, display name the child's title, one `ToolResultSubagentContent` (resource, title, agent name, the task as description), and `_meta` with `toolKind: "subagent"`, `subagentChatUri`, `subagentAgentName` and `subagentDescription` (`<label>: <task>`). VS Code shows one subagent row per tool call and reads only its first subagent content, so a single call linking all children showed only the first; with a call per child, each has its own row that opens its chat. The `subagent` call itself keeps pi's result. Runs started in a pi terminal are tracked the same way.

### Following it

- `status.json` is watched with `fs.watch` on the run's directory, and every tracked file is re-read every 2 s (`SUBAGENT_POLL_MS`) while anything can still change; `fs.watch` can miss events or have no inotify watches left. `parseRunStatus` reads both versions. `mergeChildren` updates the children by key, keeping the labels and tasks from the arguments.
- A status file that disappears ends the run: its children still running show as stopped.
- Each child's session file is re-read when its size changes, parsed with `turnsFromEntries` (the history mapping), and `transcriptActions` brings the child's chat from what it already shows to the file's turns: `chat/turnStarted` for a new turn (its prompt as an agent message), `chat/responsePart` for new text and reasoning, `chat/toolCallStart`/`Ready` for new tool calls and `chat/toolCallComplete` when their results arrive. The last turn stays open while the child runs, so VS Code shows the chat as working; when the child finishes it ends as the child did (complete, failed with its error, or cancelled when stopped). A child that ended without a transcript (for example 0.73's "No models available") gets one turn that says so.

### The chats

- **Id and URI:** `subagent-<run id>-<child key>`, stable across restarts, and the URI `ahp-chat://<id>/<base64url(session URI)>` (the shape VS Code gives chats of a session), so a subagent chat's URI names its session. Subscribing to one after a restart loads its session, which rebuilds it.
- **Title:** `<label> (<agent>)`: the workflow key (`task-1 (delegate)`), or for a single subagent the start of its task. A child that failed or was stopped gets ` · failed` or ` · stopped` (renamed with `session/chatUpdated` when its status changes): VS Code's Subagents list puts errored chats under "Completed", with nothing else to tell a failed child from one that finished, and a parent that relaunched its subagents lists both sets under the same names.
- **Catalog entry:** `origin: { kind: "tool", chat: <parent chat>, toolCallId: <its row's id> }`, `interactivity: "read-only"`, added with `session/chatAdded`; status and `modifiedAt` follow the chat with `session/chatUpdated`, and the root summary's catalog is refreshed. They are registered in the state store like forked chats (`StateStore.addForkedChat`), but have no `PiSession` behind them.
- **Read-only:** `chat/turnStarted` and every other client action on a subagent chat, and renaming one, are rejected with "Subagent chats are read-only". Two are accepted, because VS Code sends them for any chat it shows and they change nothing pi sees: `chat/isReadChanged` (the catalog entry's `IsRead` bit follows) and `chat/draftChanged`.

### Background work

Each running child is a `BackgroundSubagentWork` entry on the parent chat (`subagent:<chat id>`, its title, `chat` set to its chat), removed when it finishes (`subagentWorkActions`). pi-subagents' runner processes are no longer published as shells (`isSubagentRunner`), but they still keep an idle pi from being stopped. The session summary's `_meta` count includes the subagent entries.

### After a restart

When a chat loads from its session file, `restore` finds every `subagent` tool result on its branch. A run whose `status.json` is still there is followed as above. If `/tmp` was cleaned (or the machine replaced), its children come from the session files: a workflow's from its completion notice's `childRuns` (0.84) and `<parent>/<child run id>/run-0/session.jsonl`, a single run's from `<parent>/<run id>/run-0/session.jsonl`. Children whose file can't be found are left out; 0.73 runs without a status file are lost. The parent's history gets the rows (`turnsFromEntries`' `extraCalls`, after the `subagent` call as live) before it is published, and the children's chats are added right after (`publish`).

**Wake-ups in history:** pi-subagents wakes the parent with custom messages (`subagent-incremental-child-notify`, `subagent-notify`), which live start an outside run the host shows as a "Continued in pi" turn. History does the same: a custom message after a run has ended (its last assistant message stopped for anything but a tool call), when an assistant message follows it, starts a "Continued in pi" turn with the custom message's entry id. Before, history started turns only at user messages, so after a restart the wake-up's reply was merged into the previous turn. `ahp-resume` markers are excluded: they continue the errored turn.

## Not in scope

- Stopping or steering one subagent from VS Code (pi-subagents has `/subagents-stop` and `/subagents-steer`; AHP has no action for it on a worker chat).
- A subagent's own subagents: a child's session file is shown as a transcript, not followed for further `subagent` calls.
- Subagents started by other tools (Bolt's `agent_bg`) are still shells.

## Tests

- `test/subagents.test.ts` (from the fixtures): tool results of a 0.84 workflow, a 0.73 single run, a foreground run and a management call; `status.json` of both versions at each stage; child naming for tasks and chains; chat ids, URIs and titles; a row per child, also in restored history; wake-ups as their own turns in restored history (`test/history.test.ts`); subagent background work and runner detection; children from session files when the status file is gone; the transcript growing into an open turn, ending as complete, failed (without a transcript) or cancelled.
- `test/subagent-e2e.test.ts` (`rpc`, pi's real CLI with a fake `subagent` tool in `test/fixtures/subagent-extension.ts`): chats created with the tool origin, read-only, titled; a row per child after the parent's tool call, each chat's origin its row; subagent background work; a transcript streaming in; read and draft changes accepted; a typed message rejected; status flips (complete, failed) and the work removed; after a restart, the chats and links rebuilt from the status file; after a restart without it, rebuilt from the session files and loaded through a subagent chat's URI.
