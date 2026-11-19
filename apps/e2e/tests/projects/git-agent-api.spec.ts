// spec: features/projects/git-agent-api.feature
// seed: tests/seed.spec.ts

import { type APIRequestContext, expect, test } from "@playwright/test";
import {
	API_URL,
	assignGlobalRoles,
	authRequest,
	cleanupGlobalRolesByPrefix,
	cleanupProjectsByPrefix,
	cleanupUsersByPrefix,
	createGlobalRole,
	createProject,
	createProjectAgent,
	newRunId,
} from "../helpers/e2e-api";
import { anonymous, memberWith, refused } from "../helpers/git";
import { allow, asUser, dataOf, errorCode, policyOf } from "../helpers/iam";

const PREFIX = "E2E_GITAGENT_";
const RUN_ID = newRunId();

interface Trigger {
	kind: string;
	enabled: boolean;
	explicit: boolean;
	supported: boolean;
}

async function cleanup(request: APIRequestContext) {
	await cleanupProjectsByPrefix(request, PREFIX);
	await cleanupUsersByPrefix(request, PREFIX);
	await cleanupGlobalRolesByPrefix(request, PREFIX);
}

test.describe("Agent Git API", () => {
	test.describe.configure({ mode: "serial" });
	let projectId: string;
	let agentId: string;
	const users = new Map<string, string>();

	const agentUrl = (path = "") =>
		`${API_URL}/projects/${projectId}/agents/${agentId}/git${path}`;

	test.beforeAll(async ({ request, playwright }) => {
		await authRequest(request);
		await cleanup(request);
		projectId = await createProject(request, `${PREFIX}PROJECT_${RUN_ID}`);
		agentId = (
			await createProjectAgent(request, projectId, `${PREFIX}AGENT_${RUN_ID}`)
		).id;

		const defs: Record<string, { project: string[]; workspace: string[] }> = {
			READER: { project: ["agents:read"], workspace: [] },
			WRITER: { project: ["agents:read", "agents:write"], workspace: [] },
			WRITERGIT: {
				project: ["agents:read", "agents:write", "git:write"],
				workspace: [],
			},
			MANAGER: {
				project: ["agents:read", "agents:write"],
				workspace: ["git.identities:manage"],
			},
			NOTHING: { project: [], workspace: [] },
		};
		for (const [label, d] of Object.entries(defs)) {
			const member = await memberWith(
				request,
				playwright,
				projectId,
				PREFIX,
				RUN_ID,
				label,
				d.project,
			);
			if (d.workspace.length > 0) {
				const roleName = `${PREFIX}WS_${label}_${RUN_ID}`;
				await createGlobalRole(
					request,
					roleName,
					policyOf(allow(d.workspace, ["git_identity/*"])),
				);
				await assignGlobalRoles(request, member.userId, [roleName]);
			}
			users.set(label, member.username);
		}
		// A member holding both agents:write + git:write + the workspace action.
		const all = await memberWith(
			request,
			playwright,
			projectId,
			PREFIX,
			RUN_ID,
			"ALL",
			["agents:read", "agents:write", "git:write"],
		);
		const roleName = `${PREFIX}WS_ALL_${RUN_ID}`;
		await createGlobalRole(
			request,
			roleName,
			policyOf(allow(["git.identities:manage"], ["git_identity/*"])),
		);
		await assignGlobalRoles(request, all.userId, [roleName]);
		users.set("ALL", all.username);
	});

	test.afterAll(async ({ request }) => {
		await authRequest(request);
		await cleanup(request);
	});

	test("A new agent has the default triggers", async ({ request }) => {
		await authRequest(request);
		const triggers = await dataOf<Trigger[]>(
			await request.get(agentUrl("/triggers")),
		);
		expect(triggers.map((t) => t.kind)).toEqual(
			expect.arrayContaining([
				"mention",
				"own_cr_feedback",
				"ci_failure",
				"review_request",
				"assignment",
				"auto_review",
			]),
		);
		for (const t of triggers) {
			expect(t.explicit, t.kind).toBe(false);
			expect(t.supported, t.kind).toBe(false);
			expect(t.enabled, t.kind).toBe(t.kind === "auto_review" ? false : true);
		}
		expect(
			await dataOf<unknown[]>(await request.get(agentUrl("/identity"))),
		).toEqual([]);
	});

	test("Switching a trigger is remembered as an explicit choice", async ({
		request,
	}) => {
		await authRequest(request);
		const off = await request.put(agentUrl("/triggers/mention"), {
			data: { enabled: false },
		});
		expect(off.status()).toBe(200);
		const after = await dataOf<Trigger[]>(off);
		expect(after.find((t) => t.kind === "mention")).toMatchObject({
			enabled: false,
			explicit: true,
		});
		expect(after.find((t) => t.kind === "ci_failure")).toMatchObject({
			enabled: true,
			explicit: false,
		});

		const on = await request.put(agentUrl("/triggers/mention"), {
			data: { enabled: true },
		});
		expect(
			(await dataOf<Trigger[]>(on)).find((t) => t.kind === "mention"),
		).toMatchObject({ enabled: true, explicit: true });

		const stored = await dataOf<Trigger[]>(
			await request.get(agentUrl("/triggers")),
		);
		expect(stored.find((t) => t.kind === "mention")).toMatchObject({
			enabled: true,
			explicit: true,
		});
	});

	test("auto_review can be switched on", async ({ request }) => {
		await authRequest(request);
		const response = await request.put(agentUrl("/triggers/auto_review"), {
			data: { enabled: true },
		});
		expect(response.status()).toBe(200);
		expect(
			(await dataOf<Trigger[]>(response)).find((t) => t.kind === "auto_review"),
		).toMatchObject({ enabled: true, explicit: true });
	});

	test("An unknown trigger kind is a 400", async ({ request }) => {
		await authRequest(request);
		const response = await request.put(agentUrl("/triggers/bogus"), {
			data: { enabled: true },
		});
		expect(response.status()).toBe(400);
		expect(await errorCode(response)).toBe("BAD_REQUEST");
	});

	test("Triggers of an agent of another project are not reachable", async ({
		request,
	}) => {
		await authRequest(request);
		const otherId = await createProject(request, `${PREFIX}OTHER_${RUN_ID}`);
		const response = await request.get(
			`${API_URL}/projects/${otherId}/agents/${agentId}/git/triggers`,
		);
		expect([403, 404]).toContain(response.status());
	});

	const ROUTES: Array<{
		name: string;
		method: "GET" | "PUT" | "POST" | "DELETE";
		path: string;
		holders: string[];
	}> = [
		{
			name: "GET triggers",
			method: "GET",
			path: "/triggers",
			holders: ["READER", "WRITER", "WRITERGIT", "MANAGER", "ALL"],
		},
		{
			name: "PUT trigger",
			method: "PUT",
			path: "/triggers/mention",
			holders: ["WRITER", "WRITERGIT", "MANAGER", "ALL"],
		},
		{
			name: "GET identity",
			method: "GET",
			path: "/identity",
			holders: ["READER", "WRITER", "WRITERGIT", "MANAGER", "ALL"],
		},
		{
			name: "POST identity/setup",
			method: "POST",
			path: "/identity/setup",
			holders: ["MANAGER", "ALL"],
		},
		{
			name: "DELETE identity",
			method: "DELETE",
			path: "/identity",
			holders: ["MANAGER", "ALL"],
		},
		{
			name: "POST identity/access/begin",
			method: "POST",
			path: "/identity/access/begin",
			holders: ["WRITERGIT", "ALL"],
		},
	];

	for (const route of ROUTES) {
		test(`${route.name} is open to its holders only`, async ({
			playwright,
		}) => {
			const send = (api: APIRequestContext) =>
				api.fetch(agentUrl(route.path), {
					method: route.method,
					...(route.method === "GET" || route.method === "DELETE"
						? {}
						: { data: route.method === "PUT" ? { enabled: true } : {} }),
				});
			for (const [label, username] of users) {
				await asUser(playwright, username, async (api) => {
					const response = await send(api);
					expect(refused(response), `${label}: ${response.status()}`).toBe(
						!route.holders.includes(label),
					);
				});
			}
			await anonymous(playwright, async (api) => {
				expect((await send(api)).status()).toBe(401);
			});
		});
	}

	test("Identity setup without a provider plugin is a 503 GIT_PROVIDER_UNAVAILABLE", async ({
		request,
	}) => {
		await authRequest(request);
		const response = await request.post(agentUrl("/identity/setup"), {
			data: { provider_id: "com.example.none", host: "git.example.test" },
		});
		expect(response.status()).toBe(503);
		expect(await errorCode(response)).toBe("GIT_PROVIDER_UNAVAILABLE");
	});
});
