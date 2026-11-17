// spec: features/iam/boundaries.feature
// seed: tests/seed.spec.ts
//
// The edges of the model (docs/architecture/authorization.md): who gets in
// without being signed in, where workspace grants stop and project grants
// begin, what a role attached to one project can reach, what the built-in ADMIN
// role cannot do, what a removed member or a deleted account keeps, and the
// read-only helpers (simulate, "my permissions").
//
// Everything is set up and asserted over the API. Members sign in as
// themselves (asUser), so each request is judged against their own roles.

import {
	type APIRequestContext,
	type APIResponse,
	expect,
	test,
} from "@playwright/test";
import {
	API_URL,
	authRequest,
	cleanupGlobalRolesByPrefix,
	cleanupProjectsByPrefix,
	cleanupUsersByPrefix,
	createGlobalRole,
	createProject,
	createUserWithPassword,
	globalRoleIdByName,
	newRunId,
	projectRoleIdByName,
} from "../helpers/e2e-api";
import {
	allow,
	asUser,
	createMember,
	createTask,
	dataOf,
	deny,
	errorCode,
	listTasks,
	openProject,
	policyOf,
	projectActions,
	projectRoleFrom,
} from "../helpers/iam";
import { loginContext } from "../helpers/profile-users";

const PREFIX = "E2E_IAMBND_";
const RUN_ID = newRunId();
const name = (label: string) => `${PREFIX}${label}_${RUN_ID}`;

async function cleanup(request: APIRequestContext) {
	await cleanupProjectsByPrefix(request, PREFIX);
	await cleanupUsersByPrefix(request, PREFIX);
	await cleanupGlobalRolesByPrefix(request, PREFIX);
}

type Playwright = Parameters<typeof asUser>[0];

/** An API context with no credentials at all. */
async function anonymous<T>(
	playwright: Playwright,
	fn: (api: APIRequestContext) => Promise<T>,
): Promise<T> {
	const api = await playwright.request.newContext();
	try {
		return await fn(api);
	} finally {
		await api.dispose();
	}
}

const taskUrl = (projectId: string, taskId: string) =>
	`${API_URL}/projects/${projectId}/tasks/${taskId}`;

/** A user whose only workspace role is the one called `roleName`. */
async function userWithWorkspaceRole(
	request: APIRequestContext,
	playwright: Playwright,
	label: string,
	roleName: string,
): Promise<string> {
	const username = name(label);
	await createUserWithPassword(request, playwright, {
		username,
		fullName: username,
		roles: [roleName],
	});
	return username;
}

// ─── Not signed in ───────────────────────────────────────────────────────────

