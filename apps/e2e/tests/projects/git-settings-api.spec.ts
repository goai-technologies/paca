// spec: features/projects/git-settings-api.feature
// seed: tests/seed.spec.ts

import { type APIRequestContext, expect, test } from "@playwright/test";
import {
	API_URL,
	authRequest,
	cleanupProjectsByPrefix,
	createProject,
	createProjectAgent,
	newRunId,
} from "../helpers/e2e-api";
import { gitUrl } from "../helpers/git";
import { dataOf, errorCode } from "../helpers/iam";

const PREFIX = "E2E_GITSAPI_";
const RUN_ID = newRunId();
const name = (label: string) => `${PREFIX}${label}_${RUN_ID}`;

interface Settings {
	default_responder_agent_id: string | null;
	paused: boolean;
	min_actor_permission: string;
}

const getSettings = async (api: APIRequestContext, projectId: string) =>
	dataOf<Settings>(await api.get(gitUrl(projectId, "/settings")));

test.describe("Project Git settings API", () => {
	let projectId: string;

	test.beforeAll(async ({ request }) => {
		await authRequest(request);
		await cleanupProjectsByPrefix(request, PREFIX);
	});

	test.beforeEach(async ({ request }) => {
		await authRequest(request);
		projectId = await createProject(request, name("PROJECT"));
	});

	test.afterAll(async ({ request }) => {
		await authRequest(request);
		await cleanupProjectsByPrefix(request, PREFIX);
	});

	test("A new project has the default policy", async ({ request }) => {
		expect(await getSettings(request, projectId)).toEqual({
			default_responder_agent_id: null,
			paused: false,
			min_actor_permission: "write",
		});
		expect(
			await dataOf<unknown[]>(await request.get(gitUrl(projectId, "/runs"))),
		).toEqual([]);
		expect(
			await dataOf<unknown[]>(
				await request.get(gitUrl(projectId, "/providers")),
			),
		).toEqual([]);
		expect(
			await dataOf<unknown[]>(
				await request.get(gitUrl(projectId, "/repositories")),
			),
		).toEqual([]);
	});

	test("Settings round-trip", async ({ request }) => {
		const saved = await request.put(gitUrl(projectId, "/settings"), {
			data: { paused: true, min_actor_permission: "admin" },
		});
		expect(saved.status()).toBe(200);
		expect(await dataOf<Settings>(saved)).toMatchObject({
			paused: true,
			min_actor_permission: "admin",
		});
		expect(await getSettings(request, projectId)).toMatchObject({
			paused: true,
			min_actor_permission: "admin",
		});
	});

	test("A save replaces the whole policy: what it omits goes back to the default", async ({
		request,
	}) => {
		await request.put(gitUrl(projectId, "/settings"), {
			data: { paused: true, min_actor_permission: "admin" },
		});
		await request.put(gitUrl(projectId, "/settings"), {
			data: { paused: false },
		});
		expect(await getSettings(request, projectId)).toEqual({
			default_responder_agent_id: null,
			paused: false,
			min_actor_permission: "write",
		});
	});

	for (const level of ["read", "triage", "write", "maintain", "admin"]) {
		test(`The minimum permission "${level}" is accepted`, async ({
			request,
		}) => {
			const response = await request.put(gitUrl(projectId, "/settings"), {
				data: { min_actor_permission: level },
			});
			expect(response.status()).toBe(200);
			expect((await getSettings(request, projectId)).min_actor_permission).toBe(
				level,
			);
		});
	}

	test("An unknown minimum permission is a 400 and changes nothing", async ({
		request,
	}) => {
		const response = await request.put(gitUrl(projectId, "/settings"), {
			data: { min_actor_permission: "root" },
		});
		expect(response.status()).toBe(400);
		expect(await errorCode(response)).toBe("BAD_REQUEST");
		expect((await getSettings(request, projectId)).min_actor_permission).toBe(
			"write",
		);
	});

	test("The default responder must be an agent of this project", async ({
		request,
	}) => {
		const own = await createProjectAgent(request, projectId, name("OWNAGENT"));
		const otherId = await createProject(request, name("OTHER"));
		const foreign = await createProjectAgent(
			request,
			otherId,
			name("FOREIGNAGENT"),
		);

		const accepted = await request.put(gitUrl(projectId, "/settings"), {
			data: { default_responder_agent_id: own.id },
		});
		expect(accepted.status()).toBe(200);
		expect(
			(await getSettings(request, projectId)).default_responder_agent_id,
		).toBe(own.id);

		const rejected = await request.put(gitUrl(projectId, "/settings"), {
			data: { default_responder_agent_id: foreign.id },
		});
		expect(rejected.status()).toBe(400);
		expect(
			(await getSettings(request, projectId)).default_responder_agent_id,
		).toBe(own.id);

		const cleared = await request.put(gitUrl(projectId, "/settings"), {
			data: { default_responder_agent_id: null },
		});
		expect(cleared.status()).toBe(200);
		expect(
			(await getSettings(request, projectId)).default_responder_agent_id,
		).toBeNull();
	});

	test("Projects do not share settings", async ({ request }) => {
		const otherId = await createProject(request, name("SEPARATE"));
		await request.put(gitUrl(projectId, "/settings"), {
			data: { paused: true },
		});
		expect((await getSettings(request, otherId)).paused).toBe(false);
	});

	test("A malformed body is a 400", async ({ request }) => {
		const response = await request.put(gitUrl(projectId, "/settings"), {
			headers: { "content-type": "application/json" },
			data: "{not json",
		});
		expect(response.status()).toBe(400);
	});

	test("Saving settings for a project that does not exist is a 404, not a 500", async ({
		request,
	}) => {
		const response = await request.put(
			`${API_URL}/projects/00000000-0000-4000-8000-0000000000ff/git/settings`,
			{ data: { paused: true } },
		);
		expect(response.status()).toBe(404);
		expect(await errorCode(response)).toBe("GIT_NOT_FOUND");
	});
});
