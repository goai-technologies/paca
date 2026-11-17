import { queryOptions } from "@tanstack/react-query";
import { apiClient } from "./api-client";
import type { SuccessEnvelope } from "./api-error";
import type { TaskType } from "./project-api";

// ── Commitment catalog ────────────────────────────────────────────────────────
//
// A commitment is a Commitment-typed task in the one Commitments project the
// workspace admin designates. Any ticket, in any project, can belong to
// exactly one commitment (tasks.commitment_task_id); its children inherit it.
// These calls are workspace-wide on purpose: the person attaching a
// ticket from another project is rarely a member of the Commitments project.

export interface CommitmentCatalogItem {
	id: string;
	project_id: string;
	task_id_prefix: string;
	task_number: number;
	ref: string;
	title: string;
	status_id?: string | null;
	status_name?: string;
	status_category?: string;
	is_closed: boolean;
	due_date?: string | null;
	custom_fields: Record<string, unknown>;
	/** The project this commitment is for (its Project field); absent when none is chosen. */
	home_project_id?: string | null;
	home_project_name?: string;
	home_project_task_id_prefix?: string;
}

export interface CommitmentCatalog {
	items: CommitmentCatalogItem[];
	commitments_project_id: string;
	task_id_prefix: string;
}

export interface CommitmentWorkItem {
	id: string;
	project_id: string;
	task_id_prefix: string;
	task_number: number;
	ref: string;
	title: string;
	task_type_id?: string | null;
	status_id?: string | null;
	parent_task_id?: string | null;
	due_date?: string | null;
	updated_at: string;
}

export interface CommitmentWorkGroup {
	project_id: string;
	project_name: string;
	task_id_prefix: string;
	tasks: CommitmentWorkItem[];
}

export interface CommitmentWork {
	commitment: CommitmentCatalogItem;
	projects: CommitmentWorkGroup[];
	hidden_project_count: number;
}

/** True when the type is the Commitment type (matched by name, case-insensitively). */
export function isCommitmentType(t: TaskType | undefined | null): boolean {
	return !!t && t.name.trim().toLowerCase() === "commitment";
}

export async function listCommitments(opts?: {
	search?: string;
	includeClosed?: boolean;
}): Promise<CommitmentCatalog> {
	const params = new URLSearchParams();
	if (opts?.search) params.set("search", opts.search);
	if (opts?.includeClosed) params.set("include_closed", "true");
	const qs = params.toString();
	const { data } = await apiClient.instance.get<
		SuccessEnvelope<CommitmentCatalog>
	>(`/commitments${qs ? `?${qs}` : ""}`);
	return data.data;
}

export async function getCommitmentWork(
	commitmentId: string,
): Promise<CommitmentWork> {
	const { data } = await apiClient.instance.get<
		SuccessEnvelope<CommitmentWork>
	>(`/commitments/${commitmentId}/work`);
	return data.data;
}

export const commitmentCatalogQueryOptions = (search = "") =>
	queryOptions({
		queryKey: ["commitments", "catalog", search],
		queryFn: () => listCommitments({ search }),
		staleTime: 30_000,
	});

/** The catalog including closed commitments — to label a ticket whose commitment has since closed. */
export const commitmentCatalogAllQueryOptions = () =>
	queryOptions({
		queryKey: ["commitments", "catalog", "all"],
		queryFn: () => listCommitments({ includeClosed: true }),
		staleTime: 30_000,
	});

/**
 * The id of the workspace's Commitments project. Read from the full catalog
 * (same cache entry as commitmentCatalogAllQueryOptions), so a page that
 * already labels commitments does not fetch twice. Errors when no
 * Commitments project is configured.
 */
export const commitmentsProjectIdQueryOptions = () =>
	queryOptions({
		...commitmentCatalogAllQueryOptions(),
		select: (catalog) => catalog.commitments_project_id,
	});

/**
 * Orders catalog rows for a ticket in `projectId`: commitments FOR that
 * project first, then the rest, each group keeping the catalog's order.
 */
export function partitionCommitmentsByProject(
	items: CommitmentCatalogItem[],
	projectId: string,
): {
	thisProject: CommitmentCatalogItem[];
	otherProjects: CommitmentCatalogItem[];
} {
	const thisProject: CommitmentCatalogItem[] = [];
	const otherProjects: CommitmentCatalogItem[] = [];
	for (const c of items) {
		(c.home_project_id === projectId ? thisProject : otherProjects).push(c);
	}
	return { thisProject, otherProjects };
}

/** True when the commitment's ref, title or project (name or prefix) contains the query, ignoring case. */
export function commitmentMatchesSearch(
	c: CommitmentCatalogItem,
	query: string,
): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return [c.ref, c.title, c.home_project_name, c.home_project_task_id_prefix]
		.filter((v): v is string => !!v)
		.some((v) => v.toLowerCase().includes(q));
}

export const commitmentWorkQueryOptions = (commitmentId: string) =>
	queryOptions({
		queryKey: ["commitments", commitmentId, "work"],
		queryFn: () => getCommitmentWork(commitmentId),
	});
