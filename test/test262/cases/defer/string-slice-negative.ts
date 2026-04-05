export function main(): string {
  const value = {
    toString() {},
  };
  return String(value).slice(-4, undefined);
}