test.describe("Callers who are not signed in", () => {
	let projectId: string;
	let taskId: string;
	const projectName = name("PRIVATE");

	test.beforeEach(async ({ request, context }) => {
		await authRequest(request);
		await cleanup(request);
		await context.clearCookies();
		projectId = await createProject(request, projectName);
		taskId = await createTask(request, projectId, "Public task");
	});

	test.afterEach(async ({ request }) => {
		await authRequest(request);
		await cleanup(request);
	});

	test("A private project and every workspace route answer 401", async ({
		playwright,
	}) => {
		await anonymous(playwright, async (api) => {
			const reads = [
				`/projects`,
				`/projects/${projectId}`,
				`/projects/${projectId}/tasks`,
				`/projects/${projectId}/sprints`,
				`/projects/${projectId}/docs`,
				`/projects/${projectId}/members`,
				`/projects/${projectId}/roles`,
				`/admin/users`,
				`/admin/roles`,
				`/admin/agents`,
				`/roles/actions`,
				`/roles/attribute-schema`,
				`/users/me/global-permissions`,
				`/projects/${projectId}/members/me/permissions`,
			];
			for (const path of reads) {
				expect(
					(await api.get(`${API_URL}${path}`)).status(),
					`GET ${path}`,
				).toBe(401);
			}
			const writes: Array<[string, string]> = [
				["post", `/projects/${projectId}/tasks`],
				["post", `/projects`],
				["post", `/admin/users`],
				["post", `/admin/roles`],
				["post", `/roles/simulate`],
				["patch", `/projects/${projectId}`],
				["delete", `/projects/${projectId}`],
			];
			for (const [method, path] of writes) {
				const response = await api.fetch(`${API_URL}${path}`, {
					method,
					data: {},
				});
				expect(response.status(), `${method.toUpperCase()} ${path}`).toBe(401);
			}
		});
	});

	test("A malformed or forged token is 401, not a way in", async ({
		playwright,
	}) => {
		for (const token of ["garbage", "a.b.c", ""]) {
			const api = await playwright.request.newContext({
				extraHTTPHeaders: { Authorization: `Bearer ${token}` },
			});
			try {
				expect(
					(await api.get(`${API_URL}/projects/${projectId}/tasks`)).status(),
					`token "${token}"`,
				).toBe(401);
				expect((await api.get(`${API_URL}/admin/users`)).status()).toBe(401);
			} finally {
				await api.dispose();
			}
		}
	});

	test("There is no public mode: nothing a project says opens it to visitors", async ({
		request,
		playwright,
	}) => {
		// A client that still sends the retired is_public flag gets no public
		// project out of it: the flag is not part of a project any more.
		const patched = await request.patch(`${API_URL}/projects/${projectId}`, {
			data: { name: projectName, is_public: true },
		});
		// The unknown field is ignored, not rejected: the edit itself goes through.
		expect(patched.ok(), await patched.text()).toBeTruthy();
		expect((await dataOf<{ name: string }>(patched)).name).toBe(projectName);
		const project = await dataOf<Record<string, unknown>>(
			await request.get(`${API_URL}/projects/${projectId}`),
		);
		expect(project).not.toHaveProperty("is_public");

		await anonymous(playwright, async (api) => {
			for (const path of [
				"",
				"/members",
				"/task-statuses",
				"/tasks",
				`/tasks/${taskId}`,
				`/tasks/${taskId}/activities`,
				"/sprints",
				"/docs",
				"/views",
			]) {
				expect(
					(await api.get(`${API_URL}/projects/${projectId}${path}`)).status(),
					`GET /projects/:id${path}`,
				).toBe(401);
			}
		});
	});

	test("A signed-in user with no role on the project is refused", async ({
		request,
		playwright,
	}) => {
		const stranger = await userWithWorkspaceRole(
			request,
			playwright,
			"STRANGER",
			"USER",
		);
		await asUser(playwright, stranger, async (api) => {
			expect(
				(await api.get(`${API_URL}/projects/${projectId}/tasks`)).status(),
			).toBe(403);
			expect((await api.get(`${API_URL}/projects/${projectId}`)).status()).toBe(
				403,
			);
		});
	});

	test("A non-UUID project id is a 400 for a signed-in caller", async ({
		request,
	}) => {
		for (const path of ["not-a-uuid/tasks", "123/sprints", "x/members"]) {
			const response = await request.get(`${API_URL}/projects/${path}`);
			expect(response.status(), path).toBe(400);
		}
	});
});

// ─── Workspace grants versus project grants ──────────────────────────────────

