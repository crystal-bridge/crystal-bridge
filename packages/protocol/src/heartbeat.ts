/** How often each end of the node link checks the other, and so how long a dead link can go unnoticed, at most twice this. */
export const HEARTBEAT_MS = 30_000;

/** The part of a `ws` socket this needs, so this package doesn't depend on `ws`. */
export interface BeatingSocket {
  readonly OPEN: number;
  readonly readyState: number;
  readonly bufferedAmount?: number;
  ping(): void;
  terminate(): void;
  on(event: 'pong' | 'message' | 'close', listener: () => void): unknown;
}

/**
 * Pings `socket` every `intervalMs` and ends it after a whole interval with nothing heard.
 *
 * TCP says nothing about a peer that disappeared: when a proxy on the way restarts or a machine loses power, the socket
 * still looks open, and the far end only finds out on its next write, which on a quiet link may be hours away. The ping
 * is the WebSocket control frame, which `ws` answers by itself, so older peers need no change. Ending the socket fires
 * its `close`, so whatever already handles a lost connection handles this too.
 *
 * A peer working through a backlog can't answer yet, because the ping waits behind everything queued before it, so a
 * backlog that shrank since the last beat counts as a sign of life. One that stopped moving doesn't.
 */
export function keepBeating(socket: BeatingSocket, intervalMs: number = HEARTBEAT_MS, onDead?: () => void): void {
  let heard = true;
  const alive = (): void => {
    heard = true;
  };
  socket.on('pong', alive);
  socket.on('message', alive);

  let backlog = 0;
  const timer = setInterval(() => {
    if (socket.readyState !== socket.OPEN) return;
    const left = socket.bufferedAmount ?? 0;
    const draining = left > 0 && left < backlog;
    backlog = left;
    if (!heard && !draining) {
      clearInterval(timer);
      onDead?.();
      socket.terminate();
      return;
    }
    heard = false;
    socket.ping();
  }, intervalMs);
  // A browser's timer is a number, and this package also compiles for the web app.
  (timer as unknown as { unref?(): void }).unref?.();
  socket.on('close', () => clearInterval(timer));
}
