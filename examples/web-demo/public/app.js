const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_LOG_ENTRIES = 200;

const elements = {
  support: document.querySelector('#support-status'),
  connection: document.querySelector('#connection-status'),
  sessionId: document.querySelector('#session-id'),
  roundTrip: document.querySelector('#round-trip'),
  received: document.querySelector('#received-count'),
  sent: document.querySelector('#sent-count'),
  serverUrl: document.querySelector('#server-url'),
  token: document.querySelector('#auth-token'),
  certificateHash: document.querySelector('#certificate-hash'),
  connect: document.querySelector('#connect-button'),
  disconnect: document.querySelector('#disconnect-button'),
  datagramMessage: document.querySelector('#datagram-message'),
  datagram: document.querySelector('#datagram-button'),
  broadcastMessage: document.querySelector('#broadcast-message'),
  broadcast: document.querySelector('#broadcast-button'),
  bidiMessage: document.querySelector('#bidi-message'),
  bidi: document.querySelector('#bidi-button'),
  bidiResult: document.querySelector('#bidi-result'),
  uniMessage: document.querySelector('#uni-message'),
  uni: document.querySelector('#uni-button'),
  uniResult: document.querySelector('#uni-result'),
  clearLog: document.querySelector('#clear-log-button'),
  log: document.querySelector('#event-log'),
};

let transport;
let datagramWriter;
let connectionGeneration = 0;
let sentCount = 0;
let receivedCount = 0;

initialize().catch((error) =>
  recordEvent({
    direction: 'ERROR',
    channel: 'page',
    event: 'initialization-failed',
    details: error,
  }),
);

elements.connect.addEventListener('click', () => void connect());
elements.disconnect.addEventListener('click', () => disconnect());
elements.datagram.addEventListener(
  'click',
  () => void sendDatagramPacket('echo', elements.datagramMessage.value),
);
elements.broadcast.addEventListener(
  'click',
  () => void sendDatagramPacket('broadcast', elements.broadcastMessage.value),
);
elements.bidi.addEventListener('click', () => void testBidirectionalStream());
elements.uni.addEventListener('click', () => void testUnidirectionalStream());
elements.clearLog.addEventListener('click', () => elements.log.replaceChildren());

async function initialize() {
  const supported = typeof globalThis.WebTransport === 'function';
  elements.support.textContent = supported ? 'supported' : 'not supported';
  elements.connect.disabled = !supported;

  const config = await fetch('/config.json', { cache: 'no-store' }).then((response) => {
    if (!response.ok) throw new Error(`config request failed (${response.status})`);
    return response.json();
  });
  elements.serverUrl.value = config.webTransportUrl;
  elements.certificateHash.value = config.certificateSha256 ?? '';
  recordEvent({ direction: 'SYSTEM', channel: 'http', event: 'config-loaded' });
}

async function connect() {
  if (transport) return;
  const token = elements.token.value.trim();
  if (!token) {
    recordEvent({ direction: 'ERROR', channel: 'auth', event: 'token-required' });
    elements.token.focus();
    return;
  }

  elements.connection.textContent = 'connecting';
  elements.connect.disabled = true;
  const generation = ++connectionGeneration;
  recordEvent({ direction: 'OUT', channel: 'http', event: 'session-ticket-requested' });

  try {
    const ticket = await requestSessionTicket(token);
    recordEvent({
      direction: 'IN',
      channel: 'http',
      event: 'session-ticket-issued',
      details: { expiresInMs: ticket.expiresInMs },
    });

    const targetUrl = new URL(elements.serverUrl.value.trim());
    targetUrl.searchParams.set('ticket', ticket.ticket);
    const options = { allowPooling: false, requireUnreliable: true };
    const hash = elements.certificateHash.value.trim();
    if (hash) {
      options.serverCertificateHashes = [{ algorithm: 'sha-256', value: hexToBytes(hash) }];
    }

    const candidate = new WebTransport(targetUrl, options);
    transport = candidate;
    await candidate.ready;
    if (generation !== connectionGeneration) {
      candidate.close();
      return;
    }

    const admissionBytes = await verifyApplicationAdmission(candidate);
    datagramWriter = candidate.datagrams.writable.getWriter();
    elements.connection.textContent = 'connected';
    setTestButtons(true);
    elements.disconnect.disabled = false;
    recordEvent({
      direction: 'IN',
      channel: 'stream',
      event: 'gateway-admission-confirmed',
      bytes: admissionBytes,
    });
    void readDatagrams(candidate, generation);
    void candidate.closed.then(
      () => connectionEnded(candidate, generation, 'closed'),
      (error) => connectionEnded(candidate, generation, 'connection-error', error),
    );
  } catch (error) {
    connectionEnded(transport, generation, 'connection-failed', error);
  }
}

