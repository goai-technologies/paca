import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Check, FolderKanban, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { commitmentCatalogAllQueryOptions } from "@/lib/commitment-api";
import type { Task } from "@/lib/interaction-api";
import { projectsLookupInfiniteQueryOptions } from "@/lib/project-api";
import { FieldRow } from "./primitives";

interface CommitmentProjectFieldProps {
	/** A Commitment-typed task in the Commitments project. */
	task: Task;
	/** The Commitments project itself — never offered as a commitment's project. */
	commitmentsProjectId: string;
	canEdit: boolean;
	onChange: (projectId: string | null) => void;
}

/**
 * The Project field on a commitment: which project the commitment is for
 * (tasks.home_project_id). Offers every project the reader can list except
 * the Commitments project, with a search box. The ticket-side Commitment
 * picker uses this to put a project's own commitments first.
 */
export function CommitmentProjectField({
	task,
	commitmentsProjectId,
	canEdit,
	onChange,
}: CommitmentProjectFieldProps) {
	const { t } = useTranslation("projects");
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const homeId = task.home_project_id ?? null;

	const {
		data: projectsData,
		isLoading,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
		isFetchNextPageError,
	} = useInfiniteQuery(projectsLookupInfiniteQueryOptions());
	// The picker needs every project, not a page of them: drain the rest in
	// the background (usually there is only one page). The lookup cache key
	// exists for exactly this, so the sidebar's own paging is untouched.
	// Stops on a failed page, which would otherwise retry forever.
	useEffect(() => {
		if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) {
			void fetchNextPage();
		}
	}, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

	// The catalog row for this commitment names its project even when the
	// reader cannot list that project.
	const { data: catalog, isLoading: catalogLoading } = useQuery({
		...commitmentCatalogAllQueryOptions(),
		enabled: !!homeId,
	});

	const projects = useMemo(
		() =>
			(projectsData?.pages.flatMap((p) => p.items) ?? [])
				.filter((p) => p.id !== commitmentsProjectId)
				.sort((a, b) => a.name.localeCompare(b.name)),
		[projectsData, commitmentsProjectId],
	);

	const listed = homeId ? projects.find((p) => p.id === homeId) : undefined;
	const catalogRow = homeId
		? catalog?.items.find(
				(c) => c.id === task.id && c.home_project_id === homeId,
			)
		: undefined;
	const currentName = listed?.name ?? catalogRow?.home_project_name;
	const currentPrefix =
		listed?.task_id_prefix ?? catalogRow?.home_project_task_id_prefix;
	const resolving =
		isLoading ||
		catalogLoading ||
		(hasNextPage && !isFetchNextPageError) ||
		isFetchingNextPage;

	const query = search.trim().toLowerCase();
	const options = query
		? projects.filter(
				(p) =>
					p.name.toLowerCase().includes(query) ||
					p.task_id_prefix.toLowerCase().includes(query),
			)
		: projects;

	const label = currentName ? (
		<>
			<FolderKanban className="size-3.5 shrink-0 text-muted-foreground" />
			<span className="truncate text-foreground/80">
				{currentName}
				{currentPrefix && (
					<span className="ml-1.5 font-mono text-xs text-muted-foreground">
						{currentPrefix}
					</span>
				)}
			</span>
		</>
	) : homeId ? (
		<span className="text-muted-foreground/70 italic">
			{resolving
				? t("taskDetail.commitment.loading")
				: t("taskDetail.commitment.projectUnknown")}
		</span>
	) : (
		<span className="text-muted-foreground/50 italic">
			{t("taskDetail.properties.none")}
		</span>
	);

	if (!canEdit) {
		return (
			<FieldRow label={t("taskDetail.commitment.projectLabel")}>
				<span
					title={t("taskDetail.commitment.projectHint")}
					className="inline-flex items-center gap-1.5 text-sm font-medium max-w-72 truncate"
				>
					{label}
				</span>
			</FieldRow>
		);
	}

	return (
		<FieldRow label={t("taskDetail.commitment.projectLabel")}>
			<DropdownMenu open={open} onOpenChange={setOpen}>
				<DropdownMenuTrigger
					title={t("taskDetail.commitment.projectHint")}
					className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium hover:bg-muted/50 transition-colors duration-150 cursor-pointer -ml-2 max-w-72 truncate"
				>
					{label}
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="w-72">
					<p className="px-2 pt-1 pb-1.5 text-[11px] text-muted-foreground">
						{t("taskDetail.commitment.projectHint")}
					</p>
					<div className="flex items-center gap-2 px-2 py-1.5">
						<Search className="size-3.5 shrink-0 text-muted-foreground" />
						<input
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder={t("taskDetail.commitment.projectSearchPlaceholder")}
							className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
							onKeyDown={(e) => {
								// Let Escape close the menu; keep other keys out of the
								// menu's own type-ahead navigation.
								if (e.key !== "Escape") e.stopPropagation();
							}}
						/>
					</div>
					<DropdownMenuSeparator />
					{homeId && (
						<>
							<DropdownMenuItem
								className="text-destructive focus:text-destructive"
								onClick={() => onChange(null)}
							>
								<X className="size-3.5 mr-2 shrink-0" />
								{t("taskDetail.commitment.projectClear")}
							</DropdownMenuItem>
							<DropdownMenuSeparator />
						</>
					)}
					{isLoading ? (
						<div className="px-2 py-2 text-xs text-muted-foreground">
							{t("taskDetail.commitment.loading")}
						</div>
					) : options.length === 0 ? (
						<div className="px-2 py-2 text-xs text-muted-foreground">
							{query
								? t("taskDetail.searchableList.noResults")
								: t("taskDetail.commitment.projectEmpty")}
						</div>
					) : (
						<div className="max-h-72 overflow-y-auto">
							{options.map((p) => (
								<DropdownMenuItem key={p.id} onClick={() => onChange(p.id)}>
									<FolderKanban className="size-3.5 mr-1 shrink-0 text-muted-foreground" />
									<span className="truncate">{p.name}</span>
									<span className="font-mono text-[11px] text-muted-foreground">
										{p.task_id_prefix}
									</span>
									{p.id === homeId && (
										<Check className="size-3.5 text-primary ml-auto" />
									)}
								</DropdownMenuItem>
							))}
						</div>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</FieldRow>
	);
}
