import type { Writable } from 'node:stream';
import type { WebTransportLogger } from 'nest-webtransport';

export function createBoundedLogger(
  output: Pick<Writable, 'write' | 'once'> = process.stdout,
): WebTransportLogger {
  let blocked = false;
  let suppressed = 0;
  return (record) => {
    if (blocked) {
      suppressed += 1;
      return;
    }
    const line = JSON.stringify(
      suppressed === 0 ? record : { ...record, loggerSuppressed: suppressed },
    );
    suppressed = 0;
    if (!output.write(`${line}\n`)) {
      blocked = true;
      output.once('drain', () => {
        blocked = false;
      });
    }
  };
}
