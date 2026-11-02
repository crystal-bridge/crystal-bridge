import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keepBeating } from './heartbeat.js';

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  ping = vi.fn();
  terminate = vi.fn();
}

describe('keepBeating', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pings each interval and ends a socket silent for a whole one', () => {
    const socket = new FakeSocket();
    const onDead = vi.fn();
    keepBeating(socket, 1000, onDead);

    vi.advanceTimersByTime(1000);
    expect(socket.ping).toHaveBeenCalledTimes(1);
    expect(socket.terminate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it.each(['pong', 'message'])('counts a %s as a sign of life', (event) => {
    const socket = new FakeSocket();
    keepBeating(socket, 1000);

    for (let beat = 0; beat < 5; beat++) {
      vi.advanceTimersByTime(1000);
      socket.emit(event);
    }

    expect(socket.ping).toHaveBeenCalledTimes(5);
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it('spares a socket still working through its backlog: a ping waits behind what was queued first', () => {
    const socket = new FakeSocket();
    keepBeating(socket, 1000);

    for (const left of [9000, 6000, 3000, 1000]) {
      socket.bufferedAmount = left;
      vi.advanceTimersByTime(1000);
    }
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it('ends a socket whose backlog stopped moving', () => {
    const socket = new FakeSocket();
    keepBeating(socket, 1000);

    socket.bufferedAmount = 9000;
    vi.advanceTimersByTime(3000);

    expect(socket.terminate).toHaveBeenCalledTimes(1);
  });

  it('stops once the socket closes', () => {
    const socket = new FakeSocket();
    keepBeating(socket, 1000);

    socket.emit('close');
    vi.advanceTimersByTime(5000);

    expect(socket.ping).not.toHaveBeenCalled();
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it('leaves a socket that is already closing to finish', () => {
    const socket = new FakeSocket();
    socket.readyState = 2;
    keepBeating(socket, 1000);

    vi.advanceTimersByTime(5000);

    expect(socket.ping).not.toHaveBeenCalled();
    expect(socket.terminate).not.toHaveBeenCalled();
  });
});
