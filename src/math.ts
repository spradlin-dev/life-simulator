export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// standard normal via Box-Muller; its asymptotic tail is the whole mutation model —
// mild drift is common, radical mutation is possible but vanishingly unlikely
export function gaussian(rand: () => number = Math.random): number {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}
