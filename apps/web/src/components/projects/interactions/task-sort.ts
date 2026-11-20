import type { Task } from "@/lib/interaction-api";
import type { ProjectMember, TaskStatus } from "@/lib/project-api";

export type TimelineSortField =
	| "manual"
	| "card_id"
	| "priority"
	| "status"
	| "created_at"
	| "updated_at"
	| "assignee"
	| "title"
	| "start_date"
	| "due_date";

export type SortDirection = "asc" | "desc";

export interface TaskSortContext {
	statuses?: TaskStatus[];
	members?: ProjectMember[];
	taskIdPrefix?: string;
}

export const TIMELINE_SORT_OPTIONS: {
	key: TimelineSortField;
	labelKey: string;
}[] = [
	{ key: "card_id", labelKey: "layout.timeline.sortOptions.cardId" },
	{ key: "priority", labelKey: "layout.timeline.sortOptions.priority" },
	{ key: "status", labelKey: "layout.timeline.sortOptions.status" },
	{ key: "created_at", labelKey: "layout.timeline.sortOptions.createdAt" },
	{ key: "updated_at", labelKey: "layout.timeline.sortOptions.updatedAt" },
	{ key: "assignee", labelKey: "layout.timeline.sortOptions.assignee" },
];

function getAssigneeName(task: Task, members?: ProjectMember[]): string {
	if (task.assignees && task.assignees.length > 0) {
		const first = task.assignees[0];
		return first.full_name || first.username || "";
	}
	if (task.assignee_ids && task.assignee_ids.length > 0 && members) {
		const firstId = task.assignee_ids[0];
		const match = members.find(
			(m) => m.id === firstId || m.user_id === firstId,
		);
		if (match) {
			return match.full_name || match.username || "";
		}
	}
	return "";
}

function getStatusPosition(task: Task, statuses?: TaskStatus[]): number {
	if (!task.status_id || !statuses || statuses.length === 0) return 999999;
	const match = statuses.find((s) => s.id === task.status_id);
	return match ? match.position : 999999;
}

export function compareTasks(
	a: Task,
	b: Task,
	field: TimelineSortField | string,
	direction: SortDirection = "asc",
	ctx: TaskSortContext = {},
): number {
	let diff = 0;

	switch (field) {
		case "card_id": {
			const numA = a.task_number || 0;
			const numB = b.task_number || 0;
			diff = numA !== numB ? numA - numB : a.id.localeCompare(b.id);
			break;
		}
		case "priority":
		case "importance": {
			const impA = a.importance ?? 0;
			const impB = b.importance ?? 0;
			diff = impA - impB;
			break;
		}
		case "status": {
			const posA = getStatusPosition(a, ctx.statuses);
			const posB = getStatusPosition(b, ctx.statuses);
			diff =
				posA !== posB
					? posA - posB
					: (a.status_id || "").localeCompare(b.status_id || "");
			break;
		}
		case "created":
		case "created_at": {
			const timeA = a.created_at ? new Date(a.created_at).getTime() : 0;
			const timeB = b.created_at ? new Date(b.created_at).getTime() : 0;
			diff = timeA - timeB;
			break;
		}
		case "updated":
		case "updated_at": {
			const timeA = a.updated_at ? new Date(a.updated_at).getTime() : 0;
			const timeB = b.updated_at ? new Date(b.updated_at).getTime() : 0;
			diff = timeA - timeB;
			break;
		}
		case "assignee": {
			const nameA = getAssigneeName(a, ctx.members);
			const nameB = getAssigneeName(b, ctx.members);
			if (!nameA && !nameB) {
				diff = 0;
			} else if (!nameA) {
				return 1; // Unassigned placed at the end regardless of asc/desc
			} else if (!nameB) {
				return -1;
			} else {
				diff = nameA.localeCompare(nameB, undefined, { sensitivity: "base" });
			}
			break;
		}
		case "title": {
			diff = (a.title || "").localeCompare(b.title || "", undefined, {
				sensitivity: "base",
			});
			break;
		}
		case "start_date": {
			const tA = a.start_date ? new Date(a.start_date).getTime() : 0;
			const tB = b.start_date ? new Date(b.start_date).getTime() : 0;
			if (!tA && !tB) diff = 0;
			else if (!tA) return 1;
			else if (!tB) return -1;
			else diff = tA - tB;
			break;
		}
		case "due_date": {
			const tA = a.due_date ? new Date(a.due_date).getTime() : 0;
			const tB = b.due_date ? new Date(b.due_date).getTime() : 0;
			if (!tA && !tB) diff = 0;
			else if (!tA) return 1;
			else if (!tB) return -1;
			else diff = tA - tB;
			break;
		}
		default:
			return 0;
	}

	if (diff === 0) {
		// Tiebreaker: task_number or created_at
		const numA = a.task_number || 0;
		const numB = b.task_number || 0;
		if (numA !== numB) {
			return direction === "asc" ? numA - numB : numB - numA;
		}
		return a.id.localeCompare(b.id);
	}

	return direction === "asc" ? diff : -diff;
}

export function sortTasks(
	tasks: Task[],
	field: TimelineSortField | string | undefined,
	direction: SortDirection = "asc",
	ctx: TaskSortContext = {},
): Task[] {
	if (!field || field === "manual") {
		return tasks;
	}
	return [...tasks].sort((a, b) => compareTasks(a, b, field, direction, ctx));
}