async function requestSessionTicket(token) {
  const response = await fetch('/session-ticket', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? 'invalid bearer token'
        : `ticket request failed (${response.status})`,
    );
  }
  const result = await response.json();
  if (
    typeof result.ticket !== 'string' ||
    result.ticket.length === 0 ||
    typeof result.expiresInMs !== 'number'
  ) {
    throw new Error('invalid session ticket response');
  }
  return result;
}

async function verifyApplicationAdmission(candidate) {
  const stream = await candidate.createBidirectionalStream();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const bytes = encoder.encode(`admission:${crypto.randomUUID()}`);
  try {
    await writer.write(bytes);
    await writer.close();
    const received = await readAll(reader);
    if (!bytesEqual(received, bytes)) throw new Error('gateway admission response mismatch');
    return received.byteLength;
  } finally {
    writer.releaseLock();
    reader.releaseLock();
  }
}

function disconnect() {
  if (!transport) return;
  connectionGeneration += 1;
  const active = transport;
  cleanupConnection();
  active.close({ closeCode: 0, reason: 'Closed from web demo' });
  elements.connection.textContent = 'disconnected';
  recordEvent({ direction: 'OUT', channel: 'session', event: 'close-requested' });
}

async function sendDatagramPacket(type, message) {
  if (!transport || !datagramWriter) return;
  const packet = {
    type,
    id: crypto.randomUUID(),
    sentAt: performance.timeOrigin + performance.now(),
    message,
  };
  const bytes = encoder.encode(JSON.stringify(packet));
  if (bytes.byteLength > 1_200) {
    recordEvent({
      direction: 'ERROR',
      channel: 'datagram',
      event: 'payload-too-large',
      bytes: bytes.byteLength,
      message,
    });
    return;
  }

  try {
    await datagramWriter.ready;
    await datagramWriter.write(bytes);
    incrementSent();
    recordEvent({
      direction: 'OUT',
      channel: 'datagram',
      event: type === 'broadcast' ? 'broadcast-requested' : 'echo-requested',
      bytes: bytes.byteLength,
      message,
      details: { id: packet.id },
    });
  } catch (error) {
    recordEvent({ direction: 'ERROR', channel: 'datagram', event: 'send-failed', details: error });
  }
}

async function readDatagrams(activeTransport, generation) {
  const reader = activeTransport.datagrams.readable.getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done || generation !== connectionGeneration) return;
      incrementReceived();
      handleIncomingDatagram(result.value);
    }
  } catch (error) {
    if (generation === connectionGeneration) {
      recordEvent({
        direction: 'ERROR',
        channel: 'datagram',
        event: 'receive-ended',
        details: error,
      });
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The session may already be closed.
    }
  }
}

function handleIncomingDatagram(bytes) {
  const raw = decoder.decode(bytes);
  let packet;
  try {
    packet = JSON.parse(raw);
  } catch {
    recordEvent({
      direction: 'IN',
      channel: 'datagram',
      event: 'unparsed',
      bytes: bytes.byteLength,
      message: raw,
    });
    return;
  }

  if (packet.type === 'echo') {
    const roundTrip = Math.max(0, performance.timeOrigin + performance.now() - packet.sentAt);
    elements.roundTrip.textContent = `${roundTrip.toFixed(1)} ms`;
    recordEvent({
      direction: 'IN',
      channel: 'datagram',
      event: 'echo-received',
      bytes: bytes.byteLength,
      message: packet.message,
      details: { id: packet.id, roundTripMs: roundTrip, sourceSessionId: packet.sourceSessionId },
    });
    return;
  }

  if (packet.type === 'broadcast') {
    recordEvent({
      direction: 'IN',
      channel: 'datagram',
      event: 'broadcast-received',
      bytes: bytes.byteLength,
      message: packet.message,
      details: {
        id: packet.id,
        sourceSessionId: packet.sourceSessionId,
        recipients: packet.recipients,
      },
    });
    return;
  }

  if (packet.type === 'server-event') {
    if (packet.event === 'session-joined' && elements.sessionId.textContent === '—') {
      elements.sessionId.textContent = packet.sessionId;
    }
    if (packet.event === 'unidirectional-received') {
      elements.uniResult.textContent = `server received ${packet.bytes} bytes`;
    }
    recordEvent({
      direction: 'SERVER',
      channel: 'datagram',
      event: packet.event,
      bytes: bytes.byteLength,
      message: packet.message,
      details: withoutMessage(packet),
    });
    return;
  }

  recordEvent({
    direction: packet.type === 'server-error' ? 'ERROR' : 'IN',
    channel: 'datagram',
    event: packet.event ?? 'unknown-packet',
    bytes: bytes.byteLength,
    message: raw,
    details: packet,
  });
}

