import {
	useInfiniteQuery,
	useQueries,
	useQuery,
} from "@tanstack/react-query";
import { Check, ChevronDown, ChevronsUpDown, Filter, RotateCcw, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
	getImportanceBucketBounds,
	PRIORITY_LEVELS,
} from "@/components/projects/interactions/priority";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import type {
	CustomFieldFilterQuery,
	SearchTasksOptions,
} from "@/lib/interaction-api";
import {
	listProjectMembers,
	type Project,
	projectsLookupInfiniteQueryOptions,
	taskStatusesQueryOptions,
	taskTypesQueryOptions,
} from "@/lib/project-api";
import { cn } from "@/lib/utils";

const PRIORITY_OPTIONS = ["None", "Low", "Medium", "High", "Critical"];

export interface GlobalTaskFilterDraft {
	projectIds: string[];
	/** Canonical status name keys (see groupByCanonicalName), not raw UUIDs. */
	statusIds: string[];
	/** Canonical task-type name keys (see groupByCanonicalName), not raw UUIDs. */
	taskTypeIds: string[];
	assigneeUserIds: string[];
	importanceBuckets: number[];
	priorityValues: string[];
	tags: string;
	createdAfter: string;
	createdBefore: string;
	updatedAfter: string;
	updatedBefore: string;
	devCompletedAfter: string;
	devCompletedBefore: string;
	/** User ids selected for QA By — labels resolved at Apply against the
	 *  member catalog (qa_by custom field stores display names). */
	qaByUserIds: string[];
	qaStartAfter: string;
	qaStartBefore: string;
	qaEndAfter: string;
	qaEndBefore: string;
}

export const EMPTY_GLOBAL_FILTER: GlobalTaskFilterDraft = {
	projectIds: [],
	statusIds: [],
	taskTypeIds: [],
	assigneeUserIds: [],
	importanceBuckets: [],
	priorityValues: [],
	tags: "",
	createdAfter: "",
	createdBefore: "",
	updatedAfter: "",
	updatedBefore: "",
	devCompletedAfter: "",
	devCompletedBefore: "",
	qaByUserIds: [],
	qaStartAfter: "",
	qaStartBefore: "",
	qaEndAfter: "",
	qaEndBefore: "",
};

/** Whether Global Tasks should auto-mount GlobalTaskResults (and thus call
 *  GET /tasks/search) without waiting for Apply. Cleared searches stay idle
 *  until the Admin applies again; non-admins never auto-start. */
export function shouldAutoStartGlobalSearch(opts: {
	canAccessAdmin: boolean;
	projectCount: number;
	cleared: boolean;
	current: SearchTasksOptions | null;
}): boolean {
	return (
		opts.canAccessAdmin &&
		!opts.cleared &&
		opts.current == null &&
		opts.projectCount > 0
	);
}

/** One UI option that stands for every same-named type/status across projects. */
export interface CanonicalNamedOption {
	/** Stable key: trimmed lower-case name. */
	key: string;
	/** Display label (first-seen casing). */
	label: string;
	/** Concrete per-project ids that share this name. */
	ids: string[];
}

/** Collapse same-named types/statuses from many projects into one option.
 *  Distinct custom names stay separate. Selection uses `key`; Apply expands
 *  to every member id so the API matches cards in all accessible projects. */
export function groupByCanonicalName(
	items: { id: string; name: string }[],
): CanonicalNamedOption[] {
	const byKey = new Map<string, CanonicalNamedOption>();
	for (const item of items) {
		const label = item.name.trim();
		if (!label) continue;
		const key = label.toLowerCase();
		const existing = byKey.get(key);
		if (existing) {
			if (!existing.ids.includes(item.id)) existing.ids.push(item.id);
		} else {
			byKey.set(key, { key, label, ids: [item.id] });
		}
	}
	return [...byKey.values()].sort((a, b) =>
		a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
	);
}

function expandCanonicalKeys(
	keys: string[],
	idsByKey: Record<string, string[]> | undefined,
): string[] | undefined {
	if (keys.length === 0) return undefined;
	if (!idsByKey) return keys;
	const ids = [...new Set(keys.flatMap((k) => idsByKey[k] ?? []))];
	return ids.length > 0 ? ids : undefined;
}

