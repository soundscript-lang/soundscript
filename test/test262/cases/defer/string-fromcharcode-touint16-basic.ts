export function main(): number[] {
  return [
    String.fromCharCode(0).charCodeAt(0),
    String.fromCharCode(1).charCodeAt(0),
    String.fromCharCode(-1).charCodeAt(0),
    String.fromCharCode(65535).charCodeAt(0),
    String.fromCharCode(65534).charCodeAt(0),
    String.fromCharCode(65536).charCodeAt(0),
    String.fromCharCode(4294967295).charCodeAt(0),
    String.fromCharCode(4294967294).charCodeAt(0),
    String.fromCharCode(4294967296).charCodeAt(0),
  ];
}
