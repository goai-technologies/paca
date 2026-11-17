import { listDocuments } from "./doc-api";
import { listAllTasks } from "./interaction-api";
import { listProjectMembers, type ProjectMember } from "./project-api";
import { type AvatarIdentity, memberAvatar } from "./provider-logos";

export interface TeamMember {
	id: string;
	name: string;
	username: string;
	avatar: AvatarIdentity;
	avatarUrl?: string | null | undefined;
}

export interface MentionableTask {
	id: string;
	title: string;
	task_number: number;
	status?: string | null | undefined;
}

export interface MentionableDocument {
	id: string;
	title: string;
}

/** Trims, collapses internal whitespace (a comment body can be
 * multi-paragraph), and truncates for use as a short display label —
 * mirrors annotationsvc.taskTitleFromBody's own short-title-from-body
 * derivation on the Go side. Used for a pasted comment's attach-context
 * chip title (thread.tsx) and the annotation card block's fallback title
 * (blocknote-annotation-card-block.tsx). */
export function excerptOf(body: string, max = 60): string {
	const collapsed = body.trim().replace(/\s+/g, " ");
	if (collapsed.length <= max) return collapsed || "Comment";
	return `${collapsed.slice(0, max - 1)}…`;
}

export const MENTIONABLE_MEMBERS_PAGE_SIZE = 20;

/** Live server-side search backing the "@" team-member mention menu: the
 *  first page of members matching what the user has typed after "@". The
 *  team has no fixed upper bound, so it is queried on demand rather than
 *  preloaded in full. */
export async function searchMentionableMembers(
	projectId: string,
	query: string,
): Promise<TeamMember[]> {
	const page = await listProjectMembers(projectId, {
		search: query,
		pageSize: MENTIONABLE_MEMBERS_PAGE_SIZE,
	});
	return page.items.map((member: ProjectMember) => ({
		id:
			member.member_type === "agent"
				? (member.agent_id ?? member.user_id)
				: member.user_id,
		name: member.full_name,
		username: member.username,
		avatarUrl: member.avatar_url,
		avatar: memberAvatar(member),
	}));
}

export const MENTIONABLE_TASKS_PAGE_SIZE = 20;

/** Live server-side search backing the "#" task-reference mention menu.
 *  Queried fresh for whatever the user has typed after "#" — the project's
 *  task list has no fixed upper bound and the backend caps page_size at 200,
 *  so unlike team members/docs this can't just be preloaded once and
 *  filtered client-side without silently hiding tasks past the first page. */
export async function searchMentionableTasks(
	projectId: string,
	query: string,
): Promise<MentionableTask[]> {
	const result = await listAllTasks(projectId, {
		search: query,
		pageSize: MENTIONABLE_TASKS_PAGE_SIZE,
	});
	return result.items.map((task) => ({
		id: task.id,
		title: task.title,
		task_number: task.task_number,
		status: task.status_id || undefined,
	}));
}

export const MENTIONABLE_DOCS_PAGE_SIZE = 20;

/** Live server-side search backing the document references in the "#"
 *  mention menu: the first page of documents whose title matches what the
 *  user has typed. A project's documents have no fixed upper bound, so they
 *  are queried on demand rather than preloaded in full. */
export async function searchMentionableDocuments(
	projectId: string,
	query: string,
): Promise<MentionableDocument[]> {
	const page = await listDocuments(projectId, {
		search: query,
		pageSize: MENTIONABLE_DOCS_PAGE_SIZE,
	});
	return page.items.map((doc) => ({ id: doc.id, title: doc.title }));
}
