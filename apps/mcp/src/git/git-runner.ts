import { execFile as execFileCb } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	type GitAuth,
	splitRemote,
	withCredentialBroker,
} from "./credential-broker.js";

const execFileAsync = promisify(execFileCb);

export interface GitResult {
	stdout: string;
	stderr: string;
}

export interface GitRunOptions {
	cwd?: string;
	/** Present for commands that talk to an http(s) remote. */
	auth?: GitAuth;
}

/**
 * Runs one git command. A thin injection seam so tests can substitute a fake
 * without mocking node:child_process globally.
 */
export type GitExec = (
	args: string[],
	opts?: GitRunOptions,
) => Promise<GitResult>;

const MAX_BUFFER = 10 * 1024 * 1024;

/** Where the credential helper script lives (next to this module, src or build). */
export function credentialHelperPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "credential-helper.mjs");
}

function shellQuote(s: string): string {
	return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Removes a credential from text before it can reach a log or the model's
 * context. Defence in depth: with the credential helper the secret is never on
 * a command line or in a URL, so there is normally nothing to remove — but git
 * and servers occasionally echo credentials in error messages.
 */
export function scrubSecret(text: string, secret: string): string {
	let out = text;
	if (secret) {
		out = out.split(secret).join("***");
		const encoded = encodeURIComponent(secret);
		if (encoded !== secret) out = out.split(encoded).join("***");
	}
	return out.replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/g, "$1***:***@");
}

/**
 * Configuration that makes git ask Paca's helper — and nothing else — for a
 * credential. `credential.helper=` first clears any inherited helper (a
 * system keychain would otherwise cache the credential), `useHttpPath` makes
 * git send the repository path so the broker can authorize that exact
 * repository, and the protocol allow-list keeps a hostile repository from
 * redirecting git to file:// or ssh transports.
 */
function authConfig(): string[] {
	const helper = `!${shellQuote(process.execPath)} ${shellQuote(credentialHelperPath())}`;
	return [
		"-c",
		"credential.helper=",
		"-c",
		`credential.helper=${helper}`,
		"-c",
		"credential.useHttpPath=true",
		"-c",
		"protocol.allow=never",
		"-c",
		"protocol.https.allow=always",
		"-c",
		"protocol.http.allow=always",
	];
}

/** The production GitExec. */
export const defaultGitExec: GitExec = async (args, opts = {}) => {
	const baseEnv = {
		...process.env,
		GIT_TERMINAL_PROMPT: "0",
		GCM_INTERACTIVE: "never",
	};
	const { auth, cwd } = opts;
	if (!auth || !splitRemote(auth.remoteURL)) {
		return execFileAsync("git", args, {
			cwd,
			env: baseEnv,
			maxBuffer: MAX_BUFFER,
		});
	}
	return withCredentialBroker(auth, async (session) => {
		try {
			const res = await execFileAsync("git", [...authConfig(), ...args], {
				cwd,
				env: { ...baseEnv, ...session.env },
				maxBuffer: MAX_BUFFER,
			});
			return {
				stdout: scrubSecret(res.stdout, session.issuedSecret()),
				stderr: scrubSecret(res.stderr, session.issuedSecret()),
			};
		} catch (err) {
			// Re-throw with the secret scrubbed from everything an error can carry.
			const e = err as { stdout?: string; stderr?: string; message?: string };
			const s = session.issuedSecret();
			if (typeof e.stdout === "string") e.stdout = scrubSecret(e.stdout, s);
			if (typeof e.stderr === "string") e.stderr = scrubSecret(e.stderr, s);
			if (typeof e.message === "string") e.message = scrubSecret(e.message, s);
			throw err;
		}
	});
};
