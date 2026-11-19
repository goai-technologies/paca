import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A git smart-HTTP server (git-http-backend as CGI) that accepts only
 * short-lived, repository- and access-scoped Basic-auth tokens. Stands in for a
 * Git platform so the credential helper can be tested with real git.
 */
export interface TestGitServer {
	url: string; // http://127.0.0.1:PORT
	host: string; // 127.0.0.1:PORT
	/** Mints a token the server will accept. */
	mint(repoPath: string, access: "read" | "write", ttlMs?: number): string;
	/** How many requests presented a valid token. */
	authedRequests(): number;
	close(): Promise<void>;
}

interface Token {
	path: string;
	access: "read" | "write";
	exp: number;
}

export async function startGitServer(root: string): Promise<TestGitServer> {
	const tokens = new Map<string, Token>();
	let authed = 0;
	const server = http.createServer((req, res) => {
		const u = new URL(req.url ?? "/", "http://x");
		const m = /^\/(.+?)\.git(\/.*)?$/.exec(u.pathname);
		const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
		const pass = basic
			? Buffer.from(basic[1], "base64").toString().split(":")[1]
			: undefined;
		const tok = pass ? tokens.get(pass) : undefined;
		if (!m || !tok || tok.exp < Date.now() || tok.path !== m[1]) {
			res
				.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' })
				.end("auth required");
			return;
		}
		const isPush =
			u.searchParams.get("service") === "git-receive-pack" ||
			(m[2] ?? "").endsWith("git-receive-pack");
		if (isPush && tok.access !== "write") {
			res.writeHead(403).end("read-only credential");
			return;
		}
		authed++;
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			const cgi = spawn("git", ["http-backend"], {
				env: {
					PATH: process.env.PATH ?? "",
					GIT_PROJECT_ROOT: root,
					GIT_HTTP_EXPORT_ALL: "1",
					REMOTE_USER: "x-access-token",
					REQUEST_METHOD: req.method ?? "GET",
					PATH_INFO: u.pathname,
					QUERY_STRING: u.search.slice(1),
					CONTENT_TYPE: req.headers["content-type"] ?? "",
					CONTENT_LENGTH: String(body.length),
					HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""),
				},
			});
			const out: Buffer[] = [];
			cgi.stdout.on("data", (c) => out.push(c));
			cgi.stdin.end(body);
			cgi.on("close", () => {
				const raw = Buffer.concat(out);
				const i = raw.indexOf("\r\n\r\n");
				const headers: Record<string, string> = {};
				let status = 200;
				for (const line of raw.subarray(0, i).toString().split("\r\n")) {
					const [k, ...v] = line.split(": ");
					if (k.toLowerCase() === "status") status = Number.parseInt(v[0], 10);
					else headers[k] = v.join(": ");
				}
				res.writeHead(status, headers).end(raw.subarray(i + 4));
			});
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}`,
		host: `127.0.0.1:${port}`,
		mint(repoPath, access, ttlMs = 60_000) {
			const t = `ghs_${crypto.randomBytes(12).toString("hex")}`;
			tokens.set(t, { path: repoPath, access, exp: Date.now() + ttlMs });
			return t;
		},
		authedRequests: () => authed,
		close: () => new Promise<void>((r) => server.close(() => r())),
	};
}
