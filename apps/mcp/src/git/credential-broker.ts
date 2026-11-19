import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A credential for one git invocation. */
export interface GitCredential {
	username: string;
	secret: string;
}

/**
 * How a network git command authenticates. `remoteURL` is credential-free: the
 * credential itself is only ever handed to git, per command, through the
 * credential helper — never embedded in a URL, a config file, the environment
 * or an argument.
 */
export interface GitAuth {
	remoteURL: string;
	access: "read" | "write";
	/** Called lazily, at most once per command, when git asks for a credential. */
	getCredential: (access: "read" | "write") => Promise<GitCredential>;
}

/** Most credential requests one git command may make (a clone needs 1–2). */
const MAX_REQUESTS_PER_COMMAND = 8;

/** "https://host:8443/o/r.git" -> { host: "host:8443", path: "o/r" } (lower-cased host). */
export function splitRemote(
	url: string,
): { scheme: string; host: string; path: string } | null {
	try {
		const u = new URL(url);
		if (u.protocol !== "https:" && u.protocol !== "http:") return null;
		return {
			scheme: u.protocol.slice(0, -1),
			host: u.host.toLowerCase(),
			path: u.pathname
				.replace(/^\/+/, "")
				.replace(/\.git$/, "")
				.replace(/\/+$/, ""),
		};
	} catch {
		return null;
	}
}

/** Strips any userinfo from a URL; leaves non-URL remotes (paths, scp-style) alone. */
export function stripCredentials(url: string): string {
	try {
		const u = new URL(url);
		u.username = "";
		u.password = "";
		return u.toString();
	} catch {
		return url;
	}
}

export interface BrokerSession {
	/** Environment to give git so the helper can reach this broker. */
	env: Record<string, string>;
	/** The secret that was handed out, if any — for scrubbing command output. */
	issuedSecret(): string;
}

/**
 * Opens a broker for exactly one git command: a unix socket in a private
 * (0700) temp directory, answering only requests for the command's own remote
 * host and path, at most MAX_REQUESTS_PER_COMMAND times. It closes and removes
 * itself when `fn` settles, so nothing outlives the command that needed it.
 */
export async function withCredentialBroker<T>(
	auth: GitAuth,
	fn: (session: BrokerSession) => Promise<T>,
): Promise<T> {
	const expected = splitRemote(auth.remoteURL);
	if (!expected) {
		throw new Error("credential broker: remote must be an http(s) URL");
	}
	const dir = await mkdtemp(join(tmpdir(), "pgc-"));
	const sock = join(dir, "s");
	let issued = "";
	let cached: Promise<GitCredential> | null = null;
	let requests = 0;

	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", async () => {
			const deny = (code: number) => res.writeHead(code).end();
			if (req.method !== "POST" || ++requests > MAX_REQUESTS_PER_COMMAND)
				return deny(403);
			let q: { protocol?: string; host?: string; path?: string };
			try {
				q = JSON.parse(body || "{}");
			} catch {
				return deny(400);
			}
			const path = String(q.path ?? "")
				.replace(/^\/+/, "")
				.replace(/\.git$/, "")
				.replace(/\/+$/, "");
			// The scheme too: git must not be talked into sending the credential
			// over http to a host the remote names with https (git-runner allows
			// http for remotes that really are http).
			if (
				String(q.protocol ?? "").toLowerCase() !== expected.scheme ||
				String(q.host ?? "").toLowerCase() !== expected.host ||
				path !== expected.path
			) {
				return deny(403);
			}
			try {
				cached ??= auth.getCredential(auth.access);
				const cred = await cached;
				issued = cred.secret;
				res
					.writeHead(200, { "content-type": "application/json" })
					.end(
						JSON.stringify({ username: cred.username, secret: cred.secret }),
					);
			} catch {
				deny(502);
			}
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(sock, resolve);
	});
	try {
		return await fn({
			env: { PACA_GIT_SOCK: sock },
			issuedSecret: () => issued,
		});
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	}
}
