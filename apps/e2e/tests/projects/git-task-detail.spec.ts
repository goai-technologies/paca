// spec: features/projects/git-task-detail.feature
// seed: tests/seed.spec.ts
//
// The Git endpoints (repositories, a task's links) are answered in the browser;
// the project, task and the signed-in user's permissions are real.

import { expect, type Page, test } from "@playwright/test";
import {
	authRequest,
	BASE_URL,
	cleanupProjectsByPrefix,
	cleanupUsersByPrefix,
	createProject,
	newRunId,
	RESTRICTED_PASSWORD,
	signIn,
} from "../helpers/e2e-api";
import { memberWith } from "../helpers/git";
import { createTask } from "../helpers/iam";

const PREFIX = "E2E_GITTD_";
const RUN_ID = newRunId();

const REPO = {
	id: "00000000-0000-4000-8000-0000000000a1",
	provider_id: "com.example.git",
	host: "git.example.test",
	full_path: "acme/web",
	default_branch: "main",
	clone_url: "https://git.example.test/acme/web.git",
	identity_id: null,
	identity_handle: "paca-bot",
	created_at: "2026-10-01T00:00:00Z",
};

const pr = (over: Record<string, unknown> = {}) => ({
	repository_id: REPO.id,
	repository: REPO.full_path,
	provider_id: REPO.provider_id,
	number: "4",
	title: "Add login",
	state: "open",
	draft: false,
	head_ref: "feat/login",
	base_ref: "main",
	author: "alice",
	url: "https://git.example.test/acme/web/pull/4",
	merged_at: null,
	updated_at: "2026-10-01T00:00:00Z",
	ci: null,
	...over,
});

const branch = (name: string) => ({
	repository_id: REPO.id,
	repository: REPO.full_path,
	provider_id: REPO.provider_id,
	branch: name,
});

const ok = (data: unknown) => ({
	status: 200,
	contentType: "application/json",
	body: JSON.stringify({ success: true, data }),
});

interface Stub {
	repositories: unknown[];
	links: { change_requests: unknown[]; branches: unknown[] };
	requests: Array<{ method: string; path: string; body?: unknown }>;
	linkError?: { status: number; code: string };
}

async function stubGit(
	page: Page,
	projectId: string,
	taskId: string,
	stub: Stub,
) {
	await page.route(`**/api/v1/projects/${projectId}/git/providers`, (route) =>
		route.fulfill(
			ok([
				{
					id: REPO.provider_id,
					display_name: "Example Git",
					hosts: [REPO.host],
					self_hosted_hosts: false,
					terms: {
						change_request: "pull request",
						change_request_plural: "pull requests",
						repository: "Repository",
					},
					capabilities: {
						multiple_identities: false,
						access_grants: false,
						branches: true,
					},
				},
			]),
		),
	);
	await page.route(
		`**/api/v1/projects/${projectId}/git/repositories`,
		(route) => route.fulfill(ok(stub.repositories)),
	);
	await page.route(
		`**/api/v1/projects/${projectId}/tasks/${taskId}/git**`,
		(route) => {
			const request = route.request();
			const path = new URL(request.url()).pathname.split(
				`/tasks/${taskId}/git`,
			)[1];
			if (request.method() === "GET") return route.fulfill(ok(stub.links));
			stub.requests.push({
				method: request.method(),
				path: path + new URL(request.url()).search,
				body: request.postDataJSON() ?? undefined,
			});
			if (stub.linkError && request.method() === "POST") {
				return route.fulfill({
					status: stub.linkError.status,
					contentType: "application/json",
					body: JSON.stringify({
						success: false,
						error_code: stub.linkError.code,
						error: stub.linkError.code,
					}),
				});
			}
			stub.links = { change_requests: [], branches: [] };
			return route.fulfill({ status: 204 });
		},
	);
}

const newStub = (over: Partial<Stub> = {}): Stub => ({
	repositories: [REPO],
	links: { change_requests: [], branches: [] },
	requests: [],
	...over,
});

