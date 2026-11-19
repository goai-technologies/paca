import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	get: vi.fn(),
	post: vi.fn(),
	del: vi.fn(),
	project: new Set<string>(),
}));

vi.mock("@/lib/api-client", () => ({
	apiClient: { instance: { get: h.get, post: h.post, delete: h.del } },
}));
vi.mock("@/hooks/use-permissions", () => ({
	usePermissions: () => ({ hasPermission: () => false }),
}));
vi.mock("@/hooks/use-project-permissions", () => ({
	useProjectPermissions: () => ({
		hasProjectPermission: (a: string) => h.project.has(a),
	}),
}));

import {
	parseBranchUrl,
	parseChangeRequestUrl,
	suggestBranchName,
} from "./task-git-forms";
import { TaskGitSection } from "./task-git-section";

const repo = (id: string, path: string) => ({
	id,
	provider_id: "com.paca.github",
	host: "github.com",
	full_path: path,
	default_branch: "main",
	clone_url: `https://github.com/${path}.git`,
	identity_id: "i1",
	created_at: "2026-01-01T00:00:00Z",
});
const web = repo("r1", "acme/web");
const api = repo("r2", "acme/api");

const cr = (over: Record<string, unknown> = {}) => ({
	repository_id: "r1",
	repository: "acme/web",
	provider_id: "com.paca.github",
	number: "4",
	title: "Add login",
	state: "open",
	draft: false,
	head_ref: "feat/PACA-12-login",
	base_ref: "main",
	author: "alice",
	url: "https://github.com/acme/web/pull/4",
	merged_at: null,
	updated_at: "2026-01-01T00:00:00Z",
	ci: null,
	...over,
});
const branch = (name: string) => ({
	repository_id: "r1",
	repository: "acme/web",
	provider_id: "com.paca.github",
	branch: name,
});

let repos: unknown[] = [web];
let links: { change_requests: unknown[]; branches: unknown[] } = {
	change_requests: [],
	branches: [],
};
let providerBranches = true;

function renderSection(canEdit = true) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<TaskGitSection
				projectId="p1"
				taskId="t1"
				taskIdPrefix="paca"
				taskNumber={12}
				taskTitle="Fix the login bug!"
				canEdit={canEdit}
			/>
		</QueryClientProvider>,
	);
}

describe("parsing what the user pastes", () => {
	it("reads pull/merge request and branch links", () => {
		expect(
			parseChangeRequestUrl("https://github.com/acme/web/pull/42"),
		).toEqual({
			host: "github.com",
			fullPath: "acme/web",
			number: "42",
		});
		expect(
			parseChangeRequestUrl(
				"https://gitlab.example/g/sub/p/-/merge_requests/7",
			),
		).toEqual({ host: "gitlab.example", fullPath: "g/sub/p", number: "7" });
		expect(parseChangeRequestUrl("42")).toBeNull();
		expect(
			parseChangeRequestUrl("https://github.com/acme/web/issues/42"),
		).toBeNull();
		expect(
			parseBranchUrl("https://github.com/acme/web/tree/feat/x%2By"),
		).toEqual({
			host: "github.com",
			fullPath: "acme/web",
			branch: "feat/x+y",
		});
		expect(parseBranchUrl("feature/foo")).toBeNull();
	});

	it("suggests a branch name from the task key and title", () => {
		expect(suggestBranchName("feat", "PACA-12", "Fix the login bug!")).toBe(
			"feat/PACA-12-fix-the-login-bug",
		);
		expect(suggestBranchName("fix", "PACA-12", undefined)).toBe("fix/PACA-12");
		expect(suggestBranchName("docs", "PACA-12", "!!!")).toBe("docs/PACA-12");
	});
});

