import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { SearchableList } from "@/components/projects/interactions/task-detail/property-field/searchable-list";
import { RemoteSelect } from "@/components/shared/remote-select";
import {
	useEnvironmentFolderSearch,
	useEnvironmentSearch,
} from "@/hooks/use-environment-search";
import {
	type Environment,
	environmentFolderQueryOptions,
	environmentQueryOptions,
} from "@/lib/environment-api";
import { EnvironmentCreateDialog } from "./environment-create-dialog";
import { FolderCreateDialog } from "./folder-create-dialog";

// DefaultEnvironmentSelect / DefaultFolderSelect are the shared "pick a
// default environment/folder for this agent" pair — one implementation
// instead of the three that used to exist independently (create-agent-
// dialog.tsx's LLM and provider_cli forms, agent-detail.tsx's OverviewTab),
// which had drifted: only the OverviewTab copy offered a "create new
// environment/folder" escape hatch, the other two silently required the
// project to already have one.
//
// Deliberately NOT unified with agent-picker.tsx's EnvironmentPickerInline/
// FolderPickerInline — those back a different concept (a per-conversation
// override in the chat composer, pill-styled, worded "temporary" instead
// of "no default", and auto-selected from the agent's own default via
// effects) rather than a settings-form "default" field. They do reuse the
// same EnvironmentCreateDialog/FolderCreateDialog underneath, same as here.
//
// Callers keep owning their own environmentId/folderId state (and the
// "picking a new environment clears the previously-picked folder" rule —
// a folder only ever belongs to one environment) since that state also
// feeds each caller's own dirty-checking/save-payload logic; only the
// Select markup and create-dialog wiring are shared here.

/** Row that opens a "create new…" dialog, pinned above the search results. */
export function PinnedRow({
	onSelect,
	selected,
	children,
}: {
	onSelect: () => void;
	selected?: boolean;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm hover:bg-muted/60 transition-colors duration-100"
			onClick={onSelect}
			aria-pressed={selected}
		>
			{children}
		</button>
	);
}

/** Name of an environment looked up by id (cached), for a select's trigger. */
export function useEnvironmentName(projectId: string, environmentId: string) {
	const { data } = useQuery({
		...environmentQueryOptions(projectId, environmentId),
		enabled: !!projectId && !!environmentId,
	});
	return data?.name;
}

/** Path of a folder looked up by id (cached), for a select's trigger. */
export function useFolderPath(
	projectId: string,
	environmentId: string,
	folderId: string,
) {
	const { data } = useQuery({
		...environmentFolderQueryOptions(projectId, environmentId, folderId),
		enabled: !!projectId && !!environmentId && !!folderId,
	});
	return data?.path;
}

export function DefaultEnvironmentSelect({
	projectId,
	value,
	onChange,
	required = false,
	disabled,
	className,
}: {
	projectId: string;
	value: string;
	onChange: (id: string) => void;
	/** Omits the "no default environment" option and shows a placeholder
	 * instead — for agent types (provider_cli) that require one. */
	required?: boolean;
	disabled?: boolean;
	className?: string;
}) {
	const { t } = useTranslation("projects");
	const [open, setOpen] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const search = useEnvironmentSearch(projectId, open && !disabled);
	const name = useEnvironmentName(projectId, value);

	return (
		<>
			<RemoteSelect
				open={open}
				onOpenChange={setOpen}
				disabled={disabled}
				className={className}
				label={
					value
						? name
						: required
							? undefined
							: t("agents.detail.overview.noDefaultEnvironment")
				}
				placeholder={
					required ? t("agents.createDialog.environmentPlaceholder") : undefined
				}
			>
				<SearchableList
					remote={search}
					pinned={
						<>
							{!required && (
								<PinnedRow
									onSelect={() => {
										onChange("");
										setOpen(false);
									}}
								>
									{t("agents.detail.overview.noDefaultEnvironment")}
								</PinnedRow>
							)}
							<PinnedRow
								onSelect={() => {
									setOpen(false);
									setCreateOpen(true);
								}}
							>
								<Plus className="size-3.5" />
								{t("environments.picker.createNew")}
							</PinnedRow>
						</>
					}
					items={search.environments.map((env) => ({
						key: env.id,
						label: env.name,
						selected: env.id === value,
						onSelect: () => {
							onChange(env.id);
							setOpen(false);
						},
						content: (
							<span className="flex-1 truncate text-left">{env.name}</span>
						),
					}))}
				/>
			</RemoteSelect>
			<EnvironmentCreateDialog
				projectId={projectId}
				open={createOpen}
				onOpenChange={setCreateOpen}
				onCreated={(env) => onChange(env.id)}
			/>
		</>
	);
}

export function DefaultFolderSelect({
	projectId,
	environment,
	value,
	onChange,
	disabled,
	className,
	required = false,
}: {
	projectId: string;
	/** Drops the "no default folder" choice — the caller needs a folder. */
	required?: boolean;
	/** The currently-selected default environment — the folder select has
	 * nothing to offer (and isn't rendered by any caller) without one. */
	environment: Pick<Environment, "id" | "status">;
	value: string;
	onChange: (id: string) => void;
	disabled?: boolean;
	className?: string;
}) {
	const { t } = useTranslation("projects");
	const [open, setOpen] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const search = useEnvironmentFolderSearch(
		projectId,
		environment.id,
		open && !disabled,
	);
	const path = useFolderPath(projectId, environment.id, value);

	return (
		<>
			<RemoteSelect
				open={open}
				onOpenChange={setOpen}
				disabled={disabled}
				className={className}
				label={
					value
						? path
						: required
							? undefined
							: t("agents.detail.overview.noDefaultFolder")
				}
			>
				<SearchableList
					remote={search}
					pinned={
						<>
							{!required && (
								<PinnedRow
									onSelect={() => {
										onChange("");
										setOpen(false);
									}}
								>
									{t("agents.detail.overview.noDefaultFolder")}
								</PinnedRow>
							)}
							<PinnedRow
								onSelect={() => {
									setOpen(false);
									setCreateOpen(true);
								}}
							>
								<Plus className="size-3.5" />
								{t("environments.picker.folderCreateNew")}
							</PinnedRow>
						</>
					}
					items={search.folders.map((folder) => ({
						key: folder.id,
						label: folder.path,
						selected: folder.id === value,
						onSelect: () => {
							onChange(folder.id);
							setOpen(false);
						},
						content: (
							<span className="flex-1 truncate text-left font-mono text-xs">
								{folder.path}
							</span>
						),
					}))}
				/>
			</RemoteSelect>
			<FolderCreateDialog
				projectId={projectId}
				environmentId={environment.id}
				environmentStatus={environment.status}
				open={createOpen}
				onOpenChange={setCreateOpen}
				onCreated={(folder) => onChange(folder.id)}
			/>
		</>
	);
}
