import {
	keepPreviousData,
	useInfiniteQuery,
	useQuery,
} from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { useDebouncedCallback } from "@/hooks/use-debounced-callback";
import {
	platformRolesInfiniteQueryOptions,
	projectRolesInfiniteQueryOptions,
	type Role,
	rolesByIdsQueryOptions,
} from "@/lib/role-api";

/** Server-side searchable, cursor-paged role list: the platform roles, or —
 *  with a projectId — the roles usable inside that project. Nothing is fetched
 *  until `enabled`; typing re-queries the server after a short pause while the
 *  pages already loaded stay on screen. */
export function useRoleSearch(projectId: string | undefined, enabled: boolean) {
	const [query, setQuery] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const applyQuery = useDebouncedCallback(setDebouncedQuery, 250);

	const platform = useInfiniteQuery({
		...platformRolesInfiniteQueryOptions(debouncedQuery),
		enabled: enabled && !projectId,
		placeholderData: keepPreviousData,
	});
	const project = useInfiniteQuery({
		...projectRolesInfiniteQueryOptions(projectId ?? "", debouncedQuery),
		enabled: enabled && !!projectId,
		placeholderData: keepPreviousData,
	});
	const active = projectId ? project : platform;
	const roles = useMemo(
		() => active.data?.pages.flatMap((p) => p.items) ?? [],
		[active.data],
	);

	return {
		query,
		onQueryChange: (value: string) => {
			setQuery(value);
			applyQuery(value);
		},
		roles,
		total: active.data?.pages[0]?.total_count,
		isPending: active.isPending,
		isError: active.isError,
		isRefetching: active.isRefetching,
		refetch: active.refetch,
		hasMore: !!active.hasNextPage,
		isLoadingMore: active.isFetchingNextPage,
		isLoadMoreError: active.isFetchNextPageError,
		onLoadMore: () => void active.fetchNextPage(),
	};
}

/** The roles with these ids (at most 100), looked up in one request. Empty
 *  until loaded, and for ids that no longer exist. */
export function useRolesByIds(
	projectId: string | undefined,
	ids: string[],
	enabled = true,
): Role[] {
	const { data } = useQuery({
		...rolesByIdsQueryOptions(projectId, ids),
		enabled: enabled && ids.length > 0,
	});
	return data ?? [];
}
