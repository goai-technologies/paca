// spec: features/projects/git-task-links.feature
// seed: tests/seed.spec.ts

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
import { anonymous, memberWith, REPOSITORY, refused } from "../helpers/git";
import { asUser, createTask, dataOf, errorCode } from "../helpers/iam";

const PREFIX = "E2E_GITTASK_";
const RUN_ID = newRunId();

type Method = "GET" | "POST" | "DELETE";

async function cleanup(request: APIRequestContext) {
	await cleanupProjectsByPrefix(request, PREFIX);
	await cleanupUsersByPrefix(request, PREFIX);
	await cleanupGlobalRolesByPrefix(request, PREFIX);
}

test.describe("Task Git links API", () => {
	test.describe.configure({ mode: "serial" });
	let projectId: string;
	let taskId: string;
	const users = new Map<string, string>();

	const base = () => `${API_URL}/projects/${projectId}/tasks/${taskId}/git`;
	const body = (extra: object = {}) => ({
		repository_id: REPOSITORY,
		number: "1",
		branch: "feature/x",
		...extra,
	});
	const query = `repository_id=${REPOSITORY}&branch=feature/x`;

	const ROUTES: Array<{
		method: Method;
		path: string;
		needs: string[];
		send: () => object | undefined;
	}> = [
		{ method: "GET", path: "", needs: ["tasks:read"], send: () => undefined },
		{
			method: "POST",
			path: "/change-requests",
			needs: ["tasks:write", "git:read"],
			send: () => body(),
		},
		{
			method: "DELETE",
			path: `/change-requests/1?repository_id=${REPOSITORY}`,
			needs: ["tasks:write", "git:read"],
			send: () => undefined,
		},
		{
			method: "POST",
			path: "/branches",
			needs: ["tasks:write", "git:read"],
			send: () => body(),
		},
		{
			method: "DELETE",
			path: `/branches?${query}`,
			needs: ["tasks:write", "git:read"],
			send: () => undefined,
		},
		{
			method: "POST",
			path: "/branches/new",
			needs: ["tasks:write", "git:write"],
			send: () => body(),
		},
	];

	const call = (api: APIRequestContext, route: (typeof ROUTES)[number]) =>
		api.fetch(`${base()}${route.path}`, {
			method: route.method,
			...(route.send() ? { data: route.send() } : {}),
		});

	test.beforeAll(async ({ request, playwright }) => {
		await authRequest(request);
		await cleanup(request);
		projectId = await createProject(request, `${PREFIX}PROJECT_${RUN_ID}`);
		taskId = await createTask(request, projectId, "Linked work");
		const members: Record<string, string[]> = {
			FULL: ["tasks:read", "tasks:write", "git:read", "git:write"],
			NOGIT: ["tasks:read", "tasks:write"],
			READONLY: ["tasks:read", "git:read", "git:write"],
			NOWRITEGIT: ["tasks:read", "tasks:write", "git:read"],
		};
		for (const [label, actions] of Object.entries(members)) {
			const m = await memberWith(
				request,
				playwright,
				projectId,
				PREFIX,
				RUN_ID,
				label,
				actions,
			);
			users.set(label, m.username);
		}
	});

	test.afterAll(async ({ request }) => {
		await authRequest(request);
		await cleanup(request);
	});

	test("A task with nothing linked", async ({ request }) => {
		await authRequest(request);
		const response = await request.get(base());
		expect(response.status()).toBe(200);
		expect(await dataOf(response)).toEqual({
			change_requests: [],
			branches: [],
		});
	});

	for (const route of ROUTES) {
		test(`${route.method} /git${route.path.split("?")[0]} needs ${route.needs.join(" + ")}`, async ({
			playwright,
		}) => {
			const holders: Record<string, boolean> = {
				FULL: true,
				NOGIT: route.needs.every((n) => n.startsWith("tasks")),
				READONLY: route.needs.every(
					(n) => n === "tasks:read" || n.startsWith("git"),
				),
				NOWRITEGIT: route.needs.every((n) => n !== "git:write"),
			};
			for (const [label, allowed] of Object.entries(holders)) {
				await asUser(playwright, users.get(label) ?? "", async (api) => {
					const response = await call(api, route);
					expect(refused(response), `${label}: ${response.status()}`).toBe(
						!allowed,
					);
				});
			}
			await anonymous(playwright, async (api) => {
				expect((await call(api, route)).status()).toBe(401);
			});
		});
	}

	test("A repository that is not linked to the project is not found", async ({
		request,
	}) => {
		await authRequest(request);
		for (const route of ROUTES.slice(1)) {
			const response = await call(request, route);
			expect(response.status(), `${route.method} ${route.path}`).toBe(404);
			expect(await errorCode(response)).toBe("GIT_NOT_FOUND");
		}
	});

	test("A link request must say what it links", async ({ request }) => {
		await authRequest(request);
		const response = await request.post(`${base()}/change-requests`, {
			data: { repository_id: REPOSITORY },
		});
		expect(response.status()).toBe(400);
		expect(await errorCode(response)).toBe("BAD_REQUEST");
	});

	test("A task of another project is not reachable through this one", async ({
		request,
	}) => {
		await authRequest(request);
		const otherId = await createProject(request, `${PREFIX}OTHER_${RUN_ID}`);
		const otherTask = await createTask(request, otherId, "Elsewhere");
		const response = await request.get(
			`${API_URL}/projects/${projectId}/tasks/${otherTask}/git`,
		);
		expect(response.status()).toBe(404);
		expect(await errorCode(response)).toBe("GIT_NOT_FOUND");
	});
});
