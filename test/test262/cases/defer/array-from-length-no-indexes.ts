export function main(): (number | string)[] {
  const created = Array.from({ length: 5 });
  const mapped = Array.from({ length: 5 }).map(() => 1);

  return [created.length, mapped.join(',')];
}
