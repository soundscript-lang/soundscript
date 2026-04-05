export function main(): number {
  return globalThis.JSON.parse('{"value":22}').value;
}
