import {
  type Appearance,
  type Attention,
  type ClientMessage,
  Envelope,
  type FileReply,
  HubToClient,
  type Cast,
  type NodeCommand,
  UnreadEventsFrame,
  PONG_FRAME,
} from '@crystal-bridge/protocol';
import { insertBySeq } from './model.js';
import { notSentLine } from './theme/words.js';

export type HubStatus = 'connecting' | 'open' | 'closed';

/** How far a session's history has loaded: events received of the replay's total, and whether it's complete. */
export interface ReplayProgress {
  received: number;
  total: number | null;
  synced: boolean;
}

/** One shared object, so a store snapshot of an unsubscribed session's progress stays stable. */
const NOT_LOADED: ReplayProgress = { received: 0, total: null, synced: false };

/** Event bursts (a streaming reply, a replay) reach listeners at most this often, as one change. */
const CHANGE_MS = 16;

/** Past the hub's own wait for the node, so its plainer "didn't answer" usually arrives first. */
const FILE_TIMEOUT_MS = 20_000;

/** How often a quiet link is checked. Under the 30 to 60 s after which many proxies drop an idle socket. */
const HEARTBEAT_MS = 25_000;

/** How long a hub that answers pings gets to answer one. */
const PONG_TIMEOUT_MS = 10_000;

/**
 * Commands that mean nothing once the link has been down: a Stop would hit whatever turn runs by then, keys whatever
 * the terminal shows, and an answer may be to a card that has changed. Each with what the user is told wasn't sent.
 */
const STALE_AFTER_A_GAP: Partial<Record<NodeCommand['type'], string>> = {
  'session.interrupt': 'Stop',
  'session.keys': 'terminal keys',
  'permission.answer': 'an approval',
};

/** A hub `error` frame, or with `notSent` this client's own word that it dropped commands it had queued. */
export type ErrorListener = (message: string, notSent?: boolean) => void;

