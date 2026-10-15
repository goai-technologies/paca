import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLink, Search, Target, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	commitmentCatalogAllQueryOptions,
	commitmentCatalogQueryOptions,
} from "@/lib/commitment-api";
import type { Task } from "@/lib/interaction-api";
import { FieldRow } from "./primitives";

interface CommitmentFieldProps {
	task: Task;
	canEdit: boolean;
	/** True when the task's parent carries the commitment — the field is then read-only. */
	inherited: boolean;
	onChange: (commitmentTaskId: string | null) => void;
}

/**
 * The Commitment picker on a ticket. Lists the OPEN commitments of the
 * workspace's Commitments project (any project may attach to them), with a
 * search box because the catalog spans every customer. A ticket under a
 * parent shows the inherited value and cannot change it: membership is set
 * once, on the top-level ticket, and everything beneath follows.
 */
export function CommitmentField({
	task,
	canEdit,
	inherited,
	onChange,
}: CommitmentFieldProps) {
	const { t } = useTranslation("projects");
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");

	const { data: openCatalog, isLoading } = useQuery({
		...commitmentCatalogQueryOptions(search.trim()),
		enabled: open,
	});
	// The full catalog (closed included) only to LABEL the current value — a
	// ticket keeps its commitment after that commitment closes.
	const { data: allCatalog } = useQuery({
		...commitmentCatalogAllQueryOptions(),
		enabled: !!task.commitment_task_id,
	});

	const current = task.commitment_task_id
		? allCatalog?.items.find((c) => c.id === task.commitment_task_id)
		: undefined;
	const options = (openCatalog?.items ?? []).filter(
		(c) => c.id !== task.commitment_task_id,
	);

	const label = current ? (
		<>
			<Target className="size-3.5 shrink-0 text-sky-600/80" />
			<span className="truncate text-foreground/80">
				<span className="font-mono text-xs text-muted-foreground mr-1.5">
					{current.ref}
				</span>
				{current.title}
			</span>
		</>
	) : task.commitment_task_id ? (
		<span className="text-muted-foreground/70 italic">
			{t("taskDetail.commitment.loading")}
		</span>
	) : (
		<span className="text-muted-foreground/50 italic">
			{t("taskDetail.properties.none")}
		</span>
	);

	const openCommitment = () => {
		if (!current) return;
		navigate({
			to: "/projects/$projectId/tasks/$taskId",
			params: { projectId: current.project_id, taskId: current.id },
		});
	};

	if (inherited || !canEdit) {
		return (
			<FieldRow label={t("taskDetail.commitment.label")}>
				<button
					type="button"
					onClick={openCommitment}
					disabled={!current}
					title={
						inherited ? t("taskDetail.commitment.inheritedHint") : undefined
					}
					className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium -ml-2 max-w-72 truncate hover:bg-muted/50 disabled:hover:bg-transparent"
				>
					{label}
					{inherited && (
						<span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
							{t("taskDetail.commitment.inherited")}
						</span>
					)}
				</button>
			</FieldRow>
		);
	}

	return (
		<FieldRow label={t("taskDetail.commitment.label")}>
			<DropdownMenu open={open} onOpenChange={setOpen}>
				<DropdownMenuTrigger className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium hover:bg-muted/50 transition-colors duration-150 cursor-pointer -ml-2 max-w-72 truncate">
					{label}
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="w-80">
					<div className="flex items-center gap-2 px-2 py-1.5">
						<Search className="size-3.5 shrink-0 text-muted-foreground" />
						<input
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder={t("taskDetail.commitment.searchPlaceholder")}
							className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
							onKeyDown={(e) => e.stopPropagation()}
						/>
					</div>
					<DropdownMenuSeparator />
					{current && (
						<>
							<DropdownMenuItem onClick={openCommitment}>
								<ExternalLink className="size-3.5 mr-2 shrink-0" />
								{t("taskDetail.commitment.open")}
							</DropdownMenuItem>
							<DropdownMenuItem
								className="text-destructive focus:text-destructive"
								onClick={() => onChange(null)}
							>
								<X className="size-3.5 mr-2 shrink-0" />
								{t("taskDetail.commitment.remove")}
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
							{t("taskDetail.commitment.empty")}
						</div>
					) : (
						<div className="max-h-72 overflow-y-auto">
							{options.map((c) => (
								<DropdownMenuItem
									key={c.id}
									onClick={() => onChange(c.id)}
									className="flex flex-col items-start gap-0.5"
								>
									<span className="flex w-full items-center gap-2">
										<span className="font-mono text-xs text-muted-foreground">
											{c.ref}
										</span>
										<span className="truncate">{c.title}</span>
									</span>
									{c.status_name && (
										<span className="text-[11px] text-muted-foreground">
											{c.status_name}
										</span>
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
