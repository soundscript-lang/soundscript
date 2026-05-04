import { connectTls, listenTls, TlsConnection, TlsListener } from 'sts:net';

export type {
  ListenOptions,
  OperationOptions,
  SocketAddress,
  TlsConnectOptions,
  TlsCredential,
  TlsListenOptions,
} from 'sts:net';
export { connectTls, listenTls, TlsConnection, TlsListener };

export const Tls = Object.freeze({
  connect: connectTls,
  listen: listenTls,
  Connection: TlsConnection,
  Listener: TlsListener,
});
