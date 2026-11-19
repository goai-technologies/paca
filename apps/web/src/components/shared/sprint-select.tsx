import { useState } from "react";
import { SearchableList } from "@/components/projects/interactions/task-detail/property-field/searchable-list";
import { RemoteSelect } from "@/components/shared/remote-select";
import { useSprintSearch } from "@/hooks/use-sprint-search";
import type { SprintStatus } from "@/lib/interaction-api";
import { useSprintDirectory } from "@/lib/sprint-directory";

/** Single-select sprint dropdown for forms. The current value is resolved by
 *  id, and the options are searched and paged on the server once the popover
 *  opens, so it works for any number of sprints. `value` is a sprint id; ""
 *  means none (or the backlog, when `emptyLabel` is given). */
export function SprintSelect({
	projectId,
	value,
	onChange,
	disabled,
	placeholder,
	emptyLabel,
	status,
	className,
}: {
	projectId: string;
	value: string;
	onChange: (sprintId: string) => void;
	disabled?: boolean;
	placeholder?: string;
	/** Adds a pinned row that selects "" (e.g. "Product backlog"). */
	emptyLabel?: string;
	/** Offer only sprints in these statuses. */
	status?: SprintStatus[];
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const getSprint = useSprintDirectory(projectId);
	const search = useSprintSearch(projectId, open && !disabled, { status });
	const label = value ? (getSprint(value)?.name ?? "") : emptyLabel;

	return (
		<RemoteSelect
			open={open}
			onOpenChange={setOpen}
			disabled={disabled}
			className={className}
			label={label}
			placeholder={placeholder}
		>
			<SearchableList
				remote={search}
				pinned={
					emptyLabel ? (
						<button
							type="button"
							className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm hover:bg-muted/60 transition-colors duration-100"
							onClick={() => {
								onChange("");
								setOpen(false);
							}}
						>
							{emptyLabel}
						</button>
					) : undefined
				}
				items={search.sprints.map((s) => ({
					key: s.id,
					label: s.name,
					selected: s.id === value,
					onSelect: () => {
						onChange(s.id);
						setOpen(false);
					},
					content: <span className="flex-1 truncate text-left">{s.name}</span>,
				}))}
			/>
		</RemoteSelect>
	);
}
