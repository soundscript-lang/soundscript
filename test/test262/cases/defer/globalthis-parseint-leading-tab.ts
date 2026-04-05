export function main(): number {
  const parseIntAlias = globalThis.parseInt;
  return parseIntAlias('\u00091');
}