export interface DraftSearchContext {
	memberLabelsById?: Record<string, string>;
	/** Canonical status key → all matching status UUIDs across projects. */
	statusIdsByKey?: Record<string, string[]>;
	/** Canonical task-type key → all matching type UUIDs across projects. */
	taskTypeIdsByKey?: Record<string, string[]>;
}

/** Convert the draft form into SearchTasksOptions for the API.
 *  Draft status/type selections are canonical name keys; context expands them
 *  to every matching project-scoped id. QA By user ids resolve to display names. */
export function draftToSearchOptions(
	draft: GlobalTaskFilterDraft,
	ctx: DraftSearchContext | Record<string, string> = {},
): SearchTasksOptions {
	// Back-compat: older call sites passed memberLabelsById as the 2nd arg.
	const context: DraftSearchContext = isDraftSearchContext(ctx)
		? ctx
		: { memberLabelsById: ctx };
	const memberLabelsById = context.memberLabelsById ?? {};

	const customFieldFilters: Record<string, CustomFieldFilterQuery> = {};
	if (draft.priorityValues.length > 0) {
		customFieldFilters.priority = { values: draft.priorityValues };
	}
	const qaByNames = draft.qaByUserIds
		.map((id) => memberLabelsById[id]?.trim())
		.filter((name): name is string => Boolean(name));
	if (qaByNames.length > 0) {
		customFieldFilters.qa_by = { values: qaByNames };
	}
	if (draft.devCompletedAfter || draft.devCompletedBefore) {
		customFieldFilters.dev_completion_date = {
			after: draft.devCompletedAfter || undefined,
			before: draft.devCompletedBefore || undefined,
		};
	}
	if (draft.qaStartAfter || draft.qaStartBefore) {
		customFieldFilters.qa_start_date = {
			after: draft.qaStartAfter || undefined,
			before: draft.qaStartBefore || undefined,
		};
	}
	if (draft.qaEndAfter || draft.qaEndBefore) {
		customFieldFilters.qa_end_date = {
			after: draft.qaEndAfter || undefined,
			before: draft.qaEndBefore || undefined,
		};
	}

	const tags = draft.tags
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);

	return {
		projectIds: draft.projectIds.length ? draft.projectIds : undefined,
		statusIds: expandCanonicalKeys(draft.statusIds, context.statusIdsByKey),
		taskTypeIds: expandCanonicalKeys(
			draft.taskTypeIds,
			context.taskTypeIdsByKey,
		),
		assigneeUserIds: draft.assigneeUserIds.length
			? draft.assigneeUserIds
			: undefined,
		importanceRanges:
			draft.importanceBuckets.length > 0
				? draft.importanceBuckets.map(getImportanceBucketBounds)
				: undefined,
		tags: tags.length ? tags : undefined,
		createdAfter: draft.createdAfter || undefined,
		createdBefore: draft.createdBefore || undefined,
		updatedAfter: draft.updatedAfter || undefined,
		updatedBefore: draft.updatedBefore || undefined,
		customFieldFilters:
			Object.keys(customFieldFilters).length > 0
				? customFieldFilters
				: undefined,
		sortBy: "created",
	};
}

function isDraftSearchContext(
	ctx: DraftSearchContext | Record<string, string>,
): ctx is DraftSearchContext {
	return (
		"memberLabelsById" in ctx ||
		"statusIdsByKey" in ctx ||
		"taskTypeIdsByKey" in ctx ||
		Object.keys(ctx).length === 0
	);
}

/** Default applied search for Admin home — unfiltered cross-project list.
 *  Mirrors an empty filter draft so Apply with no selections hits the same
 *  GET /tasks/search shape. */
export const DEFAULT_GLOBAL_SEARCH: SearchTasksOptions =
	draftToSearchOptions(EMPTY_GLOBAL_FILTER);