test.describe("Workspace grants do not reach into projects", () => {
	let projectId: string;
	let otherProjectId: string;

	test.beforeEach(async ({ request, context }) => {
		await authRequest(request);
		await cleanup(request);
		await context.clearCookies();
		projectId = await createProject(request, name("P1"));
		otherProjectId = await createProject(request, name("P2"));
		await createTask(request, projectId, "In P1");
		await createTask(request, otherProjectId, "In P2");
	});

	test.afterEach(async ({ request }) => {
		await authRequest(request);
		await cleanup(request);
	});

	test("A named project action on the workspace resources opens no project", async ({
		request,
		playwright,
	}) => {
		// tasks:read lives inside projects; written on the workspace resources
		// it names nothing a project request is ever checked against.
		await createGlobalRole(
			request,
			name("WS_TASKS"),
			policyOf(
				allow(
					["tasks:read", "tasks:write", "docs:read", "sprints:read"],
					["user/*", "role/*", "agent/*", "plugin/*", "settings", "project"],
				),
			),
		);
		const username = await userWithWorkspaceRole(
			request,
			playwright,
			"WS_ONLY",
			name("WS_TASKS"),
		);
		await asUser(playwright, username, async (api) => {
			for (const id of [projectId, otherProjectId]) {
				expect((await listTasks(api, id)).status, `tasks of ${id}`).toBe(403);
				expect(
					(await api.get(`${API_URL}/projects/${id}/sprints`)).status(),
				).toBe(403);
				expect(
					(
						await api.post(`${API_URL}/projects/${id}/tasks`, {
							data: { title: "Nope" },
						})
					).status(),
				).toBe(403);
			}
		});
	});

	test("Only * on * (or a grant on project/...) reaches inside every project", async ({
		request,
		playwright,
	}) => {
		await createGlobalRole(
			request,
			name("EVERYTHING"),
			policyOf(allow(["*"], ["*"])),
		);
		await createGlobalRole(
			request,
			name("ONE_PROJECT"),
			policyOf(
				allow(["tasks:read"], [`project/${projectId}/*`]),
				allow(["projects:read"], [`project/${projectId}`]),
			),
		);
		const everything = await userWithWorkspaceRole(
			request,
			playwright,
			"EVERYONE",
			name("EVERYTHING"),
		);
		const oneProject = await userWithWorkspaceRole(
			request,
			playwright,
			"ONEPROJ",
			name("ONE_PROJECT"),
		);
		await asUser(playwright, everything, async (api) => {
			expect((await listTasks(api, projectId)).status).toBe(200);
			expect((await listTasks(api, otherProjectId)).status).toBe(200);
		});
		await asUser(playwright, oneProject, async (api) => {
			expect((await listTasks(api, projectId)).status).toBe(200);
			expect((await listTasks(api, otherProjectId)).status).toBe(403);
			// Read, not write: the grant names only tasks:read.
			expect(
				(
					await api.post(`${API_URL}/projects/${projectId}/tasks`, {
						data: { title: "Nope" },
					})
				).status(),
			).toBe(403);
		});
	});

	test("A full-access role attached to one project reaches that project and nothing else", async ({
		request,
		playwright,
	}) => {
		// "*" on "*" is the most a role can say, yet attached to a project it only
		// ever applies to resources inside it: not the other project, and none of
		// the workspace.
		const full = await createGlobalRole(
			request,
			name("FULL_BUT_SCOPED"),
			policyOf(allow(["*"], ["*"])),
		);
		const member = await createMember(
			request,
			playwright,
			projectId,
			name("PROJECTFULL"),
			[full.id],
		);
		await asUser(playwright, member.username, async (api) => {
			expect((await listTasks(api, projectId)).status).toBe(200);
			expect(
				(
					await api.post(`${API_URL}/projects/${projectId}/tasks`, {
						data: { title: "Allowed here" },
					})
				).status(),
			).toBeLessThan(300);
			expect((await listTasks(api, otherProjectId)).status).toBe(403);
			// (Every account holds the default USER role, which can list users, so
			// that is not a signal here; users:write and the rest are.)
			for (const path of ["/admin/roles", "/admin/agents"]) {
				expect((await api.get(`${API_URL}${path}`)).status(), path).toBe(403);
			}
			expect(
				(
					await api.post(`${API_URL}/admin/users`, {
						data: { username: name("MADE0"), password: "Passw0rd!Passw0rd" },
					})
				).status(),
			).toBe(403);
			expect(
				(
					await api.post(`${API_URL}/admin/roles`, {
						data: { name: name("ESCAPE"), policy: policyOf() },
					})
				).status(),
			).toBe(403);
		});
	});

	test("A project Admin has no say outside its project", async ({
		request,
		playwright,
	}) => {
		const admin = await createMember(
			request,
			playwright,
			projectId,
			name("PROJADMIN"),
			[await projectRoleIdByName(request, projectId, "Admin")],
		);
		await asUser(playwright, admin.username, async (api) => {
			expect((await listTasks(api, projectId)).status).toBe(200);
			expect((await listTasks(api, otherProjectId)).status).toBe(403);
			expect(
				(await api.get(`${API_URL}/projects/${otherProjectId}`)).status(),
			).toBe(403);
			for (const path of [
				"/admin/roles",
				"/admin/agents",
				"/admin/plugins/marketplace",
			]) {
				expect((await api.get(`${API_URL}${path}`)).status(), path).toBe(403);
			}
			expect(
				(
					await api.post(`${API_URL}/admin/users`, {
						data: { username: name("MADE"), password: "Passw0rd!Passw0rd" },
					})
				).status(),
			).toBe(403);
		});
	});

	test("Deny on a project beats a workspace-wide full-access role", async ({
		request,
		playwright,
	}) => {
		const secret = await createTask(request, otherProjectId, "Secret in P2");
		await createGlobalRole(
			request,
			name("EVERYTHING_DENY"),
			policyOf(
				allow(["*"], ["*"]),
				deny(["tasks:read", "tasks:write"], [`project/${otherProjectId}/*`]),
			),
		);
		const username = await userWithWorkspaceRole(
			request,
			playwright,
			"DENIED",
			name("EVERYTHING_DENY"),
		);
		await asUser(playwright, username, async (api) => {
			expect((await listTasks(api, projectId)).status).toBe(200);
			expect((await listTasks(api, projectId)).total).toBe(1);
			// The denied project lists no task and takes none, ...
			expect((await listTasks(api, otherProjectId)).status).toBe(403);
			expect(
				(
					await api.post(`${API_URL}/projects/${otherProjectId}/tasks`, {
						data: { title: "Nope" },
					})
				).status(),
			).toBe(403);
			expect(
				(
					await api.patch(taskUrl(otherProjectId, secret), {
						data: { title: "Changed" },
					})
				).status(),
			).toBe(403);
			// ... while the rest of that project is untouched.
			expect(
				(
					await api.get(`${API_URL}/projects/${otherProjectId}/sprints`)
				).status(),
			).toBe(200);
		});
	});

	// Reading what is inside a project never rides on the workspace-wide
	// projects:read: a Deny of tasks:read on the project also stops a task being
	// opened by id, with its activities, links and attachments.
	test("A Deny of tasks:read also stops by-id reads for a holder of full access", async ({
		request,
		playwright,
	}) => {
		const secret = await createTask(request, otherProjectId, "Secret in P2");
		await createGlobalRole(
			request,
			name("EVERYTHING_DENY2"),
			policyOf(
				allow(["*"], ["*"]),
				deny(["tasks:read"], [`project/${otherProjectId}/*`]),
			),
		);
		const username = await userWithWorkspaceRole(
			request,
			playwright,
			"DENIED2",
			name("EVERYTHING_DENY2"),
		);
		await asUser(playwright, username, async (api) => {
			for (const path of ["", "/activities", "/links", "/attachments"]) {
				expect(
					(await api.get(`${taskUrl(otherProjectId, secret)}${path}`)).status(),
					`GET task${path}`,
				).toBe(403);
			}
		});
	});
});

