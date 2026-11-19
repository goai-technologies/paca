// spec: features/admin/service-accounts.feature
// seed: tests/seed.spec.ts
//
// Service accounts (docs/api/service-accounts.md): admin-managed, non-human
// accounts with their own API keys and roles. They cannot sign in, so every
// scenario drives them over the API, the same surface an integration uses.

import { type APIRequestContext, expect, test } from "@playwright/test";
import {
	cleanupServiceAccountsByPrefix,
	createServiceAccount,
	createServiceAccountKey,
	listServiceAccounts,
	postServiceAccount,
	postServiceAccountKey,
	putServiceAccountRoles,
	rolesReadStatus,
} from "../helpers/accounts";
import {
	API_URL,
	authRequest,
	cleanupGlobalAgentsByPrefix,
	cleanupGlobalRolesByPrefix,
	cleanupProjectsByPrefix,
	cleanupUsersByPrefix,
	createGlobalAgent,
	createGlobalRole,
	createProject,
	createUserWithGlobalPermissions,
	createUserWithPassword,
	newRunId,
	projectRoleIdByName,
	RESTRICTED_PASSWORD,
} from "../helpers/e2e-api";
import {
	allow,
	asUser,
	createTask,
	dataOf,
	deny,
	errorCode,
	keyContext,
	listTasks,
	policyOf,
	putMemberRoles,
} from "../helpers/iam";

const PREFIX = "E2E_SVCACC_";
const RUN_ID = newRunId();
const name = (label: string) => `${PREFIX}${label}_${RUN_ID}`;

async function cleanup(request: APIRequestContext) {
	await authRequest(request);
	await cleanupProjectsByPrefix(request, PREFIX);
	await cleanupServiceAccountsByPrefix(request, PREFIX);
	await cleanupUsersByPrefix(request, PREFIX);
	await cleanupGlobalAgentsByPrefix(request, PREFIX);
	await cleanupGlobalRolesByPrefix(request, PREFIX);
}

/** A workspace role granting `actions` on every resource. */
async function roleGranting(
	request: APIRequestContext,
	label: string,
	actions: string[],
) {
	return createGlobalRole(
		request,
		name(`ROLE_${label}`),
		policyOf(allow(actions, ["*"])),
	);
}

test.describe("Service accounts: management", () => {
	test.beforeEach(async ({ request, context }) => {
		await authRequest(request);
		await cleanup(request);
		await context.clearCookies();
	});

	test.afterEach(async ({ request }) => {
		await cleanup(request);
	});

	test("A service account is created, read, listed, renamed and deleted", async ({
		request,
	}) => {
		const created = await createServiceAccount(
			request,
			name("CRUD"),
			"deploys the site",
		);
		expect(created.name).toBe(name("CRUD"));
		expect(created.description).toBe("deploys the site");
		// A new account holds no role until it is given some.
		expect(created.roles).toEqual([]);

		const fetched = await request.get(
			`${API_URL}/admin/service-accounts/${created.id}`,
		);
		expect(fetched.status()).toBe(200);
		expect((await dataOf<{ id: string }>(fetched)).id).toBe(created.id);

		expect((await listServiceAccounts(request)).map((a) => a.id)).toContain(
			created.id,
		);

		// A PATCH changes only the fields it names.
		const renamed = await request.patch(
			`${API_URL}/admin/service-accounts/${created.id}`,
			{ data: { name: name("CRUD_RENAMED") } },
		);
		expect(renamed.status()).toBe(200);
		const after = await dataOf<{ name: string; description: string }>(renamed);
		expect(after.name).toBe(name("CRUD_RENAMED"));
		expect(after.description).toBe("deploys the site");

		const deleted = await request.delete(
			`${API_URL}/admin/service-accounts/${created.id}`,
		);
		expect(deleted.status()).toBe(204);
		expect(
			(
				await request.get(`${API_URL}/admin/service-accounts/${created.id}`)
			).status(),
		).toBe(404);
		expect((await listServiceAccounts(request)).map((a) => a.id)).not.toContain(
			created.id,
		);
	});

	test("A name is required and bounded", async ({ request }) => {
		for (const bad of ["", "   ", "x".repeat(101)]) {
			const response = await postServiceAccount(request, bad);
			expect(response.ok(), `name ${JSON.stringify(bad.slice(0, 5))}`).toBe(
				false,
			);
			expect(response.status()).toBeLessThan(500);
		}
		const tooLong = await postServiceAccount(
			request,
			name("DESC"),
			"d".repeat(1001),
		);
		expect(tooLong.ok()).toBe(false);
		expect(tooLong.status()).toBeLessThan(500);
	});

	test("Only service accounts are reachable on the service-account routes", async ({
		request,
		playwright,
	}) => {
		const username = name("USER");
		await createUserWithGlobalPermissions(request, playwright, {
			username,
			roleName: name("ROLE_USER"),
			permissions: { "projects:read": true },
		});
		const users = await request.get(`${API_URL}/admin/users`);
		const userId = (
			(await users.json()).data.items as Array<{
				id: string;
				username: string;
			}>
		).find((u) => u.username === username)?.id as string;
		const agent = await createGlobalAgent(request, name("AGENT"), "acp");

		// A user's or agent's id is not a service account's: 404, and nothing happens to it.
		for (const id of [userId, agent.id]) {
			const base = `${API_URL}/admin/service-accounts/${id}`;
			expect((await request.get(base)).status()).toBe(404);
			expect(
				(await request.patch(base, { data: { name: "hijacked" } })).status(),
			).toBe(404);
			expect((await request.delete(base)).status()).toBe(404);
			expect((await request.get(`${base}/api-keys`)).status()).toBe(404);
			expect((await postServiceAccountKey(request, id, "nope")).status()).toBe(
				404,
			);
		}
		expect((await request.get(`${API_URL}/admin/users/${userId}`)).ok()).toBe(
			true,
		);
		expect(
			(await request.get(`${API_URL}/admin/agents/${agent.id}`)).ok(),
		).toBe(true);
	});

	test("A service account cannot sign in", async ({ request, playwright }) => {
		const account = await createServiceAccount(request, name("NOLOGIN"));
		const anonymous = await playwright.request.newContext();
		try {
			for (const username of [account.name, account.id]) {
				const login = await anonymous.post(`${API_URL}/auth/login`, {
					data: { username, password: RESTRICTED_PASSWORD, rememberMe: false },
				});
				expect(login.status()).toBe(401);
			}
		} finally {
			await anonymous.dispose();
		}
	});
});

