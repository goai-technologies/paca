// spec: features/iam/condition-operators.feature
// seed: tests/seed.spec.ts
//
// Every condition operator and attribute, enforced end to end
// (docs/architecture/authorization.md, "Conditions"): In / NotIn / StringLike
// on task attributes, the multi-valued task.assignee_id, principal.id and
// principal.type, AND across the conditions of one statement, a Deny with a
// condition, how an absent attribute treats negated operators, and what is
// refused when the policy is saved.
//
// scoped-access.spec.ts covers StringEquals / StringNotEquals on sprints,
// views and folders; this file covers the rest of the language. The admin sets
// everything up over the API; the limited member signs in as themselves, so
// each request is judged against their own roles.

import { type APIRequestContext, expect, test } from "@playwright/test";
import {
	API_URL,
	authRequest,
	cleanupProjectsByPrefix,
	cleanupUsersByPrefix,
	createProject,
	newRunId,
} from "../helpers/e2e-api";
import {
	allow,
	asUser,
	createMember,
	createSprint,
	dataOf,
	deny,
	errorCode,
	listAllTaskTitles,
	listTasks,
	openProject,
	policyIssues,
	policyOf,
	postProjectRole,
	projectRoleFrom,
	putMemberRoles,
} from "../helpers/iam";

const PREFIX = "E2E_IAMCOND_";
const RUN_ID = newRunId();
const name = (label: string) => `${PREFIX}${label}_${RUN_ID}`;

async function cleanup(request: APIRequestContext) {
	await cleanupProjectsByPrefix(request, PREFIX);
	await cleanupUsersByPrefix(request, PREFIX);
}

const taskUrl = (projectId: string, taskId: string) =>
	`${API_URL}/projects/${projectId}/tasks/${taskId}`;

/** The status the project starts tasks in, and a "done" one. */
async function statusIds(request: APIRequestContext, projectId: string) {
	const { items } = await dataOf<{
		items: Array<{ id: string; category: string }>;
	}>(await request.get(`${API_URL}/projects/${projectId}/task-statuses`));
	const done = items.find((s) => s.category === "done")?.id ?? "";
	const open = items.find((s) => s.category !== "done")?.id ?? "";
	expect(done, "the project has a done status").not.toBe("");
	expect(open, "the project has an open status").not.toBe("");
	return { done, open };
}

/** Creates a task with the given body fields and returns its id. */
async function makeTask(
	request: APIRequestContext,
	projectId: string,
	title: string,
	fields: Record<string, unknown> = {},
): Promise<string> {
	const response = await request.post(
		`${API_URL}/projects/${projectId}/tasks`,
		{
			data: { title, ...fields },
		},
	);
	expect(response.ok(), await response.text()).toBeTruthy();
	return (await dataOf<{ id: string }>(response)).id;
}

