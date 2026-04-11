export function main(): number {
  return globalThis.JSON.parse('{"value":21}').value;
}