async function testBidirectionalStream() {
  if (!transport) return;
  elements.bidi.disabled = true;
  const message = elements.bidiMessage.value;
  const sentBytes = encoder.encode(message);
  elements.bidiResult.textContent = 'sending';
  try {
    const stream = await transport.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    await writer.write(sentBytes);
    await writer.close();
    writer.releaseLock();
    incrementSent();
    recordEvent({
      direction: 'OUT',
      channel: 'bidirectional',
      event: 'stream-sent',
      bytes: sentBytes.byteLength,
      message,
    });

    const receivedBytes = await readAll(reader);
    reader.releaseLock();
    const received = decoder.decode(receivedBytes);
    incrementReceived();
    elements.bidiResult.textContent = received === message ? 'echo matched' : 'echo mismatch';
    recordEvent({
      direction: 'IN',
      channel: 'bidirectional',
      event: received === message ? 'echo-received' : 'echo-mismatch',
      bytes: receivedBytes.byteLength,
      message: received,
    });
  } catch (error) {
    elements.bidiResult.textContent = 'failed';
    recordEvent({
      direction: 'ERROR',
      channel: 'bidirectional',
      event: 'stream-failed',
      details: error,
    });
  } finally {
    elements.bidi.disabled = !transport;
  }
}

async function testUnidirectionalStream() {
  if (!transport) return;
  elements.uni.disabled = true;
  const message = elements.uniMessage.value;
  const bytes = encoder.encode(message);
  elements.uniResult.textContent = 'sending';
  try {
    const stream = await transport.createUnidirectionalStream();
    const writer = stream.getWriter();
    await writer.write(bytes);
    await writer.close();
    writer.releaseLock();
    incrementSent();
    elements.uniResult.textContent = `sent ${bytes.byteLength} bytes; waiting for server`;
    recordEvent({
      direction: 'OUT',
      channel: 'unidirectional',
      event: 'stream-sent',
      bytes: bytes.byteLength,
      message,
    });
  } catch (error) {
    elements.uniResult.textContent = 'failed';
    recordEvent({
      direction: 'ERROR',
      channel: 'unidirectional',
      event: 'stream-failed',
      details: error,
    });
  } finally {
    elements.uni.disabled = !transport;
  }
}

function connectionEnded(candidate, generation, event, details) {
  if (generation !== connectionGeneration || candidate !== transport) return;
  cleanupConnection();
  elements.connection.textContent = event === 'closed' ? 'disconnected' : 'failed';
  recordEvent({
    direction: event === 'closed' ? 'SERVER' : 'ERROR',
    channel: 'session',
    event,
    details,
  });
}

function cleanupConnection() {
  try {
    datagramWriter?.releaseLock();
  } catch {
    // The connection may already be terminal.
  }
  datagramWriter = undefined;
  transport = undefined;
  elements.sessionId.textContent = '—';
  elements.connect.disabled = typeof globalThis.WebTransport !== 'function';
  elements.disconnect.disabled = true;
  setTestButtons(false);
}

function setTestButtons(enabled) {
  elements.datagram.disabled = !enabled;
  elements.broadcast.disabled = !enabled;
  elements.bidi.disabled = !enabled;
  elements.uni.disabled = !enabled;
}

function incrementSent() {
  sentCount += 1;
  elements.sent.textContent = String(sentCount);
}

function incrementReceived() {
  receivedCount += 1;
  elements.received.textContent = String(receivedCount);
}

function recordEvent({ direction, channel, event, bytes, message, details }) {
  const row = document.createElement('tr');
  const values = [
    new Date().toISOString(),
    direction,
    channel,
    event,
    bytes ?? '—',
    message ?? '—',
    formatDetails(details),
  ];
  for (const value of values) {
    const cell = document.createElement('td');
    cell.textContent = String(value);
    row.append(cell);
  }
  elements.log.prepend(row);
  while (elements.log.children.length > MAX_LOG_ENTRIES) elements.log.lastElementChild.remove();
}

function formatDetails(details) {
  if (details === undefined) return '—';
  if (details instanceof Error) return `${details.name}: ${details.message}`;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function withoutMessage(packet) {
  const copy = { ...packet };
  delete copy.message;
  return copy;
}

function hexToBytes(hex) {
  if (!/^[a-fA-F0-9]{64}$/.test(hex))
    throw new Error('certificate SHA-256 must be 64 hex characters');
  return Uint8Array.from(hex.match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
}

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

async function readAll(reader) {
  const chunks = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) return joinChunks(chunks, total);
    chunks.push(result.value);
    total += result.value.byteLength;
  }
}

function joinChunks(chunks, total) {
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
