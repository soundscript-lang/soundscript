export function main(): number | undefined {
  return new Map<string, number>().get('missing');
}