test.describe("Operators on task attributes", () => {
	let projectId: string;
	let sprint1: string;
	let sprint2: string;
	let doneStatus: string;
	let openStatus: string;
	// Tasks: t1 = S1/open, t2 = S1/done, t3 = S2/open, t4 = no sprint/open.
	let t1: string;
	let t2: string;
	let t3: string;
	let t4: string;

	test.beforeEach(async ({ request, context }) => {
		await authRequest(request);
		await cleanup(request);
		await context.clearCookies();
		projectId = await createProject(request, name("PROJECT"));
		sprint1 = await createSprint(request, projectId, name("S1"));
		sprint2 = await createSprint(request, projectId, name("S2"));
		({ done: doneStatus, open: openStatus } = await statusIds(
			request,
			projectId,
		));
		t1 = await makeTask(request, projectId, "T1 S1 open", {
			sprint_id: sprint1,
			status_id: openStatus,
		});
		t2 = await makeTask(request, projectId, "T2 S1 done", {
			sprint_id: sprint1,
			status_id: doneStatus,
		});
		t3 = await makeTask(request, projectId, "T3 S2 open", {
			sprint_id: sprint2,
			status_id: openStatus,
		});
		t4 = await makeTask(request, projectId, "T4 backlog open", {
			status_id: openStatus,
		});
	});

	test.afterEach(async ({ request }) => {
		await authRequest(request);
		await cleanup(request);
	});

	/** A member whose only role reads tasks under `conditions`. */
	async function memberReading(
		request: APIRequestContext,
		playwright: Parameters<typeof createMember>[1],
		label: string,
		conditions: Record<string, Record<string, unknown>>,
	) {
		const role = await projectRoleFrom(
			request,
			projectId,
			name(`${label}_ROLE`),
			openProject(projectId, ["tasks:read"]),
			allow(["tasks:read"], [`project/${projectId}/task/*`], conditions),
		);
		return createMember(request, playwright, projectId, name(`${label}_USER`), [
			role,
		]);
	}

	test("In: tasks whose attribute is any of the listed values", async ({
		request,
		playwright,
	}) => {
		const member = await memberReading(request, playwright, "IN", {
			In: { "task.sprint_id": [sprint1, sprint2] },
		});
		await asUser(playwright, member.username, async (api) => {
			expect((await listAllTaskTitles(api, projectId)).titles).toEqual([
				"T1 S1 open",
				"T2 S1 done",
				"T3 S2 open",
			]);
			expect((await api.get(taskUrl(projectId, t3))).status()).toBe(200);
			// The backlog task has no sprint, so a positive operator is false.
			expect((await api.get(taskUrl(projectId, t4))).status()).toBe(403);
		});
	});

	test("NotIn: everything except the listed values, tasks without the attribute included", async ({
		request,
		playwright,
	}) => {
		const member = await memberReading(request, playwright, "NOTIN", {
			NotIn: { "task.sprint_id": [sprint1] },
		});
		await asUser(playwright, member.username, async (api) => {
			expect((await listAllTaskTitles(api, projectId)).titles).toEqual([
				"T3 S2 open",
				"T4 backlog open",
			]);
			expect((await api.get(taskUrl(projectId, t1))).status()).toBe(403);
			expect((await api.get(taskUrl(projectId, t2))).status()).toBe(403);
			expect((await api.get(taskUrl(projectId, t4))).status()).toBe(200);
		});
	});

	test("StringNotEquals on a missing attribute is true; StringEquals on it is false", async ({
		request,
		playwright,
	}) => {
		const notS1 = await memberReading(request, playwright, "NOTEQ", {
			StringNotEquals: { "task.sprint_id": sprint1 },
		});
		const isS1 = await memberReading(request, playwright, "EQ", {
			StringEquals: { "task.sprint_id": sprint1 },
		});
		await asUser(playwright, notS1.username, async (api) => {
			expect((await api.get(taskUrl(projectId, t4))).status()).toBe(200);
			expect((await api.get(taskUrl(projectId, t1))).status()).toBe(403);
		});
		await asUser(playwright, isS1.username, async (api) => {
			expect((await api.get(taskUrl(projectId, t4))).status()).toBe(403);
			expect((await api.get(taskUrl(projectId, t1))).status()).toBe(200);
		});
	});

	test("StringLike: * matches a run of characters and ? exactly one", async ({
		request,
		playwright,
	}) => {
		// Ids are random UUIDs, so a prefix of S1's id names S1 and nothing else.
		const prefix = sprint1.slice(0, 13);
		const star = await memberReading(request, playwright, "LIKESTAR", {
			StringLike: { "task.sprint_id": `${prefix}*` },
		});
		const question = await memberReading(request, playwright, "LIKEQ", {
			StringLike: { "task.sprint_id": `${sprint1.slice(0, -1)}?` },
		});
		const tooShort = await memberReading(request, playwright, "LIKESHORT", {
			// One "?" stands for one character, so this is one character short.
			StringLike: { "task.sprint_id": `${sprint1.slice(0, -2)}?` },
		});
		for (const member of [star, question]) {
			await asUser(playwright, member.username, async (api) => {
				expect((await listAllTaskTitles(api, projectId)).titles).toEqual([
					"T1 S1 open",
					"T2 S1 done",
				]);
				expect((await api.get(taskUrl(projectId, t3))).status()).toBe(403);
			});
		}
		await asUser(playwright, tooShort.username, async (api) => {
			expect((await listAllTaskTitles(api, projectId)).titles).toEqual([]);
			expect((await api.get(taskUrl(projectId, t1))).status()).toBe(403);
		});
	});

	test("task.status_id: only tasks in a status, and a task leaves the scope when its status changes", async ({
		request,
		playwright,
	}) => {
		const member = await memberReading(request, playwright, "STATUS", {
			StringEquals: { "task.status_id": openStatus },
		});
		await asUser(playwright, member.username, async (api) => {
			expect((await listAllTaskTitles(api, projectId)).titles).toEqual([
				"T1 S1 open",
				"T3 S2 open",
				"T4 backlog open",
			]);
			expect((await api.get(taskUrl(projectId, t2))).status()).toBe(403);
		});
		// Finishing T1 takes it out of the member's reach on their next request.
		const finished = await request.patch(taskUrl(projectId, t1), {
			data: { status_id: doneStatus },
		});
		expect(finished.ok()).toBeTruthy();
		await asUser(playwright, member.username, async (api) => {
			expect((await api.get(taskUrl(projectId, t1))).status()).toBe(403);
			expect((await listTasks(api, projectId)).total).toBe(2);
		});
	});

	test("task.type_id: tasks of one type", async ({ request, playwright }) => {
		const { items } = await dataOf<{ items: Array<{ id: string }> }>(
			await request.get(`${API_URL}/projects/${projectId}/task-types`),
		);
		expect(items.length).toBeGreaterThan(1);
		const [typeA, typeB] = items.map((i) => i.id);
		const typed = await makeTask(request, projectId, "Typed A", {
			task_type_id: typeA,
		});
		const other = await makeTask(request, projectId, "Typed B", {
			task_type_id: typeB,
		});
		const member = await memberReading(request, playwright, "TYPE", {
			StringEquals: { "task.type_id": typeA },
		});
		await asUser(playwright, member.username, async (api) => {
			const { titles } = await listAllTaskTitles(api, projectId);
			expect(titles).toContain("Typed A");
			expect(titles).not.toContain("Typed B");
			expect((await api.get(taskUrl(projectId, typed))).status()).toBe(200);
			expect((await api.get(taskUrl(projectId, other))).status()).toBe(403);
		});
	});

	test("Every condition of a statement must hold (AND)", async ({
		request,
		playwright,
	}) => {
		const member = await memberReading(request, playwright, "AND", {
			StringEquals: {
				"task.sprint_id": sprint1,
				"task.status_id": openStatus,
			},
		});
		await asUser(playwright, member.username, async (api) => {
			expect((await listAllTaskTitles(api, projectId)).titles).toEqual([
				"T1 S1 open",
			]);
			expect((await api.get(taskUrl(projectId, t2))).status()).toBe(403); // S1 but done
			expect((await api.get(taskUrl(projectId, t3))).status()).toBe(403); // open but S2
		});
	});

	test("Two operators in one statement are ANDed as well", async ({
		request,
		playwright,
	}) => {
		const member = await memberReading(request, playwright, "TWOOPS", {
			In: { "task.sprint_id": [sprint1, sprint2] },
			StringNotEquals: { "task.status_id": doneStatus },
		});
		await asUser(playwright, member.username, async (api) => {
			expect((await listAllTaskTitles(api, projectId)).titles).toEqual([
				"T1 S1 open",
				"T3 S2 open",
			]);
		});
	});

	test("A Deny with a condition hides only what matches, over a broad Allow", async ({
		request,
		playwright,
	}) => {
		const role = await projectRoleFrom(
			request,
			projectId,
			name("DENYCOND_ROLE"),
			openProject(projectId, ["tasks:read"]),
			allow(["tasks:read"], [`project/${projectId}/task/*`]),
			deny(["tasks:read"], [`project/${projectId}/task/*`], {
				StringEquals: { "task.status_id": doneStatus },
			}),
		);
		const member = await createMember(
			request,
			playwright,
			projectId,
			name("DENYCOND_USER"),
			[role],
		);
		await asUser(playwright, member.username, async (api) => {
			expect((await listAllTaskTitles(api, projectId)).titles).toEqual([
				"T1 S1 open",
				"T3 S2 open",
				"T4 backlog open",
			]);
			expect((await api.get(taskUrl(projectId, t2))).status()).toBe(403);
			expect((await api.get(taskUrl(projectId, t1))).status()).toBe(200);
		});
	});

	test("A Deny on a negated operator also hits tasks that lack the attribute", async ({
		request,
		playwright,
	}) => {
		// Deny when sprint != S1. The backlog task has no sprint, so "not equal"
		// is true and the Deny applies: only S1's tasks stay readable.
		const role = await projectRoleFrom(
			request,
			projectId,
			name("DENYNEG_ROLE"),
			openProject(projectId, ["tasks:read"]),
			allow(["tasks:read"], [`project/${projectId}/task/*`]),
			deny(["tasks:read"], [`project/${projectId}/task/*`], {
				StringNotEquals: { "task.sprint_id": sprint1 },
			}),
		);
		const member = await createMember(
			request,
			playwright,
			projectId,
			name("DENYNEG_USER"),
			[role],
		);
		await asUser(playwright, member.username, async (api) => {
			expect((await listAllTaskTitles(api, projectId)).titles).toEqual([
				"T1 S1 open",
				"T2 S1 done",
			]);
			expect((await api.get(taskUrl(projectId, t4))).status()).toBe(403);
		});
	});
});

