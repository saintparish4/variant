import { expect, test } from "vitest";
import { cartTotal } from "./cart";

test("totals the cart", () => {
	expect(cartTotal([{ cents: 500 }, { cents: 750 }])).toBe("$12.50");
});
