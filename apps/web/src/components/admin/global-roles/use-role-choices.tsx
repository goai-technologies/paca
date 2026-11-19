import type { ReactNode } from "react";

import { RolesQueryBoundary } from "@/components/admin/global-roles/role-option-list";
import type { RemoteRoleSearch } from "@/components/admin/global-roles/role-select";
import { useRoleSearch, useRolesByIds } from "@/hooks/use-role-search";
import { isProjectTemplate } from "@/lib/policy";
import type { Role } from "@/lib/role-api";

/**
 * What a role-changing dialog needs to offer the platform roles: the roles
 * matching the search so far (`roles`), the roles the account holds resolved by
 * id (`knownRoles`, so they show and diff correctly even when not on a loaded
 * page), the server-side search and paging state (`remote`), and a `status`
 * placeholder while the roles load, fail, or there are none at all.
 *
 * A project template (project/*) only works attached per project; given
 * platform-wide it would reach every project, so it is not offered — unless
 * the account already holds it, so saving never drops a role it could not see.
 *
 * With a `projectId` the choices are the roles usable inside that project
 * (project templates included), so nothing is filtered out.
 */
export function useRoleChoices(
	open: boolean,
	heldIds: string[],
	projectId?: string,
) {
	const search = useRoleSearch(projectId, open);
	const knownRoles = useRolesByIds(projectId, heldIds, open);
	const roles = projectId
		? search.roles
		: search.roles.filter(
				(r: Role) => !isProjectTemplate(r.policy) || heldIds.includes(r.id),
			);
	const remote: RemoteRoleSearch = {
		query: search.query,
		onQueryChange: search.onQueryChange,
		hasMore: search.hasMore,
		isLoadingMore: search.isLoadingMore,
		isError: search.isLoadMoreError,
		onLoadMore: search.onLoadMore,
	};
	const searching = search.query.trim() !== "";
	const status: ReactNode =
		search.isPending || search.isError || (roles.length === 0 && !searching) ? (
			<RolesQueryBoundary
				query={{ ...search, data: search.isPending ? undefined : roles }}
			>
				{() => null}
			</RolesQueryBoundary>
		) : undefined;
	return { roles, knownRoles, remote, status };
}