// ─── The built-in ADMIN role ─────────────────────────────────────────────────

test.describe("The built-in ADMIN role runs the workspace but not the roles", () => {
	test.beforeEach(async ({ request, context }) => {
		await authRequest(request);
		await cleanup(request);
		await context.clearCookies();
	});

	test.afterEach(async ({ request }) => {
		await authRequest(request);
		await cleanup(request);
	});

	test("It manages users, projects, agents and plugins and reads roles, but cannot write or assign them", async ({
		request,
		playwright,
	}) => {
		const username = await userWithWorkspaceRole(
			request,
			playwright,
			"WS_ADMIN",
			"ADMIN",
		);
		const target = name("TARGET");
		await createUserWithPassword(request, playwright, {
			username: target,
			fullName: target,
		});
		const targetRecord = await dataOf<{
			items: Array<{ id: string; username: string }>;
		}>(await request.get(`${API_URL}/admin/users?search=${target}`));
		const targetId = targetRecord.items.find((u) => u.username === target)?.id;
		expect(targetId, "the target user is listed").toBeTruthy();

		await asUser(playwright, username, async (api) => {
			expect((await api.get(`${API_URL}/admin/users`)).status()).toBe(200);
			expect((await api.get(`${API_URL}/admin/roles`)).status()).toBe(200);
			expect((await api.get(`${API_URL}/admin/agents`)).status()).toBe(200);
			expect(
				(await api.get(`${API_URL}/admin/plugins/marketplace`)).status(),
			).toBe(200);

			const created = await api.post(`${API_URL}/admin/users`, {
				data: {
					username: name("BYADMIN"),
					full_name: "Created by ADMIN",
					password: "TempPassword123!",
				},
			});
			expect(created.status(), await created.text()).toBeLessThan(300);

			// Roles can be read, never defined or handed out.
			const newRole = await api.post(`${API_URL}/admin/roles`, {
				data: { name: name("ADMIN_ROLE"), description: "", policy: policyOf() },
			});
			expect(newRole.status()).toBe(403);
			const roleId = await globalRoleIdByName(request, "SUPER_ADMIN");
			const assign = await api.put(`${API_URL}/admin/users/${targetId}/roles`, {
				data: { role_ids: [roleId] },
			});
			expect(assign.status()).toBe(403);
			expect(await errorCode(assign)).toBe("FORBIDDEN");
			expect(
				(
					await api.put(`${API_URL}/admin/roles/${roleId}/default`, {
						data: {},
					})
				).status(),
			).toBe(403);
			expect(
				(
					await api.put(`${API_URL}/admin/roles/${roleId}`, {
						data: { name: "SUPER_ADMIN", description: "", policy: policyOf() },
					})
				).status(),
			).toBe(403);
		});
	});

	test("It reads every project but holds no role inside one", async ({
		request,
		playwright,
	}) => {
		const projectId = await createProject(request, name("ADMINPROJECT"));
		const taskId = await createTask(request, projectId, "Not for ADMIN");
		const username = await userWithWorkspaceRole(
			request,
			playwright,
			"WS_ADMIN2",
			"ADMIN",
		);
		await asUser(playwright, username, async (api) => {
			const list = await dataOf<{ items: Array<{ id: string }> }>(
				await api.get(`${API_URL}/projects`),
			);
			expect(list.items.map((p) => p.id)).toContain(projectId);
			// It opens the project itself, but nothing inside it: lists and
			// by-id reads of the project's content answer 403 alike.
			expect((await api.get(`${API_URL}/projects/${projectId}`)).status()).toBe(
				200,
			);
			expect((await listTasks(api, projectId)).status).toBe(403);
			expect(
				(
					await api.get(`${API_URL}/projects/${projectId}/tasks/${taskId}`)
				).status(),
			).toBe(403);
			// Writing inside a project is not something projects:* on the project
			// collection grants.
			expect(
				(
					await api.post(`${API_URL}/projects/${projectId}/tasks`, {
						data: { title: "Nope" },
					})
				).status(),
			).toBe(403);
			expect(
				(
					await api.post(`${API_URL}/projects/${projectId}/sprints`, {
						data: { name: "Nope" },
					})
				).status(),
			).toBe(403);
		});
	});
});

