// spec: features/iam/git-ops-gates.feature
// seed: tests/seed.spec.ts
//
// One test per Git operation route: it is open to the member holding the one
// action the route declares (and to git:*), and answers 403 to everyone else.
// Past the gate the repository does not exist, so a request that is not
// refused for permissions answers something else (404 or 400).

import { type APIRequestContext, expect, test } from "@playwright/test";
import {
	API_URL,
	authRequest,
	cleanupGlobalRolesByPrefix,
	cleanupProjectsByPrefix,
	cleanupUsersByPrefix,
	createProject,
	newRunId,
} from "../helpers/e2e-api";
import {
	anonymous,
	memberWith,
	REPOSITORY,
	refused,
	repoUrl,
} from "../helpers/git";
import {
	allow,
	asUser,
	createMember,
	deny,
	projectRoleFrom,
} from "../helpers/iam";

const PREFIX = "E2E_GITOPS_";
const RUN_ID = newRunId();

type Action = "git:read" | "git:write" | "git:approve" | "git:merge";
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const ROUTES: Array<{ method: Method; path: string; action: Action }> = [
	{ method: "GET", path: "/change-requests/1", action: "git:read" },
	{ method: "GET", path: "/change-requests/1/files", action: "git:read" },
	{ method: "GET", path: "/change-requests/1/diff", action: "git:read" },
	{ method: "GET", path: "/change-requests/1/threads", action: "git:read" },
	{ method: "GET", path: "/subjects/issue/1/comments", action: "git:read" },
	{
		method: "GET",
		path: "/subjects/change_request/1/comments",
		action: "git:read",
	},
	{ method: "GET", path: "/issues/1", action: "git:read" },
	{ method: "GET", path: "/checks", action: "git:read" },
	{ method: "GET", path: "/checks/1/logs", action: "git:read" },
	{ method: "GET", path: "/files", action: "git:read" },
	{ method: "GET", path: "/code-search", action: "git:read" },
	{ method: "POST", path: "/credential/read", action: "git:read" },
	{ method: "POST", path: "/change-requests", action: "git:write" },
	{ method: "PATCH", path: "/change-requests/1", action: "git:write" },
	{ method: "POST", path: "/change-requests/1/reviews", action: "git:write" },
	{ method: "POST", path: "/change-requests/1/reviewers", action: "git:write" },
	{
		method: "POST",
		path: "/change-requests/1/threads/t/replies",
		action: "git:write",
	},
	{
		method: "POST",
		path: "/change-requests/1/threads/t/resolution",
		action: "git:write",
	},
	{ method: "POST", path: "/subjects/issue/1/comments", action: "git:write" },
	{ method: "POST", path: "/subjects/issue/1/labels", action: "git:write" },
	{ method: "PUT", path: "/subjects/issue/1/assignees", action: "git:write" },
	{ method: "POST", path: "/checks/rerun", action: "git:write" },
	{ method: "POST", path: "/credential/write", action: "git:write" },
	{ method: "DELETE", path: "", action: "git:write" },
	{
		method: "POST",
		path: "/change-requests/1/approvals",
		action: "git:approve",
	},
	{ method: "POST", path: "/change-requests/1/merge", action: "git:merge" },
];

const ACTORS = [
	"git:read",
	"git:write",
	"git:approve",
	"git:merge",
	"none",
] as const;

async function cleanup(request: APIRequestContext) {
	await cleanupProjectsByPrefix(request, PREFIX);
	await cleanupUsersByPrefix(request, PREFIX);
	await cleanupGlobalRolesByPrefix(request, PREFIX);
}

test.describe("Git operation route gates", () => {
	test.describe.configure({ mode: "serial" });
	let projectId: string;
	const users = new Map<string, string>();

	test.beforeAll(async ({ request, playwright }) => {
		await authRequest(request);
		await cleanup(request);
		projectId = await createProject(request, `${PREFIX}PROJECT_${RUN_ID}`);
		for (const actor of ACTORS) {
			const label = actor.replace(/\W/g, "").toUpperCase();
			const actions = actor === "none" ? [] : [actor];
			const member = await memberWith(
				request,
				playwright,
				projectId,
				PREFIX,
				RUN_ID,
				label,
				actions,
			);
			users.set(actor, member.username);
		}
		const star = await memberWith(
			request,
			playwright,
			projectId,
			PREFIX,
			RUN_ID,
			"STAR",
			["git:*"],
		);
		users.set("git:*", star.username);
	});

	test.afterAll(async ({ request }) => {
		await authRequest(request);
		await cleanup(request);
	});

	const call = (api: APIRequestContext, method: Method, path: string) => {
		const url = repoUrl(projectId, path);
		const options = method === "GET" || method === "DELETE" ? {} : { data: {} };
		return api.fetch(url, { method, ...options });
	};

	for (const route of ROUTES) {
		test(`${route.method} ${route.path || "/ (unlink)"} needs ${route.action}`, async ({
			playwright,
		}) => {
			for (const actor of [...ACTORS, "git:*"]) {
				const allowed = actor === route.action || actor === "git:*";
				await asUser(playwright, users.get(actor) ?? "", async (api) => {
					const response = await call(api, route.method, route.path);
					expect(refused(response), `${actor}: ${response.status()}`).toBe(
						!allowed,
					);
					if (!allowed) expect(response.status()).toBe(403);
				});
			}
			await anonymous(playwright, async (api) => {
				expect((await call(api, route.method, route.path)).status()).toBe(401);
			});
		});
	}

	test("A denied action wins over a wildcard grant", async ({
		request,
		playwright,
	}) => {
		await authRequest(request);
		const roleId = await projectRoleFrom(
			request,
			projectId,
			`${PREFIX}ROLE_DENY_${RUN_ID}`,
			allow(["projects:read"], [`project/${projectId}`]),
			allow(["git:*"], [`project/${projectId}/*`]),
			deny(["git:write"], [`project/${projectId}/*`]),
		);
		const member = await createMember(
			request,
			playwright,
			projectId,
			`${PREFIX}DENIED_${RUN_ID}`,
			[roleId],
		);
		await asUser(playwright, member.username, async (api) => {
			expect(refused(await call(api, "GET", "/issues/1"))).toBe(false);
			expect(
				(await call(api, "POST", "/subjects/issue/1/comments")).status(),
			).toBe(403);
			expect((await call(api, "POST", "/credential/write")).status()).toBe(403);
		});
	});

	test("Repository ids and project ids are validated", async ({ request }) => {
		await authRequest(request);
		const bad = await request.get(
			`${API_URL}/projects/not-a-uuid/git/repositories`,
		);
		expect(bad.status()).toBe(400);
		const badRepo = await request.post(
			`${API_URL}/projects/${projectId}/git/repositories/not-a-uuid/credential/read`,
			{ data: {} },
		);
		expect(badRepo.status()).toBe(400);
		const missing = await request.post(
			`${API_URL}/projects/${projectId}/git/repositories/${REPOSITORY}/credential/read`,
			{ data: {} },
		);
		expect(missing.status()).toBe(404);
		expect((await missing.json()).error_code).toBe("GIT_NOT_FOUND");
	});
});
