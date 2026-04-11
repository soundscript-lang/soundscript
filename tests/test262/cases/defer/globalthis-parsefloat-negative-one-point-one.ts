export function main(): number {
  const parseFloatAlias = globalThis.parseFloat;
  return parseFloatAlias('-11e-1');
}
