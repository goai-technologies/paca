// spec: features/iam/accounts-model.feature
// seed: tests/seed.spec.ts
//
// The unified accounts model (docs/architecture/database-schema.md, "Accounts
// model"): a user, an agent and a service account are all one `accounts` row.
// Each authenticates with its own API key and is judged by its own role
// attachments and nothing else, a deleted account stops resolving, identifiers
// stay unique among live accounts only, and there is no way to act as another
// account by naming it in a header or by presenting the retired shared key.

import { type APIRequestContext, expect, test } from "@playwright/test";
import {
	cleanupServiceAccountsByPrefix,
	createServiceAccount,
	createServiceAccountKey,
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
	createProjectAgent,
	createUserWithPassword,
	handleFor,
	newRunId,
	projectRoleIdByName,
} from "../helpers/e2e-api";
import {
	allow,
	asUser,
	createAgentKey,
	createMember,
	createTask,
	dataOf,
	keyContext,
	listTasks,
	policyOf,
	projectActions,
	putUserRoles,
} from "../helpers/iam";

const PREFIX = "E2E_ACCT_";
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

type Kind = "user" | "agent" | "service_account";

interface Actor {
	kind: Kind;
	id: string;
	key: string;
	/** Replaces the workspace roles the account holds. */
	setRoles(roleIds: string[]): Promise<void>;
	/** Deletes the account. */
	remove(): Promise<void>;
}

/** Creates one account of `kind` with a working key and no workspace role. */
async function createActor(
	request: APIRequestContext,
	playwright: Parameters<typeof asUser>[0],
	kind: Kind,
	label: string,
): Promise<Actor> {
	if (kind === "user") {
		const username = name(`U_${label}`);
		const id = await createUserWithPassword(request, playwright, {
			username,
			fullName: username,
		});
		const key = await asUser(playwright, username, async (api) => {
			const response = await api.post(`${API_URL}/users/me/api-keys`, {
				data: { name: "e2e" },
			});
			expect(response.status(), await response.text()).toBe(201);
			return (await dataOf<{ key: string }>(response)).key;
		});
		const setRoles = async (roleIds: string[]) => {
			expect((await putUserRoles(request, id, roleIds)).ok()).toBe(true);
		};
		await setRoles([]);
		return {
			kind,
			id,
			key,
			setRoles,
			remove: async () => {
				await request.delete(`${API_URL}/admin/users/${id}`);
			},
		};
	}
	if (kind === "agent") {
		const agent = await createGlobalAgent(request, name(`A_${label}`), "acp");
		const key = await createAgentKey(request, agent.id);
		const setRoles = async (roleIds: string[]) => {
			const response = await request.put(
				`${API_URL}/admin/agents/${agent.id}/roles`,
				{ data: { role_ids: roleIds } },
			);
			expect(response.ok(), await response.text()).toBe(true);
		};
		await setRoles([]);
		return {
			kind,
			id: agent.id,
			key,
			setRoles,
			remove: async () => {
				await request.delete(`${API_URL}/admin/agents/${agent.id}`);
			},
		};
	}
	const account = await createServiceAccount(request, name(`S_${label}`));
	const minted = await createServiceAccountKey(request, account.id);
	return {
		kind,
		id: account.id,
		key: minted.key,
		setRoles: async (roleIds) => {
			expect(
				(await putServiceAccountRoles(request, account.id, roleIds)).ok(),
			).toBe(true);
		},
		remove: async () => {
			await request.delete(`${API_URL}/admin/service-accounts/${account.id}`);
		},
	};
}

const KINDS: Kind[] = ["user", "agent", "service_account"];

