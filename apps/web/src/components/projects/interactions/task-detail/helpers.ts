import type { CustomFieldDefinition, FieldType } from "@/lib/project-api";
import type { CustomFieldDef } from "./types";

export function shortId(id: string): string {
	return id.slice(0, 8).toUpperCase();
}

export function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/\s+/g, "_")
		.replace(/[^a-z0-9_]/g, "")
		.replace(/_+/g, "_")
		.slice(0, 64);
}

const API_TO_UI_FIELD_TYPE: Record<FieldType, CustomFieldDef["field_type"]> = {
	text: "Text",
	number: "Number",
	date: "Date",
	boolean: "Checkbox",
	select: "Select",
	multi_select: "MultiSelect",
	url: "Url",
	long_text: "LongText",
};

const UI_TO_API_FIELD_TYPE: Record<CustomFieldDef["field_type"], FieldType> = {
	Text: "text",
	Number: "number",
	Date: "date",
	Checkbox: "boolean",
	Select: "select",
	MultiSelect: "multi_select",
	Url: "url",
	LongText: "long_text",
};

export function mapApiFieldToUi(
	apiField: CustomFieldDefinition,
): CustomFieldDef {
	return {
		id: apiField.id,
		display_name: apiField.display_name,
		field_key: apiField.field_key,
		field_type: API_TO_UI_FIELD_TYPE[apiField.field_type] ?? "Text",
		required: apiField.is_required,
		options: apiField.options,
		rows: apiField.rows,
	};
}

export function mapUiFieldTypeToApi(
	uiType: CustomFieldDef["field_type"],
): FieldType {
	return UI_TO_API_FIELD_TYPE[uiType];
}
