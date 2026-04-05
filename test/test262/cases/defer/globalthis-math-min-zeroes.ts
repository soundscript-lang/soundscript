export function main(): boolean {
  return Object.is(globalThis.Math.min(0, -0), -0);
}
