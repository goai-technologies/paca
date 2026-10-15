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

export const commitmentWorkQueryOptions = (commitmentId: string) =>
	queryOptions({
		queryKey: ["commitments", commitmentId, "work"],
		queryFn: () => getCommitmentWork(commitmentId),
	});
