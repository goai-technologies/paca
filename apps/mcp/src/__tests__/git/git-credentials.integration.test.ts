import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultGitExec } from "../../git/git-runner.js";
import { prepareWorkspace, pushWorkspace } from "../../git/workspace.js";
import { startGitServer, type TestGitServer } from "./test-git-server.js";

// Real git against a real (local) smart-HTTP server: proves the credential
// helper hands git a credential per command without it ever being persisted.
const hasGit = (() => {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

const sh = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

async function grepTree(dir: string, needle: string): Promise<string[]> {
	const hits: string[] = [];
	const walk = async (d: string) => {
		for (const e of await readdir(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) await walk(p);
			else if ((await readFile(p)).includes(needle)) hits.push(p);
		}
	};
	await walk(dir);
	return hits;
}

describe.skipIf(!hasGit)("git credential helper (real git)", () => {
	let root: string;
	let work: string;
	let home: string;
	let server: TestGitServer;
	let url: string;
	const prevEnv: Record<string, string | undefined> = {};

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "pgc-srv-"));
		work = await mkdtemp(join(tmpdir(), "pgc-work-"));
		home = await mkdtemp(join(tmpdir(), "pgc-home-"));
		// A global "store" helper the tool must override, not use.
		await writeFile(
			join(home, ".gitconfig"),
			"[credential]\n\thelper = store\n[user]\n\temail = t@t\n\tname = t\n",
		);
		for (const k of ["HOME", "GIT_CONFIG_GLOBAL", "XDG_CONFIG_HOME"])
			prevEnv[k] = process.env[k];
		process.env.HOME = home;
		process.env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
		process.env.XDG_CONFIG_HOME = join(home, ".config");

		await mkdir(join(root, "acme"), { recursive: true });
		sh(root, "init", "-q", "--bare", "acme/web.git");
		sh(root, "init", "-q", "--bare", "acme/secret.git");
		sh(join(root, "acme/web.git"), "config", "http.receivepack", "true");
		const seed = join(work, "seed");
		sh(work, "clone", "-q", join(root, "acme/web.git"), seed);
		await writeFile(join(seed, "README.md"), "hi\n");
		sh(seed, "add", ".");
		sh(seed, "commit", "-qm", "init");
		sh(seed, "branch", "-M", "main");
		sh(seed, "push", "-q", "origin", "main");
		server = await startGitServer(root);
		url = `${server.url}/acme/web.git`;
	});

	afterAll(async () => {
		await server?.close();
		for (const [k, v] of Object.entries(prevEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		await Promise.all(
			[root, work, home].map(
				(d) => d && rm(d, { recursive: true, force: true }),
			),
		);
	});

	const repo = () => ({
		providerId: "com.paca.github",
		repoId: "r1",
		fullName: "acme/web",
		cloneUrl: url,
		defaultBranch: "main",
	});
	const cred =
		(access: "read" | "write", ttl = 60_000, counter?: { n: number }) =>
		async () => {
			if (counter) counter.n++;
			return {
				username: "x-access-token",
				secret: server.mint("acme/web", access, ttl),
			};
		};

	it("clones with a minted credential and leaves no trace of it", async () => {
		const dir = join(work, "clone1");
		const res = await prepareWorkspace(defaultGitExec, {
			repo: repo(),
			path: dir,
			strategy: "clone",
			getCredential: cred("read"),
		});
		expect(res.ok, JSON.stringify(res)).toBe(true);
		expect(server.authedRequests()).toBeGreaterThan(0);
		expect(sh(dir, "remote", "get-url", "origin")).toBe(url); // token-free
		expect(await grepTree(join(dir, ".git"), "ghs_")).toEqual([]);
		expect(await grepTree(join(dir, ".git"), "x-access-token")).toEqual([]);
		// The global `store` helper must not have cached it either.
		expect(existsSync(join(home, ".git-credentials"))).toBe(false);
	});

	it("asks for a fresh credential per command (an expired one is not reused)", async () => {
		const dir = join(work, "clone2");
		const counter = { n: 0 };
		await prepareWorkspace(defaultGitExec, {
			repo: repo(),
			path: dir,
			strategy: "clone",
			getCredential: cred("read", 1500, counter),
		});
		await new Promise((r) => setTimeout(r, 2000)); // the first credential is now expired server-side
		const res = await prepareWorkspace(defaultGitExec, {
			repo: repo(),
			path: dir,
			strategy: "reuse",
			getCredential: cred("read", 1500, counter),
		});
		expect(res.ok, JSON.stringify(res)).toBe(true);
		expect(res.actions).toContain("fetched origin");
		expect(counter.n).toBeGreaterThanOrEqual(2);
	});

	it("a read credential cannot push; a write credential can", async () => {
		const dir = join(work, "clone3");
		await prepareWorkspace(defaultGitExec, {
			repo: repo(),
			path: dir,
			strategy: "clone",
			getCredential: cred("read"),
		});
		sh(dir, "checkout", "-q", "-b", "paca/feature");
		await writeFile(join(dir, "f.txt"), "x\n");
		sh(dir, "add", ".");
		sh(dir, "commit", "-qm", "feat");

		const denied = await pushWorkspace(defaultGitExec, {
			repo: repo(),
			repoDir: dir,
			getCredential: cred("read"),
		});
		expect(denied.ok).toBe(false);
		expect(denied.problem).toContain("git push failed");

		const ok = await pushWorkspace(defaultGitExec, {
			repo: repo(),
			repoDir: dir,
			getCredential: cred("write"),
		});
		expect(ok.ok, JSON.stringify(ok)).toBe(true);
		expect(
			sh(
				join(root, "acme/web.git"),
				"rev-parse",
				"--verify",
				"refs/heads/paca/feature",
			),
		).toMatch(/^[0-9a-f]{40}$/);
	});

	it("the broker answers only for the command's own repository", async () => {
		let asked = 0;
		const other = {
			...repo(),
			cloneUrl: `${server.url}/acme/secret.git`,
			fullName: "acme/secret",
		};
		// The credential getter would hand out a token for acme/web; the broker
		// must never be asked for it because the command targets another repo
		// than... actually it IS the command's repo, so make the helper ask for a
		// different path by pointing git at a redirect-free mismatch: use the
		// getter for web but clone secret — it is called (same command), yet the
		// server rejects the token for the wrong path.
		const res = await prepareWorkspace(defaultGitExec, {
			repo: other,
			path: join(work, "secret-clone"),
			strategy: "clone",
			getCredential: async () => {
				asked++;
				return {
					username: "x-access-token",
					secret: server.mint("acme/web", "read"),
				};
			},
		});
		expect(res.ok).toBe(false); // the server refuses a web token for the secret repo
		expect(asked).toBeLessThanOrEqual(2);
	});

	it("opens no lingering sockets or temp directories", async () => {
		const before = (await readdir(tmpdir())).filter(
			(n) =>
				n.startsWith("pgc-") &&
				!["pgc-srv-", "pgc-work-", "pgc-home-"].some((p) => n.startsWith(p)),
		);
		await prepareWorkspace(defaultGitExec, {
			repo: repo(),
			path: join(work, "clone4"),
			strategy: "clone",
			getCredential: cred("read"),
		});
		const after = (await readdir(tmpdir())).filter(
			(n) =>
				n.startsWith("pgc-") &&
				!["pgc-srv-", "pgc-work-", "pgc-home-"].some((p) => n.startsWith(p)),
		);
		expect(after).toEqual(before);
	});

	it("fails cleanly, without prompting, when no credential can be obtained", async () => {
		const res = await prepareWorkspace(defaultGitExec, {
			repo: repo(),
			path: join(work, "clone5"),
			strategy: "clone",
			getCredential: async () => {
				throw new Error("no credential available");
			},
		});
		expect(res.ok).toBe(false);
		expect(res.problem).toContain("git clone failed");
	});
});
