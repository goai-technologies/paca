import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export { getInitials } from "./initials";

export function cleanBlocks(
	blocks: unknown[] | null | undefined,
): unknown[] | null {
	if (!blocks || !Array.isArray(blocks)) return null;
	const strip = (arr: unknown[]): unknown[] => {
		return arr.map((item) => {
			if (!item || typeof item !== "object") return item;
			const { id, children, ...rest } = item as Record<string, unknown>;
			const res: Record<string, unknown> = { ...rest };
			if (Array.isArray(children)) {
				res.children = strip(children as unknown[]);
			}
			return res;
		});
	};
	return strip(blocks);
}