test.describe("Git on the task page", () => {
	let projectId: string;
	let taskId: string;

	test.beforeAll(async ({ request }) => {
		await authRequest(request);
		await cleanupProjectsByPrefix(request, PREFIX);
		await cleanupUsersByPrefix(request, PREFIX);
	});

	test.beforeEach(async ({ request }) => {
		await authRequest(request);
		projectId = await createProject(request, `${PREFIX}PROJECT_${RUN_ID}`);
		taskId = await createTask(request, projectId, "Login work");
	});

	test.afterAll(async ({ request }) => {
		await authRequest(request);
		await cleanupProjectsByPrefix(request, PREFIX);
		await cleanupUsersByPrefix(request, PREFIX);
	});

	const openTask = async (page: Page) => {
		await page.goto(`${BASE_URL}/projects/${projectId}/tasks/${taskId}`);
		await expect(page.getByRole("heading", { name: "Login work" })).toBeVisible(
			{
				timeout: 15_000,
			},
		);
	};

	test("Nothing is shown until a repository is linked", async ({ page }) => {
		await signIn(page);
		await stubGit(page, projectId, taskId, newStub({ repositories: [] }));
		// The sections depend on the repositories request: wait for it to
		// complete, then for the task's own Properties panel, before asserting
		// that nothing Git-related was rendered.
		const repositories = page.waitForResponse(
			(r) =>
				r.url().endsWith(`/projects/${projectId}/git/repositories`) &&
				r.request().method() === "GET",
		);
		await openTask(page);
		await repositories;
		await expect(page.getByText("Properties", { exact: true })).toBeVisible();

		await expect(page.getByText("Pull requests", { exact: true })).toHaveCount(
			0,
		);
		await expect(page.getByText("Branches", { exact: true })).toHaveCount(0);
	});

	test("Both sections show their empty states and actions", async ({
		page,
	}) => {
		await signIn(page);
		await stubGit(page, projectId, taskId, newStub());
		await openTask(page);

		await expect(page.getByText("No pull requests linked yet.")).toBeVisible();
		await expect(page.getByText("No branches linked yet.")).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Link pull request" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Link branch" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "New branch" }),
		).toBeVisible();
	});

	const cases: Array<[string, Record<string, unknown>, string]> = [
		[
			"Add login",
			{ ci: { state: "passing", passed: 3, total: 3, failing: [] } },
			"CI passing",
		],
		[
			"Fix flake",
			{ ci: { state: "failing", passed: 1, total: 3, failing: ["unit"] } },
			"CI failing",
		],
		[
			"Refactor db",
			{ ci: { state: "pending", passed: 1, total: 3, failing: [] } },
			"CI running",
		],
		[
			"Ship it",
			{ state: "merged", merged_at: "2026-10-02T00:00:00Z" },
			"Merged",
		],
		["Dropped", { state: "closed" }, "Closed"],
		["Early draft", { draft: true }, "Draft"],
	];
	for (const [title, over, badge] of cases) {
		test(`A pull request "${title}" shows ${badge}`, async ({ page }) => {
			await signIn(page);
			await stubGit(
				page,
				projectId,
				taskId,
				newStub({
					links: { change_requests: [pr({ title, ...over })], branches: [] },
				}),
			);
			await openTask(page);

			await expect(page.getByText(title, { exact: true })).toBeVisible();
			// Narrow screens hide the author and the badge label, so check they are rendered.
			await expect(page.getByText("by alice")).toBeAttached();
			await expect(
				page.getByText(badge, { exact: true }).first(),
			).toBeAttached();
		});
	}

	test("A linked branch is listed and can be unlinked", async ({ page }) => {
		const stub = newStub({
			links: { change_requests: [], branches: [branch("feat/login")] },
		});
		await signIn(page);
		await stubGit(page, projectId, taskId, stub);
		await openTask(page);

		await expect(page.getByText("feat/login", { exact: true })).toBeVisible();
		await page
			.getByRole("button", { name: "Unlink branch feat/login" })
			.click();
		await expect.poll(() => stub.requests.length).toBe(1);
		expect(stub.requests[0].method).toBe("DELETE");
		expect(stub.requests[0].path).toContain("/branches");
		expect(stub.requests[0].path).toContain("branch=feat%2Flogin");
		await expect(page.getByText("No branches linked yet.")).toBeVisible();
		await expect(page.getByText("feat/login", { exact: true })).toHaveCount(0);
	});

	test("A pull request is unlinked", async ({ page }) => {
		const stub = newStub({
			links: { change_requests: [pr()], branches: [] },
		});
		await signIn(page);
		await stubGit(page, projectId, taskId, stub);
		await openTask(page);

		await page.getByRole("button", { name: /Unlink pull request/ }).click();
		await expect.poll(() => stub.requests.length).toBe(1);
		expect(stub.requests[0].method).toBe("DELETE");
		expect(stub.requests[0].path).toContain("/change-requests/4");
		await expect(page.getByText("No pull requests linked yet.")).toBeVisible();
		await expect(page.getByText("Add login", { exact: true })).toHaveCount(0);
	});

	test("A pull request is linked by pasted link", async ({ page }) => {
		const stub = newStub();
		await signIn(page);
		await stubGit(page, projectId, taskId, stub);
		await openTask(page);

		await page.getByRole("button", { name: "Link pull request" }).click();
		await page
			.getByLabel("Pull request", { exact: true })
			.fill("https://git.example.test/acme/web/pull/7");
		await page
			.getByRole("button", { name: "Link pull request" })
			.last()
			.click();

		await expect.poll(() => stub.requests.length).toBe(1);
		expect(stub.requests[0]).toMatchObject({
			method: "POST",
			path: "/change-requests",
			body: { repository_id: REPO.id, number: "7" },
		});
	});

	test("A link the platform rejects is explained", async ({ page }) => {
		const stub = newStub({ linkError: { status: 404, code: "GIT_NOT_FOUND" } });
		await signIn(page);
		await stubGit(page, projectId, taskId, stub);
		await openTask(page);

		await page.getByRole("button", { name: "Link pull request" }).click();
		await page.getByLabel("Pull request", { exact: true }).fill("99");
		await page
			.getByRole("button", { name: "Link pull request" })
			.last()
			.click();

		await expect(page.getByRole("alert")).toContainText(
			"It wasn't found in that repository.",
		);
	});

	test("Without edit access the actions are hidden", async ({
		page,
		request,
		playwright,
	}) => {
		const reader = await memberWith(
			request,
			playwright,
			projectId,
			PREFIX,
			RUN_ID,
			"READER",
			["tasks:read", "git:read"],
		);
		await signIn(page, reader.username, RESTRICTED_PASSWORD);
		await stubGit(
			page,
			projectId,
			taskId,
			newStub({
				links: { change_requests: [pr()], branches: [branch("feat/login")] },
			}),
		);
		await openTask(page);

		await expect(page.getByText("Add login", { exact: true })).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Link pull request" }),
		).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Link branch" })).toHaveCount(
			0,
		);
		await expect(page.getByRole("button", { name: "New branch" })).toHaveCount(
			0,
		);
		await expect(page.getByRole("button", { name: /Unlink/ })).toHaveCount(0);
	});
});