test.describe("Service accounts: API keys", () => {
	test.beforeEach(async ({ request, context }) => {
		await authRequest(request);
		await cleanup(request);
		await context.clearCookies();
	});

	test.afterEach(async ({ request }) => {
		await cleanup(request);
	});

	test("A key is shown once, listed without its secret, and authenticates as the account", async ({
		request,
		playwright,
	}) => {
		const account = await createServiceAccount(request, name("KEY"));
		const minted = await createServiceAccountKey(request, account.id, "ci");
		expect(minted.key).toMatch(/^paca_[0-9a-f]{64}$/);
		expect(minted.key.slice("paca_".length).startsWith(minted.key_prefix)).toBe(
			true,
		);

		const listed = await request.get(
			`${API_URL}/admin/service-accounts/${account.id}/api-keys`,
		);
		expect(listed.status()).toBe(200);
		const body = await listed.text();
		expect(body).not.toContain(minted.key);
		const keys = JSON.parse(body).data.items as Array<{
			id: string;
			name: string;
			last_used_at: string | null;
		}>;
		expect(keys.map((k) => k.id)).toEqual([minted.id]);
		expect(keys[0].last_used_at).toBeNull();

		// With no role the key authenticates (not 401) and is simply refused.
		const api = await keyContext(playwright, minted.key);
		try {
			expect(await rolesReadStatus(api)).toBe(403);
			// ...and in the Authorization header form too.
			const viaHeader = await playwright.request.newContext({
				extraHTTPHeaders: { Authorization: `ApiKey ${minted.key}` },
			});
			expect(await rolesReadStatus(viaHeader)).toBe(403);
			await viaHeader.dispose();
		} finally {
			await api.dispose();
		}

		const used = await request.get(
			`${API_URL}/admin/service-accounts/${account.id}/api-keys`,
		);
		expect(
			((await used.json()).data.items as Array<{ last_used_at: string | null }>)[0]
				.last_used_at,
		).not.toBeNull();
	});

	test("A revoked key stops working and leaves the list; other keys are unaffected", async ({
		request,
		playwright,
	}) => {
		const account = await createServiceAccount(request, name("REVOKE"));
		const role = await roleGranting(request, "REVOKE", ["roles:read"]);
		expect(
			(await putServiceAccountRoles(request, account.id, [role.id])).ok(),
		).toBe(true);
		const first = await createServiceAccountKey(request, account.id, "first");
		const second = await createServiceAccountKey(request, account.id, "second");

		const firstApi = await keyContext(playwright, first.key);
		const secondApi = await keyContext(playwright, second.key);
		try {
			expect(await rolesReadStatus(firstApi)).toBe(200);
			expect(await rolesReadStatus(secondApi)).toBe(200);

			const revoked = await request.delete(
				`${API_URL}/admin/service-accounts/${account.id}/api-keys/${first.id}`,
			);
			expect(revoked.status()).toBe(204);

			expect(await rolesReadStatus(firstApi)).toBe(401);
			expect(await rolesReadStatus(secondApi)).toBe(200);
			const listed = await request.get(
				`${API_URL}/admin/service-accounts/${account.id}/api-keys`,
			);
			expect(
				((await listed.json()).data.items as Array<{ id: string }>).map((k) => k.id),
			).toEqual([second.id]);
		} finally {
			await firstApi.dispose();
			await secondApi.dispose();
		}
	});

	test("A key cannot be revoked through another service account", async ({
		request,
		playwright,
	}) => {
		const owner = await createServiceAccount(request, name("OWNER"));
		const other = await createServiceAccount(request, name("OTHER"));
		const key = await createServiceAccountKey(request, owner.id);
		const revoked = await request.delete(
			`${API_URL}/admin/service-accounts/${other.id}/api-keys/${key.id}`,
		);
		expect(revoked.ok()).toBe(false);
		const api = await keyContext(playwright, key.key);
		try {
			// Still authenticates: refused for lack of a role, not for being revoked.
			expect(await rolesReadStatus(api)).toBe(403);
		} finally {
			await api.dispose();
		}
	});

	test("A key past its expiry is refused", async ({ request, playwright }) => {
		const account = await createServiceAccount(request, name("EXPIRY"));
		const past = new Date(Date.now() - 60_000).toISOString();
		const response = await postServiceAccountKey(
			request,
			account.id,
			"old",
			past,
		);
		if (response.ok()) {
			// The API accepted a past expiry: the key must then not authenticate.
			const key = (await response.json()).data.key as string;
			const api = await keyContext(playwright, key);
			try {
				expect(await rolesReadStatus(api)).toBe(401);
			} finally {
				await api.dispose();
			}
		} else {
			expect(response.status()).toBeLessThan(500);
		}
		const future = new Date(Date.now() + 86_400_000).toISOString();
		const valid = await createServiceAccountKey(
			request,
			account.id,
			"fresh",
			future,
		);
		const api = await keyContext(playwright, valid.key);
		try {
			expect(await rolesReadStatus(api)).toBe(403);
		} finally {
			await api.dispose();
		}
	});

	test("Keys are managed with a session: a key cannot list, mint or revoke keys", async ({
		request,
		playwright,
	}) => {
		const account = await createServiceAccount(request, name("SESSION"));
		// The most powerful key there is: every action on every resource.
		const root = await roleGranting(request, "SESSION", ["*"]);
		expect(
			(await putServiceAccountRoles(request, account.id, [root.id])).ok(),
		).toBe(true);
		const key = await createServiceAccountKey(request, account.id);

		const api = await keyContext(playwright, key.key);
		try {
			// It may manage service accounts...
			expect(
				(await api.get(`${API_URL}/admin/service-accounts`)).status(),
			).toBe(200);
			// ...but never their credentials.
			const base = `${API_URL}/admin/service-accounts/${account.id}/api-keys`;
			expect((await api.get(base)).status()).toBe(403);
			expect((await api.post(base, { data: { name: "more" } })).status()).toBe(
				403,
			);
			expect((await api.delete(`${base}/${key.id}`)).status()).toBe(403);
			// Nor a user's own keys.
			expect(
				(
					await api.post(`${API_URL}/users/me/api-keys`, {
						data: { name: "x" },
					})
				).status(),
			).toBe(403);
		} finally {
			await api.dispose();
		}
	});

	test("Deleting the account kills its keys", async ({
		request,
		playwright,
	}) => {
		const account = await createServiceAccount(request, name("DELKEY"));
		const role = await roleGranting(request, "DELKEY", ["roles:read"]);
		await putServiceAccountRoles(request, account.id, [role.id]);
		const key = await createServiceAccountKey(request, account.id);
		const api = await keyContext(playwright, key.key);
		try {
			expect(await rolesReadStatus(api)).toBe(200);
			await request.delete(`${API_URL}/admin/service-accounts/${account.id}`);
			expect(await rolesReadStatus(api)).toBe(401);
		} finally {
			await api.dispose();
		}
	});
});

