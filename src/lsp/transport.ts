import { runtimeStdinReadable, runtimeStdoutWritable } from '../platform/host.ts';
import { isJsonRpcNotification, isJsonRpcResponse, type JsonRpcMessage } from './protocol.ts';

export interface MessageTransport {
  read(): Promise<JsonRpcMessage | null>;
  write(message: JsonRpcMessage): Promise<void>;
}

interface ByteReader {
  read(buffer: Uint8Array): Promise<number | null>;
}

interface ByteWriter {
  write(buffer: Uint8Array): Promise<number>;
}

class AsyncMessageQueue {
  readonly #items: (JsonRpcMessage | null)[] = [];
  readonly #waiters: ((message: JsonRpcMessage | null) => void)[] = [];

  push(message: JsonRpcMessage | null): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter(message);
      return;
    }

    this.#items.push(message);
  }

  shift(): Promise<JsonRpcMessage | null> {
    const message = this.#items.shift();
    if (message !== undefined) {
      return Promise.resolve(message);
    }

    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }
}

class QueueTransport implements MessageTransport {
  constructor(
    private readonly inbound: AsyncMessageQueue,
    private readonly outbound: AsyncMessageQueue,
  ) {}

  read(): Promise<JsonRpcMessage | null> {
    return this.inbound.shift();
  }

  write(message: JsonRpcMessage): Promise<void> {
    this.outbound.push(message);
    return Promise.resolve();
  }
}

class MemoryClient {
  #nextRequestId = 1;

  constructor(
    private readonly requests: AsyncMessageQueue,
    private readonly responses: AsyncMessageQueue,
  ) {}

  async readNotification(
    method: string,
  ): Promise<JsonRpcMessage & { method: string; params?: unknown }> {
    while (true) {
      const message = await this.responses.shift();
      if (message === null) {
        throw new Error('Transport closed before notification was received.');
      }

      if (isJsonRpcNotification(message) && message.method === method) {
        return message;
      }
    }
  }

  async readResponse(
    expectedId: number,
  ): Promise<{ error?: unknown; id: number; result?: unknown }> {
    while (true) {
      const message = await this.responses.shift();
      if (message === null) {
        throw new Error('Transport closed before response was received.');
      }

      if (isJsonRpcResponse(message) && message.id === expectedId) {
        return message;
      }
    }
  }

  sendNotification(method: string, params?: unknown): Promise<void> {
    this.requests.push({
      jsonrpc: '2.0',
      method,
      params,
    });
    return Promise.resolve();
  }

  sendRequest(method: string, params?: unknown): Promise<number> {
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;

    this.requests.push({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });

    return Promise.resolve(id);
  }
}

async function readExactly(reader: ByteReader, length: number): Promise<Uint8Array | null> {
  const buffer = new Uint8Array(length);
  let offset = 0;

  while (offset < length) {
    const bytesRead = await reader.read(buffer.subarray(offset));
    if (bytesRead === null) {
      return null;
    }

    offset += bytesRead;
  }

  return buffer;
}

async function readHeaders(reader: ByteReader): Promise<string | null> {
  const bytes: number[] = [];
  const singleByte = new Uint8Array(1);

  while (true) {
    const bytesRead = await reader.read(singleByte);
    if (bytesRead === null) {
      return bytes.length === 0 ? null : new TextDecoder().decode(new Uint8Array(bytes));
    }

    bytes.push(singleByte[0]);
    const byteCount = bytes.length;
    if (
      byteCount >= 4 &&
      bytes[byteCount - 4] === 13 &&
      bytes[byteCount - 3] === 10 &&
      bytes[byteCount - 2] === 13 &&
      bytes[byteCount - 1] === 10
    ) {
      return new TextDecoder().decode(new Uint8Array(bytes));
    }
  }
}

function createByteReader(readable: ReadableStream<Uint8Array>): ByteReader {
  const reader = readable.getReader();
  let buffered: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  return {
    async read(target: Uint8Array): Promise<number | null> {
      while (buffered.byteLength === 0) {
        const { done, value } = await reader.read();
        if (done) {
          return null;
        }
        buffered = value ?? new Uint8Array(0);
      }

      const byteLength = Math.min(target.byteLength, buffered.byteLength);
      target.set(buffered.subarray(0, byteLength));
      buffered = buffered.subarray(byteLength);
      return byteLength;
    },
  };
}

function createByteWriter(writable: WritableStream<Uint8Array>): ByteWriter {
  const writer = writable.getWriter();

  return {
    async write(buffer: Uint8Array): Promise<number> {
      await writer.write(buffer);
      return buffer.byteLength;
    },
  };
}

export function createMemoryTransportPair(): {
  client: MemoryClient;
  server: MessageTransport;
} {
  const requests = new AsyncMessageQueue();
  const responses = new AsyncMessageQueue();

  return {
    client: new MemoryClient(requests, responses),
    server: new QueueTransport(requests, responses),
  };
}

export function createStdioTransport(
  reader: ByteReader = createByteReader(runtimeStdinReadable()),
  writer: ByteWriter = createByteWriter(runtimeStdoutWritable()),
): MessageTransport {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let pendingWrite: Promise<void> = Promise.resolve();

  return {
    async read(): Promise<JsonRpcMessage | null> {
      const headerText = await readHeaders(reader);
      if (headerText === null) {
        return null;
      }

      const contentLengthHeader = headerText
        .split('\r\n')
        .find((header) => header.toLowerCase().startsWith('content-length:'));
      if (!contentLengthHeader) {
        throw new Error('Missing Content-Length header.');
      }

      const contentLength = Number.parseInt(contentLengthHeader.split(':')[1]?.trim() ?? '', 10);
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        throw new Error('Invalid Content-Length header.');
      }

      const payloadBytes = await readExactly(reader, contentLength);
      if (payloadBytes === null) {
        return null;
      }

      return JSON.parse(decoder.decode(payloadBytes)) as JsonRpcMessage;
    },

    async write(message: JsonRpcMessage): Promise<void> {
      const writeOperation = pendingWrite.then(async () => {
        const payload = encoder.encode(JSON.stringify(message));
        const header = encoder.encode(`Content-Length: ${payload.byteLength}\r\n\r\n`);
        await writer.write(header);
        await writer.write(payload);
      });
      pendingWrite = writeOperation.catch(() => {});
      await writeOperation;
    },
  };
}
