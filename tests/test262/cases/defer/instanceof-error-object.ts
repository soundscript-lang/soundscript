export function main(): boolean {
  return new Error('boom') instanceof Object;
}
