/** Orders of 100 or more get the discount. */
export function qualifiesForDiscount(total: number): boolean {
	return total >= 100;
}
