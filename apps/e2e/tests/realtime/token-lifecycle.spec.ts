// spec: features/realtime/token-lifecycle.feature
// seed: tests/seed.spec.ts
//
// A socket is authenticated once, when it connects, so it must not outlive the
// access token it connected with. About a minute before the token expires the
// server sends "reauth" (the client refreshes its session and reconnects on the
// new cookie); at expiry it disconnects the socket. The client reconnects after
// a server-initiated disconnect, so even a client that ignores "reauth" ends up
// with a fresh handshake.
//
// The stack's access tokens live for 15 minutes, so the specs mint copies of a
// member's real token with a lifetime of seconds (signed with the stack's JWT
// secret, see mintToken) and watch what the server does with them.

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
	createMember,
	createTask,
	projectRoleFrom,
} from "../helpers/iam";
import {
	accessTokenOf,
	closeAll,
	connectAs,
	mintToken,
	Probe,
	sleep,
	track,
} from "../helpers/realtime";

const PREFIX = "E2E_RTTOKEN_";
const RUN_ID = newRunId();
const name = (label: string) => `${PREFIX}${label}_${RUN_ID}`;

async function cleanup(request: APIRequestContext) {
	await cleanupProjectsByPrefix(request, PREFIX);
	await cleanupUsersByPrefix(request, PREFIX);
}

test.beforeEach(async ({ request, context }) => {
	await authRequest(request);
	await cleanup(request);
	await context.clearCookies();
});

test.afterEach(async ({ request }) => {
	await closeAll();
	await authRequest(request);
	await cleanup(request);
});

/** A project, a member who reads its tasks, and that member's real access token. */
async function arrange(
	request: APIRequestContext,
	playwright: Parameters<typeof connectAs>[0],
) {
	await authRequest(request);
	const projectId = await createProject(request, name("p"));
	const role = await projectRoleFrom(
		request,
		projectId,
		name("role"),
		allow(["projects:read", "tasks:read"], [`project/${projectId}/*`]),
	);
	const member = await createMember(
		request,
		playwright,
		projectId,
		name("bob"),
		[role],
	);
	const session = await connectAs(playwright, member.username);
	return {
		projectId,
		member,
		realToken: await accessTokenOf(session.api),
		task: await createTask(request, projectId, name("t")),
	};
}

async function touch(
	request: APIRequestContext,
	projectId: string,
	taskId: string,
) {
	const response = await request.patch(
		`${API_URL}/projects/${projectId}/tasks/${taskId}`,
		{
			data: { title: name(`t_${Math.random().toString(36).slice(2, 7)}`) },
		},
	);
	expect(response.ok(), await response.text()).toBeTruthy();
}

const seconds = (from: number, to: number) => Math.round((to - from) / 1000);

// The server notices expiry on a shared scan every 5 seconds, so what it does
// may come up to that much after the moment it was due (plus network and load).
const SCAN_SLACK = 5;

