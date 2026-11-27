import { apiClient } from "./api-client";
import type { SuccessEnvelope } from "./api-error";
import { listTaskColumns } from "./interaction-api";

/**
 * Workspace-wide distinct tags (GET /tags) across every project the
 * caller can access. Falls back to the current project's tag columns if
 * the workspace endpoint is unavailable.
 */
export async function listWorkspaceTagSuggestions(
	projectId: string,
): Promise<string[]> {
	try {
		const { data } = await apiClient.instance.get<
			SuccessEnvelope<{ items: string[] }>
		>("/tags");
		const items = data.data?.items ?? [];
		const byLower = new Map<string, string>();
		for (const tag of items) {
			const trimmed = tag.trim();
			if (!trimmed) continue;
			const key = trimmed.toLowerCase();
			if (!byLower.has(key)) byLower.set(key, trimmed);
		}
		return [...byLower.values()].sort((a, b) =>
			a.localeCompare(b, undefined, { sensitivity: "base" }),
		);
	} catch {
		// Older API builds without GET /tags — keep project-local suggestions.
		const columns = await listTaskColumns(projectId, "tags");
		return (columns.columns ?? [])
			.map((column) => (column.label || column.key).trim())
			.filter((tag) => tag.length > 0)
			.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
	}
}

export const workspaceTagSuggestionsQueryKey = (projectId: string) =>
	["workspace", "tag-suggestions", projectId] as const;
