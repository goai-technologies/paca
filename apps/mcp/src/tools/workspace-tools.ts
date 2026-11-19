import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { PacaAPIClient } from "../api/index.js";
import { defaultGitExec, type GitExec } from "../git/git-runner.js";
import {
	commitWorkspace,
	inspectWorkspace,
	type LinkedRepo,
	prepareWorkspace,
	pushWorkspace,
} from "../git/workspace.js";
import { DEFAULT_REPO_DIR, loadRepo } from "./repo-tools.js";

/**
 * Workspace tools: the agent — not Paca — decides whether a repository needs
 * cloning. It inspects the working directory, then prepares the checkout it
 * needs (reusing one that is already there, fetching and fast-forwarding the
 * right branch first). Network commands authenticate through a per-command
 * credential helper, so no token is ever written to .git/config, the
 * environment or a command line.
 */

export const WORKSPACE_TOOL_NAMES = [
	"workspace_inspect",
	"workspace_prepare",
	"git_commit",
	"git_push",
] as const;

const InspectSchema = z.object({
	projectId: z.string(),
	path: z.string().optional(),
});

const PrepareSchema = z.object({
	projectId: z.string(),
	repoId: z.string(),
	path: z.string().optional(),
	ref: z.string().optional(),
	strategy: z.enum(["reuse", "clone"]).optional(),
	createBranch: z.string().optional(),
	worktree: z.boolean().optional(),
	stash: z.boolean().optional(),
	blobless: z.boolean().optional(),
});

const CommitSchema = z.object({
	message: z.string(),
	repoDir: z.string().optional(),
	paths: z.array(z.string()).optional(),
	all: z.boolean().optional(),
});

const PushSchema = z.object({
	projectId: z.string(),
	repoId: z.string(),
	repoDir: z.string().optional(),
	branchName: z.string().optional(),
});

export function getWorkspaceTools(): Tool[] {
	return [
		{
			name: "workspace_inspect",
			description:
				"Read-only survey of your working directory. Call this BEFORE cloning " +
				"anything: it lists what is in the directory and every git checkout " +
				"found (path, token-free origin, current branch, ahead/behind, " +
				"uncommitted changes, last fetch) and says which of the project's " +
				"linked repositories each checkout is. Your working directory can " +
				"persist across conversations, so the repository may already be " +
				"here — possibly on another branch, with uncommitted work from an " +
				"earlier conversation. Never mutates anything and never uses the " +
				"network.",
			inputSchema: {
				type: "object",
				properties: {
					projectId: {
						type: "string",
						description: "The technical UUID of the project.",
					},
					path: {
						type: "string",
						description: `Directory to survey (absolute). Defaults to ${DEFAULT_REPO_DIR}.`,
					},
				},
				required: ["projectId"],
			},
		},
		{
			name: "workspace_prepare",
			description:
				'Get a working tree ready to edit. strategy "reuse" (default) takes ' +
				"an existing checkout of the repository: fetches origin, switches to " +
				"`ref` (default: the repository's default branch) and fast-forwards it " +
				'so you start from the latest code. strategy "clone" clones into an ' +
				"EMPTY directory. It never deletes anything, never resets a diverged " +
				"branch (it reports the divergence instead), and refuses to switch a " +
				"dirty tree unless you pass stash: true or worktree: true " +
				"(worktree gives this ref its own checkout under " +
				"`.paca-worktrees/`, so two pull requests never fight over one " +
				"directory). Use createBranch to start a new branch from `ref`. Use " +
				"ref = the pull request's head branch to review or fix an existing " +
				"pull request. You need the repoId from list_repositories " +
				"(or the matching checkout from workspace_inspect).",
			inputSchema: {
				type: "object",
				properties: {
					projectId: {
						type: "string",
						description: "The technical UUID of the project.",
					},
					repoId: {
						type: "string",
						description: "The repository ID from list_repositories.",
					},
					path: {
						type: "string",
						description: `Checkout directory (absolute). Defaults to ${DEFAULT_REPO_DIR}.`,
					},
					ref: {
						type: "string",
						description:
							"Branch name (or commit SHA) to have checked out. Defaults to the repository's default branch.",
					},
					strategy: {
						type: "string",
						enum: ["reuse", "clone"],
						description:
							"reuse (default): existing checkout. clone: empty directory.",
					},
					createBranch: {
						type: "string",
						description:
							"Create and switch to this new branch, starting from ref.",
					},
					worktree: {
						type: "boolean",
						description:
							"Give the ref its own worktree instead of switching the main checkout.",
					},
					stash: {
						type: "boolean",
						description:
							"If the tree is dirty, stash the changes (git stash) before switching.",
					},
					blobless: {
						type: "boolean",
						description:
							"Clone with --filter=blob:none (faster for large repositories; review-only work).",
					},
				},
				required: ["projectId", "repoId"],
			},
		},
		{
			name: "git_commit",
			description:
				"Commit changes in a checkout. Pass `paths` to stage specific files, " +
				"or `all: true` to stage every change; with neither, commits what is " +
				"already staged. Refuses an empty commit, a detached HEAD, and any " +
				"change to CI/CD configuration (.github/workflows/**, .gitlab-ci.yml, " +
				"…): those files are unstaged and the commit is rejected — describe " +
				"the needed pipeline change in the pull request for a human instead.",
			inputSchema: {
				type: "object",
				properties: {
					message: { type: "string", description: "The commit message." },
					repoDir: {
						type: "string",
						description: `Checkout directory (absolute). Defaults to ${DEFAULT_REPO_DIR}.`,
					},
					paths: {
						type: "array",
						items: { type: "string" },
						description: "Files/directories to stage.",
					},
					all: {
						type: "boolean",
						description: "Stage every change (git add -A).",
					},
				},
				required: ["message"],
			},
		},
		{
			name: "git_push",
			description:
				"Push the current branch (or branchName) to the repository's remote. " +
				"Never force-pushes and refuses the repository's default branch — " +
				"push a feature branch and open a pull/merge request. Credentials " +
				"are handled for you; you never see or need a token.",
			inputSchema: {
				type: "object",
				properties: {
					projectId: {
						type: "string",
						description: "The technical UUID of the project.",
					},
					repoId: {
						type: "string",
						description: "The repository ID from list_repositories.",
					},
					repoDir: {
						type: "string",
						description: `Checkout directory (absolute). Defaults to ${DEFAULT_REPO_DIR}.`,
					},
					branchName: {
						type: "string",
						description:
							"Branch to push. Defaults to the currently checked-out branch.",
					},
				},
				required: ["projectId", "repoId"],
			},
		},
	];
}

