import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { useDebouncedCallback } from "@/hooks/use-debounced-callback";
import {
	type ListSprintsOptions,
	sprintsInfiniteQueryOptions,
} from "@/lib/interaction-api";
import { getSprintDirectory } from "@/lib/sprint-directory";

/** Server-side searchable, cursor-paged sprint list for pickers. Nothing is
 *  fetched until `enabled`; typing re-queries the server after a short pause
 *  while the pages already loaded stay on screen. Loaded sprints also seed the
 *  id → sprint directory. */
export function useSprintSearch(
	projectId: string,
	enabled: boolean,
	opts: Pick<ListSprintsOptions, "status" | "sort"> = {},
) {
	const [query, setQuery] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const applyQuery = useDebouncedCallback(setDebouncedQuery, 250);

	const result = useInfiniteQuery({
		...sprintsInfiniteQueryOptions(projectId, {
			...opts,
			search: debouncedQuery,
		}),
		enabled: enabled && !!projectId,
		placeholderData: keepPreviousData,
	});
	const sprints = useMemo(
		() => result.data?.pages.flatMap((p) => p.items) ?? [],
		[result.data],
	);
	const total = result.data?.pages[0]?.total_count;
	useEffect(() => {
		if (sprints.length > 0) getSprintDirectory(projectId).seed(sprints);
	}, [projectId, sprints]);

	return {
		query,
		onQueryChange: (value: string) => {
			setQuery(value);
			applyQuery(value);
		},
		sprints,
		total,
		isLoading: result.isLoading,
		hasMore: !!result.hasNextPage,
		isLoadingMore: result.isFetchingNextPage,
		isError: result.isFetchNextPageError,
		onLoadMore: () => void result.fetchNextPage(),
	};
}
