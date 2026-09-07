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

@Injectable()
@WebTransportGateway('/basic')
export class BasicGateway {
  private readonly logger = new Logger(BasicGateway.name);
  private readonly datagramWrites = new WeakMap<WebTransportSession, Promise<void>>();

  @OnSession()
  onSession(@Session() session: WebTransportSession): void {
    this.logger.log(
      `session accepted id=${session.id} remote=${session.remoteAddress ?? '<unknown>'}`,
    );
    session.signal.addEventListener(
      'abort',
      () => this.logger.log(`session closed id=${session.id}`),
      { once: true },
    );
  }

  @OnDatagram()
  onDatagram(
    @Session() session: WebTransportSession,
    @Payload() datagram: Uint8Array,
  ): Promise<void> {
    const previous = this.datagramWrites.get(session) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.echoDatagram(session, datagram));
    this.datagramWrites.set(session, current);
    return current;
  }

  @OnBidirectionalStream()
  async onBidirectionalStream(@Stream() stream: WebTransportBidirectionalStream): Promise<void> {
    try {
      await stream.readable.pipeTo(stream.writable);
    } catch (error) {
      if (!stream.signal.aborted) {
        throw error;
      }
    }
  }

  @OnUnidirectionalStream()
  async onUnidirectionalStream(@Stream() stream: WebTransportReceiveStream): Promise<void> {
    const reader = stream.readable.getReader();
    let receivedBytes = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        receivedBytes += result.value.byteLength;
      }
    } catch (error) {
      if (!stream.signal.aborted) {
        throw error;
      }
    } finally {
      reader.releaseLock();
    }

    this.logger.log(`unidirectional stream complete id=${stream.id} bytes=${receivedBytes}`);
  }

  private async echoDatagram(session: WebTransportSession, datagram: Uint8Array): Promise<void> {
    const writer = session.datagrams.writable.getWriter();
    try {
      await writer.write(datagram);
    } finally {
      writer.releaseLock();
    }
  }
}
