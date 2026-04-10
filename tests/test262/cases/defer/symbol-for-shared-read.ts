export function main(): number {
  const key = Symbol.for('shared');
  const result = Object.fromEntries([[key, 9]]) as Record<PropertyKey, number>;
  return result[Symbol.for('shared')];
}