export function hubUrl(loc: Pick<Location, 'protocol' | 'host'> = location): string {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/client`;
}

/**
 * One `/client` WebSocket to the Airship. Keeps every subscribed session's events sorted by seq
 * (deduped) and, after a reconnect, re-subscribes each session from the last seq it saw plus one.
 */
export class HubClient {
  status: HubStatus = 'connecting';
  private socket: WebSocket | null = null;
  private readonly sessions = new Map<string, Envelope[]>();
  private readonly lastSeq = new Map<string, number>();
  private readonly snapshots = new Map<string, Envelope[]>();
  private readonly replays = new Map<string, ReplayProgress>();
  private changeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly attentionListeners = new Set<(attention: Attention) => void>();
  private readonly castListeners = new Set<(node: string, cast: Cast) => void>();
  private readonly appearanceListeners = new Set<(appearance: Appearance) => void>();
  private readonly fileRequests = new Map<string, (reply: FileReply) => void>();
  private outbox: ClientMessage[] = [];
  private retryMs = 500;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private beatTimer: ReturnType<typeof setInterval> | undefined;
  /** Running while a ping waits for an answer. */
  private pongTimer: ReturnType<typeof setTimeout> | undefined;
  /** This hub has answered a ping on this socket. */
  private answersPing = false;
  private closed = false;

  constructor(private readonly url: string = hubUrl()) {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onWake);
      document.addEventListener('visibilitychange', this.onWake);
    }
    this.connect();
  }

  /** Change listener for `useSyncExternalStore`. */
  readonly onChange = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Sessions anywhere that need the user, finished a turn, or failed; not limited to subscribed sessions. */
  onAttention(listener: (attention: Attention) => void): () => void {
    this.attentionListeners.add(listener);
    return () => this.attentionListeners.delete(listener);
  }

  /** A Cast changed on any Kingdom. */
  onCast(listener: (node: string, cast: Cast) => void): () => void {
    this.castListeners.add(listener);
    return () => this.castListeners.delete(listener);
  }

  /** The user's Kingdom appearance, changed on another of their devices. */
  onAppearance(listener: (appearance: Appearance) => void): () => void {
    this.appearanceListeners.add(listener);
    return () => this.appearanceListeners.delete(listener);
  }

  /**
   * Reads one file in a Quest's folder for the viewer, through the hub to the Quest's Kingdom. Always resolves: a
   * refusal, a dropped connection or no answer comes back as `ok: false` with a plain reason.
   */
  readFile(session: string, path: string): Promise<FileReply> {
    const requestId = crypto.randomUUID();
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ kind: 'file', requestId, ok: false, reason: 'not connected to the hub' });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.fileRequests.delete(requestId);
        resolve({ kind: 'file', requestId, ok: false, reason: 'no answer from the hub' });
      }, FILE_TIMEOUT_MS);
      this.fileRequests.set(requestId, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.post({ kind: 'command', command: { type: 'file.read', session, requestId, path } });
    });
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  /**
   * Events for a session in seq order; the same array until a new event arrives. A new event
   * usually lands at the end, which `IncrementalView` turns into a cheap update.
   */
  events(session: string): Envelope[] {
    let snapshot = this.snapshots.get(session);
    if (!snapshot) {
      snapshot = [...(this.sessions.get(session) ?? [])];
      this.snapshots.set(session, snapshot);
    }
    return snapshot;
  }

  /** Highest seq received for a session, or -1. */
  seenSeq(session: string): number {
    return this.lastSeq.get(session) ?? -1;
  }

  /** How far a subscribed session's history has loaded; synced once the hub has replayed all of it. */
  progress(session: string): ReplayProgress {
    return this.replays.get(session) ?? NOT_LOADED;
  }

  subscribe(session: string): void {
    if (this.sessions.has(session)) return;
    this.sessions.set(session, []);
    this.replays.set(session, { received: 0, total: null, synced: false });
    this.post({ kind: 'subscribe', session, fromSeq: 0 });
  }

  send(command: NodeCommand): void {
    this.post({ kind: 'command', command });
  }

  /** Commands waiting for the link to come back. */
  get queued(): number {
    return this.outbox.length;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.stopBeat();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onWake);
      document.removeEventListener('visibilitychange', this.onWake);
    }
    this.socket?.close();
  }

  private post(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    } else if (message.kind === 'command') {
      // Subscriptions are rebuilt from `sessions` on open; only commands need queueing.
      this.outbox.push(message);
      this.emit();
    }
  }

  /** Sends what waited for the link, apart from commands that only made sense against what was on screen then. */
  private flushOutbox(socket: WebSocket): void {
    const queued = this.outbox;
    this.outbox = [];
    const stale = new Set<string>();
    for (const message of queued) {
      const missed = message.kind === 'command' ? STALE_AFTER_A_GAP[message.command.type] : undefined;
      if (missed) stale.add(missed);
      else socket.send(JSON.stringify(message));
    }
    if (stale.size > 0) for (const listener of this.errorListeners) listener(notSentLine([...stale]), true);
    if (queued.length > 0) this.emit();
  }

  /**
   * Asks whether the link is alive. A hub that has answered before and now says nothing has gone, however healthy the
   * socket looks: after a sleep or a network change the browser can sit on a half-open one for minutes.
   */
  private ping(socket: WebSocket): void {
    if (this.pongTimer !== undefined) return;
    socket.send(JSON.stringify({ kind: 'ping' } satisfies ClientMessage));
    if (this.answersPing) this.pongTimer = setTimeout(() => this.giveUpOn(socket), PONG_TIMEOUT_MS);
  }

  private stopBeat(): void {
    clearInterval(this.beatTimer);
    clearTimeout(this.pongTimer);
    this.pongTimer = undefined;
  }

  private giveUpOn(socket: WebSocket): void {
    socket.close();
    this.lost(socket);
  }

  private lost(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.stopBeat();
    this.setStatus('closed');
    if (this.closed) return;
    this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 10_000);
  }

  /** The tab came back or the network changed: a good moment to find out now rather than at the next beat. */
  private readonly onWake = (): void => {
    if (document.visibilityState === 'hidden') return;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.ping(this.socket);
    } else if (!this.socket) {
      clearTimeout(this.retryTimer);
      this.connect();
    }
  };

  private setStatus(status: HubStatus): void {
    this.status = status;
    this.emit();
  }

  private emit(): void {
    clearTimeout(this.changeTimer);
    this.changeTimer = undefined;
    for (const listener of this.listeners) listener();
  }

  /** One change for a burst of events, instead of a render per event. */
  private emitSoon(): void {
    this.changeTimer ??= setTimeout(() => this.emit(), CHANGE_MS);
  }

  private connect(): void {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    this.setStatus('connecting');

    socket.addEventListener('open', () => {
      this.retryMs = 500;
      this.setStatus('open');
      for (const session of this.sessions.keys()) {
        socket.send(
          JSON.stringify({ kind: 'subscribe', session, fromSeq: this.seenSeq(session) + 1 } satisfies ClientMessage),
        );
      }
      this.flushOutbox(socket);
      // Only a hub that answers this gets more of them: an older one logs each as a frame it doesn't know.
      this.answersPing = false;
      this.ping(socket);
      this.beatTimer = setInterval(() => {
        if (this.answersPing) this.ping(socket);
      }, HEARTBEAT_MS);
    });

    socket.addEventListener('message', (event) => {
      if (this.socket === socket) {
        // Anything at all shows the link works.
        clearTimeout(this.pongTimer);
        this.pongTimer = undefined;
      }
      if (event.data === PONG_FRAME) this.answersPing = true;
      else this.receive(event.data);
    });

    socket.addEventListener('close', () => this.lost(socket));
  }

  private receive(data: unknown): void {
    let json: unknown;
    try {
      json = JSON.parse(String(data));
    } catch {
      return;
    }
    const replay = UnreadEventsFrame.safeParse(json);
    if (replay.success) {
      this.receiveReplay(replay.data);
      return;
    }
    const frame = HubToClient.safeParse(json);
    if (!frame.success) return;

    if (frame.data.kind === 'error') {
      for (const listener of this.errorListeners) listener(frame.data.message);
      return;
    }
    if (frame.data.kind === 'attention') {
      for (const listener of this.attentionListeners) listener(frame.data);
      return;
    }
    if (frame.data.kind === 'cast') {
      const { node, cast } = frame.data;
      for (const listener of this.castListeners) listener(node, cast);
      return;
    }
    if (frame.data.kind === 'appearance') {
      for (const listener of this.appearanceListeners) listener(frame.data.appearance);
      return;
    }
    if (frame.data.kind === 'file') {
      const resolve = this.fileRequests.get(frame.data.requestId);
      this.fileRequests.delete(frame.data.requestId);
      resolve?.(frame.data);
      return;
    }

    if (frame.data.kind === 'synced') {
      const { session, seq } = frame.data;
      if (!this.sessions.has(session)) return;
      // Left-out fragments still count as seen, so a reconnect resumes after them.
      if (seq > this.seenSeq(session)) this.lastSeq.set(session, seq);
      this.replays.set(session, { ...this.progress(session), synced: true });
      this.emit();
      return;
    }

    if (frame.data.kind !== 'event') return;
    const envelope = frame.data.event;
    const events = this.sessions.get(envelope.session);
    if (!events || !this.insert(events, envelope)) return;
    this.snapshots.delete(envelope.session);
    this.emitSoon();
  }

  /** Reads a replay batch one event at a time, skipping any this client can't read. */
  private receiveReplay({ session, events: batch, total }: UnreadEventsFrame): void {
    const events = this.sessions.get(session);
    if (!events) return;
    let added = 0;
    for (const unread of batch) {
      const envelope = Envelope.safeParse(unread);
      if (envelope.success && this.insert(events, envelope.data)) added++;
    }
    const replay = this.progress(session);
    this.replays.set(session, { ...replay, received: replay.received + added, total });
    this.snapshots.delete(session);
    this.emitSoon();
  }

  private insert(events: Envelope[], envelope: Envelope): boolean {
    if (!insertBySeq(events, envelope)) return false;
    if (envelope.seq > this.seenSeq(envelope.session)) this.lastSeq.set(envelope.session, envelope.seq);
    return true;
  }
}
