import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { useDebouncedCallback } from "@/hooks/use-debounced-callback";
import { getMemberDirectory } from "@/lib/member-directory";
import {
	type ProjectMemberFilters,
	projectMembersInfiniteQueryOptions,
} from "@/lib/project-api";

/** Server-side searchable, cursor-paged member list for pickers. Nothing is
 *  fetched until `enabled` (e.g. the popover is open); typing re-queries the
 *  server after a short pause, and the pages already loaded stay on screen
 *  meanwhile. Loaded members also seed the id → member directory. */
export function useMemberSearch(
	projectId: string,
	enabled: boolean,
	filters: Omit<ProjectMemberFilters, "search"> = {},
) {
	const [query, setQuery] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const applyQuery = useDebouncedCallback(setDebouncedQuery, 250);

	const {
		data,
		isLoading,
		isFetchingNextPage,
		hasNextPage,
		fetchNextPage,
		isFetchNextPageError,
	} = useInfiniteQuery({
		...projectMembersInfiniteQueryOptions(projectId, {
			...filters,
			search: debouncedQuery,
		}),
		enabled,
		placeholderData: keepPreviousData,
	});

	const members = useMemo(
		() => data?.pages.flatMap((p) => p.items) ?? [],
		[data],
	);
	useEffect(() => {
		if (members.length > 0) getMemberDirectory(projectId).seed(members);
	}, [projectId, members]);

	return {
		query,
		onQueryChange: (value: string) => {
			setQuery(value);
			applyQuery(value);
		},
		members,
		isLoading,
		hasMore: !!hasNextPage,
		isLoadingMore: isFetchingNextPage,
		isError: isFetchNextPageError,
		onLoadMore: () => void fetchNextPage(),
	};
}
