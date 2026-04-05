export function main(): number {
  return globalThis.JSON.parse('{"value":20}').value;
}
