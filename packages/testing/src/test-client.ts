import type {
  SessionCloseOptions,
  WebTransportBidirectionalStream,
  WebTransportReceiveStream,
  WebTransportSendStream,
  WebTransportSessionState,
} from 'webtransport-core';

import type { MockSessionCloseInfo, MockWebTransportSession } from './mock-session.js';
import type { VirtualWebTransportDriver } from './virtual-driver.js';

async function receiveOne<T>(stream: ReadableStream<T>): Promise<T | undefined> {
  const reader = stream.getReader();
  try {
    const result = await reader.read();
    return result.done ? undefined : result.value;
  } finally {
    reader.releaseLock();
  }
}

export class TestClientSession {
  readonly session: MockWebTransportSession;

  constructor(session: MockWebTransportSession) {
    this.session = session;
  }

  get id(): string {
    return this.session.id;
  }

  get path(): string {
    return this.session.path;
  }

  get headers(): Readonly<Headers> {
    return this.session.headers;
  }

  get state(): WebTransportSessionState {
    return this.session.state;
  }

  get signal(): AbortSignal {
    return this.session.signal;
  }

  get closeInfo(): MockSessionCloseInfo | undefined {
    return this.session.closeInfo;
  }

  async sendDatagram(datagram: Uint8Array): Promise<void> {
    const writer = this.session.datagrams.writable.getWriter();
    try {
      await writer.write(datagram);
    } finally {
      writer.releaseLock();
    }
  }

  receiveDatagram(): Promise<Uint8Array | undefined> {
    return receiveOne(this.session.datagrams.readable);
  }

  createBidirectionalStream(): Promise<WebTransportBidirectionalStream> {
    return this.session.createBidirectionalStream();
  }

  createUnidirectionalStream(): Promise<WebTransportSendStream> {
    return this.session.createUnidirectionalStream();
  }

  receiveBidirectionalStream(): Promise<WebTransportBidirectionalStream | undefined> {
    return receiveOne(this.session.incomingBidirectionalStreams);
  }

  receiveUnidirectionalStream(): Promise<WebTransportReceiveStream | undefined> {
    return receiveOne(this.session.incomingUnidirectionalStreams);
  }

  close(options?: SessionCloseOptions): Promise<void> {
    return this.session.close(options);
  }

  abort(reason?: unknown): Promise<void> {
    return this.session.abort(reason);
  }

  waitForClose(): Promise<MockSessionCloseInfo> {
    return this.session.closed;
  }
}

export class TestClient {
  readonly #driver: VirtualWebTransportDriver;

  constructor(driver: VirtualWebTransportDriver) {
    this.#driver = driver;
  }

  async connect(path: string, headers: HeadersInit = {}): Promise<TestClientSession> {
    return new TestClientSession(await this.#driver.connect(path, headers));
  }
}