function toggleId(ids: string[], id: string): string[] {
	return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

function toggleNum(nums: number[], n: number): number[] {
	return nums.includes(n) ? nums.filter((x) => x !== n) : [...nums, n];
}

function MultiSelectPills({
	options,
	selected,
	onChange,
	emptyLabel,
}: {
	options: { id: string; label: string }[];
	selected: string[];
	onChange: (next: string[]) => void;
	emptyLabel: string;
}) {
	if (options.length === 0) {
		return (
			<p className="text-xs text-muted-foreground/70 py-1">{emptyLabel}</p>
		);
	}
	return (
		<div className="flex flex-wrap gap-1.5">
			{options.map((opt) => {
				const active = selected.includes(opt.id);
				return (
					<button
						key={opt.id}
						type="button"
						onClick={() => onChange(toggleId(selected, opt.id))}
						className={cn(
							"rounded-md border px-2 py-0.5 text-xs transition-colors",
							active
								? "border-primary/40 bg-primary/10 text-primary"
								: "border-border/60 text-muted-foreground hover:border-border hover:text-foreground",
						)}
					>
						{opt.label}
					</button>
				);
			})}
		</div>
	);
}

/** Searchable multi-select for people (Assigned To / QA By). Selection state
 *  lives in the parent draft so collapse/expand does not clear picks. */
function SearchableUserMultiSelect({
	options,
	selected,
	onChange,
	placeholder,
	emptyLabel,
	searchPlaceholder,
	ariaLabel,
}: {
	options: { id: string; label: string }[];
	selected: string[];
	onChange: (next: string[]) => void;
	placeholder: string;
	emptyLabel: string;
	searchPlaceholder: string;
	ariaLabel: string;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");

	const selectedOptions = useMemo(
		() => options.filter((o) => selected.includes(o.id)),
		[options, selected],
	);

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return options;
		return options.filter((o) => o.label.toLowerCase().includes(q));
	}, [options, query]);

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setQuery("");
			}}
		>
			<PopoverTrigger
				type="button"
				role="combobox"
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={ariaLabel}
				className="flex min-h-8 w-full items-center justify-between gap-2 rounded-md border border-border/60 bg-transparent px-2 py-1 text-left text-xs transition-colors hover:border-border hover:bg-muted/30 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
			>
				<span className="flex w-0 min-w-0 flex-1 flex-wrap items-center gap-1">
					{selectedOptions.length > 0 ? (
						selectedOptions.map((opt) => (
							<span
								key={opt.id}
								className="inline-flex max-w-full items-center gap-0.5 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary"
							>
								<span className="truncate">{opt.label}</span>
								<span
									role="button"
									tabIndex={-1}
									aria-label={`Remove ${opt.label}`}
									className="shrink-0 rounded p-0.5 hover:bg-primary/15"
									onClick={(e) => {
										e.preventDefault();
										e.stopPropagation();
										onChange(selected.filter((id) => id !== opt.id));
									}}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											e.stopPropagation();
											onChange(selected.filter((id) => id !== opt.id));
										}
									}}
								>
									<X className="size-2.5" />
								</span>
							</span>
						))
					) : (
						<span className="text-muted-foreground">{placeholder}</span>
					)}
				</span>
				<ChevronsUpDown
					className="size-3.5 shrink-0 text-muted-foreground"
					aria-hidden="true"
				/>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-(--anchor-width) min-w-56 p-2"
				initialFocus={false}
			>
				<div className="relative mb-1.5">
					<Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/50" />
					<input
						type="text"
						// biome-ignore lint/a11y/noAutofocus: search is the point of opening the picker
						autoFocus
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={searchPlaceholder}
						aria-label={searchPlaceholder}
						className="w-full rounded-md border border-border/40 bg-muted/20 py-1.5 pr-2 pl-7 text-xs placeholder:text-muted-foreground/50 focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
					/>
				</div>
				<div
					role="listbox"
					aria-multiselectable="true"
					aria-label={ariaLabel}
					className="max-h-56 overflow-y-auto"
				>
					{options.length === 0 ? (
						<p className="px-2 py-3 text-center text-xs text-muted-foreground/70">
							{emptyLabel}
						</p>
					) : visible.length === 0 ? (
						<p className="px-2 py-3 text-center text-xs text-muted-foreground/70">
							{emptyLabel}
						</p>
					) : (
						visible.map((opt) => {
							const active = selected.includes(opt.id);
							return (
								<button
									key={opt.id}
									type="button"
									role="option"
									aria-selected={active}
									onClick={() => onChange(toggleId(selected, opt.id))}
									className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/60 transition-colors"
								>
									<span className="min-w-0 flex-1 truncate text-left">
										{opt.label}
									</span>
									{active ? (
										<Check className="size-3.5 shrink-0 text-primary" />
									) : null}
								</button>
							);
						})
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}

function DateRangeFields({
	from,
	to,
	onFrom,
	onTo,
	fromLabel,
	toLabel,
}: {
	from: string;
	to: string;
	onFrom: (v: string) => void;
	onTo: (v: string) => void;
	fromLabel: string;
	toLabel: string;
}) {
	return (
		<div className="grid grid-cols-2 gap-2">
			<div className="space-y-1">
				<Label className="text-[11px] text-muted-foreground">{fromLabel}</Label>
				<Input
					type="date"
					value={from}
					onChange={(e) => onFrom(e.target.value)}
					className="h-8 text-xs"
				/>
			</div>
			<div className="space-y-1">
				<Label className="text-[11px] text-muted-foreground">{toLabel}</Label>
				<Input
					type="date"
					value={to}
					onChange={(e) => onTo(e.target.value)}
					className="h-8 text-xs"
				/>
			</div>
		</div>
	);
}

export function GlobalTaskFilter({
	onApply,
	onClear,
	applied,
}: {
	onApply: (opts: SearchTasksOptions) => void;
	onClear: () => void;
	applied: boolean;
}) {
	const { t } = useTranslation("shared");
	const [draft, setDraft] = useState<GlobalTaskFilterDraft>(EMPTY_GLOBAL_FILTER);
	/** UI-only: expand/collapse must not remount draft or call onApply. */
	const [filtersOpen, setFiltersOpen] = useState(false);

	const {
		data: projectsData,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
	} = useInfiniteQuery(projectsLookupInfiniteQueryOptions());

	useEffect(() => {
		if (hasNextPage && !isFetchingNextPage) {
			void fetchNextPage();
		}
	}, [hasNextPage, isFetchingNextPage, fetchNextPage]);

	const projects: Project[] = useMemo(
		() => projectsData?.pages.flatMap((p) => p.items) ?? [],
		[projectsData],
	);

	const catalogProjectIds = useMemo(
		() =>
			draft.projectIds.length > 0
				? draft.projectIds
				: projects.map((p) => p.id).slice(0, 30),
		[draft.projectIds, projects],
	);

	const statusQueries = useQueries({
		queries: catalogProjectIds.map((id) => taskStatusesQueryOptions(id)),
	});
	const typeQueries = useQueries({
		queries: catalogProjectIds.map((id) => taskTypesQueryOptions(id)),
	});

	const statusGroups = useMemo(
		() =>
			groupByCanonicalName(
				statusQueries.flatMap((q) =>
					(q.data ?? []).map((s) => ({ id: s.id, name: s.name })),
				),
			),
		[statusQueries],
	);
	const typeGroups = useMemo(
		() =>
			groupByCanonicalName(
				typeQueries.flatMap((q) =>
					(q.data ?? []).map((ty) => ({ id: ty.id, name: ty.name })),
				),
			),
		[typeQueries],
	);

	const statusOptions = useMemo(
		() => statusGroups.map((g) => ({ id: g.key, label: g.label })),
		[statusGroups],
	);
	const typeOptions = useMemo(
		() => typeGroups.map((g) => ({ id: g.key, label: g.label })),
		[typeGroups],
	);

	const statusIdsByKey = useMemo(
		() => Object.fromEntries(statusGroups.map((g) => [g.key, g.ids])),
		[statusGroups],
	);
	const taskTypeIdsByKey = useMemo(
		() => Object.fromEntries(typeGroups.map((g) => [g.key, g.ids])),
		[typeGroups],
	);

	// Load human members from catalog projects (first page each) for Assigned To.
	const { data: assigneeOptions = [] } = useQuery({
		queryKey: ["global-task-filter", "assignees", catalogProjectIds],
		queryFn: async () => {
			const pages = await Promise.all(
				catalogProjectIds.map((id) =>
					listProjectMembers(id, { pageSize: 50, memberType: "human" }),
				),
			);
			const byUser = new Map<string, string>();
			for (const page of pages) {
				for (const m of page.items) {
					if (!m.user_id || byUser.has(m.user_id)) continue;
					byUser.set(
						m.user_id,
						m.full_name?.trim() || m.username || m.user_id,
					);
				}
			}
			return [...byUser.entries()].map(([id, label]) => ({ id, label }));
		},
		enabled: catalogProjectIds.length > 0,
		staleTime: 30_000,
	});

	const set = <K extends keyof GlobalTaskFilterDraft>(
		key: K,
		value: GlobalTaskFilterDraft[K],
	) => setDraft((d) => ({ ...d, [key]: value }));

	const memberLabelsById = useMemo(
		() => Object.fromEntries(assigneeOptions.map((o) => [o.id, o.label])),
		[assigneeOptions],
	);

	return (
		<Collapsible open={filtersOpen} onOpenChange={setFiltersOpen}>
			<div className="rounded-xl border border-border/60 bg-card">
				<CollapsibleTrigger
					type="button"
					className={cn(
						"flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/30",
						filtersOpen && "border-b border-border/40",
					)}
				>
					<Filter className="size-3.5 shrink-0 text-muted-foreground" />
					<span className="flex-1 text-sm font-medium">
						{t("home.globalTaskFilter.toggleLabel")}
					</span>
					{applied ? (
						<span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
							{t("home.globalTaskFilter.activeBadge")}
						</span>
					) : null}
					<ChevronDown
						className={cn(
							"size-4 shrink-0 text-muted-foreground transition-transform",
							filtersOpen && "rotate-180",
						)}
					/>
				</CollapsibleTrigger>

				<CollapsibleContent>
					<div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
						<div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
							<Label className="text-xs">
								{t("home.globalTaskFilter.project")}
							</Label>
							<MultiSelectPills
								options={projects.map((p) => ({ id: p.id, label: p.name }))}
								selected={draft.projectIds}
								onChange={(projectIds) => set("projectIds", projectIds)}
								emptyLabel={t("home.globalTaskFilter.noProjects")}
							/>
						</div>

						<div className="space-y-1.5">
							<Label className="text-xs">
								{t("home.globalTaskFilter.taskType")}
							</Label>
							<MultiSelectPills
								options={typeOptions}
								selected={draft.taskTypeIds}
								onChange={(taskTypeIds) => set("taskTypeIds", taskTypeIds)}
								emptyLabel={t("home.globalTaskFilter.noOptions")}
							/>
						</div>

						<div className="space-y-1.5">
							<Label className="text-xs">
								{t("home.globalTaskFilter.status")}
							</Label>
							<MultiSelectPills
								options={statusOptions}
								selected={draft.statusIds}
								onChange={(statusIds) => set("statusIds", statusIds)}
								emptyLabel={t("home.globalTaskFilter.noOptions")}
							/>
						</div>

						<div className="space-y-1.5">
							<Label className="text-xs">
								{t("home.globalTaskFilter.assignedTo")}
							</Label>
							<SearchableUserMultiSelect
								options={assigneeOptions}
								selected={draft.assigneeUserIds}
								onChange={(assigneeUserIds) =>
									set("assigneeUserIds", assigneeUserIds)
								}
								placeholder={t("home.globalTaskFilter.userSelectPlaceholder")}
								emptyLabel={t("home.globalTaskFilter.noOptions")}
								searchPlaceholder={t(
									"home.globalTaskFilter.userSearchPlaceholder",
								)}
								ariaLabel={t("home.globalTaskFilter.assignedTo")}
							/>
						</div>

						<div className="space-y-1.5">
							<Label className="text-xs">
								{t("home.globalTaskFilter.importance")}
							</Label>
							<div className="flex flex-wrap gap-1.5">
								{PRIORITY_LEVELS.map((level) => {
									const active = draft.importanceBuckets.includes(level.value);
									return (
										<button
											key={level.value}
											type="button"
											onClick={() =>
												set(
													"importanceBuckets",
													toggleNum(draft.importanceBuckets, level.value),
												)
											}
											className={cn(
												"rounded-md border px-2 py-0.5 text-xs transition-colors",
												active
													? "border-primary/40 bg-primary/10 text-primary"
													: "border-border/60 text-muted-foreground hover:border-border",
											)}
										>
											{t(level.labelKey, { ns: "projects" })}
										</button>
									);
								})}
							</div>
						</div>

						<div className="space-y-1.5">
							<Label className="text-xs">
								{t("home.globalTaskFilter.priority")}
							</Label>
							<MultiSelectPills
								options={PRIORITY_OPTIONS.map((v) => ({ id: v, label: v }))}
								selected={draft.priorityValues}
								onChange={(priorityValues) =>
									set("priorityValues", priorityValues)
								}
								emptyLabel=""
							/>
						</div>

						<div className="space-y-1.5">
							<Label className="text-xs">
								{t("home.globalTaskFilter.tags")}
							</Label>
							<Input
								value={draft.tags}
								onChange={(e) => set("tags", e.target.value)}
								placeholder={t("home.globalTaskFilter.tagsPlaceholder")}
								className="h-8 text-xs"
							/>
						</div>

						<div className="space-y-1.5">
							<Label className="text-xs">
								{t("home.globalTaskFilter.qaBy")}
							</Label>
							<SearchableUserMultiSelect
								options={assigneeOptions}
								selected={draft.qaByUserIds}
								onChange={(qaByUserIds) => set("qaByUserIds", qaByUserIds)}
								placeholder={t("home.globalTaskFilter.userSelectPlaceholder")}
								emptyLabel={t("home.globalTaskFilter.noOptions")}
								searchPlaceholder={t(
									"home.globalTaskFilter.userSearchPlaceholder",
								)}
								ariaLabel={t("home.globalTaskFilter.qaBy")}
							/>
						</div>

						<div className="space-y-1.5">
							<Label className="text-xs">
								{t("home.globalTaskFilter.created")}
							</Label>
							<DateRangeFields
								from={draft.createdAfter}
								to={draft.createdBefore}
								onFrom={(v) => set("createdAfter", v)}
								onTo={(v) => set("createdBefore", v)}
								fromLabel={t("home.globalTaskFilter.from")}
								toLabel={t("home.globalTaskFilter.to")}
							/>
						</div>

						<div className="space-y-1.5">
							<Label className="text-xs">
								{t("home.globalTaskFilter.updated")}
							</Label>
							<DateRangeFields
								from={draft.updatedAfter}
								to={draft.updatedBefore}
								onFrom={(v) => set("updatedAfter", v)}
								onTo={(v) => set("updatedBefore", v)}
								fromLabel={t("home.globalTaskFilter.from")}
								toLabel={t("home.globalTaskFilter.to")}
							/>
						</div>

						<div className="space-y-1.5">
							<Label className="text-xs">
								{t("home.globalTaskFilter.devCompleted")}
							</Label>
							<DateRangeFields
								from={draft.devCompletedAfter}
								to={draft.devCompletedBefore}
								onFrom={(v) => set("devCompletedAfter", v)}
								onTo={(v) => set("devCompletedBefore", v)}
								fromLabel={t("home.globalTaskFilter.from")}
								toLabel={t("home.globalTaskFilter.to")}
							/>
						</div>

						<div className="space-y-1.5">
							<Label className="text-xs">
								{t("home.globalTaskFilter.qaStart")}
							</Label>
							<DateRangeFields
								from={draft.qaStartAfter}
								to={draft.qaStartBefore}
								onFrom={(v) => set("qaStartAfter", v)}
								onTo={(v) => set("qaStartBefore", v)}
								fromLabel={t("home.globalTaskFilter.from")}
								toLabel={t("home.globalTaskFilter.to")}
							/>
						</div>

						<div className="space-y-1.5">
							<Label className="text-xs">
								{t("home.globalTaskFilter.qaEnd")}
							</Label>
							<DateRangeFields
								from={draft.qaEndAfter}
								to={draft.qaEndBefore}
								onFrom={(v) => set("qaEndAfter", v)}
								onTo={(v) => set("qaEndBefore", v)}
								fromLabel={t("home.globalTaskFilter.from")}
								toLabel={t("home.globalTaskFilter.to")}
							/>
						</div>
					</div>

					<div className="flex items-center justify-end gap-2 border-t border-border/40 px-4 py-3">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="gap-1.5"
							onClick={() => {
								setDraft(EMPTY_GLOBAL_FILTER);
								onClear();
							}}
						>
							<RotateCcw className="size-3.5" />
							{t("home.globalTaskFilter.clear")}
						</Button>
						<Button
							type="button"
							size="sm"
							className="gap-1.5"
							onClick={() =>
								onApply(
									draftToSearchOptions(draft, {
										memberLabelsById,
										statusIdsByKey,
										taskTypeIdsByKey,
									}),
								)
							}
						>
							<Search className="size-3.5" />
							{applied
								? t("home.globalTaskFilter.update")
								: t("home.globalTaskFilter.apply")}
						</Button>
					</div>
				</CollapsibleContent>
			</div>
		</Collapsible>
	);
}
