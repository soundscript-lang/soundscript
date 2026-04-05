export function main(): boolean {
  const value = new String('abc');
  return value instanceof String && value instanceof Object;
}
