import { Key, Shield } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Separator } from "@/components/ui/separator";

interface GlobalRolesStatsProps {
	rolesCount: number;
	/** Permission grants across every role; undefined while only some roles
	 *  are loaded (the sum would be misleading), which hides the figure. */
	totalGranted?: number;
}

export function GlobalRolesStats({
	rolesCount,
	totalGranted,
}: GlobalRolesStatsProps) {
	const { t } = useTranslation("admin");

	return (
		<div className="flex items-center gap-5 rounded-xl border bg-muted/20 px-5 py-3">
			<div className="flex items-center gap-2">
				<Shield className="size-4 text-primary" />
				<span className="text-sm">
					<span className="font-semibold tabular-nums">{rolesCount}</span>
					<span className="ml-1.5 text-muted-foreground">
						{t("globalRoles.stats.roleCount", { count: rolesCount })}{" "}
						{t("globalRoles.stats.defined")}
					</span>
				</span>
			</div>
			{totalGranted !== undefined ? (
				<>
					<Separator orientation="vertical" className="h-4" />
					<div className="flex items-center gap-2">
						<Key className="size-4 text-muted-foreground" />
						<span className="text-sm">
							<span className="font-semibold tabular-nums">{totalGranted}</span>
							<span className="ml-1.5 text-muted-foreground">
								{t("globalRoles.stats.permissionGrants")}
							</span>
						</span>
					</div>
				</>
			) : null}
		</div>
	);
}
