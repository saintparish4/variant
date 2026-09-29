/**
 * @module
 * A seeded pseudo-random source for property tests. Hand-rolled rather than
 * `fast-check`: the properties here need a generator and a fixed list of
 * seeds, not shrinking, and a failure names its seed, which reproduces it
 * exactly.
 */

export interface Random {
	/** Integer in [min, max], inclusive. */
	int(min: number, max: number): number;
	/** True with probability `p`. */
	chance(p: number): boolean;
	pick<T>(items: readonly T[]): T;
	shuffle<T>(items: readonly T[]): T[];
}

/** mulberry32: small, fast, and good enough to vary test inputs. */
export function seededRandom(seed: number): Random {
	let state = seed >>> 0;
	const next = (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
	const int = (min: number, max: number): number =>
		min + Math.floor(next() * (max - min + 1));
	return {
		int,
		chance: (p) => next() < p,
		pick: <T>(items: readonly T[]): T => {
			const item = items[int(0, items.length - 1)];
			if (item === undefined) throw new Error("pick from an empty list");
			return item;
		},
		shuffle: <T>(items: readonly T[]): T[] => {
			const out = [...items];
			for (let i = out.length - 1; i > 0; i--) {
				const j = int(0, i);
				const a = out[i] as T;
				out[i] = out[j] as T;
				out[j] = a;
			}
			return out;
		},
	};
}

/** Seeds 1..count, so a run is the same on every machine. */
export function seeds(count: number): number[] {
	return Array.from({ length: count }, (_, i) => i + 1);
}
