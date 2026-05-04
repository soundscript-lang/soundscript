import { connect, listen, TcpConnection, TcpListener } from 'sts:net';

export type { ListenOptions, OperationOptions, SocketAddress } from 'sts:net';
export { connect, listen, TcpConnection, TcpListener };

export const Tcp = Object.freeze({
  connect,
  listen,
  Connection: TcpConnection,
  Listener: TcpListener,
});
