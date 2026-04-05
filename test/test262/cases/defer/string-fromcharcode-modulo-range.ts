export function main(): number[] {
  return [
    String.fromCharCode(-32767).charCodeAt(0),
    String.fromCharCode(-32768).charCodeAt(0),
    String.fromCharCode(-32769).charCodeAt(0),
    String.fromCharCode(-65535).charCodeAt(0),
    String.fromCharCode(-65536).charCodeAt(0),
    String.fromCharCode(-65537).charCodeAt(0),
    String.fromCharCode(65535).charCodeAt(0),
    String.fromCharCode(65536).charCodeAt(0),
    String.fromCharCode(65537).charCodeAt(0),
    String.fromCharCode(131071).charCodeAt(0),
    String.fromCharCode(131072).charCodeAt(0),
    String.fromCharCode(131073).charCodeAt(0),
  ];
}
