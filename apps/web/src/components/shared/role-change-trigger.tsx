import { Pencil } from "lucide-react";

import {
	type RoleBadgeData,
	RoleBadgeList,
} from "@/components/shared/role-badge";
import { cn } from "@/lib/utils";

/**
 * A person's role badges as one clickable control that opens the role
 * editor. The pencil and the hover state make it read as editable; the
 * accessible name is the action (`label`) followed by the held roles.
 */
export function RoleChangeTrigger({
	roles,
	label,
	onClick,
	max = 2,
	className,
}: {
	roles: RoleBadgeData[];
	label: string;
	onClick: () => void;
	max?: number;
	className?: string;
}) {
	// The name says what the control does and which roles are held now.
	const accessibleName = roles.length
		? `${label}: ${roles.map((r) => r.name).join(", ")}`
		: label;
	return (
		<button
			type="button"
			onClick={onClick}
			title={label}
			aria-label={accessibleName}
			className={cn(
				"group/role-trigger flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-dashed border-border bg-transparent py-0.5 pr-2 pl-0.5 transition-colors hover:border-primary/50 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				className,
			)}
		>
			<RoleBadgeList roles={roles} max={max} interactive={false} />
			<Pencil
				className="size-3 shrink-0 text-muted-foreground transition-colors group-hover/role-trigger:text-primary"
				aria-hidden="true"
			/>
		</button>
	);
}
