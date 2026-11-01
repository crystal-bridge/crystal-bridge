import {
  type Appearance,
  type Attention,
  type ClientMessage,
  type Envelope,
  type FileReply,
  HubToClient,
  type Cast,
  type NodeCommand,
} from '@crystal-bridge/protocol';
import { insertBySeq } from './model.js';

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
  private readonly errorListeners = new Set<(message: string) => void>();
  private readonly attentionListeners = new Set<(attention: Attention) => void>();
  private readonly castListeners = new Set<(node: string, cast: Cast) => void>();
  private readonly appearanceListeners = new Set<(appearance: Appearance) => void>();
  private readonly fileRequests = new Map<string, (reply: FileReply) => void>();
  private outbox: ClientMessage[] = [];
  private retryMs = 500;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(private readonly url: string = hubUrl()) {
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

  onError(listener: (message: string) => void): () => void {
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

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.socket?.close();
  }

  private post(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    } else if (message.kind === 'command') {
      // Subscriptions are rebuilt from `sessions` on open; only commands need queueing.
      this.outbox.push(message);
    }
  }

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
      const queued = this.outbox;
      this.outbox = [];
      for (const message of queued) socket.send(JSON.stringify(message));
    });

    socket.addEventListener('message', (event) => this.receive(event.data));

    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setStatus('closed');
      if (this.closed) return;
      this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
    });
  }

  private receive(data: unknown): void {
    let json: unknown;
    try {
      json = JSON.parse(String(data));
    } catch {
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

    if (frame.data.kind === 'events') {
      const { session, events: batch, total } = frame.data;
      const events = this.sessions.get(session);
      if (!events) return;
      let added = 0;
      for (const envelope of batch) if (this.insert(events, envelope)) added++;
      const replay = this.progress(session);
      this.replays.set(session, { ...replay, received: replay.received + added, total });
      this.snapshots.delete(session);
      this.emitSoon();
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

    const envelope = frame.data.event;
    const events = this.sessions.get(envelope.session);
    if (!events || !this.insert(events, envelope)) return;
    this.snapshots.delete(envelope.session);
    this.emitSoon();
  }

  private insert(events: Envelope[], envelope: Envelope): boolean {
    if (!insertBySeq(events, envelope)) return false;
    if (envelope.seq > this.seenSeq(envelope.session)) this.lastSeq.set(envelope.session, envelope.seq);
    return true;
  }
}
