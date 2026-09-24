import { formatPrice } from "@acme/utils/price";

export function cartTotal(items: { cents: number }[]): string {
	return formatPrice(items.reduce((sum, item) => sum + item.cents, 0));
}
