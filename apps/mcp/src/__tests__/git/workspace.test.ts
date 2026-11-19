import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultGitExec } from "../../git/git-runner.js";
import {
	CI_CONFIG_GLOBS,
	commitWorkspace,
	inspectWorkspace,
	type LinkedRepo,
	matchesCIConfig,
	prepareWorkspace,
	repoKey,
} from "../../git/workspace.js";

const git = (cwd: string, ...a: string[]) =>
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
const noCred = async () => {
	throw new Error("local remotes need no credential");
};

describe("workspace library (real git, local remotes)", () => {
	let base: string;
	let origin: string; // bare
	let seed: string; // a second clone used to push upstream changes
	let work: string; // the agent's workdir
	let repo: LinkedRepo;

	beforeEach(async () => {
		base = await mkdtemp(join(tmpdir(), "ws-"));
		origin = join(base, "origin.git");
		seed = join(base, "seed");
		work = join(base, "work");
		await mkdir(work);
		git(base, "init", "-q", "--bare", "-b", "main", origin);
		git(base, "clone", "-q", origin, seed);
		await writeFile(join(seed, "README.md"), "v1\n");
		git(seed, "add", ".");
		git(seed, "commit", "-qm", "init");
		git(seed, "branch", "-M", "main");
		git(seed, "push", "-q", "origin", "main");
		repo = {
			providerId: "p",
			repoId: "r",
			fullName: "acme/web",
			cloneUrl: origin,
			defaultBranch: "main",
		};
	});
	afterEach(() => rm(base, { recursive: true, force: true }));

	const clone = (dir = join(work, "web")) =>
		prepareWorkspace(defaultGitExec, {
			repo,
			path: dir,
			strategy: "clone",
			getCredential: noCred,
		});
	const reuse = (
		extra: Record<string, unknown> = {},
		dir = join(work, "web"),
	) =>
		prepareWorkspace(defaultGitExec, {
			repo,
			path: dir,
			strategy: "reuse",
			getCredential: noCred,
			...extra,
		});
	const pushUpstream = async (
		branch: string,
		file: string,
		content: string,
	) => {
		if (branch !== "main") {
			try {
				git(seed, "checkout", "-q", branch);
			} catch {
				git(seed, "checkout", "-q", "-b", branch, "main");
			}
		} else git(seed, "checkout", "-q", "main");
		await writeFile(join(seed, file), content);
		git(seed, "add", ".");
		git(seed, "commit", "-qm", `${branch}: ${file}`);
		git(seed, "push", "-q", "origin", branch);
	};

	describe("inspectWorkspace", () => {
		it("reports a missing workdir without creating it", async () => {
			const r = await inspectWorkspace({
				git: defaultGitExec,
				workdir: join(base, "nope"),
				repos: [repo],
			});
			expect(r.exists).toBe(false);
			expect(existsSync(join(base, "nope"))).toBe(false);
		});

		it("finds a checkout in a subfolder and says which linked repository it is", async () => {
			await clone(join(work, "projects", "web"));
			const r = await inspectWorkspace({
				git: defaultGitExec,
				workdir: work,
				repos: [repo],
			});
			expect(r.checkouts).toHaveLength(1);
			const c = r.checkouts[0];
			expect(c.path).toBe(join(work, "projects", "web"));
			expect(c.branch).toBe("main");
			expect(c.dirty).toBe(false);
			expect(c.matches).toEqual({
				providerId: "p",
				repoId: "r",
				fullName: "acme/web",
			});
			expect(c.behind).toBe(0);
		});

		it("flags uncommitted work and unpushed commits", async () => {
			const dir = join(work, "web");
			await clone(dir);
			await writeFile(join(dir, "wip.txt"), "wip");
			await writeFile(join(dir, "README.md"), "v1 edited\n");
			git(dir, "commit", "-qam", "local");
			await writeFile(join(dir, "more.txt"), "x");
			const c = (
				await inspectWorkspace({
					git: defaultGitExec,
					workdir: work,
					repos: [repo],
				})
			).checkouts[0];
			expect(c.dirty).toBe(true);
			expect(c.changedFiles).toBe(2);
			expect(c.ahead).toBe(1);
		});

		it("never reports credentials from an origin URL", async () => {
			const dir = join(work, "web");
			await clone(dir);
			git(
				dir,
				"remote",
				"set-url",
				"origin",
				"https://x-access-token:ghs_leaked@github.com/acme/web.git",
			);
			const c = (
				await inspectWorkspace({
					git: defaultGitExec,
					workdir: work,
					repos: [repo],
				})
			).checkouts[0];
			expect(c.origin).toBe("https://github.com/acme/web.git");
			expect(JSON.stringify(c)).not.toContain("ghs_leaked");
		});

		it("warns when a non-empty directory holds no checkout, and skips node_modules", async () => {
			await mkdir(join(work, "node_modules", "dep", ".git"), {
				recursive: true,
			});
			await writeFile(join(work, "notes.txt"), "x");
			const r = await inspectWorkspace({
				git: defaultGitExec,
				workdir: work,
				repos: [repo],
			});
			expect(r.checkouts).toEqual([]);
			expect(r.empty).toBe(false);
			expect(r.notes.join(" ")).toContain("Do not clone over it");
		});

		it("lists linked worktrees", async () => {
			await clone();
			await reuse({ worktree: true, createBranch: "paca/a" });
			const r = await inspectWorkspace({
				git: defaultGitExec,
				workdir: work,
				repos: [repo],
			});
			expect(r.checkouts.map((c) => c.worktree)).toEqual([false, true]);
		});
	});

	describe("prepareWorkspace – clone", () => {
		it("clones into an empty directory", async () => {
			const r = await clone();
			expect(r).toMatchObject({ ok: true, branch: "main" });
			expect(r.head).toMatch(/^[0-9a-f]{40}$/);
		});

		it("refuses a non-empty directory and deletes nothing", async () => {
			const dir = join(work, "web");
			await mkdir(dir);
			await writeFile(join(dir, "mine.txt"), "keep");
			const r = await clone(dir);
			expect(r.ok).toBe(false);
			expect(r.problem).toContain("not empty");
			expect(await readFile(join(dir, "mine.txt"), "utf8")).toBe("keep");
		});
	});

	describe("prepareWorkspace – reuse", () => {
		it("fetches and fast-forwards the default branch before any work", async () => {
			await clone();
			await pushUpstream("main", "new.txt", "from upstream");
			const r = await reuse();
			expect(r.ok).toBe(true);
			expect(r.actions.join(" ")).toContain("fast-forwarded main");
			expect(existsSync(join(work, "web", "new.txt"))).toBe(true);
		});

		it("switches to an existing remote branch, tracking it", async () => {
			await clone();
			await pushUpstream("feature/x", "x.txt", "x");
			const r = await reuse({ ref: "feature/x" });
			expect(r).toMatchObject({ ok: true, branch: "feature/x" });
			expect(
				git(
					join(work, "web"),
					"rev-parse",
					"--abbrev-ref",
					"feature/x@{upstream}",
				),
			).toBe("origin/feature/x");
		});

		it("fast-forwards a stale local branch when switching to it", async () => {
			await clone();
			await pushUpstream("feature/x", "x.txt", "1");
			await reuse({ ref: "feature/x" });
			git(join(work, "web"), "checkout", "-q", "main");
			await pushUpstream("feature/x", "x2.txt", "2");
			const r = await reuse({ ref: "feature/x" });
			expect(r.ok).toBe(true);
			expect(existsSync(join(work, "web", "x2.txt"))).toBe(true);
		});

		it("starts a new branch from the ref with createBranch", async () => {
			await clone();
			const r = await reuse({ createBranch: "paca/task-1" });
			expect(r).toMatchObject({ ok: true, branch: "paca/task-1" });
			expect(git(join(work, "web"), "rev-parse", "HEAD")).toBe(
				git(join(work, "web"), "rev-parse", "origin/main"),
			);
		});

		it("refuses to create a branch that already exists", async () => {
			await clone();
			await reuse({ createBranch: "paca/dup" });
			const r = await reuse({ createBranch: "paca/dup" });
			expect(r.ok).toBe(false);
			expect(r.problem).toContain("already exists");
		});

		it("refuses to switch a dirty tree, and says what is dirty", async () => {
			const dir = join(work, "web");
			await clone();
			await writeFile(join(dir, "wip.txt"), "someone else's work");
			await pushUpstream("feature/x", "x.txt", "x");
			const r = await reuse({ ref: "feature/x" });
			expect(r.ok).toBe(false);
			expect(r.problem).toContain("uncommitted change");
			expect(r.hint).toContain("worktree");
			expect(await readFile(join(dir, "wip.txt"), "utf8")).toBe(
				"someone else's work",
			);
			expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
		});

		it("stashes a dirty tree on request instead of discarding it", async () => {
			const dir = join(work, "web");
			await clone();
			await writeFile(join(dir, "README.md"), "edited\n");
			await pushUpstream("feature/x", "x.txt", "x");
			const r = await reuse({ ref: "feature/x", stash: true });
			expect(r).toMatchObject({ ok: true, branch: "feature/x" });
			expect(git(dir, "stash", "list")).toContain(
				"paca: before switching to feature/x",
			);
		});

		it("reports divergence and resets nothing", async () => {
			const dir = join(work, "web");
			await clone();
			await writeFile(join(dir, "local.txt"), "local");
			git(dir, "add", ".");
			git(dir, "commit", "-qm", "local commit");
			const localHead = git(dir, "rev-parse", "HEAD");
			await pushUpstream("main", "remote.txt", "remote");
			const r = await reuse();
			expect(r.ok).toBe(true);
			expect(r.problem).toContain("diverged");
			expect(r.hint).toContain("force-push");
			expect(git(dir, "rev-parse", "HEAD")).toBe(localHead);
		});

		it("is fine with local commits that are only ahead", async () => {
			const dir = join(work, "web");
			await clone();
			await writeFile(join(dir, "local.txt"), "local");
			git(dir, "add", ".");
			git(dir, "commit", "-qm", "local");
			const r = await reuse();
			expect(r.ok).toBe(true);
			expect(r.problem).toBeUndefined();
			expect(r.ahead).toBe(1); // reported, not an error
		});

		it("reports an unknown ref", async () => {
			await clone();
			const r = await reuse({ ref: "no-such-branch" });
			expect(r.ok).toBe(false);
			expect(r.problem).toContain("does not exist");
		});

		it("refuses a checkout of a different repository", async () => {
			const other = join(base, "other.git");
			git(base, "init", "-q", "--bare", "-b", "main", other);
			const dir = join(work, "web");
			await clone();
			git(dir, "remote", "set-url", "origin", other);
			const r = await reuse();
			expect(r.ok).toBe(false);
			expect(r.problem).toContain("not acme/web");
		});

		it("refuses a directory that is not a checkout", async () => {
			await mkdir(join(work, "plain"));
			const r = await reuse({}, join(work, "plain"));
			expect(r.ok).toBe(false);
			expect(r.problem).toContain("not a git checkout");
		});

		it("rejects option-looking refs", async () => {
			await clone();
			const r = await reuse({ ref: "--upload-pack=evil" });
			expect(r.ok).toBe(false);
			expect(r.problem).toContain("not a valid branch name");
		});

		it("removes credentials a previous tool version left in the origin URL", async () => {
			const dir = join(work, "web");
			await clone();
			const httpRepo = { ...repo, cloneUrl: "http://127.0.0.1:1/acme/web.git" };
			git(
				dir,
				"remote",
				"set-url",
				"origin",
				"http://x-access-token:ghs_old@127.0.0.1:1/acme/web.git",
			);
			const r = await prepareWorkspace(defaultGitExec, {
				repo: httpRepo,
				path: dir,
				strategy: "reuse",
				getCredential: noCred,
			});
			expect(r.ok).toBe(false); // nothing listens on port 1, but the cleanup comes first
			expect(r.actions).toContain(
				"removed credentials from the origin remote URL",
			);
			expect(git(dir, "remote", "get-url", "origin")).toBe(
				"http://127.0.0.1:1/acme/web.git",
			);
			expect(await readFile(join(dir, ".git", "config"), "utf8")).not.toContain(
				"ghs_old",
			);
		});
	});

	describe("prepareWorkspace – worktrees", () => {
		it("gives a ref its own checkout and keeps it out of git status", async () => {
			const dir = join(work, "web");
			await clone();
			await pushUpstream("feature/pr-42", "pr.txt", "pr");
			const r = await reuse({ ref: "feature/pr-42", worktree: true });
			expect(r.ok, JSON.stringify(r)).toBe(true);
			expect(r.path).toBe(join(dir, ".paca-worktrees", "feature-pr-42"));
			expect(r.branch).toBe("feature/pr-42");
			expect(existsSync(join(r.path!, "pr.txt"))).toBe(true);
			expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main"); // main checkout untouched
			expect(git(dir, "status", "--porcelain")).toBe(""); // the worktree dir is excluded
		});

		it("works even when the main checkout is dirty", async () => {
			const dir = join(work, "web");
			await clone();
			await writeFile(join(dir, "wip.txt"), "wip");
			await pushUpstream("feature/x", "x.txt", "x");
			const r = await reuse({ ref: "feature/x", worktree: true });
			expect(r.ok, JSON.stringify(r)).toBe(true);
			expect(existsSync(join(dir, "wip.txt"))).toBe(true);
		});

		it("reuses an existing worktree and brings it up to date", async () => {
			await clone();
			await pushUpstream("feature/x", "x.txt", "1");
			const first = await reuse({ ref: "feature/x", worktree: true });
			await pushUpstream("feature/x", "x2.txt", "2");
			const second = await reuse({ ref: "feature/x", worktree: true });
			expect(second.path).toBe(first.path);
			expect(second.actions.join(" ")).toContain("reused worktree");
			expect(existsSync(join(second.path!, "x2.txt"))).toBe(true);
		});

		it("falls back to a detached worktree when the branch is checked out in the main tree", async () => {
			await clone();
			const r = await reuse({ ref: "main", worktree: true });
			expect(r.ok, JSON.stringify(r)).toBe(true);
			expect(r.branch).toBeNull();
			expect(r.actions.join(" ")).toContain("detached");
		});

		it("cannot be combined with clone", async () => {
			const r = await prepareWorkspace(defaultGitExec, {
				repo,
				path: join(work, "x"),
				strategy: "clone",
				worktree: true,
				getCredential: noCred,
			});
			expect(r.ok).toBe(false);
		});
	});

	describe("commitWorkspace", () => {
		const setup = async () => {
			const dir = join(work, "web");
			await clone();
			await reuse({ createBranch: "paca/t" });
			return dir;
		};

		it("commits named paths with a run trailer", async () => {
			const dir = await setup();
			await writeFile(join(dir, "a.txt"), "a");
			await writeFile(join(dir, "b.txt"), "b");
			const r = await commitWorkspace(defaultGitExec, {
				repoDir: dir,
				message: "add a",
				paths: ["a.txt"],
				conversationId: "conv-1",
			});
			expect(r).toMatchObject({ ok: true, branch: "paca/t", files: ["a.txt"] });
			expect(git(dir, "log", "-1", "--format=%B")).toContain(
				"Paca-Run: conv-1",
			);
			expect(git(dir, "status", "--porcelain")).toContain("b.txt"); // not staged
		});

		it("falls back to a neutral identity only when none is configured anywhere", async () => {
			const dir = await setup();
			const saved: Record<string, string | undefined> = {};
			const set = (k: string, v: string | undefined) => {
				saved[k] = process.env[k];
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			};
			set("GIT_CONFIG_GLOBAL", "/dev/null");
			set("GIT_CONFIG_NOSYSTEM", "1");
			for (const k of [
				"GIT_AUTHOR_NAME",
				"GIT_AUTHOR_EMAIL",
				"GIT_COMMITTER_NAME",
				"GIT_COMMITTER_EMAIL",
			])
				set(k, undefined);
			try {
				await writeFile(join(dir, "a.txt"), "a");
				const r = await commitWorkspace(defaultGitExec, {
					repoDir: dir,
					message: "m",
					all: true,
				});
				expect(r.ok, JSON.stringify(r)).toBe(true);
				expect(git(dir, "log", "-1", "--format=%an <%ae>")).toBe(
					"Paca Agent <agent@paca.invalid>",
				);
			} finally {
				for (const [k, v] of Object.entries(saved)) {
					if (v === undefined) delete process.env[k];
					else process.env[k] = v;
				}
			}
		});

		it("keeps a configured identity", async () => {
			const dir = await setup();
			git(dir, "config", "user.name", "Dev Agent");
			git(dir, "config", "user.email", "dev@example.com");
			await writeFile(join(dir, "a.txt"), "a");
			await commitWorkspace(defaultGitExec, {
				repoDir: dir,
				message: "m",
				all: true,
			});
			expect(git(dir, "log", "-1", "--format=%an <%ae>")).toBe(
				"Dev Agent <dev@example.com>",
			);
		});

		it("refuses an empty commit and an empty message", async () => {
			const dir = await setup();
			expect(
				(
					await commitWorkspace(defaultGitExec, {
						repoDir: dir,
						message: "x",
						all: true,
					})
				).problem,
			).toContain("nothing is staged");
			expect(
				(await commitWorkspace(defaultGitExec, { repoDir: dir, message: "  " }))
					.problem,
			).toContain("message");
		});

		it("refuses a detached HEAD", async () => {
			const dir = await setup();
			git(dir, "checkout", "-q", "--detach");
			await writeFile(join(dir, "a.txt"), "a");
			const r = await commitWorkspace(defaultGitExec, {
				repoDir: dir,
				message: "m",
				all: true,
			});
			expect(r.ok).toBe(false);
			expect(r.problem).toContain("detached");
		});

		it("rejects CI configuration changes and unstages them", async () => {
			const dir = await setup();
			await mkdir(join(dir, ".github", "workflows"), { recursive: true });
			await writeFile(join(dir, ".github", "workflows", "ci.yml"), "name: x");
			await writeFile(join(dir, "ok.txt"), "ok");
			const r = await commitWorkspace(defaultGitExec, {
				repoDir: dir,
				message: "m",
				all: true,
			});
			expect(r.ok).toBe(false);
			expect(r.problem).toContain(".github/workflows/ci.yml");
			expect(git(dir, "diff", "--cached", "--name-only")).toContain("ok.txt"); // the rest stays staged
			expect(git(dir, "diff", "--cached", "--name-only")).not.toContain(
				"ci.yml",
			); // the CI file was unstaged
			expect(git(dir, "log", "--oneline").split("\n")).toHaveLength(1); // nothing committed
			// An operator-level override exists; an agent argument does not.
			const allowed = await commitWorkspace(defaultGitExec, {
				repoDir: dir,
				message: "m",
				all: true,
				allowCIConfig: true,
			});
			expect(allowed.ok, JSON.stringify(allowed)).toBe(true);
		});

		it("rejects option-looking paths", async () => {
			const dir = await setup();
			const r = await commitWorkspace(defaultGitExec, {
				repoDir: dir,
				message: "m",
				paths: ["--all"],
			});
			expect(r.ok).toBe(false);
		});

		it("is not a checkout", async () => {
			const r = await commitWorkspace(defaultGitExec, {
				repoDir: work,
				message: "m",
				all: true,
			});
			expect(r.ok).toBe(false);
		});
	});
});

