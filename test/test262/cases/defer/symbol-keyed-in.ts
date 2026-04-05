export function main(): boolean {
  const key = Symbol('token');
  const record = { [key]: 1 };
  return key in record;
}