function json(value: unknown, scrub: (t: string) => string = (t) => t) {
	return {
		content: [{ type: "text", text: scrub(JSON.stringify(value, null, 2)) }],
	};
}

async function linkedRepos(
	client: PacaAPIClient,
	projectId: string,
): Promise<LinkedRepo[]> {
	try {
		return (await client.listGitRepositories(projectId)).map((r) => ({
			providerId: r.provider_id,
			repoId: r.id,
			fullName: r.full_path,
			cloneUrl: r.clone_url,
			defaultBranch: r.default_branch || undefined,
		}));
	} catch {
		// An unreachable API must not fail a read-only survey.
		return [];
	}
}

export async function handleWorkspaceTool(
	toolName: string,
	args: any,
	client: PacaAPIClient,
	gitExec: GitExec = defaultGitExec,
	conversationId: string | undefined = process.env.PACA_CONVERSATION_ID ||
		undefined,
): Promise<any> {
	switch (toolName) {
		case "workspace_inspect": {
			InspectSchema.parse(args);
			const repos = await linkedRepos(client, args.projectId);
			return json(
				await inspectWorkspace({
					git: gitExec,
					workdir: args.path || DEFAULT_REPO_DIR,
					repos,
				}),
			);
		}

		case "workspace_prepare": {
			PrepareSchema.parse(args);
			const loaded = await loadRepo(client, args.projectId, args.repoId);
			if (!loaded) {
				return json({
					ok: false,
					problem: `Repository ${args.repoId} is not linked to this project.`,
				});
			}
			return json(
				await prepareWorkspace(gitExec, {
					repo: loaded.repo,
					path: args.path || DEFAULT_REPO_DIR,
					ref: args.ref,
					strategy: args.strategy ?? "reuse",
					createBranch: args.createBranch,
					worktree: args.worktree,
					stash: args.stash,
					blobless: args.blobless,
					getCredential: loaded.getCredential,
				}),
				loaded.scrub,
			);
		}

		case "git_commit": {
			CommitSchema.parse(args);
			return json(
				await commitWorkspace(gitExec, {
					repoDir: args.repoDir || DEFAULT_REPO_DIR,
					message: args.message,
					paths: args.paths,
					all: args.all,
					conversationId,
					// Deliberately not a tool argument: an agent must not be able to
					// unlock CI-config edits itself. Only the operator's environment can.
					allowCIConfig: process.env.PACA_ALLOW_CI_CONFIG === "1",
				}),
			);
		}

		case "git_push": {
			PushSchema.parse(args);
			const loaded = await loadRepo(client, args.projectId, args.repoId);
			if (!loaded) {
				return json({
					ok: false,
					problem: `Repository ${args.repoId} is not linked to this project.`,
				});
			}
			const res = await pushWorkspace(gitExec, {
				repo: loaded.repo,
				repoDir: args.repoDir || DEFAULT_REPO_DIR,
				branch: args.branchName,
				getCredential: loaded.getCredential,
			});
			return json(
				res.ok
					? {
							...res,
							next: "Open a pull/merge request for this branch; the work is not finished until one exists.",
						}
					: res,
				loaded.scrub,
			);
		}

		default:
			throw new Error(`Unknown workspace tool: ${toolName}`);
	}
}
