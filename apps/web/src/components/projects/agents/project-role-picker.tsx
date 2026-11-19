import {
	RoleOptionList,
	type RoleOptionListProps,
	RolesQueryBoundary,
} from "@/components/admin/global-roles/role-option-list";
import { projectPermissionBadgeClass } from "@/components/projects/roles/utils";
import { useRoleSearch, useRolesByIds } from "@/hooks/use-role-search";
import type { Role } from "@/lib/role-api";

type ProjectRolePickerProps = Omit<
	RoleOptionListProps<Role>,
	"roles" | "knownRoles" | "remote" | "badgeClass"
> & {
	projectId: string;
};

/**
 * Lists the roles that can be given inside a project (its own and the
 * workspace roles attachable there) to choose from, each with a glance at
 * what it grants (see RoleOptionList). Searches and pages them on the server
 * and resolves the picked and held roles by id. Loads them itself, which
 * needs `roles:read`.
 */
export function ProjectRolePicker({
	projectId,
	...props
}: ProjectRolePickerProps) {
	const search = useRoleSearch(projectId, true);
	const known = useRolesByIds(projectId, [
		...props.values,
		...(props.currentRoleIds ?? []),
	]);
	return (
		<RolesQueryBoundary
			query={{ ...search, data: search.isPending ? undefined : search.roles }}
			searching={search.query.trim() !== ""}
		>
			{(roles) => (
				<RoleOptionList
					roles={roles}
					knownRoles={known}
					remote={{
						query: search.query,
						onQueryChange: search.onQueryChange,
						hasMore: search.hasMore,
						isLoadingMore: search.isLoadingMore,
						isError: search.isLoadMoreError,
						onLoadMore: search.onLoadMore,
					}}
					badgeClass={projectPermissionBadgeClass}
					{...props}
				/>
			)}
		</RolesQueryBoundary>
	);
}