test.describe("task.assignee_id is multi-valued", () => {
	let projectId: string;
	let sprint: string;

	test.beforeEach(async ({ request, context }) => {
		await authRequest(request);
		await cleanup(request);
		await context.clearCookies();
		projectId = await createProject(request, name("ASSIGNEE"));
		sprint = await createSprint(request, projectId, name("S"));
	});

	test.afterEach(async ({ request }) => {
		await authRequest(request);
		await cleanup(request);
	});

	test("A positive operator matches when any assignee matches; a negated one only when none does", async ({
		request,
		playwright,
	}) => {
		const viewerRole = await projectRoleFrom(
			request,
			projectId,
			name("PLAIN"),
			openProject(projectId),
		);
		const alice = await createMember(
			request,
			playwright,
			projectId,
			name("ALICE"),
			[viewerRole],
		);
		const bob = await createMember(
			request,
			playwright,
			projectId,
			name("BOB"),
			[viewerRole],
		);
		const mine = await makeTask(request, projectId, "Alice only", {
			sprint_id: sprint,
			assignee_ids: [alice.memberId],
		});
		const shared = await makeTask(request, projectId, "Alice and Bob", {
			sprint_id: sprint,
			assignee_ids: [alice.memberId, bob.memberId],
		});
		const bobs = await makeTask(request, projectId, "Bob only", {
			sprint_id: sprint,
			assignee_ids: [bob.memberId],
		});
		const nobody = await makeTask(request, projectId, "Nobody", {
			sprint_id: sprint,
		});

		const aliceRole = await projectRoleFrom(
			request,
			projectId,
			name("ALICE_ONLY"),
			openProject(projectId, ["tasks:read"]),
			allow(["tasks:read"], [`project/${projectId}/task/*`], {
				StringEquals: { "task.assignee_id": alice.userId },
			}),
		);
		const notAliceRole = await projectRoleFrom(
			request,
			projectId,
			name("NOT_ALICE"),
			openProject(projectId, ["tasks:read"]),
			allow(["tasks:read"], [`project/${projectId}/task/*`], {
				StringNotEquals: { "task.assignee_id": alice.userId },
			}),
		);
		const reader = await createMember(
			request,
			playwright,
			projectId,
			name("READER"),
			[aliceRole],
		);
		const complement = await createMember(
			request,
			playwright,
			projectId,
			name("COMPLEMENT"),
			[notAliceRole],
		);

		await asUser(playwright, reader.username, async (api) => {
			expect((await listAllTaskTitles(api, projectId)).titles).toEqual([
				"Alice and Bob",
				"Alice only",
			]);
			expect((await api.get(taskUrl(projectId, shared))).status()).toBe(200);
			expect((await api.get(taskUrl(projectId, bobs))).status()).toBe(403);
			expect((await api.get(taskUrl(projectId, nobody))).status()).toBe(403);
		});
		await asUser(playwright, complement.username, async (api) => {
			// Shared with Alice means one assignee matches, so the negated
			// operator is false; an unassigned task has no value to match.
			expect((await listAllTaskTitles(api, projectId)).titles).toEqual([
				"Bob only",
				"Nobody",
			]);
			expect((await api.get(taskUrl(projectId, mine))).status()).toBe(403);
			expect((await api.get(taskUrl(projectId, shared))).status()).toBe(403);
		});
	});

	test("A task cannot be created or handed over outside the assignee scope", async ({
		request,
		playwright,
	}) => {
		const plain = await projectRoleFrom(
			request,
			projectId,
			name("PLAIN2"),
			openProject(projectId),
		);
		const self = await createMember(
			request,
			playwright,
			projectId,
			name("SELF"),
			[plain],
		);
		const other = await createMember(
			request,
			playwright,
			projectId,
			name("OTHER"),
			[plain],
		);
		// The scope names the member's own user id, known only now.
		const scoped = await projectRoleFrom(
			request,
			projectId,
			name("MY_TASKS"),
			openProject(projectId, ["tasks:read", "tasks:write"]),
			allow(["tasks:read", "tasks:write"], [`project/${projectId}/task/*`], {
				StringEquals: { "task.assignee_id": self.userId },
			}),
		);
		expect(
			(await putMemberRoles(request, projectId, self.memberId, [scoped])).ok(),
		).toBeTruthy();

		await asUser(playwright, self.username, async (api) => {
			const create = (data: Record<string, unknown>) =>
				api.post(`${API_URL}/projects/${projectId}/tasks`, { data });
			expect((await create({ title: "No assignee" })).status()).toBe(403);
			expect(
				(
					await create({ title: "Not mine", assignee_ids: [other.memberId] })
				).status(),
			).toBe(403);
			const mine = await create({
				title: "Mine",
				assignee_ids: [self.memberId],
			});
			expect(mine.status(), await mine.text()).toBeLessThan(300);
			const mineId = (await dataOf<{ id: string }>(mine)).id;
			// Handing it to someone else would move it out of the scope.
			const handOff = await api.patch(taskUrl(projectId, mineId), {
				data: { assignee_ids: [other.memberId] },
			});
			expect(handOff.status()).toBe(403);
			expect((await api.get(taskUrl(projectId, mineId))).status()).toBe(200);
		});
	});
});

