import type { APIRequestContext, APIResponse } from "@playwright/test";
import { API_URL, assignGlobalRoles, createGlobalRole } from "./e2e-api";
import {
	allow,
	type asUser,
	createMember,
	policyOf,
	projectRoleFrom,
} from "./iam";

export type Playwright = Parameters<typeof asUser>[0];

/** Any repository id: nothing is ever linked in the e2e stack. */
export const REPOSITORY = "00000000-0000-4000-8000-000000000001";

export const gitUrl = (projectId: string, path = "") =>
	`${API_URL}/projects/${projectId}/git${path}`;

export const repoUrl = (projectId: string, path = "") =>
	gitUrl(projectId, `/repositories/${REPOSITORY}${path}`);

/** True when the request was refused for permissions rather than for its content. */
export function refused(response: APIResponse): boolean {
	return response.status() === 401 || response.status() === 403;
}

/** An API context with no credentials at all. */
export async function anonymous<T>(
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

/** A member of `projectId` whose only project role allows `actions` there. */
export async function memberWith(
	request: APIRequestContext,
	playwright: Playwright,
	projectId: string,
	prefix: string,
	runId: string,
	label: string,
	actions: string[],
) {
	const roleId = await projectRoleFrom(
		request,
		projectId,
		`${prefix}ROLE_${label}_${runId}`,
		allow(["projects:read", ...actions], [`project/${projectId}`]),
		...(actions.length > 0 ? [allow(actions, [`project/${projectId}/*`])] : []),
	);
	return createMember(
		request,
		playwright,
		projectId,
		`${prefix}${label}_${runId}`,
		[roleId],
	);
}

/** Gives `userId` exactly one workspace role allowing `actions`. */
export async function grantWorkspace(
	request: APIRequestContext,
	userId: string,
	roleName: string,
	actions: string[],
	resources: string[] = ["git_identity/*"],
) {
	await createGlobalRole(
		request,
		roleName,
		policyOf(allow(actions, resources)),
	);
	await assignGlobalRoles(request, userId, [roleName]);
}
