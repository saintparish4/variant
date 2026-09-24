import { slugify } from "@acme/utils/slug";

export function postUrl(title: string): string {
	return `/blog/${slugify(title)}`;
}
