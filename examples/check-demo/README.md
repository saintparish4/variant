# `variant check` demo

The example from the README: a discount rule whose tests pass, and miss its
boundary. It takes about a minute, most of it installing.

```bash
cp -r examples/check-demo /tmp/check-demo && cd /tmp/check-demo
npm install
npm install -D @blzsky/variant          # once check is released; see below

git init -q
git add package.json vitest.config.ts && git commit -qm "project setup"
git add src                              # the change you are about to commit

npx @blzsky/variant check
```

Until `check` is released, build this repository (`pnpm install && pnpm build`)
and run `node /path/to/variant/dist/cli.js check` in place of `npx`.

It reports one mutation the tests did not notice:

```
Undetected: 1
  src/discount.ts:3:9  in qualifiesForDiscount
    - total >= 100
    + total > 100
    Changing >= to > went undetected. Review the behavior at total = 100.
```

The tests check 50 and 150, and both pass whether the rule is `>=` or `>`. Add a
test at the boundary to `src/discount.test.ts`:

```ts
	it("accepts an order of exactly 100", () => {
		expect(qualifiesForDiscount(100)).toBe(true);
	});
```

and run it again:

```
All 4 mutations were detected by the tests that ran.
That is evidence these tests check these lines, not proof the change is correct.
```

Your working tree is as you left it: `git status` shows the staged files and the
unstaged test, nothing else.

variant's own test suite runs this demo (`src/__tests__/e2e/check.e2e.test.ts`).
