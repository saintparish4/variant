# `variant check` demo, with Jest

The example from the README, tested with Jest ([`check-demo`](../check-demo) is
the Vitest one): a discount rule whose tests pass, and miss its boundary. It
takes about a minute, most of it installing.

```bash
cp -r examples/check-demo-jest /tmp/check-demo-jest && cd /tmp/check-demo-jest
npm install
npm install -D @blzsky/variant@canary

git init -q
git add .gitignore package.json babel.config.js && git commit -qm "project setup"
git add src                              # the change you are about to commit

npx @blzsky/variant check
```

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

variant's own test suite runs this demo (`src/__tests__/integration/check.integration.test.ts`).
