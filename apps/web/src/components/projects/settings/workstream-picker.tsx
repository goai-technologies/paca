import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * The project-level default workstream, stored in projects.settings.
 * "platform" is shown as "PPE"; only the label changed, the stored value
 * did not.
 */
export type Workstream = "delivery" | "platform" | "internal";

/** The three, in the order the picker draws them. */
export const WORKSTREAMS: readonly Workstream[] = [
	"delivery",
	"platform",
	"internal",
];

/**
 * Where a project sits until it says otherwise. Dashboards should read an
 * unset workstream the same way, so a project that never chose is Internal.
 */
export const DEFAULT_WORKSTREAM: Workstream = "internal";

/** Key in `project.settings` — mirrored by the API's validation. */
export const WORKSTREAM_SETTING_KEY = "default_workstream";

/** Read the project's default workstream from its settings map; unset or unrecognised reads as Internal. */
export function readWorkstream(
	settings: Record<string, unknown> | undefined,
): Workstream {
	const raw = settings?.[WORKSTREAM_SETTING_KEY];
	return WORKSTREAMS.find((w) => w === raw) ?? DEFAULT_WORKSTREAM;
}

/**
 * Return a COPY of settings with the workstream set. The project update
 * endpoint replaces the whole settings map, so the caller must always send
 * the merged map — sending `{ default_workstream }` alone would wipe every
 * other key a plugin or the app stored there.
 */
export function withWorkstream(
	settings: Record<string, unknown> | undefined,
	workstream: Workstream,
): Record<string, unknown> {
	return { ...(settings ?? {}), [WORKSTREAM_SETTING_KEY]: workstream };
}

interface WorkstreamPickerProps {
	value: Workstream;
	onChange: (value: Workstream) => void;
	disabled?: boolean;
}

/**
 * Delivery / PPE / Internal — which dashboard this project's
 * commitments default to. A commitment's own Workstream field wins over this;
 * the project value is only the default.
 */
export function WorkstreamPicker({
	value,
	onChange,
	disabled = false,
}: WorkstreamPickerProps) {
	const { t } = useTranslation("projects");
	const options: { value: Workstream; label: string }[] = [
		{ value: "delivery", label: t("workstream.delivery") },
		{ value: "platform", label: t("workstream.platform") },
		{ value: "internal", label: t("workstream.internal") },
	];
	return (
		<div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
			<p className="font-medium text-sm">{t("workstream.label")}</p>
			<p className="text-xs text-muted-foreground mt-0.5 mb-2.5 leading-relaxed">
				{t("workstream.hint")}
			</p>
			<div
				role="radiogroup"
				aria-label={t("workstream.label")}
				className="inline-flex gap-1 rounded-full border border-border/60 bg-background p-1"
			>
				{options.map((o) => {
					const active = value === o.value;
					return (
						// biome-ignore lint/a11y/useSemanticElements: a segmented control reads better than radio inputs here
						<button
							key={o.value}
							type="button"
							role="radio"
							aria-checked={active}
							disabled={disabled}
							onClick={() => onChange(o.value)}
							className={cn(
								"rounded-full px-3.5 py-1 text-xs font-medium transition-colors",
								active
									? "bg-primary text-primary-foreground"
									: "text-muted-foreground hover:text-foreground",
								disabled && "opacity-60 cursor-not-allowed",
							)}
						>
							{o.label}
						</button>
					);
				})}
			</div>
		</div>
	);
}
