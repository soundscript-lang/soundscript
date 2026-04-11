export function main(): boolean {
  return Object.is(globalThis.Math.floor(-0), -0);
}