test.describe("principal.id and principal.type", () => {
	let projectId: string;

	test.beforeEach(async ({ request, context }) => {
		await authRequest(request);
		await cleanup(request);
		await context.clearCookies();
		projectId = await createProject(request, name("PRINCIPAL"));
	});

	test.afterEach(async ({ request }) => {
		await authRequest(request);
		await cleanup(request);
	});

	test("One shared role can name who it applies to: NotIn principal.id spares the listed users", async ({
		request,
		playwright,
	}) => {
		// A Deny for everyone except the listed users, the "restrict ... only
		// these people" form, here on a whole task collection.
		await makeTask(request, projectId, "Guarded");
		const reader = await projectRoleFrom(
			request,
			projectId,
			name("READ"),
			openProject(projectId, ["tasks:read"]),
			allow(["tasks:read"], [`project/${projectId}/task/*`]),
		);
		const insider = await createMember(
			request,
			playwright,
			projectId,
			name("INSIDER"),
			[reader],
		);
		const outsider = await createMember(
			request,
			playwright,
			projectId,
			name("OUTSIDER"),
			[reader],
		);
		const lock = await projectRoleFrom(
			request,
			projectId,
			name("LOCK"),
			deny(["tasks:read"], [`project/${projectId}/*`], {
				NotIn: { "principal.id": [insider.userId] },
			}),
		);
		for (const m of [insider, outsider]) {
			const response = await request.put(
				`${API_URL}/projects/${projectId}/members/${m.memberId}/roles`,
				{ data: { role_ids: [reader, lock] } },
			);
			expect(response.ok()).toBeTruthy();
		}
		await asUser(playwright, insider.username, async (api) => {
			expect((await listTasks(api, projectId)).status).toBe(200);
		});
		await asUser(playwright, outsider.username, async (api) => {
			expect((await listTasks(api, projectId)).status).toBe(403);
		});
	});

	test("principal.type separates users from agents", async ({
		request,
		playwright,
	}) => {
		const taskId = await makeTask(request, projectId, "For people");
		const role = await projectRoleFrom(
			request,
			projectId,
			name("USERS_ONLY"),
			openProject(projectId),
			allow(["tasks:read"], [`project/${projectId}/task/*`], {
				StringEquals: { "principal.type": "user" },
			}),
		);
		const member = await createMember(
			request,
			playwright,
			projectId,
			name("PERSON"),
			[role],
		);
		await asUser(playwright, member.username, async (api) => {
			expect((await api.get(taskUrl(projectId, taskId))).status()).toBe(200);
		});
		// The same condition, as a role for agents only, grants a user nothing.
		const agentsOnly = await projectRoleFrom(
			request,
			projectId,
			name("AGENTS_ONLY"),
			openProject(projectId),
			allow(["tasks:read"], [`project/${projectId}/task/*`], {
				StringEquals: { "principal.type": "agent" },
			}),
		);
		const other = await createMember(
			request,
			playwright,
			projectId,
			name("PERSON2"),
			[agentsOnly],
		);
		await asUser(playwright, other.username, async (api) => {
			expect((await api.get(taskUrl(projectId, taskId))).status()).toBe(403);
		});
	});
});

