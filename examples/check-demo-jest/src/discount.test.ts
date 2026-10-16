import { qualifiesForDiscount } from "./discount";

describe("qualifiesForDiscount", () => {
	it("rejects a small order", () => {
		expect(qualifiesForDiscount(50)).toBe(false);
	});

	it("accepts a large order", () => {
		expect(qualifiesForDiscount(150)).toBe(true);
	});
});
