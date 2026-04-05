import { assertEquals } from '@std/assert';

import { createStdioTransport } from './transport.ts';

interface CapturedMessage {
  id: number;
  jsonrpc: '2.0';
  method: string;
}

class UnusedReader {
  read(_buffer: Uint8Array): Promise<number | null> {
    return Promise.resolve(null);
  }
}

class CapturingWriter {
  readonly chunks: Uint8Array[] = [];

  write(buffer: Uint8Array): Promise<number> {
    this.chunks.push(buffer.slice());
    return Promise.resolve(buffer.byteLength);
  }
}

function parseCapturedMessages(chunks: readonly Uint8Array[]): CapturedMessage[] {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const decoder = new TextDecoder();
  const messages: CapturedMessage[] = [];
  let cursor = 0;

  while (cursor < combined.byteLength) {
    const headerEnd = decoder.decode(combined.subarray(cursor)).indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      throw new Error('Missing message header terminator.');
    }

    const absoluteHeaderEnd = cursor + headerEnd;
    const headerText = decoder.decode(combined.subarray(cursor, absoluteHeaderEnd));
    const contentLengthHeader = headerText
      .split('\r\n')
      .find((header) => header.toLowerCase().startsWith('content-length:'));
    if (!contentLengthHeader) {
      throw new Error('Missing Content-Length header.');
    }

    const contentLength = Number.parseInt(contentLengthHeader.split(':')[1]!.trim(), 10);
    const payloadStart = absoluteHeaderEnd + 4;
    const payloadEnd = payloadStart + contentLength;
    const payloadText = decoder.decode(combined.subarray(payloadStart, payloadEnd));
    messages.push(JSON.parse(payloadText) as CapturedMessage);
    cursor = payloadEnd;
  }

  return messages;
}

Deno.test('createStdioTransport serializes concurrent writes as complete messages', async () => {
  const writer = new CapturingWriter();
  const transport = createStdioTransport(new UnusedReader(), writer);

  await Promise.all([
    transport.write({ jsonrpc: '2.0', id: 1, method: 'first' }),
    transport.write({ jsonrpc: '2.0', id: 2, method: 'second' }),
  ]);

  assertEquals(parseCapturedMessages(writer.chunks), [
    { jsonrpc: '2.0', id: 1, method: 'first' },
    { jsonrpc: '2.0', id: 2, method: 'second' },
  ]);
});