test.describe("A socket and the lifetime of its token", () => {
	test("a token with plenty of life gets no reauth and stays connected", async ({
		request,
		playwright,
	}) => {
		const a = await arrange(request, playwright);
		const probe = track(await Probe.connect({ token: a.realToken }));
		await probe.join(a.projectId);
		await sleep(7_000); // longer than one expiry scan
		expect(probe.reauths).toEqual([]);
		expect(probe.connected).toBe(true);
	});

	test("asks to reauthenticate about a minute before expiry, then disconnects at expiry", async ({
		request,
		playwright,
	}) => {
		test.setTimeout(180_000);
		const a = await arrange(request, playwright);

		// Two sockets with different lifetimes, watched at the same time.
		const longTtl = 75; // reauth at ~15s, disconnect at ~75s
		const shortTtl = 30; // already inside the one-minute window: reauth at once
		const longProbe = track(
			await Probe.connect({ token: mintToken(a.realToken, longTtl) }),
		);
		const shortToken = mintToken(a.realToken, shortTtl);
		const shortProbe = track(await Probe.connect({ token: shortToken }));
		await longProbe.join(a.projectId);
		await shortProbe.join(a.projectId);
		const longBorn = longProbe.connectedAt;
		const shortBorn = shortProbe.connectedAt;

		await test.step("both receive events while their token is valid", async () => {
			const since = Date.now();
			await touch(request, a.projectId, a.task);
			await expect
				.poll(() => longProbe.eventsAbout(a.task, since).length)
				.toBeGreaterThan(0);
			await expect
				.poll(() => shortProbe.eventsAbout(a.task, since).length)
				.toBeGreaterThan(0);
		});

		await test.step("the short-lived token is asked to reauthenticate straight away", async () => {
			await expect
				.poll(() => shortProbe.reauths.length, { timeout: 15_000 })
				.toBe(1);
			expect(
				seconds(shortBorn, shortProbe.reauths[0] as number),
			).toBeLessThanOrEqual(SCAN_SLACK + 3);
		});

		await test.step("and is disconnected when it expires, with no reauth repeated", async () => {
			await expect
				.poll(() => shortProbe.disconnects.length, { timeout: 40_000 })
				.toBe(1);
			const gone = shortProbe.disconnects[0] as { reason: string; at: number };
			expect(gone.reason).toBe("io server disconnect");
			const lived = seconds(shortBorn, gone.at);
			expect(lived).toBeGreaterThanOrEqual(shortTtl - 2);
			expect(lived).toBeLessThanOrEqual(shortTtl + SCAN_SLACK + 3);
			expect(shortProbe.reauths.length).toBe(1);
		});

		await test.step("the other socket is untouched and still receives events", async () => {
			expect(longProbe.connected).toBe(true);
			// (its own reauth, due ~15s in, may already have arrived: that is checked below)
			expect(longProbe.disconnects).toEqual([]);
			const since = Date.now();
			await touch(request, a.projectId, a.task);
			await expect
				.poll(() => longProbe.eventsAbout(a.task, since).length)
				.toBeGreaterThan(0);
			expect(shortProbe.eventsAbout(a.task, since)).toEqual([]);
		});

		await test.step("the long-lived token gets its reauth about a minute early", async () => {
			await expect
				.poll(() => longProbe.reauths.length, { timeout: 40_000 })
				.toBe(1);
			const early = seconds(longBorn, longProbe.reauths[0] as number);
			// Due at expiry minus the one-minute lead, noticed by the next scan.
			expect(early).toBeGreaterThanOrEqual(longTtl - 60 - 2);
			expect(early).toBeLessThanOrEqual(longTtl - 60 + SCAN_SLACK + 3);
		});

		// What the web client does on "reauth": refresh the session, reconnect.
		const fresh = track(
			await Probe.connect({ token: mintToken(a.realToken, 900) }),
		);
		await test.step("a socket reconnected on a fresh token keeps working", async () => {
			expect(await fresh.join(a.projectId)).toContain("tasks");
		});

		await test.step("the first socket is disconnected at its expiry", async () => {
			await expect
				.poll(() => longProbe.disconnects.length, { timeout: 70_000 })
				.toBe(1);
			const gone = longProbe.disconnects[0] as { reason: string; at: number };
			expect(gone.reason).toBe("io server disconnect");
			const lived = seconds(longBorn, gone.at);
			expect(lived).toBeGreaterThanOrEqual(longTtl - 2);
			expect(lived).toBeLessThanOrEqual(longTtl + SCAN_SLACK + 3);
		});

		await test.step("the fresh socket outlives the old expiry and receives events", async () => {
			expect(fresh.connected).toBe(true);
			const since = Date.now();
			await touch(request, a.projectId, a.task);
			await expect
				.poll(() => fresh.eventsAbout(a.task, since).length)
				.toBeGreaterThan(0);
			expect(longProbe.eventsAbout(a.task, since)).toEqual([]);
		});

		await test.step("the expired token cannot connect again", async () => {
			// The same 30s token, long expired by now.
			const again = await Probe.tryConnect({ token: shortToken });
			expect(again.probe).toBeUndefined();
			expect(again.error).toBe("invalid or expired token");
		});
	});
});
