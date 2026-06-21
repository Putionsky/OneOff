// Seedable pseudo-random number generator.
//
// A humanized performance leans heavily on randomness (timing jitter, velocity
// variation, note choices). For that randomness to be testable and for a
// performance to be reproducible when desired, we use a small seedable PRNG
// instead of Math.random().

// mulberry32: tiny, fast, good-enough statistical quality for musical jitter.
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  if (a === 0) a = 0x9e3779b9; // avoid the all-zero fixed point
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Uniform float in [min, max).
export function range(rng, min, max) {
  return min + (max - min) * rng();
}

// Approximate standard normal via the central-limit trick (sum of uniforms).
// Returns a value centered on 0 with std dev ~1. Real human timing/velocity
// noise is far closer to a bell curve than to a flat uniform distribution, and
// the bounded tails keep us from throwing the occasional wildly-off note.
export function gaussian(rng) {
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += rng();
  return (sum - 3) / 1.732; // 6 uniforms -> std dev sqrt(6/12)=0.707; scale to ~1
}

// True with probability p.
export function chance(rng, p) {
  return rng() < p;
}

// Pick a random element.
export function pick(rng, arr) {
  return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
}