// ─── Losing access ───────────────────────────────────────────────────────────

test.describe("Access ends when the membership or the account does", () => {
	let projectId: string;

	test.beforeEach(async ({ request, context }) => {
		await authRequest(request);
		await cleanup(request);
		await context.clearCookies();
		projectId = await createProject(request, name("LOSING"));
		await createTask(request, projectId, "Still here");
	});

	test.afterEach(async ({ request }) => {
		await authRequest(request);
		await cleanup(request);
	});

	test("A removed member is refused on the very next request, with the same session", async ({
		request,
		playwright,
	}) => {
		const member = await createMember(
			request,
			playwright,
			projectId,
			name("LEAVER"),
			[await projectRoleIdByName(request, projectId, "Editor")],
		);
		const api = await loginContext(playwright, member.username);
		try {
			expect((await listTasks(api, projectId)).status).toBe(200);
			const removed = await request.delete(
				`${API_URL}/projects/${projectId}/members/${member.memberId}`,
			);
			expect(removed.ok(), await removed.text()).toBeTruthy();
			expect((await listTasks(api, projectId)).status).toBe(403);
			expect(
				(
					await api.post(`${API_URL}/projects/${projectId}/tasks`, {
						data: { title: "Nope" },
					})
				).status(),
			).toBe(403);
		} finally {
			await api.dispose();
		}
	});

	test("A deleted account's open session no longer gets anything", async ({
		request,
		playwright,
	}) => {
		const member = await createMember(
			request,
			playwright,
			projectId,
			name("DELETED"),
			[await projectRoleIdByName(request, projectId, "Editor")],
		);
		const api = await loginContext(playwright, member.username);
		try {
			expect((await listTasks(api, projectId)).status).toBe(200);
			const deleted = await request.delete(
				`${API_URL}/admin/users/${member.userId}`,
			);
			expect(deleted.ok(), await deleted.text()).toBeTruthy();
			const after = await listTasks(api, projectId);
			expect([401, 403]).toContain(after.status);
		} finally {
			await api.dispose();
		}
	});

	test("Detaching a workspace role takes its powers away at once, same session", async ({
		request,
		playwright,
	}) => {
		const role = await createGlobalRole(
			request,
			name("USERS_READER"),
			policyOf(allow(["users:read"], ["user", "user/*"])),
		);
		const username = await userWithWorkspaceRole(
			request,
			playwright,
			"DETACH",
			name("USERS_READER"),
		);
		const api = await loginContext(playwright, username);
		try {
			expect((await api.get(`${API_URL}/admin/users`)).status()).toBe(200);
			const deleted = await request.delete(`${API_URL}/admin/roles/${role.id}`);
			expect(deleted.ok(), await deleted.text()).toBeTruthy();
			expect((await api.get(`${API_URL}/admin/users`)).status()).toBe(403);
		} finally {
			await api.dispose();
		}
	});
});

