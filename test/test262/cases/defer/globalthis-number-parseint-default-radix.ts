export function main(): number {
  const parseIntAlias = globalThis.Number.parseInt;
  return parseIntAlias('11');
}
