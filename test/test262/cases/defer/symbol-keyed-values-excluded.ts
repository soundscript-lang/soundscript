export function main(): number {
  const key = Symbol('token');
  const record = { plain: 1, [key]: 2 };
  return Object.values(record).length;
}