// ─── Simulate and "my permissions" ───────────────────────────────────────────

test.describe("Simulating a request", () => {
	let projectId: string;

	test.beforeEach(async ({ request, context }) => {
		await authRequest(request);
		await cleanup(request);
		await context.clearCookies();
		projectId = await createProject(request, name("SIM"));
	});

	test.afterEach(async ({ request }) => {
		await authRequest(request);
		await cleanup(request);
	});

	const simulate = (
		api: APIRequestContext,
		body: Record<string, unknown>,
	): Promise<APIResponse> =>
		api.post(`${API_URL}/roles/simulate`, { data: body });

	test("Any signed-in caller can try a policy alone: Deny wins and the deciding statement is named", async ({
		request,
		playwright,
	}) => {
		const username = await userWithWorkspaceRole(
			request,
			playwright,
			"SIMULATOR",
			"USER",
		);
		const task = `project/${projectId}/task/t1`;
		const policy = policyOf(
			{ ...allow(["tasks:*"], [`project/${projectId}/*`]), sid: "Open" },
			{ ...deny(["tasks:write"], [`project/${projectId}/*`]), sid: "NoWrites" },
		);
		await asUser(playwright, username, async (api) => {
			const read = await dataOf<{
				allowed: boolean;
				matched: Array<{ sid: string; effect: string; role_id: string }>;
			}>(await simulate(api, { policy, action: "tasks:read", resource: task }));
			expect(read.allowed).toBe(true);
			expect(read.matched.map((m) => m.sid)).toEqual(["Open"]);

			const write = await dataOf<{
				allowed: boolean;
				matched: Array<{ sid: string; effect: string; role_id: string }>;
			}>(
				await simulate(api, { policy, action: "tasks:write", resource: task }),
			);
			expect(write.allowed).toBe(false);
			expect(write.matched.map((m) => m.sid).sort()).toEqual([
				"NoWrites",
				"Open",
			]);
			expect(write.matched.every((m) => m.role_id === "policy")).toBe(true);

			// Nothing matches: default deny, with nothing to show.
			const none = await dataOf<{ allowed: boolean; matched: unknown[] }>(
				await simulate(api, {
					policy,
					action: "docs:read",
					resource: `project/${projectId}/doc/d1`,
				}),
			);
			expect(none.allowed).toBe(false);
			expect(none.matched).toEqual([]);
		});
	});

	test("Condition attributes come only from the request: a missing one is absent", async ({
		request,
		playwright,
	}) => {
		const username = await userWithWorkspaceRole(
			request,
			playwright,
			"SIMATTR",
			"USER",
		);
		const policy = policyOf(
			allow(["tasks:read"], [`project/${projectId}/task/*`], {
				StringEquals: { "task.sprint_id": "sprint-a" },
			}),
		);
		const task = `project/${projectId}/task/t1`;
		await asUser(playwright, username, async (api) => {
			const ask = async (attributes?: Record<string, unknown>) =>
				(
					await dataOf<{ allowed: boolean }>(
						await simulate(api, {
							policy,
							action: "tasks:read",
							resource: task,
							...(attributes ? { attributes } : {}),
						}),
					)
				).allowed;
			expect(await ask({ "task.sprint_id": "sprint-a" })).toBe(true);
			expect(await ask({ "task.sprint_id": ["sprint-b", "sprint-a"] })).toBe(
				true,
			);
			expect(await ask({ "task.sprint_id": "sprint-b" })).toBe(false);
			expect(await ask()).toBe(false);
		});
	});

	test("A bad policy, an unknown action or a missing field is refused", async ({
		request,
		playwright,
	}) => {
		const username = await userWithWorkspaceRole(
			request,
			playwright,
			"SIMBAD",
			"USER",
		);
		await asUser(playwright, username, async (api) => {
			const bad = await simulate(api, {
				policy: policyOf(allow(["tasks:fly"], ["*"])),
				action: "tasks:read",
				resource: `project/${projectId}`,
			});
			expect(bad.status()).toBe(422);
			expect(await errorCode(bad)).toBe("ROLE_POLICY_INVALID");

			for (const body of [
				{ policy: policyOf(), resource: "*" },
				{ policy: policyOf(), action: "tasks:read" },
				{ action: "tasks:read", resource: "*" },
			]) {
				const response = await simulate(api, body);
				expect([400, 422], JSON.stringify(body)).toContain(response.status());
			}
		});
	});

	test("Naming a principal exposes their grants, so it needs roles:read", async ({
		request,
		playwright,
	}) => {
		// A member whose own role reads tasks; the policy under test adds nothing.
		const reader = await createMember(
			request,
			playwright,
			projectId,
			name("PRINCIPAL"),
			[
				await projectRoleFrom(
					request,
					projectId,
					name("READS"),
					openProject(projectId, ["tasks:read"]),
					allow(["tasks:read"], [`project/${projectId}/*`]),
				),
			],
		);
		const nosy = await userWithWorkspaceRole(
			request,
			playwright,
			"NOSY",
			"USER",
		);
		await createGlobalRole(
			request,
			name("ROLE_READER"),
			policyOf(allow(["roles:read"], ["role", "role/*"])),
		);
		const allowed = await userWithWorkspaceRole(
			request,
			playwright,
			"ROLEREADER",
			name("ROLE_READER"),
		);
		const body = {
			policy: policyOf(),
			principal: { type: "user", id: reader.userId },
			action: "tasks:read",
			resource: `project/${projectId}/task/t1`,
		};

		await asUser(playwright, nosy, async (api) => {
			const response = await simulate(api, body);
			expect(response.status()).toBe(403);
			// Without a principal the very same question is fine.
			expect(
				(await simulate(api, { ...body, principal: undefined })).status(),
			).toBe(200);
		});
		await asUser(playwright, allowed, async (api) => {
			const answer = await dataOf<{
				allowed: boolean;
				matched: Array<{ role_id: string }>;
			}>(await simulate(api, body));
			// The empty policy adds nothing; the member's own role decides.
			expect(answer.allowed).toBe(true);
			expect(answer.matched.some((m) => m.role_id !== "policy")).toBe(true);
		});
	});
});

