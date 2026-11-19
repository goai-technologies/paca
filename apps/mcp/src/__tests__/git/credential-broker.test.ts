import http from "node:http";
import { describe, expect, it } from "vitest";
import { withCredentialBroker } from "../../git/credential-broker.js";
import { sanitizeSlug } from "../../git/workspace.js";

/** Asks the broker for a credential the way the git helper does. */
function ask(
	sock: string,
	q: { protocol?: string; host: string; path: string },
): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ socketPath: sock, method: "POST", path: "/" },
			(res) => {
				res.resume();
				res.on("end", () => resolve(res.statusCode ?? 0));
			},
		);
		req.on("error", reject);
		req.end(JSON.stringify(q));
	});
}

const cred = async () => ({ username: "x-access-token", secret: "tok" });

describe("withCredentialBroker – who it answers", () => {
	it("answers the command's own scheme, host and path", async () => {
		await withCredentialBroker(
			{
				remoteURL: "https://git.example/acme/web.git",
				access: "read",
				getCredential: cred,
			},
			async (s) => {
				const sock = s.env.PACA_GIT_SOCK;
				expect(
					await ask(sock, {
						protocol: "https",
						host: "git.example",
						path: "acme/web.git",
					}),
				).toBe(200);
			},
		);
	});

	it("refuses another scheme for the same host and path (no cleartext credential)", async () => {
		let minted = 0;
		await withCredentialBroker(
			{
				remoteURL: "https://git.example/acme/web.git",
				access: "read",
				getCredential: async () => {
					minted++;
					return cred();
				},
			},
			async (s) => {
				const sock = s.env.PACA_GIT_SOCK;
				expect(
					await ask(sock, {
						protocol: "http",
						host: "git.example",
						path: "acme/web.git",
					}),
				).toBe(403);
				expect(
					await ask(sock, { host: "git.example", path: "acme/web.git" }),
				).toBe(403);
				expect(minted).toBe(0);
			},
		);
	});

	it("keeps an http remote on http", async () => {
		await withCredentialBroker(
			{
				remoteURL: "http://127.0.0.1:8080/acme/web.git",
				access: "read",
				getCredential: cred,
			},
			async (s) => {
				const sock = s.env.PACA_GIT_SOCK;
				expect(
					await ask(sock, {
						protocol: "http",
						host: "127.0.0.1:8080",
						path: "acme/web",
					}),
				).toBe(200);
				expect(
					await ask(sock, {
						protocol: "https",
						host: "127.0.0.1:8080",
						path: "acme/web",
					}),
				).toBe(403);
			},
		);
	});

	it("still refuses another host or path", async () => {
		await withCredentialBroker(
			{
				remoteURL: "https://git.example/acme/web.git",
				access: "read",
				getCredential: cred,
			},
			async (s) => {
				const sock = s.env.PACA_GIT_SOCK;
				expect(
					await ask(sock, {
						protocol: "https",
						host: "evil.example",
						path: "acme/web",
					}),
				).toBe(403);
				expect(
					await ask(sock, {
						protocol: "https",
						host: "git.example",
						path: "acme/other",
					}),
				).toBe(403);
			},
		);
	});
});

describe("sanitizeSlug", () => {
	it("never yields a path component that leaves or is the worktree folder", () => {
		for (const bad of [
			".",
			"..",
			"...",
			"../..",
			"a/../b",
			"../etc",
			".hidden/..",
		]) {
			const slug = sanitizeSlug(bad);
			expect(slug).not.toMatch(/^\.+$/);
			expect(slug).not.toContain("..");
			expect(slug).not.toContain("/");
			expect(slug.length).toBeGreaterThan(0);
		}
		expect(sanitizeSlug("..")).toBe("wt");
	});

	it("keeps ordinary branch names readable", () => {
		expect(sanitizeSlug("paca/task-1")).toBe("paca-task-1");
		expect(sanitizeSlug("feat/PACA-12.login")).toBe("feat-PACA-12.login");
	});
});