test.describe("Service accounts: roles and access", () => {
	test.beforeEach(async ({ request, context }) => {
		await authRequest(request);
		await cleanup(request);
		await context.clearCookies();
	});

	test.afterEach(async ({ request }) => {
		await cleanup(request);
	});

	test("A key is judged by the account's roles, and an edit applies on the next request", async ({
		request,
		playwright,
	}) => {
		const account = await createServiceAccount(request, name("RBAC"));
		const reader = await roleGranting(request, "READER", ["roles:read"]);
		const key = await createServiceAccountKey(request, account.id);
		const api = await keyContext(playwright, key.key);
		try {
			expect(await rolesReadStatus(api)).toBe(403);

			expect(
				(
					await putServiceAccountRoles(request, account.id, [reader.id])
				).status(),
			).toBe(200);
			expect(await rolesReadStatus(api)).toBe(200);

			// The roles are listed on the account and in the roles endpoint.
			const roles = await request.get(
				`${API_URL}/admin/service-accounts/${account.id}/roles`,
			);
			expect(
				((await roles.json()).data as Array<{ id: string }>).map((r) => r.id),
			).toEqual([reader.id]);
			const listed = (await listServiceAccounts(request)).find(
				(a) => a.id === account.id,
			);
			expect(listed?.roles.map((r) => r.name)).toEqual([reader.name]);

			// An explicit Deny from another role beats the Allow.
			const denier = await createGlobalRole(
				request,
				name("ROLE_DENY"),
				policyOf(deny(["roles:read"], ["*"])),
			);
			await putServiceAccountRoles(request, account.id, [reader.id, denier.id]);
			expect(await rolesReadStatus(api)).toBe(403);

			await putServiceAccountRoles(request, account.id, []);
			expect(await rolesReadStatus(api)).toBe(403);
		} finally {
			await api.dispose();
		}
	});

	test("A service account works inside a project only as a member, with the member's roles", async ({
		request,
		playwright,
	}) => {
		const projectId = await createProject(request, name("PROJECT"));
		await createTask(request, projectId, "Visible to members");
		const account = await createServiceAccount(request, name("MEMBER"));
		const key = await createServiceAccountKey(request, account.id);
		const viewer = await projectRoleIdByName(request, projectId, "Viewer");

		const api = await keyContext(playwright, key.key);
		try {
			// Not a member yet: nothing.
			expect((await listTasks(api, projectId)).status).toBe(403);

			const added = await request.post(
				`${API_URL}/projects/${projectId}/members`,
				{ data: { service_account_id: account.id, role_ids: [viewer] } },
			);
			expect(added.status(), await added.text()).toBe(201);
			const member = (await added.json()).data as {
				id: string;
				member_type: string;
				service_account_id: string;
			};
			expect(member.member_type).toBe("service_account");
			expect(member.service_account_id).toBe(account.id);

			const page = await listTasks(api, projectId);
			expect(page.status).toBe(200);
			expect(page.titles).toEqual(["Visible to members"]);

			// Adding it twice is refused.
			const again = await request.post(
				`${API_URL}/projects/${projectId}/members`,
				{ data: { service_account_id: account.id, role_ids: [viewer] } },
			);
			expect(again.ok()).toBe(false);

			// Taking its project roles away takes the access away.
			expect(
				(await putMemberRoles(request, projectId, member.id, [])).ok(),
			).toBe(true);
			expect((await listTasks(api, projectId)).status).toBe(403);
			await putMemberRoles(request, projectId, member.id, [viewer]);
			expect((await listTasks(api, projectId)).status).toBe(200);

			// Deleting the account removes its membership.
			await request.delete(`${API_URL}/admin/service-accounts/${account.id}`);
			// Look the membership up by id rather than scanning a page of the team.
			const members = await request.get(
				`${API_URL}/projects/${projectId}/members?ids=${member.id}`,
			);
			const items = (await members.json()).data.items as Array<{ id: string }>;
			expect(items.map((m) => m.id)).not.toContain(member.id);
		} finally {
			await api.dispose();
		}
	});

	test("A project member request needs exactly one account", async ({
		request,
	}) => {
		const projectId = await createProject(request, name("PROJ_ONE"));
		const account = await createServiceAccount(request, name("ONE"));
		const agent = await createGlobalAgent(request, name("ONEAGENT"), "acp");
		const viewer = await projectRoleIdByName(request, projectId, "Viewer");
		const both = await request.post(
			`${API_URL}/projects/${projectId}/members`,
			{
				data: {
					service_account_id: account.id,
					agent_id: agent.id,
					role_ids: [viewer],
				},
			},
		);
		expect(both.ok()).toBe(false);
		expect(both.status()).toBeLessThan(500);
		const none = await request.post(
			`${API_URL}/projects/${projectId}/members`,
			{
				data: { role_ids: [viewer] },
			},
		);
		expect(none.ok()).toBe(false);
		expect(none.status()).toBeLessThan(500);
	});

	test("service_accounts:read and :write are separate permissions", async ({
		request,
		playwright,
	}) => {
		const account = await createServiceAccount(request, name("PERM"));
		const reader = name("READER");
		const writer = name("WRITER");
		await createUserWithGlobalPermissions(request, playwright, {
			username: reader,
			roleName: name("ROLE_R"),
			permissions: { "projects:read": true, "service_accounts:read": true },
		});
		await createUserWithGlobalPermissions(request, playwright, {
			username: writer,
			roleName: name("ROLE_W"),
			permissions: { "projects:read": true, "service_accounts:write": true },
		});

		await asUser(playwright, reader, async (api) => {
			expect(
				(await api.get(`${API_URL}/admin/service-accounts`)).status(),
			).toBe(200);
			expect(
				(
					await api.get(`${API_URL}/admin/service-accounts/${account.id}`)
				).status(),
			).toBe(200);
			expect(
				(
					await api.get(
						`${API_URL}/admin/service-accounts/${account.id}/api-keys`,
					)
				).status(),
			).toBe(200);
			expect((await postServiceAccount(api, name("NOPE"))).status()).toBe(403);
			expect(
				(await postServiceAccountKey(api, account.id, "no")).status(),
			).toBe(403);
			expect(
				(
					await api.patch(`${API_URL}/admin/service-accounts/${account.id}`, {
						data: { name: "x" },
					})
				).status(),
			).toBe(403);
			expect(
				(
					await api.delete(`${API_URL}/admin/service-accounts/${account.id}`)
				).status(),
			).toBe(403);
		});

		await asUser(playwright, writer, async (api) => {
			expect(
				(await api.get(`${API_URL}/admin/service-accounts`)).status(),
			).toBe(403);
			const created = await postServiceAccount(api, name("BYWRITER"));
			expect(created.status()).toBe(201);
		});

		const anonymous = await playwright.request.newContext();
		try {
			expect(
				(await anonymous.get(`${API_URL}/admin/service-accounts`)).status(),
			).toBe(401);
		} finally {
			await anonymous.dispose();
		}
	});

	test("Minting a key needs the authority to assign every role the account holds", async ({
		request,
		playwright,
	}) => {
		const account = await createServiceAccount(request, name("ESCALATE"));
		const low = await roleGranting(request, "LOW", ["roles:read"]);
		const high = await roleGranting(request, "HIGH", [
			"roles:read",
			"users:read",
		]);

		// A delegate who manages service accounts and may assign only the low role.
		const delegate = name("DELEGATE");
		const delegateRole = await createGlobalRole(
			request,
			name("ROLE_DELEGATE"),
			policyOf(
				allow(["projects:read"], ["*"]),
				allow(
					["service_accounts:read", "service_accounts:write"],
					["service_account/*"],
				),
				allow(["roles:assign"], [`role/${low.id}`]),
			),
		);
		await createUserWithPassword(request, playwright, {
			username: delegate,
			fullName: delegate,
			roles: [delegateRole.name],
		});

		await asUser(playwright, delegate, async (api) => {
			// Holding nothing: a key lends no authority, so the delegate may mint it.
			expect(
				(await postServiceAccountKey(api, account.id, "empty")).status(),
			).toBe(201);
		});

		// The account holds a role the delegate may assign: still allowed.
		await putServiceAccountRoles(request, account.id, [low.id]);
		await asUser(playwright, delegate, async (api) => {
			expect(
				(await postServiceAccountKey(api, account.id, "low")).status(),
			).toBe(201);
		});

		// The account also holds a role the delegate may not assign: refused.
		await putServiceAccountRoles(request, account.id, [low.id, high.id]);
		await asUser(playwright, delegate, async (api) => {
			const refused = await postServiceAccountKey(api, account.id, "high");
			expect(refused.status()).toBe(403);
			expect(await errorCode(refused)).toBe("FORBIDDEN");
		});

		// An administrator holding roles:assign on everything may.
		expect(
			(await postServiceAccountKey(request, account.id, "admin")).status(),
		).toBe(201);
	});
});