test.describe("What the permission endpoints report", () => {
	let projectId: string;

	test.beforeEach(async ({ request, context }) => {
		await authRequest(request);
		await cleanup(request);
		await context.clearCookies();
		projectId = await createProject(request, name("PERMS"));
	});

	test.afterEach(async ({ request }) => {
		await authRequest(request);
		await cleanup(request);
	});

	const globalActions = async (api: APIRequestContext) =>
		(
			await dataOf<{ actions: string[] }>(
				await api.get(`${API_URL}/users/me/global-permissions`),
			)
		).actions;

	test("Workspace permissions follow the user's roles, and a Deny removes an action", async ({
		request,
		playwright,
	}) => {
		await createGlobalRole(
			request,
			name("WS_READ"),
			policyOf(
				allow(
					["users:read", "roles:read", "plugins:read"],
					["user/*", "role/*", "plugin/*"],
				),
			),
		);
		await createGlobalRole(
			request,
			name("WS_NO_PLUGINS"),
			policyOf(deny(["plugins:*"], ["plugin/*"])),
		);
		const plain = await userWithWorkspaceRole(
			request,
			playwright,
			"GP_PLAIN",
			name("WS_READ"),
		);
		const denied = await createUserWithPassword(request, playwright, {
			username: name("GP_DENIED"),
			fullName: "denied",
			roles: [name("WS_READ"), name("WS_NO_PLUGINS")],
		});
		expect(denied).toBeTruthy();

		await asUser(playwright, plain, async (api) => {
			const actions = await globalActions(api);
			expect(actions).toEqual(
				expect.arrayContaining(["users:read", "roles:read", "plugins:read"]),
			);
			expect(actions).not.toContain("users:write");
			expect(actions).not.toContain("roles:write");
		});
		await asUser(playwright, name("GP_DENIED"), async (api) => {
			const actions = await globalActions(api);
			expect(actions).toContain("users:read");
			expect(actions).not.toContain("plugins:read");
		});
	});

	test("A holder of * sees every workspace action; a user with an empty role sees none", async ({
		request,
		playwright,
	}) => {
		// The workspace-level list holds the actions that have a workspace root
		// (users, roles, plugins, settings, ...), not the project-level ones, so a
		// "*" holder must show exactly those entries of the catalogue.
		const workspaceDomains = new Set([
			"users",
			"roles",
			"plugins",
			"settings",
			"settings.sso",
			"agents",
			"projects",
		]);
		const catalogue = await dataOf<string[]>(
			await request.get(`${API_URL}/roles/actions`),
		);
		const workspaceActions = catalogue.filter((a) =>
			workspaceDomains.has(a.split(":")[0]),
		);
		expect(workspaceActions.length).toBeGreaterThan(10);
		expect(await globalActionsOf(request)).toEqual(
			expect.arrayContaining(workspaceActions),
		);

		await createGlobalRole(request, name("EMPTY"), policyOf());
		const empty = await userWithWorkspaceRole(
			request,
			playwright,
			"GP_EMPTY",
			name("EMPTY"),
		);
		await asUser(playwright, empty, async (api) => {
			expect(await globalActions(api)).toEqual([]);
		});
	});

	test("In a project: a conditional Allow still shows the action, an unconditional Deny hides it, a conditional Deny does not", async ({
		request,
		playwright,
	}) => {
		const role = await projectRoleFrom(
			request,
			projectId,
			name("MIXED"),
			openProject(projectId),
			allow(["tasks:read"], [`project/${projectId}/task/*`], {
				StringEquals: { "task.sprint_id": "any" },
			}),
			allow(["docs:read", "docs:write"], [`project/${projectId}/*`]),
			deny(["docs:write"], [`project/${projectId}/*`]),
			allow(["sprints:read", "sprints:write"], [`project/${projectId}/*`]),
			deny(["sprints:write"], [`project/${projectId}/*`], {
				StringEquals: { "resource.id": "one-sprint" },
			}),
		);
		const member = await createMember(
			request,
			playwright,
			projectId,
			name("MIXED_USER"),
			[role],
		);
		await asUser(playwright, member.username, async (api) => {
			const actions = await projectActions(api, projectId);
			// Possibly allowed on some task, so the Tasks UI shows.
			expect(actions).toContain("tasks:read");
			expect(actions).toContain("docs:read");
			expect(actions).not.toContain("docs:write");
			// A Deny that depends on the resource does not remove the action.
			expect(actions).toContain("sprints:write");
			expect(actions).not.toContain("tasks:write");
		});
	});
});

async function globalActionsOf(api: APIRequestContext): Promise<string[]> {
	return (
		await dataOf<{ actions: string[] }>(
			await api.get(`${API_URL}/users/me/global-permissions`),
		)
	).actions;
}
