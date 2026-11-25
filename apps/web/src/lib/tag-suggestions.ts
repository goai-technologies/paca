import { listTaskColumns } from "@/lib/interaction-api";
import { listProjects } from "@/lib/project-api";

/** Cap how many other projects we sample for workspace-wide tag suggestions. */
const MAX_WORKSPACE_PROJECTS = 30;

/**
 * Distinct tag strings used on tasks in `projectId`, plus tags from other
 * projects the user can access (PE-17: reuse tags across PACA, not only
 * within one card/project).
 */
export async function listWorkspaceTagSuggestions(
	projectId: string,
): Promise<string[]> {
	const byLower = new Map<string, string>();

	function addAll(tags: string[]) {
		for (const tag of tags) {
			const trimmed = tag.trim();
			if (!trimmed) continue;
			const key = trimmed.toLowerCase();
			if (!byLower.has(key)) byLower.set(key, trimmed);
		}
	}

	const [projectColumns, projectsPage] = await Promise.all([
		listTaskColumns(projectId, "tags"),
		listProjects(1, MAX_WORKSPACE_PROJECTS).catch(() => null),
	]);

	addAll(
		(projectColumns.columns ?? []).map((column) => column.label || column.key),
	);

	const otherIds = (projectsPage?.items ?? [])
		.map((project) => project.id)
		.filter((id) => id !== projectId)
		.slice(0, MAX_WORKSPACE_PROJECTS - 1);

	if (otherIds.length > 0) {
		const otherColumns = await Promise.all(
			otherIds.map((id) =>
				listTaskColumns(id, "tags").catch(() => ({
					columns: [],
					truncated: false,
				})),
			),
		);
		for (const result of otherColumns) {
			addAll(
				(result.columns ?? []).map((column) => column.label || column.key),
			);
		}
	}

	return [...byLower.values()].sort((a, b) =>
		a.localeCompare(b, undefined, { sensitivity: "base" }),
	);
}

export const workspaceTagSuggestionsQueryKey = (projectId: string) =>
	["workspace", "tag-suggestions", projectId] as const;
