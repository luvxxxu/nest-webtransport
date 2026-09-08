import { Injectable, Logger } from '@nestjs/common';
import {
  OnBidirectionalStream,
  OnDatagram,
  OnSession,
  OnUnidirectionalStream,
  Payload,
  Session,
  Stream,
  type WebTransportBidirectionalStream,
  WebTransportGateway,
  type WebTransportReceiveStream,
  type WebTransportSession,
} from 'nest-webtransport';

interface ClientDatagram {
  readonly type: 'echo' | 'broadcast';
  readonly id: string;
  readonly sentAt: number;
  readonly message: string;
}

interface OutgoingQueue {
  tail: Promise<void>;
  count: number;
  failed: boolean;
}

const MAX_PENDING_WRITES = 16;
const WRITE_TIMEOUT_MS = 1_000;
const PREVIEW_BYTES = 256;

@WebTransportGateway('/demo')
@Injectable()
export class DemoGateway {
  private readonly logger = new Logger(DemoGateway.name);
  private readonly sessions = new Set<WebTransportSession>();
  private readonly pendingDatagramWrites = new WeakMap<WebTransportSession, OutgoingQueue>();
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  @OnSession()
  async connected(@Session() session: WebTransportSession): Promise<void> {
    session.signal.throwIfAborted();
    this.sessions.add(session);
    session.signal.addEventListener(
      'abort',
      () => {
        this.sessions.delete(session);
        void this.broadcastServerEvent('session-left', session.id);
      },
      { once: true },
    );

    this.logger.log(`connected session=${session.id} remote=${session.remoteAddress ?? 'unknown'}`);
    await this.broadcastServerEvent('session-joined', session.id);
  }

  @OnDatagram()
  async handleDatagram(
    @Session() session: WebTransportSession,
    @Payload() datagram: Uint8Array,
  ): Promise<void> {
    const packet = this.parseClientDatagram(datagram);
    if (packet === undefined) {
      await this.sendPacket(session, {
        type: 'server-error',
        event: 'invalid-datagram',
        bytes: datagram.byteLength,
      });
      return;
    }

    if (packet.type === 'echo') {
      await this.sendPacket(session, {
        ...packet,
        type: 'echo',
        serverAt: Date.now(),
        sourceSessionId: session.id,
      });
      return;
    }

    const recipients = this.sessions.size;
    const result = await Promise.allSettled(
      [...this.sessions].map((target) =>
        this.sendPacket(target, {
          ...packet,
          type: 'broadcast',
          serverAt: Date.now(),
          sourceSessionId: session.id,
          recipients,
        }),
      ),
    );
    const delivered = result.filter((entry) => entry.status === 'fulfilled').length;
    this.logger.log(
      `broadcast session=${session.id} recipients=${recipients} delivered=${delivered}`,
    );
  }

  @OnBidirectionalStream()
  async echoBidirectional(@Stream() stream: WebTransportBidirectionalStream): Promise<void> {
    try {
      await stream.readable.pipeTo(stream.writable);
    } catch (error) {
      if (!stream.signal.aborted) throw error;
    }
  }

  @OnUnidirectionalStream()
  async consumeUnidirectional(
    @Session() session: WebTransportSession,
    @Stream() stream: WebTransportReceiveStream,
  ): Promise<void> {
    const reader = stream.readable.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let retainedBytes = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        const retained = Math.min(PREVIEW_BYTES - retainedBytes, result.value.byteLength);
        if (retained > 0) {
          chunks.push(new Uint8Array(result.value.subarray(0, retained)));
          retainedBytes += retained;
        }
      }
    } finally {
      reader.releaseLock();
    }

    const truncated = retainedBytes !== bytes;
    const message = this.decoder.decode(joinChunks(chunks, retainedBytes));
    this.logger.log(`unidirectional stream=${stream.id} bytes=${bytes}`);
    await this.sendPacket(session, {
      type: 'server-event',
      event: 'unidirectional-received',
      streamId: String(stream.id),
      bytes,
      message,
      truncated,
      serverAt: Date.now(),
    });
  }

  private async broadcastServerEvent(event: string, sessionId: string): Promise<void> {
    const activeSessions = this.sessions.size;
    await Promise.allSettled(
      [...this.sessions].map((session) =>
        this.sendPacket(session, {
          type: 'server-event',
          event,
          sessionId,
          activeSessions,
          serverAt: Date.now(),
        }),
      ),
    );
  }

  private parseClientDatagram(datagram: Uint8Array): ClientDatagram | undefined {
    try {
      const value: unknown = JSON.parse(this.decoder.decode(datagram));
      if (
        typeof value !== 'object' ||
        value === null ||
        !('type' in value) ||
        !('id' in value) ||
        !('sentAt' in value) ||
        !('message' in value) ||
        (value.type !== 'echo' && value.type !== 'broadcast') ||
        typeof value.id !== 'string' ||
        value.id.length > 128 ||
        typeof value.sentAt !== 'number' ||
        !Number.isFinite(value.sentAt) ||
        typeof value.message !== 'string' ||
        value.message.length > 400
      ) {
        return undefined;
      }
      return { type: value.type, id: value.id, sentAt: value.sentAt, message: value.message };
    } catch {
      return undefined;
    }
  }

  private sendPacket(session: WebTransportSession, packet: Record<string, unknown>): Promise<void> {
    if (session.signal.aborted) return Promise.reject(session.signal.reason);
    let queue = this.pendingDatagramWrites.get(session);
    if (queue === undefined) {
      queue = { tail: Promise.resolve(), count: 0, failed: false };
      this.pendingDatagramWrites.set(session, queue);
    }
    if (queue.failed || queue.count >= MAX_PENDING_WRITES) {
      return Promise.reject(new Error('The outgoing datagram queue is full or closed.'));
    }
    const limit = Math.min(1_200, session.datagrams.maxDatagramSize);
    let bytes = this.encoder.encode(JSON.stringify(packet));
    if (bytes.byteLength > limit) {
      bytes = this.encoder.encode(
        JSON.stringify(
          packet.event === 'unidirectional-received'
            ? { ...packet, message: undefined, truncated: true }
            : { type: 'server-error', event: 'response-too-large', bytes: bytes.byteLength },
        ),
      );
    }
    if (bytes.byteLength > limit)
      return Promise.reject(new Error('The response exceeds the datagram limit.'));
    queue.count++;
    const current = queue.tail
      .catch(() => undefined)
      .then(async () => {
        session.signal.throwIfAborted();
        if (queue.failed) throw new Error('The outgoing datagram queue is closed.');
        const operation = async () => {
          const writer = session.datagrams.writable.getWriter();
          try {
            await writer.ready;
            session.signal.throwIfAborted();
            await writer.write(bytes);
          } finally {
            writer.releaseLock();
          }
        };
        try {
          await waitForWrite(operation(), session.signal);
        } catch (error) {
          queue.failed = true;
          void Promise.resolve()
            .then(() =>
              session.close({ closeCode: 0x101, reason: 'Outgoing datagram write failed' }),
            )
            .catch(() => {});
          throw error;
        }
      });
    queue.tail = current;
    return current.finally(() => {
      queue.count--;
    });
  }
}

function waitForWrite(operation: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const abort = () => finish(signal.reason ?? new Error('Session closed'));
    const timer = setTimeout(
      () => finish(new Error('Outgoing datagram write timed out.')),
      WRITE_TIMEOUT_MS,
    );
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(() => finish(), finish);
    if (signal.aborted) abort();
  });
}

function joinChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
