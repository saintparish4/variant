import { expect, test } from "vitest";
import { slugify } from "./slug";

test("lowercases and hyphenates", () => {
	expect(slugify("Hello World")).toBe("hello-world");
});