describe("repoKey", () => {
	it("makes equivalent remotes comparable", () => {
		const keys = [
			"https://github.com/Acme/Web.git",
			"https://x-access-token:tok@github.com/acme/web",
			"git@github.com:acme/web.git",
			"https://github.com/acme/web/",
		].map(repoKey);
		expect(new Set(keys)).toEqual(new Set(["github.com/acme/web"]));
	});
	it("keeps different hosts and ports apart", () => {
		expect(repoKey("https://gitlab.acme.io:8443/a/b.git")).not.toBe(
			repoKey("https://gitlab.acme.io/a/b.git"),
		);
	});
});

describe("matchesCIConfig", () => {
	it.each([
		".github/workflows/ci.yml",
		".github/workflows/deep/nested.yaml",
		".gitlab-ci.yml",
		"bitbucket-pipelines.yml",
		".circleci/config.yml",
		"Jenkinsfile",
	])("blocks %s", (p) => expect(matchesCIConfig(p)).toBe(true));
	it.each([
		"src/main.go",
		".github/CODEOWNERS",
		"docs/ci.md",
		"my.gitlab-ci.yml.bak",
	])("allows %s", (p) => expect(matchesCIConfig(p)).toBe(false));
	it("exposes the default globs", () =>
		expect(CI_CONFIG_GLOBS).toContain(".github/workflows/**"));
});