test.describe("What is refused when a policy with conditions is saved", () => {
	let projectId: string;

	test.beforeEach(async ({ request, context }) => {
		await authRequest(request);
		await cleanup(request);
		await context.clearCookies();
		projectId = await createProject(request, name("VALIDATE"));
	});

	test.afterEach(async ({ request }) => {
		await authRequest(request);
		await cleanup(request);
	});

	const save = (
		request: APIRequestContext,
		label: string,
		conditions: Record<string, Record<string, unknown>>,
		resources = [`project/${projectId}/task/*`],
	) =>
		postProjectRole(
			request,
			projectId,
			name(label),
			policyOf(allow(["tasks:read"], resources, conditions)),
		);

	test("An unknown operator is refused at its path", async ({ request }) => {
		const response = await save(request, "BADOP", {
			StringEqualsIgnoreCase: { "task.sprint_id": "x" },
		});
		expect(response.status()).toBe(422);
		expect(await errorCode(response)).toBe("ROLE_POLICY_INVALID");
		expect((await policyIssues(response)).map((i) => i.path)).toContain(
			"statements[0].conditions.StringEqualsIgnoreCase.task.sprint_id",
		);
	});

	test("An unknown key, an empty operand and a non-boolean Bool operand are refused", async ({
		request,
	}) => {
		const unknownKey = await save(request, "BADKEY", {
			StringEquals: { "task.colour": "red" },
		});
		expect(unknownKey.status()).toBe(422);
		expect((await policyIssues(unknownKey)).map((i) => i.path)).toContain(
			"statements[0].conditions.StringEquals.task.colour",
		);

		const emptyOperand = await save(request, "EMPTYOP", {
			In: { "task.sprint_id": [] },
		});
		expect(emptyOperand.status()).toBe(422);

		const badBool = await save(request, "BADBOOL", {
			Bool: { "principal.id": "yes" },
		});
		expect(badBool.status()).toBe(422);
	});

	test("A key of one kind on a statement for another kind is refused", async ({
		request,
	}) => {
		const response = await save(
			request,
			"WRONGKIND",
			{ StringEquals: { "doc.folder_id": "f" } },
			[`project/${projectId}/task/*`],
		);
		expect(response.status()).toBe(422);
		expect((await policyIssues(response)).map((i) => i.path)).toContain(
			"statements[0].conditions.StringEquals.doc.folder_id",
		);
	});

	test("Operands may be a string, a list of strings or a bool; null and numbers are not", async ({
		request,
	}) => {
		expect(
			(await save(request, "OPSTR", { In: { "task.sprint_id": "a" } })).ok(),
		).toBeTruthy();
		expect(
			(
				await save(request, "OPLIST", { In: { "task.sprint_id": ["a", "b"] } })
			).ok(),
		).toBeTruthy();
		expect(
			(await save(request, "OPBOOL", { Bool: { "principal.id": true } })).ok(),
			"a Bool operand of true is a valid operand",
		).toBeTruthy();
		expect(
			(await save(request, "OPNULL", { In: { "task.sprint_id": null } })).ok(),
		).toBeFalsy();
		expect(
			(await save(request, "OPNUM", { In: { "task.sprint_id": 5 } })).ok(),
		).toBeFalsy();
	});
});
