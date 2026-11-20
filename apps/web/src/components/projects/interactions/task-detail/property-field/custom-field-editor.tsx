import { useQuery } from "@tanstack/react-query";
import { CalendarDays } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
	type CustomFieldOption,
	projectMembersListQueryOptions,
} from "@/lib/project-api";
import { FieldValue } from "../primitives";
import { CheckboxEditor } from "./checkbox-editor";
import { SingleDateEditor } from "./date-editor";
import { displayDate } from "./helpers";
import { LongTextEditor } from "./long-text-editor";
import { MultiSelectEditor } from "./multi-select-editor";
import { NumberEditor } from "./number-editor";
import { SelectEditor } from "./select-editor";
import { TextEditor } from "./text-editor";
import type { SelectOption } from "./types";
import { UrlEditor } from "./url-editor";

export function CustomFieldEditor({
	customType,
	rawValue,
	canEdit,
	options = [],
	optionSource = "manual",
	projectId,
	rows,
	onChange,
}: {
	customType:
		| "Text"
		| "Number"
		| "Date"
		| "Checkbox"
		| "Select"
		| "MultiSelect"
		| "Url"
		| "LongText";
	rawValue: unknown;
	canEdit: boolean;
	options?: CustomFieldOption[];
	optionSource?: string;
	projectId?: string;
	rows?: number;
	onChange?: (value: unknown) => void;
}) {
	const { t } = useTranslation("projects");

	const isMembersSource = optionSource === "project_members";
	const { data: members = [] } = useQuery({
		...projectMembersListQueryOptions(projectId ?? ""),
		enabled: Boolean(projectId) && isMembersSource,
	});

	switch (customType) {
		case "Text":
			return (
				<TextEditor
					value={rawValue != null ? String(rawValue) : null}
					canEdit={canEdit}
					onChange={(v) => onChange?.(v)}
				/>
			);
		case "Number": {
			const num =
				typeof rawValue === "number" ? rawValue : Number(rawValue) || 0;
			if (!canEdit) {
				return (
					<span className="text-sm tabular-nums font-medium text-foreground">
						{num}
					</span>
				);
			}
			return <NumberEditor value={num} onChange={(v) => onChange?.(v)} />;
		}
		case "Date":
			if (!canEdit) {
				return (
					<span className="inline-flex items-center gap-1.5 rounded-lg border border-border/25 bg-muted/25 px-2.5 py-1.5 text-xs text-muted-foreground font-medium">
						<CalendarDays className="size-3 shrink-0 opacity-70" />
						{displayDate(rawValue as string | null) ??
							t("taskDetail.common.empty")}
					</span>
				);
			}
			return (
				<SingleDateEditor
					value={rawValue as string | null}
					onChange={(v) => onChange?.(v)}
				/>
			);
		case "Checkbox":
			return (
				<CheckboxEditor
					checked={Boolean(rawValue)}
					canEdit={canEdit}
					onChange={(v) => onChange?.(v)}
				/>
			);
		case "Select": {
			const selectOptions: SelectOption[] = isMembersSource
				? members.map((m) => {
						const name = m.full_name || m.username;
						return {
							value: name,
							label: name,
							hint: m.full_name && m.username ? `@${m.username}` : undefined,
						};
					})
				: options.map((o) => ({
						value: o.value,
						label: o.value,
						colorDot: o.color ?? undefined,
					}));

			const currentRaw = rawValue != null ? String(rawValue) : null;
			let resolvedVal = currentRaw;
			if (isMembersSource && currentRaw) {
				const match = members.find(
					(m) =>
						m.id === currentRaw ||
						m.user_id === currentRaw ||
						(m.full_name || m.username) === currentRaw,
				);
				if (match) {
					resolvedVal = match.full_name || match.username;
				}
			}

			if (!canEdit) {
				return <FieldValue empty={!resolvedVal}>{resolvedVal}</FieldValue>;
			}
			return (
				<SelectEditor
					value={resolvedVal}
					options={selectOptions}
					onChange={(v) => onChange?.(v)}
				/>
			);
		}
		case "MultiSelect": {
			const selectOptions: SelectOption[] = isMembersSource
				? members.map((m) => {
						const name = m.full_name || m.username;
						return {
							value: name,
							label: name,
							hint: m.full_name && m.username ? `@${m.username}` : undefined,
						};
					})
				: options.map((o) => ({
						value: o.value,
						label: o.value,
						colorDot: o.color ?? undefined,
					}));

			const rawArr = Array.isArray(rawValue)
				? rawValue.filter((v): v is string => typeof v === "string")
				: typeof rawValue === "string" && rawValue
					? [rawValue]
					: [];

			const currentVal = isMembersSource
				? rawArr.map((v) => {
						const match = members.find(
							(m) =>
								m.id === v ||
								m.user_id === v ||
								(m.full_name || m.username) === v,
						);
						return match ? match.full_name || match.username : v;
					})
				: rawArr;

			return (
				<MultiSelectEditor
					value={currentVal}
					options={selectOptions}
					canEdit={canEdit}
					onChange={(v) => onChange?.(v)}
				/>
			);
		}
		case "LongText":
			return (
				<LongTextEditor
					value={rawValue != null ? String(rawValue) : null}
					canEdit={canEdit}
					rows={rows}
					onChange={(v) => onChange?.(v)}
				/>
			);
		case "Url":
			return (
				<UrlEditor
					value={rawValue != null ? String(rawValue) : null}
					canEdit={canEdit}
					onChange={(v) => onChange?.(v)}
				/>
			);
	}
}