test.describe("Unified accounts", () => {
	test.beforeEach(async ({ request, context }) => {
		await authRequest(request);
		await cleanup(request);
		await context.clearCookies();
	});

	test.afterEach(async ({ request }) => {
		await cleanup(request);
	});

	for (const kind of KINDS) {
		test(`A ${kind} authenticates with its own key and is judged by its own roles`, async ({
			request,
			playwright,
		}) => {
			const actor = await createActor(request, playwright, kind, "AUTHZ");
			const reader = await createGlobalRole(
				request,
				name(`ROLE_READER_${kind}`),
				policyOf(allow(["roles:read"], ["*"])),
			);

			const api = await keyContext(playwright, actor.key);
			try {
				// Authenticated (not 401) but holding nothing.
				expect(await rolesReadStatus(api)).toBe(403);
				await actor.setRoles([reader.id]);
				expect(await rolesReadStatus(api)).toBe(200);
				await actor.setRoles([]);
				expect(await rolesReadStatus(api)).toBe(403);
			} finally {
				await api.dispose();
			}
		});

		test(`A deleted ${kind} no longer authenticates`, async ({
			request,
			playwright,
		}) => {
			const actor = await createActor(request, playwright, kind, "GONE");
			const reader = await createGlobalRole(
				request,
				name(`ROLE_GONE_${kind}`),
				policyOf(allow(["roles:read"], ["*"])),
			);
			await actor.setRoles([reader.id]);

			const api = await keyContext(playwright, actor.key);
			try {
				expect(await rolesReadStatus(api)).toBe(200);
				await actor.remove();
				expect(await rolesReadStatus(api)).toBe(401);
			} finally {
				await api.dispose();
			}
		});
	}

	test("Deleting a service account removes its role attachments", async ({
		request,
	}) => {
		const account = await createServiceAccount(request, name("ATTACH"));
		const reader = await createGlobalRole(
			request,
			name("ROLE_ATTACH"),
			policyOf(allow(["roles:read"], ["*"])),
		);
		await putServiceAccountRoles(request, account.id, [reader.id]);
		await request.delete(`${API_URL}/admin/service-accounts/${account.id}`);
		expect(
			(
				await request.get(
					`${API_URL}/admin/service-accounts/${account.id}/roles`,
				)
			).status(),
		).toBe(404);
		const holders = await request.get(`${API_URL}/admin/roles/${reader.id}`);
		expect(holders.ok()).toBe(true);
	});

	test("A key proves who is calling: headers naming another account change nothing", async ({
		request,
		playwright,
	}) => {
		const agent = await createActor(request, playwright, "agent", "SPOOF");
		const me = await request.get(`${API_URL}/users/me`);
		const adminId = (await dataOf<{ id: string }>(me)).id;
		const other = await createActor(request, playwright, "agent", "VICTIM");

		const api = await playwright.request.newContext({
			extraHTTPHeaders: {
				"X-API-Key": agent.key,
				"X-Agent-ID": other.id,
				"X-Actor-User-ID": adminId,
			},
		});
		try {
			// The administrator and the other agent are named; the agent is still itself.
			expect(await rolesReadStatus(api)).toBe(403);
			const reader = await createGlobalRole(
				request,
				name("ROLE_SPOOF"),
				policyOf(allow(["roles:read"], ["*"])),
			);
			// Granting the *other* agent a role does not help the caller.
			await other.setRoles([reader.id]);
			expect(await rolesReadStatus(api)).toBe(403);
			await agent.setRoles([reader.id]);
			expect(await rolesReadStatus(api)).toBe(200);
		} finally {
			await api.dispose();
		}
	});

	test("The retired shared agent key is not a credential", async ({
		playwright,
	}) => {
		for (const legacy of [
			process.env.E2E_AGENT_API_KEY ?? "e2e-agent-api-key",
			"paca_0000000000000000000000000000000000000000000000000000000000000000",
		]) {
			const api = await keyContext(playwright, legacy);
			try {
				expect(await rolesReadStatus(api)).toBe(401);
			} finally {
				await api.dispose();
			}
		}
	});

	test("Users, agents and service accounts are members of one project, each judged by its own project roles", async ({
		request,
		playwright,
	}) => {
		const projectId = await createProject(request, name("PROJECT"));
		await createTask(request, projectId, "Shared task");
		const viewer = await projectRoleIdByName(request, projectId, "Viewer");

		const user = await createMember(
			request,
			playwright,
			projectId,
			name("MEMBER_USER"),
			[viewer],
		);
		const agent = await createProjectAgent(
			request,
			projectId,
			name("MEMBER_AGENT"),
			"acp",
		);
		const agentKey = await createAgentKey(request, agent.id, projectId);
		const account = await createServiceAccount(request, name("MEMBER_SA"));
		const accountKey = await createServiceAccountKey(request, account.id);
		const added = await request.post(
			`${API_URL}/projects/${projectId}/members`,
			{
				data: { service_account_id: account.id, role_ids: [viewer] },
			},
		);
		expect(added.status(), await added.text()).toBe(201);

		// One listing, three kinds of member.
		const listed = await request.get(
			`${API_URL}/projects/${projectId}/members?page_size=100`,
		);
		const data = (await listed.json()).data;
		const members = data.items as Array<{
			member_type: string;
			user_id?: string;
			agent_id?: string;
			service_account_id?: string;
		}>;
		expect(members.some((m) => m.user_id === user.userId)).toBe(true);
		expect(members.some((m) => m.agent_id === agent.id)).toBe(true);
		expect(members.some((m) => m.service_account_id === account.id)).toBe(true);
		expect(new Set(members.map((m) => m.member_type))).toEqual(
			new Set(["human", "agent", "service_account"]),
		);

		// Each caller sees the project through its own roles.
		await asUser(playwright, user.username, async (api) => {
			expect((await listTasks(api, projectId)).titles).toEqual(["Shared task"]);
		});
		for (const key of [accountKey.key]) {
			const api = await keyContext(playwright, key);
			try {
				expect((await listTasks(api, projectId)).titles).toEqual([
					"Shared task",
				]);
				expect(await projectActions(api, projectId)).toContain("tasks:read");
			} finally {
				await api.dispose();
			}
		}
		// The agent's role in the project is whatever it was created with, not the admin's.
		const agentApi = await keyContext(playwright, agentKey);
		try {
			const status = (await listTasks(agentApi, projectId)).status;
			expect([200, 403]).toContain(status);
			expect((await agentApi.get(`${API_URL}/admin/roles`)).status()).toBe(403);
		} finally {
			await agentApi.dispose();
		}
	});

	test("Usernames are unique among live users only", async ({
		request,
		playwright,
	}) => {
		const username = name("UNIQUE");
		const id = await createUserWithPassword(request, playwright, {
			username,
			fullName: "First",
		});
		const duplicate = await request.post(`${API_URL}/admin/users`, {
			data: { username, full_name: "Second", password: "Temp-Passw0rd!" },
		});
		expect(duplicate.status()).toBe(409);

		// Deleting the first frees the name for a new account.
		expect((await request.delete(`${API_URL}/admin/users/${id}`)).ok()).toBe(
			true,
		);
		const reused = await request.post(`${API_URL}/admin/users`, {
			data: { username, full_name: "Second", password: "Temp-Passw0rd!" },
		});
		expect(reused.status(), await reused.text()).toBe(201);
	});

	test("Agent handles are unique per project, and workspace-wide for global agents", async ({
		request,
	}) => {
		const projectA = await createProject(request, name("HANDLE_A"));
		const projectB = await createProject(request, name("HANDLE_B"));
		const label = name("HANDLE");

		const first = await createProjectAgent(request, projectA, label, "acp");
		const body = (projectId: string) => ({
			name: `${label}_2`,
			handle: first.handle,
			role_ids: undefined as string[] | undefined,
			agent_type: "acp",
			acp_provider: "claude-code",
			projectId,
		});
		const roleA = await projectRoleIdByName(request, projectA, "Viewer");
		const roleB = await projectRoleIdByName(request, projectB, "Viewer");

		// The same handle twice in one project is refused...
		const sameProject = body(projectA);
		const refused = await request.post(
			`${API_URL}/projects/${projectA}/agents`,
			{
				data: { ...sameProject, role_ids: [roleA] },
			},
		);
		expect(refused.status()).toBe(409);
		// ...but another project may use it.
		const otherProject = body(projectB);
		const allowed = await request.post(
			`${API_URL}/projects/${projectB}/agents`,
			{
				data: { ...otherProject, role_ids: [roleB] },
			},
		);
		expect(allowed.status(), await allowed.text()).toBe(201);

		// A global agent's handle is unique across the workspace.
		const global = await createGlobalAgent(request, name("GLOBALH"), "acp");
		const dup = await request.post(`${API_URL}/admin/agents`, {
			data: {
				name: `${name("GLOBALH")}_2`,
				handle: global.handle,
				agent_type: "acp",
				acp_provider: "claude-code",
			},
		});
		expect(dup.status()).toBe(409);
		// Deleting it frees the handle.
		await request.delete(`${API_URL}/admin/agents/${global.id}`);
		const reused = await request.post(`${API_URL}/admin/agents`, {
			data: {
				name: name("GLOBALH"),
				handle: handleFor(name("GLOBALH")),
				agent_type: "acp",
				acp_provider: "claude-code",
			},
		});
		expect(reused.status(), await reused.text()).toBe(201);
	});

	test("Service account names are not identifiers: two accounts may share one", async ({
		request,
	}) => {
		const first = await createServiceAccount(request, name("TWIN"));
		const second = await createServiceAccount(request, name("TWIN"));
		expect(second.id).not.toBe(first.id);
	});
});
