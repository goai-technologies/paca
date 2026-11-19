import { appendFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GitAuth } from "./credential-broker.js";
import { splitRemote, stripCredentials } from "./credential-broker.js";
import type { GitExec } from "./git-runner.js";

/** A repository linked to the project, as the workspace tools see it. */
export interface LinkedRepo {
	providerId: string;
	repoId: string;
	fullName: string;
	cloneUrl: string;
	defaultBranch?: string;
}

/** Normalizes a remote to "host/path" (no scheme, userinfo, ".git" or case) for comparison. */
export function repoKey(url: string): string {
	const parts = splitRemote(stripCredentials(url));
	if (parts) return `${parts.host}/${parts.path}`.toLowerCase();
	// scp-style git@host:owner/repo.git
	const m = /^[^@\s]+@([^:\s]+):(.+?)(?:\.git)?$/.exec(url.trim());
	if (m) return `${m[1]}/${m[2]}`.toLowerCase();
	return url
		.trim()
		.replace(/\.git$/, "")
		.toLowerCase();
}

/** git failures are normal tool outcomes; this pulls the useful message out. */
export function gitMessage(error: unknown): string {
	const e = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
	if (typeof e?.stderr === "string" && e.stderr.trim()) return e.stderr.trim();
	if (typeof e?.stdout === "string" && e.stdout.trim()) return e.stdout.trim();
	return typeof e?.message === "string" ? e.message : String(error);
}

async function tryGit(
	git: GitExec,
	args: string[],
	cwd: string,
): Promise<string | null> {
	try {
		return (await git(args, { cwd })).stdout.trim();
	} catch {
		return null;
	}
}

// ── inspect ──────────────────────────────────────────────────────────────────

export interface Checkout {
	path: string;
	origin: string | null; // token-free
	branch: string | null; // null when detached
	head: string | null;
	ahead: number | null;
	behind: number | null;
	dirty: boolean;
	changedFiles: number;
	lastFetch: string | null;
	worktree: boolean;
	matches: { providerId: string; repoId: string; fullName: string } | null;
}

export interface WorkspaceInspection {
	workdir: string;
	exists: boolean;
	empty: boolean;
	entries: string[];
	checkouts: Checkout[];
	notes: string[];
}

const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"vendor",
	"dist",
	"build",
	"target",
	".venv",
]);
const MAX_CHECKOUTS = 25;

async function isDir(p: string): Promise<boolean> {
	try {
		return (await stat(p)).isDirectory();
	} catch {
		return false;
	}
}

async function hasGit(p: string): Promise<boolean> {
	try {
		await stat(join(p, ".git")); // a directory, or a file for a linked worktree
		return true;
	} catch {
		return false;
	}
}

async function findCheckoutDirs(workdir: string): Promise<string[]> {
	const found: string[] = [];
	const scan = async (dir: string, depth: number): Promise<void> => {
		if (found.length >= MAX_CHECKOUTS) return;
		if (await hasGit(dir)) {
			found.push(dir);
			// A checkout can hold linked worktrees; list them, don't descend further.
			const wt = join(dir, ".paca-worktrees");
			if (await isDir(wt)) {
				for (const e of await readdir(wt)) {
					const p = join(wt, e);
					if (await hasGit(p)) found.push(p);
				}
			}
			return;
		}
		if (depth === 0) return;
		let names: string[] = [];
		try {
			names = await readdir(dir);
		} catch {
			return;
		}
		for (const n of names.sort()) {
			if (SKIP_DIRS.has(n) || n.startsWith(".")) continue;
			const p = join(dir, n);
			if (await isDir(p)) await scan(p, depth - 1);
		}
	};
	await scan(workdir, 2);
	return found.slice(0, MAX_CHECKOUTS);
}

