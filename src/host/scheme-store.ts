import { dirname, join } from "node:path";
import { PROVIDER, type SessionScheme } from "../core/uris.ts";
import { atomicWriter, readOptional } from "./json-file.ts";

/** The session scheme file, next to the host's settings file. */
export function schemeStorePath(settingsFile: string): string {
	return join(dirname(settingsFile), "session-schemes.json");
}

/**
 * The scheme each session was created under (see `uris.ts`). pi's session
 * files cannot hold it, so the host keeps it in its own file; without it a
 * session a client created as `ahp-session:/<id>` would come back as
 * `pi:/<id>` after a host restart, and that client would no longer match its
 * updates. Sessions not listed use the `pi` scheme.
 */
export interface SchemeStore {
	schemeOf(sessionId: string): SessionScheme;
	/** Records the scheme. Persisting is asynchronous; failures are reported through `onError`. */
	setScheme(sessionId: string, scheme: SessionScheme): void;
	/** Resolves once every pending write has finished. */
	flush(): Promise<void>;
}

/** On-disk format of the scheme file: the sessions published under `ahp-session`. */
interface SchemeFile {
	version: 1;
	ahpSession: string[];
}

/** Parses the scheme file's contents. Malformed content yields an empty set. */
export function parseSchemes(text: string): ReadonlySet<string> {
	try {
		const raw = JSON.parse(text) as Partial<SchemeFile>;
		return new Set(Array.isArray(raw.ahpSession) ? raw.ahpSession.filter((id) => typeof id === "string") : []);
	} catch {
		return new Set();
	}
}

/** Serializes the `ahp-session` session ids, sorted so the file is stable. */
export function serializeSchemes(ahpSession: ReadonlySet<string>): string {
	const file: SchemeFile = { version: 1, ahpSession: [...ahpSession].sort() };
	return `${JSON.stringify(file, null, "\t")}\n`;
}

/** Returns `ahpSession` updated for `sessionId` published under `scheme`. */
export function withScheme(
	ahpSession: ReadonlySet<string>,
	sessionId: string,
	scheme: SessionScheme,
): ReadonlySet<string> {
	const value = scheme !== PROVIDER;
	if (ahpSession.has(sessionId) === value) return ahpSession;
	const next = new Set(ahpSession);
	if (value) next.add(sessionId);
	else next.delete(sessionId);
	return next;
}

function schemeIn(ahpSession: ReadonlySet<string>, sessionId: string): SessionScheme {
	return ahpSession.has(sessionId) ? "ahp-session" : PROVIDER;
}

/** A scheme store kept only in memory (tests, and hosts without a state directory). */
export function memorySchemeStore(initial: Iterable<string> = []): SchemeStore {
	let ahpSession: ReadonlySet<string> = new Set(initial);
	return {
		schemeOf: (sessionId) => schemeIn(ahpSession, sessionId),
		setScheme: (sessionId, scheme) => {
			ahpSession = withScheme(ahpSession, sessionId, scheme);
		},
		flush: async () => {},
	};
}

/**
 * Loads the scheme file at `path` (missing means every session uses `pi`) and
 * writes it back on every change. Writes are serialized and atomic (temp file
 * plus rename), so a crash never leaves a truncated file.
 */
export async function fileSchemeStore(
	path: string,
	onError: (error: unknown) => void = () => {},
): Promise<SchemeStore> {
	const text = await readOptional(path);
	let ahpSession = text === undefined ? new Set<string>() : parseSchemes(text);
	const writer = atomicWriter(path, onError);
	return {
		schemeOf: (sessionId) => schemeIn(ahpSession, sessionId),
		setScheme: (sessionId, scheme) => {
			const next = withScheme(ahpSession, sessionId, scheme);
			if (next === ahpSession) return;
			ahpSession = next;
			writer.write(serializeSchemes(next));
		},
		flush: writer.flush,
	};
}