describe("TaskGitSection", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		h.project = new Set(["git:write"]);
		repos = [web];
		links = { change_requests: [], branches: [] };
		providerBranches = true;
		h.get.mockImplementation(async (url: string) => {
			if (url.endsWith("/git/repositories")) return { data: { data: repos } };
			if (url.endsWith("/git/providers"))
				return {
					data: {
						data: [
							{
								id: "com.paca.github",
								display_name: "GitHub",
								hosts: ["github.com"],
								terms: {},
								capabilities: { branches: providerBranches },
							},
						],
					},
				};
			if (url.endsWith("/tasks/t1/git")) return { data: { data: links } };
			throw new Error(`unexpected GET ${url}`);
		});
		h.post.mockResolvedValue({ data: { data: {} } });
		h.del.mockResolvedValue({ data: {} });
	});

	it("shows nothing until the project has a linked repository", async () => {
		repos = [];
		const { container } = renderSection();
		await waitFor(() => expect(h.get).toHaveBeenCalled());
		await waitFor(() => expect(container).toBeEmptyDOMElement());
	});

	it("shows both sections with their empty states and actions", async () => {
		renderSection();
		expect(await screen.findByText("Branches")).toBeInTheDocument();
		expect(screen.getByText("Pull requests")).toBeInTheDocument();
		expect(screen.getByText("No branches linked yet.")).toBeInTheDocument();
		expect(
			screen.getByText("No pull requests linked yet."),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^link branch$/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^new branch$/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^link pull request$/i }),
		).toBeInTheDocument();
	});

	it("hides the actions without edit access", async () => {
		renderSection(false);
		await screen.findByText("Branches");
		expect(screen.queryByRole("button", { name: /new branch/i })).toBeNull();
		expect(
			screen.queryByRole("button", { name: /link pull request/i }),
		).toBeNull();
	});

	it("lists a pull request with state, repo, branches, author and a link", async () => {
		links = { change_requests: [cr()], branches: [] };
		renderSection();
		const title = await screen.findByRole("link", { name: "Add login" });
		expect(title).toHaveAttribute("href", "https://github.com/acme/web/pull/4");
		expect(title).toHaveAttribute("rel", "noopener noreferrer");
		expect(screen.getByText("#4")).toBeInTheDocument();
		expect(screen.getByText("by alice")).toBeInTheDocument();
		expect(screen.getByText("Open")).toBeInTheDocument();
		expect(screen.getByText(/feat\/PACA-12-login/)).toBeInTheDocument();
	});

	it("labels draft, merged and closed requests, and tolerates an unknown page", async () => {
		links = {
			change_requests: [
				cr({ number: "1", title: "A", draft: true }),
				cr({ number: "2", title: "B", state: "merged" }),
				cr({ number: "3", title: "C", state: "closed", url: "" }),
			],
			branches: [],
		};
		renderSection();
		expect(await screen.findByText("Draft")).toBeInTheDocument();
		expect(screen.getByText("Merged")).toBeInTheDocument();
		expect(screen.getByText("Closed")).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "C" })).toBeNull();
		expect(screen.getByText("C")).toBeInTheDocument();
	});

	it.each([
		[
			"passing",
			{
				state: "passing",
				total: 3,
				passed: 3,
				failed: 0,
				pending: 0,
				failing: [],
			},
			"CI passing",
			"3 of 3 checks passed",
		],
		[
			"failing",
			{
				state: "failing",
				total: 3,
				passed: 1,
				failed: 2,
				pending: 0,
				failing: ["ci/test", "lint"],
			},
			"CI failing",
			"Failing: ci/test, lint",
		],
		[
			"pending",
			{
				state: "pending",
				total: 3,
				passed: 1,
				failed: 0,
				pending: 2,
				failing: [],
			},
			"CI running",
			"1 of 3 checks passed",
		],
	])("shows the %s CI status of a pull request", async (_n, ci, text, tooltip) => {
		links = { change_requests: [cr({ ci })], branches: [] };
		renderSection();
		const badge = await screen.findByTestId("ci-badge");
		expect(badge).toHaveTextContent(text);
		expect(badge).toHaveAttribute("title", tooltip);
	});

	it("shows no CI badge for a request without checks", async () => {
		links = { change_requests: [cr()], branches: [] };
		renderSection();
		await screen.findByText("Add login");
		expect(screen.queryByTestId("ci-badge")).toBeNull();
	});

	it("lists branches and unlinks one", async () => {
		links = { change_requests: [], branches: [branch("feat/PACA-12-login")] };
		const user = userEvent.setup();
		renderSection();
		expect(await screen.findByText("feat/PACA-12-login")).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", {
				name: /unlink branch feat\/PACA-12-login/i,
			}),
		);
		await waitFor(() =>
			expect(h.del).toHaveBeenCalledWith("/projects/p1/tasks/t1/git/branches", {
				params: { repository_id: "r1", branch: "feat/PACA-12-login" },
			}),
		);
	});

	it("unlinks a pull request", async () => {
		links = { change_requests: [cr()], branches: [] };
		const user = userEvent.setup();
		renderSection();
		await user.click(
			await screen.findByRole("button", {
				name: /unlink pull request acme\/web #4/i,
			}),
		);
		await waitFor(() =>
			expect(h.del).toHaveBeenCalledWith(
				"/projects/p1/tasks/t1/git/change-requests/4",
				{
					params: { repository_id: "r1" },
				},
			),
		);
	});

	it("links a pull request by pasted link, matching the linked repository", async () => {
		repos = [web, api];
		const user = userEvent.setup();
		renderSection();
		await user.click(
			await screen.findByRole("button", { name: /^link pull request$/i }),
		);
		await user.type(
			screen.getByLabelText("Pull request"),
			"https://github.com/acme/api/pull/42",
		);
		expect(screen.getByText("Will link #42 from acme/api")).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: /^link pull request$/i }),
		);
		await waitFor(() =>
			expect(h.post).toHaveBeenCalledWith(
				"/projects/p1/tasks/t1/git/change-requests",
				{
					repository_id: "r2",
					number: "42",
				},
			),
		);
	});

	it("links a pull request by number when there is one repository", async () => {
		const user = userEvent.setup();
		renderSection();
		await user.click(
			await screen.findByRole("button", { name: /^link pull request$/i }),
		);
		await user.type(screen.getByLabelText("Pull request"), "#7");
		await user.click(
			screen.getByRole("button", { name: /^link pull request$/i }),
		);
		await waitFor(() =>
			expect(h.post).toHaveBeenCalledWith(
				"/projects/p1/tasks/t1/git/change-requests",
				{
					repository_id: "r1",
					number: "7",
				},
			),
		);
	});

	it("explains a pull request link that points at another repository", async () => {
		const user = userEvent.setup();
		renderSection();
		await user.click(
			await screen.findByRole("button", { name: /^link pull request$/i }),
		);
		await user.type(
			screen.getByLabelText("Pull request"),
			"https://github.com/other/thing/pull/1",
		);
		await user.click(
			screen.getByRole("button", { name: /^link pull request$/i }),
		);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			'"other/thing" isn\'t linked to this project.',
		);
		expect(h.post).not.toHaveBeenCalled();
	});

	it("explains a pull request the platform does not know", async () => {
		h.post.mockRejectedValue({
			response: { status: 404, data: { error_code: "GIT_NOT_FOUND" } },
		});
		const user = userEvent.setup();
		renderSection();
		await user.click(
			await screen.findByRole("button", { name: /^link pull request$/i }),
		);
		await user.type(screen.getByLabelText("Pull request"), "999");
		await user.click(
			screen.getByRole("button", { name: /^link pull request$/i }),
		);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"It wasn't found in that repository.",
		);
	});

	it("links an existing branch", async () => {
		const user = userEvent.setup();
		renderSection();
		await user.click(
			await screen.findByRole("button", { name: /^link branch$/i }),
		);
		await user.type(screen.getByLabelText("Existing branch"), "feature/foo");
		await user.click(screen.getByRole("button", { name: /^link branch$/i }));
		await waitFor(() =>
			expect(h.post).toHaveBeenCalledWith(
				"/projects/p1/tasks/t1/git/branches",
				{
					repository_id: "r1",
					branch: "feature/foo",
				},
			),
		);
	});

	it("creates a branch on the platform from a suggested name", async () => {
		const user = userEvent.setup();
		renderSection();
		await user.click(
			await screen.findByRole("button", { name: /^new branch$/i }),
		);
		const name = screen.getByLabelText("Branch name");
		expect(name).toHaveValue("feat/PACA-12-fix-the-login-bug");
		await user.click(screen.getByRole("button", { name: "fix" }));
		expect(name).toHaveValue("fix/PACA-12-fix-the-login-bug");
		await user.type(screen.getByLabelText("Branch from"), "develop");
		await user.click(screen.getByRole("button", { name: /^create branch$/i }));
		await waitFor(() =>
			expect(h.post).toHaveBeenCalledWith(
				"/projects/p1/tasks/t1/git/branches/new",
				{
					repository_id: "r1",
					branch: "fix/PACA-12-fix-the-login-bug",
					from: "develop",
				},
			),
		);
	});

	it("offers only the local command when the platform cannot create branches, or the user cannot write", async () => {
		providerBranches = false;
		const user = userEvent.setup();
		const { unmount } = renderSection();
		await user.click(
			await screen.findByRole("button", { name: /^new branch$/i }),
		);
		expect(
			screen.queryByRole("button", { name: /^create branch$/i }),
		).toBeNull();
		expect(
			screen.getByText(/git checkout -b feat\/PACA-12/),
		).toBeInTheDocument();
		unmount();

		providerBranches = true;
		h.project = new Set();
		renderSection();
		await user.click(
			await screen.findByRole("button", { name: /^new branch$/i }),
		);
		expect(
			screen.queryByRole("button", { name: /^create branch$/i }),
		).toBeNull();
	});

	it("says a branch could not be created", async () => {
		h.post.mockRejectedValue({
			response: { status: 400, data: { error_code: "BAD_REQUEST" } },
		});
		const user = userEvent.setup();
		renderSection();
		await user.click(
			await screen.findByRole("button", { name: /^new branch$/i }),
		);
		await user.click(screen.getByRole("button", { name: /^create branch$/i }));
		const alert = await screen.findByRole("alert");
		expect(
			within(alert).getByText(/couldn't create that branch/i),
		).toBeInTheDocument();
	});
});
