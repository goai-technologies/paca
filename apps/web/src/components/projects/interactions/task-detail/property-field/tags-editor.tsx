import { useTranslation } from "react-i18next";
import { TagSuggestionsField } from "./tag-suggestions-field";

export function TagsEditor({
	tags = [],
	projectId,
	canEdit,
	onChange,
}: {
	tags: string[];
	/** When set, unused tags from this project and other accessible projects are suggested. */
	projectId?: string;
	canEdit: boolean;
	onChange?: (tags: string[]) => void;
}) {
	const { t } = useTranslation("projects");

	return (
		<TagSuggestionsField
			tags={tags}
			projectId={projectId}
			canEdit={canEdit}
			addLabel={t("taskDetail.propertyField.tagsEditor.addTag")}
			placeholder={t("taskDetail.propertyField.tagsEditor.addTagPlaceholder")}
			onChange={onChange}
		/>
	);
}