async function describeCheckout(
	git: GitExec,
	dir: string,
	repos: LinkedRepo[],
): Promise<Checkout> {
	const origin = await tryGit(git, ["remote", "get-url", "origin"], dir);
	const branch = await tryGit(
		git,
		["symbolic-ref", "--quiet", "--short", "HEAD"],
		dir,
	);
	const head = await tryGit(git, ["rev-parse", "HEAD"], dir);
	const status = (await tryGit(git, ["status", "--porcelain"], dir)) ?? "";
	const changed = status ? status.split("\n").filter(Boolean).length : 0;
	let ahead: number | null = null;
	let behind: number | null = null;
	const counts = await tryGit(
		git,
		["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
		dir,
	);
	if (counts) {
		const [b, a] = counts.split(/\s+/).map(Number);
		behind = Number.isFinite(b) ? b : null;
		ahead = Number.isFinite(a) ? a : null;
	}
	let lastFetch: string | null = null;
	const fetchHead = await tryGit(
		git,
		["rev-parse", "--git-path", "FETCH_HEAD"],
		dir,
	);
	if (fetchHead) {
		try {
			lastFetch = (await stat(resolve(dir, fetchHead))).mtime.toISOString();
		} catch {
			lastFetch = null;
		}
	}
	const safeOrigin = origin ? stripCredentials(origin) : null;
	const key = safeOrigin ? repoKey(safeOrigin) : null;
	const hit = key ? repos.find((r) => repoKey(r.cloneUrl) === key) : undefined;
	return {
		path: dir,
		origin: safeOrigin,
		branch,
		head,
		ahead,
		behind,
		dirty: changed > 0,
		changedFiles: changed,
		lastFetch,
		worktree: dir.includes("/.paca-worktrees/"),
		matches: hit
			? {
					providerId: hit.providerId,
					repoId: hit.repoId,
					fullName: hit.fullName,
				}
			: null,
	};
}

/**
 * Read-only survey of the working directory: what is there, which checkouts
 * exist, and which linked repository each one is. Mutates nothing and never
 * touches the network, so it is cheap to call before every task.
 */
export async function inspectWorkspace(opts: {
	git: GitExec;
	workdir: string;
	repos: LinkedRepo[];
}): Promise<WorkspaceInspection> {
	const workdir = resolve(opts.workdir);
	const notes: string[] = [];
	if (!(await isDir(workdir))) {
		return {
			workdir,
			exists: false,
			empty: true,
			entries: [],
			checkouts: [],
			notes: [
				'The working directory does not exist yet; workspace_prepare with strategy "clone" will create it.',
			],
		};
	}
	const entries = (await readdir(workdir)).sort();
	const dirs = await findCheckoutDirs(workdir);
	const checkouts: Checkout[] = [];
	for (const d of dirs)
		checkouts.push(await describeCheckout(opts.git, d, opts.repos));
	if (entries.length > 0 && checkouts.length === 0) {
		notes.push(
			"The directory is not empty but holds no git checkout (a checkout may exist without git initialised). Do not clone over it; choose a subfolder.",
		);
	}
	if (checkouts.some((c) => c.dirty)) {
		notes.push(
			"Some checkouts have uncommitted changes (possibly from an earlier conversation). Use worktree or stash in workspace_prepare rather than discarding them.",
		);
	}
	return {
		workdir,
		exists: true,
		empty: entries.length === 0,
		entries: entries.slice(0, 50),
		checkouts,
		notes,
	};
}

// ── prepare ──────────────────────────────────────────────────────────────────

export interface PrepareArgs {
	repo: LinkedRepo;
	path: string;
	ref?: string;
	strategy: "reuse" | "clone";
	createBranch?: string;
	worktree?: boolean;
	stash?: boolean;
	blobless?: boolean;
	getCredential: GitAuth["getCredential"];
}

export interface PrepareResult {
	ok: boolean;
	path?: string;
	branch?: string | null;
	head?: string | null;
	ahead?: number | null;
	behind?: number | null;
	actions: string[];
	problem?: string;
	hint?: string;
}

const BRANCH_NAME = /^(?!-)[A-Za-z0-9._\-/]+$/;

function authFor(
	repo: LinkedRepo,
	access: "read" | "write",
	getCredential: GitAuth["getCredential"],
): GitAuth | undefined {
	const url = stripCredentials(repo.cloneUrl);
	return splitRemote(url)
		? { remoteURL: url, access, getCredential }
		: undefined;
}

export function sanitizeSlug(s: string): string {
	return (
		s
			.replace(/[^A-Za-z0-9._-]+/g, "-")
			// "." and ".." are path components, not names: a slug of ".." would
			// make join(root, slug) the checkout root itself.
			.replace(/\.{2,}/g, ".")
			.replace(/^[-.]+|[-.]+$/g, "")
			.slice(0, 60) || "wt"
	);
}

/**
 * Gets a working tree ready to edit: clone into an empty folder, or reuse an
 * existing checkout — fetch, switch to the requested ref and fast-forward.
 * It never deletes anything, never resets a diverged branch, and refuses to
 * switch a dirty tree unless told to stash or to use a separate worktree.
 */
export async function prepareWorkspace(
	git: GitExec,
	a: PrepareArgs,
): Promise<PrepareResult> {
	const actions: string[] = [];
	const plainUrl = stripCredentials(a.repo.cloneUrl);
	const readAuth = authFor(a.repo, "read", a.getCredential);
	const fail = (problem: string, hint?: string): PrepareResult => ({
		ok: false,
		actions,
		problem,
		hint,
	});
	if (a.ref && !BRANCH_NAME.test(a.ref))
		return fail(`"${a.ref}" is not a valid branch name or commit.`);
	if (a.createBranch && !BRANCH_NAME.test(a.createBranch))
		return fail(`"${a.createBranch}" is not a valid branch name.`);
	const path = resolve(a.path);

	// ── clone ──
	if (a.strategy === "clone") {
		if (a.worktree)
			return fail(
				'worktree needs an existing checkout; use strategy "reuse" for it.',
			);
		let entries: string[] = [];
		try {
			entries = await readdir(path);
		} catch {
			entries = [];
		}
		if (entries.length > 0) {
			return fail(
				`${path} is not empty; refusing to clone into it.`,
				'Run workspace_inspect: the repository may already be here (use strategy "reuse"), or choose an empty subfolder.',
			);
		}
		const args = [
			"clone",
			...(a.blobless ? ["--filter=blob:none"] : []),
			...(a.ref ? ["--branch", a.ref] : []),
			plainUrl,
			path,
		];
		try {
			await git(args, { auth: readAuth });
		} catch (e) {
			return fail(`git clone failed: ${gitMessage(e)}`);
		}
		actions.push(`cloned ${a.repo.fullName}`);
		return finish(git, path, actions);
	}

	// ── reuse ──
	const isRepo = await tryGit(
		git,
		["rev-parse", "--is-inside-work-tree"],
		path,
	);
	if (isRepo !== "true")
		return fail(
			`${path} is not a git checkout.`,
			'Run workspace_inspect to find where the repository is, or use strategy "clone".',
		);
	const origin = await tryGit(git, ["remote", "get-url", "origin"], path);
	if (!origin || repoKey(origin) !== repoKey(plainUrl)) {
		return fail(
			`${path} is a checkout of ${origin ? stripCredentials(origin) : "an unknown remote"}, not ${a.repo.fullName}.`,
			"Pick the matching checkout from workspace_inspect.",
		);
	}
	// A token left in a remote URL by an older tool version is a leak; remove it.
	if (origin !== stripCredentials(origin)) {
		await git(["remote", "set-url", "origin", stripCredentials(origin)], {
			cwd: path,
		});
		actions.push("removed credentials from the origin remote URL");
	}

	try {
		await git(["fetch", "--prune", "origin"], { cwd: path, auth: readAuth });
		actions.push("fetched origin");
	} catch (e) {
		return fail(`git fetch failed: ${gitMessage(e)}`);
	}

	const defaultBranch =
		a.repo.defaultBranch ||
		(
			await tryGit(
				git,
				["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
				path,
			)
		)?.replace(/^origin\//, "") ||
		"main";
	const ref = a.ref || defaultBranch;
	const remoteExists =
		(await tryGit(
			git,
			["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${ref}`],
			path,
		)) !== null;
	const localExists =
		(await tryGit(
			git,
			["rev-parse", "--verify", "--quiet", `refs/heads/${ref}`],
			path,
		)) !== null;
	const shaLike =
		/^[0-9a-f]{7,40}$/i.test(ref) && !remoteExists && !localExists;
	if (!remoteExists && !localExists && !shaLike)
		return fail(
			`ref "${ref}" does not exist locally or on origin.`,
			"Check the branch name (it may not be pushed yet) or pass createBranch to start it from the default branch.",
		);
	if (
		a.createBranch &&
		(await tryGit(
			git,
			["rev-parse", "--verify", "--quiet", `refs/heads/${a.createBranch}`],
			path,
		)) !== null
	) {
		return fail(
			`branch "${a.createBranch}" already exists; pass it as ref instead of createBranch.`,
		);
	}
	const base = remoteExists ? `origin/${ref}` : localExists ? ref : ref;

	// ── worktree ──
	if (a.worktree) {
		const root = join(path, ".paca-worktrees");
		const dir = join(root, sanitizeSlug(a.createBranch || ref));
		if (await hasGit(dir)) {
			actions.push(`reused worktree ${dir}`);
			return fastForward(git, dir, ref, remoteExists, actions);
		}
		await mkdir(root, { recursive: true });
		const exclude = await tryGit(
			git,
			["rev-parse", "--git-path", "info/exclude"],
			path,
		);
		if (exclude)
			await appendFile(resolve(path, exclude), "\n/.paca-worktrees/\n").catch(
				() => undefined,
			);
		const current = await tryGit(
			git,
			["symbolic-ref", "--quiet", "--short", "HEAD"],
			path,
		);
		let wtArgs: string[];
		if (a.createBranch)
			wtArgs = ["worktree", "add", "-b", a.createBranch, dir, base];
		else if (shaLike) wtArgs = ["worktree", "add", "--detach", dir, ref];
		else if (localExists && current !== ref)
			wtArgs = ["worktree", "add", dir, ref];
		else if (remoteExists && !localExists)
			wtArgs = ["worktree", "add", "-b", ref, dir, `origin/${ref}`];
		else wtArgs = ["worktree", "add", "--detach", dir, base]; // same branch is checked out in the main tree
		try {
			await git(wtArgs, { cwd: path });
		} catch (e) {
			return fail(`git worktree add failed: ${gitMessage(e)}`);
		}
		actions.push(`created worktree ${dir}`);
		if (wtArgs.includes("--detach") && !shaLike)
			actions.push(
				`checked out detached at ${base} because ${ref} is already checked out in the main tree`,
			);
		return fastForward(
			git,
			dir,
			wtArgs.includes("--detach") ? null : (a.createBranch ?? ref),
			remoteExists && !a.createBranch,
			actions,
		);
	}

	// ── switch the main checkout ──
	const status = (await tryGit(git, ["status", "--porcelain"], path)) ?? "";
	if (status) {
		const files = status.split("\n").filter(Boolean);
		if (!a.stash) {
			return fail(
				`the working tree has ${files.length} uncommitted change(s): ${files
					.slice(0, 5)
					.map((l) => l.trim())
					.join(", ")}${files.length > 5 ? ", …" : ""}.`,
				"These may belong to another conversation. Retry with worktree: true (separate checkout) or stash: true (saves them with git stash).",
			);
		}
		try {
			await git(
				[
					"stash",
					"push",
					"--include-untracked",
					"-m",
					`paca: before switching to ${a.createBranch ?? ref}`,
				],
				{ cwd: path },
			);
			actions.push("stashed uncommitted changes (git stash list to restore)");
		} catch (e) {
			return fail(`git stash failed: ${gitMessage(e)}`);
		}
	}
	try {
		if (a.createBranch) {
			await git(["checkout", "-b", a.createBranch, base], { cwd: path });
			actions.push(`created branch ${a.createBranch} from ${base}`);
			return finish(git, path, actions);
		}
		if (shaLike) {
			await git(["checkout", "--detach", ref], { cwd: path });
			actions.push(`checked out ${ref} (detached)`);
			return finish(git, path, actions);
		}
		if (localExists) {
			await git(["checkout", ref], { cwd: path });
			actions.push(`checked out ${ref}`);
		} else {
			await git(["checkout", "-b", ref, "--track", `origin/${ref}`], {
				cwd: path,
			});
			actions.push(`checked out ${ref} tracking origin/${ref}`);
			return finish(git, path, actions);
		}
	} catch (e) {
		return fail(`git checkout failed: ${gitMessage(e)}`);
	}
	return fastForward(git, path, ref, remoteExists, actions);
}

/** Fast-forwards `branch` to origin/<branch>; reports divergence instead of resetting. */
async function fastForward(
	git: GitExec,
	dir: string,
	branch: string | null,
	remoteExists: boolean,
	actions: string[],
): Promise<PrepareResult> {
	if (branch && remoteExists) {
		try {
			const out = await git(["merge", "--ff-only", `origin/${branch}`], {
				cwd: dir,
			});
			actions.push(
				/Already up to date/i.test(out.stdout)
					? `${branch} is up to date with origin`
					: `fast-forwarded ${branch} to origin/${branch}`,
			);
		} catch {
			const counts = await tryGit(
				git,
				["rev-list", "--left-right", "--count", `origin/${branch}...${branch}`],
				dir,
			);
			const [behind, ahead] = (counts ?? "0 0").split(/\s+/).map(Number);
			if (behind > 0 && ahead > 0) {
				const r = await finish(git, dir, actions);
				return {
					...r,
					ok: true,
					problem: `${branch} has diverged from origin/${branch} (${ahead} local commit(s), ${behind} remote commit(s)); nothing was reset.`,
					hint: "Rebase or merge deliberately, branch off, or ask. Do not force-push.",
				};
			}
			// Only ahead (local commits not pushed yet): fine.
			actions.push(`${branch} is ${ahead} commit(s) ahead of origin`);
		}
	}
	return finish(git, dir, actions);
}

async function finish(
	git: GitExec,
	dir: string,
	actions: string[],
): Promise<PrepareResult> {
	const branch = await tryGit(
		git,
		["symbolic-ref", "--quiet", "--short", "HEAD"],
		dir,
	);
	const head = await tryGit(git, ["rev-parse", "HEAD"], dir);
	let ahead: number | null = null;
	let behind: number | null = null;
	const counts = await tryGit(
		git,
		["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
		dir,
	);
	if (counts) {
		const [b, a] = counts.split(/\s+/).map(Number);
		behind = b;
		ahead = a;
	}
	return { ok: true, path: dir, branch, head, ahead, behind, actions };
}

// ── commit ───────────────────────────────────────────────────────────────────

/** Repository paths agents must not modify: CI/CD configuration can exfiltrate secrets. */
export const CI_CONFIG_GLOBS = [
	".github/workflows/**",
	".gitlab-ci.yml",
	".gitlab/ci/**",
	"bitbucket-pipelines.yml",
	".circleci/**",
	"azure-pipelines.yml",
	".azure-pipelines/**",
	".buildkite/**",
	"Jenkinsfile",
	".drone.yml",
	".travis.yml",
];

function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			re += ".*";
			i++;
			if (glob[i + 1] === "/") i++;
		} else if (c === "*") re += "[^/]*";
		else re += c.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
	}
	return new RegExp(`^${re}$`);
}

export function matchesCIConfig(
	path: string,
	globs: string[] = CI_CONFIG_GLOBS,
): boolean {
	return globs.some((g) => globToRegExp(g).test(path));
}

export interface CommitArgs {
	repoDir: string;
	message: string;
	paths?: string[];
	all?: boolean;
	conversationId?: string;
	allowCIConfig?: boolean;
}

export interface CommitResult {
	ok: boolean;
	sha?: string;
	branch?: string | null;
	files?: string[];
	problem?: string;
	hint?: string;
}

export async function commitWorkspace(
	git: GitExec,
	a: CommitArgs,
): Promise<CommitResult> {
	const cwd = resolve(a.repoDir);
	const fail = (problem: string, hint?: string): CommitResult => ({
		ok: false,
		problem,
		hint,
	});
	if (!a.message.trim()) return fail("a commit message is required.");
	if (
		(await tryGit(git, ["rev-parse", "--is-inside-work-tree"], cwd)) !== "true"
	)
		return fail(`${cwd} is not a git checkout.`);
	const branch = await tryGit(
		git,
		["symbolic-ref", "--quiet", "--short", "HEAD"],
		cwd,
	);
	if (!branch)
		return fail(
			"HEAD is detached; create or switch to a branch before committing.",
			"workspace_prepare with createBranch, or git checkout -b <name>.",
		);

	try {
		if (a.paths && a.paths.length > 0) {
			for (const p of a.paths)
				if (p.startsWith("-")) return fail(`path "${p}" looks like an option.`);
			await git(["add", "--", ...a.paths], { cwd });
		} else if (a.all) {
			await git(["add", "-A"], { cwd });
		}
	} catch (e) {
		return fail(`git add failed: ${gitMessage(e)}`);
	}

	const staged = (
		(await tryGit(git, ["diff", "--cached", "--name-only"], cwd)) ?? ""
	)
		.split("\n")
		.filter(Boolean);
	if (staged.length === 0)
		return fail(
			"nothing is staged.",
			"Pass paths, or all: true to stage every change.",
		);
	if (!a.allowCIConfig) {
		const ci = staged.filter((f) => matchesCIConfig(f));
		if (ci.length > 0) {
			await git(["reset", "-q", "--", ...ci], { cwd }).catch(() => undefined);
			return fail(
				`refusing to commit CI/CD configuration: ${ci.join(", ")}. It was unstaged.`,
				"Changes to pipeline configuration need a human; describe the needed change in the pull request instead.",
			);
		}
	}

	const identity: string[] = [];
	const name = await tryGit(git, ["config", "user.name"], cwd);
	const email = await tryGit(git, ["config", "user.email"], cwd);
	if (!name && !process.env.GIT_AUTHOR_NAME)
		identity.push("-c", "user.name=Paca Agent");
	if (!email && !process.env.GIT_AUTHOR_EMAIL)
		identity.push("-c", "user.email=agent@paca.invalid");
	const msgArgs = [
		"-m",
		a.message.trim(),
		...(a.conversationId ? ["-m", `Paca-Run: ${a.conversationId}`] : []),
	];
	try {
		await git([...identity, "commit", ...msgArgs], { cwd });
	} catch (e) {
		return fail(`git commit failed: ${gitMessage(e)}`);
	}
	const sha = await tryGit(git, ["rev-parse", "HEAD"], cwd);
	return { ok: true, sha: sha ?? undefined, branch, files: staged };
}

// ── push ─────────────────────────────────────────────────────────────────────

export interface PushArgs {
	repo: LinkedRepo;
	repoDir: string;
	branch?: string;
	getCredential: GitAuth["getCredential"];
}

export interface PushResult {
	ok: boolean;
	branch?: string;
	problem?: string;
	hint?: string;
}

const PROTECTED_BY_NAME = new Set(["main", "master"]);

/**
 * Pushes the current (or named) branch. Never force-pushes, and never pushes
 * the repository's default branch — work lands through a change request.
 */
export async function pushWorkspace(
	git: GitExec,
	a: PushArgs,
): Promise<PushResult> {
	const cwd = resolve(a.repoDir);
	const fail = (problem: string, hint?: string): PushResult => ({
		ok: false,
		problem,
		hint,
	});
	let branch = (a.branch ?? "").trim();
	if (!branch)
		branch =
			(await tryGit(
				git,
				["symbolic-ref", "--quiet", "--short", "HEAD"],
				cwd,
			)) ?? "";
	if (!branch)
		return fail(
			"could not determine the current branch (HEAD may be detached).",
			"Specify branchName, or create a branch first.",
		);
	if (!BRANCH_NAME.test(branch))
		return fail(`"${branch}" is not a valid branch name.`);
	const defaultBranch = a.repo.defaultBranch;
	if (
		branch === defaultBranch ||
		(!defaultBranch && PROTECTED_BY_NAME.has(branch))
	) {
		return fail(
			`refusing to push directly to the default branch "${branch}".`,
			"Push a feature branch (workspace_prepare with createBranch) and open a pull/merge request.",
		);
	}
	const plainUrl = stripCredentials(a.repo.cloneUrl);
	const auth = splitRemote(plainUrl)
		? {
				remoteURL: plainUrl,
				access: "write" as const,
				getCredential: a.getCredential,
			}
		: undefined;
	try {
		await git(["push", plainUrl, `HEAD:refs/heads/${branch}`], { cwd, auth });
	} catch (e) {
		return fail(`git push failed: ${gitMessage(e)}`);
	}
	return { ok: true, branch };
}
