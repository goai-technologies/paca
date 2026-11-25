import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	listWorkspaceTagSuggestions,
	workspaceTagSuggestionsQueryKey,
} from "@/lib/tag-suggestions";
import { ChipField } from "./chip-field";

/**
 * Chip editor for tags with type-to-create and a suggestion list of tags
 * already used on cards in this project and across accessible projects.
 */
export function TagSuggestionsField({
	tags,
	projectId,
	canEdit,
	addLabel,
	placeholder,
	onChange,
}: {
	tags: string[];
	projectId?: string;
	canEdit: boolean;
	addLabel: string;
	placeholder: string;
	onChange?: (tags: string[]) => void;
}) {
	const { t } = useTranslation("projects");
	const [input, setInput] = useState("");

	const { data: workspaceTags = [] } = useQuery({
		queryKey: workspaceTagSuggestionsQueryKey(projectId ?? ""),
		queryFn: () => {
			if (!projectId) {
				throw new Error("projectId is required to list tag suggestions");
			}
			return listWorkspaceTagSuggestions(projectId);
		},
		enabled: Boolean(projectId) && canEdit,
		staleTime: 30_000,
	});

	const trimmedInput = input.trim();

	const suggestions = useMemo(() => {
		const needle = trimmedInput.toLowerCase();
		return workspaceTags
			.filter(
				(tag) =>
					!tags.some((current) => current.toLowerCase() === tag.toLowerCase()),
			)
			.filter((tag) => !needle || tag.toLowerCase().includes(needle));
	}, [workspaceTags, tags, trimmedInput]);

	const exactMatch = workspaceTags.find(
		(tag) => tag.toLowerCase() === trimmedInput.toLowerCase(),
	);
	const alreadyOnTask = tags.some(
		(tag) => tag.toLowerCase() === trimmedInput.toLowerCase(),
	);
	const canCreate = trimmedInput.length > 0 && !alreadyOnTask && !exactMatch;

	function handleAdd(tag: string) {
		const trimmed = tag.trim();
		if (!trimmed) return;
		const existing = workspaceTags.find(
			(workspaceTag) => workspaceTag.toLowerCase() === trimmed.toLowerCase(),
		);
		const value = existing ?? trimmed;
		if (tags.some((current) => current.toLowerCase() === value.toLowerCase())) {
			return;
		}
		onChange?.([...tags, value]);
		setInput("");
	}

	function handleRemove(tag: string) {
		onChange?.(tags.filter((current) => current !== tag));
	}

	return (
		<ChipField
			chips={tags.map((tag) => ({ key: tag, label: tag }))}
			onRemoveChip={handleRemove}
			canEdit={canEdit}
			addLabel={addLabel}
			popoverContentClassName="w-64 p-2 rounded-xl border border-border/40 shadow-lg"
		>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					handleAdd(input);
				}}
			>
				<input
					// biome-ignore lint/a11y/noAutofocus: intentional for popover
					autoFocus
					type="text"
					value={input}
					onChange={(e) => setInput(e.target.value)}
					placeholder={placeholder}
					className="w-full rounded-lg border border-border/30 bg-muted/25 px-3 py-2 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-all duration-150"
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							e.stopPropagation();
							handleAdd(input);
						}
					}}
				/>
			</form>

			{(suggestions.length > 0 || canCreate) && (
				<ul className="mt-1.5 max-h-48 overflow-y-auto rounded-lg border border-border/25 bg-muted/15 py-1">
					{suggestions.map((tag) => (
						<li key={tag}>
							<button
								type="button"
								onMouseDown={(e) => {
									e.preventDefault();
									handleAdd(tag);
								}}
								className="flex w-full items-center px-3 py-1.5 text-left text-sm text-foreground/90 hover:bg-muted/50 transition-colors duration-150"
							>
								{tag}
							</button>
						</li>
					))}
					{canCreate && (
						<li>
							<button
								type="button"
								onMouseDown={(e) => {
									e.preventDefault();
									handleAdd(trimmedInput);
								}}
								className="flex w-full items-center px-3 py-1.5 text-left text-sm font-medium text-primary hover:bg-muted/50 transition-colors duration-150"
							>
								{t("taskDetail.propertyField.tagsEditor.createTag", {
									tag: trimmedInput,
								})}
							</button>
						</li>
					)}
				</ul>
			)}
		</ChipField>
	);
}
