import {
	RoleOptionList,
	type RoleOptionListProps,
	RolesQueryBoundary,
} from "@/components/admin/global-roles/role-option-list";
import { isFullAccessRole } from "@/components/admin/global-roles/utils";
import { useRoleSearch, useRolesByIds } from "@/hooks/use-role-search";
import { isProjectTemplate } from "@/lib/policy";
import type { Role } from "@/lib/role-api";

export { isFullAccessRole };

type RolePickerProps = Omit<
	RoleOptionListProps<Role>,
	"roles" | "knownRoles" | "remote" | "badgeClass"
>;

/**
 * Lists the global roles to choose from (see RoleOptionList). Searches and
 * pages them on the server, and resolves the picked and held roles by id, so
 * it works for any number of roles. Loads them itself, which needs
 * `roles:read`.
 */
export function RolePicker(props: RolePickerProps) {
	const search = useRoleSearch(undefined, true);
	const known = useRolesByIds(undefined, [
		...props.values,
		...(props.currentRoleIds ?? []),
	]);
	return (
		<RolesQueryBoundary
			query={{ ...search, data: search.isPending ? undefined : search.roles }}
			searching={search.query.trim() !== ""}
		>
			{(roles) => (
				// A project template (project/*) only works attached per project;
				// given platform-wide it would reach every project.
				<RoleOptionList
					roles={roles.filter((r) => !isProjectTemplate(r.policy))}
					knownRoles={known}
					remote={{
						query: search.query,
						onQueryChange: search.onQueryChange,
						hasMore: search.hasMore,
						isLoadingMore: search.isLoadingMore,
						isError: search.isLoadMoreError,
						onLoadMore: search.onLoadMore,
					}}
					{...props}
				/>
			)}
		</RolesQueryBoundary>
	);
}
