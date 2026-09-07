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

@WebTransportGateway('/demo')
@Injectable()
export class DemoGateway {
  private readonly logger = new Logger(DemoGateway.name);
  private readonly sessions = new Set<WebTransportSession>();
  private readonly pendingDatagramWrites = new WeakMap<WebTransportSession, Promise<void>>();
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  @OnSession()
  async connected(@Session() session: WebTransportSession): Promise<void> {
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
      `broadcast session=${session.id} recipients=${recipients} delivered=${delivered} message=${JSON.stringify(packet.message)}`,
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
        if (retainedBytes + result.value.byteLength <= 64 * 1024) {
          chunks.push(result.value);
          retainedBytes += result.value.byteLength;
        }
      }
    } finally {
      reader.releaseLock();
    }

    const truncated = retainedBytes !== bytes;
    const message = truncated ? undefined : this.decoder.decode(joinChunks(chunks, retainedBytes));
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
        typeof value.sentAt !== 'number' ||
        !Number.isFinite(value.sentAt) ||
        typeof value.message !== 'string' ||
        value.message.length > 400
      ) {
        return undefined;
      }
      return value as ClientDatagram;
    } catch {
      return undefined;
    }
  }

  private sendPacket(session: WebTransportSession, packet: object): Promise<void> {
    const previous = this.pendingDatagramWrites.get(session) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const writer = session.datagrams.writable.getWriter();
        try {
          await writer.ready;
          await writer.write(this.encoder.encode(JSON.stringify(packet)));
        } finally {
          writer.releaseLock();
        }
      });
    this.pendingDatagramWrites.set(session, current);
    return current;
  }
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
