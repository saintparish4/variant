import { expect, test } from "vitest";
import { postUrl } from "./post";

test("builds a post URL from its title", () => {
	expect(postUrl("Hello World")).toBe("/blog/hello-world");
});
