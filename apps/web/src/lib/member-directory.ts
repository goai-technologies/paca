import {
	IdDirectory,
	MAX_IDS_PER_LOOKUP,
	useIdDirectory,
} from "./id-directory";
import { listProjectMembers, type ProjectMember } from "./project-api";

/** Resolves ids (a membership id or an account id) to project members without
 *  loading the whole team: ids asked for while rendering are collected and
 *  fetched in batches through the members `ids` filter, then cached. */
export class MemberDirectory extends IdDirectory<ProjectMember> {
	constructor(projectId: string) {
		super(
			async (ids) =>
				(
					await listProjectMembers(projectId, {
						ids,
						pageSize: MAX_IDS_PER_LOOKUP,
					})
				).items,
			(m) => [m.id, m.user_id, m.agent_id, m.service_account_id],
		);
	}
}

const directories = new Map<string, MemberDirectory>();

export function getMemberDirectory(projectId: string): MemberDirectory {
	let dir = directories.get(projectId);
	if (!dir) {
		dir = new MemberDirectory(projectId);
		directories.set(projectId, dir);
	}
	return dir;
}

/** Call after members are added, removed or edited so cached names, avatars
 *  and roles are fetched again. */
export function invalidateMemberDirectory(projectId: string): void {
	directories.get(projectId)?.invalidate();
}

/** Lazy id → member lookup for a project. The returned `getMember` changes
 *  identity whenever new members resolve, so memos and callbacks that depend
 *  on it recompute. */
export function useMemberDirectory(projectId: string) {
	return useIdDirectory(getMemberDirectory(projectId));
}
