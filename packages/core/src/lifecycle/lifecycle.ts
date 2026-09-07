import { WebTransportError } from '../errors/base.error.js';
import {
  WebTransportServerState,
  type WebTransportServerState as WebTransportServerStateValue,
} from './server-state.js';

const allowedTransitions: Readonly<
  Record<WebTransportServerStateValue, readonly WebTransportServerStateValue[]>
> = {
  STARTING: [WebTransportServerState.RUNNING, WebTransportServerState.STOPPING],
  RUNNING: [WebTransportServerState.DRAINING, WebTransportServerState.STOPPING],
  DRAINING: [WebTransportServerState.STOPPING],
  STOPPING: [WebTransportServerState.STOPPED],
  STOPPED: [WebTransportServerState.STARTING],
};

export interface WebTransportLifecycleSnapshot {
  readonly state: WebTransportServerStateValue;
  readonly alive: boolean;
  readonly ready: boolean;
  readonly acceptingSessions: boolean;
}

export function isWebTransportServerStateTransitionAllowed(
  from: WebTransportServerStateValue,
  to: WebTransportServerStateValue,
): boolean {
  return from === to || allowedTransitions[from].includes(to);
}

export class WebTransportLifecycle {
  #state: WebTransportServerStateValue;

  constructor(initialState: WebTransportServerStateValue = WebTransportServerState.STOPPED) {
    this.#state = initialState;
  }

  get state(): WebTransportServerStateValue {
    return this.#state;
  }

  get snapshot(): WebTransportLifecycleSnapshot {
    const ready = this.#state === WebTransportServerState.RUNNING;

    return Object.freeze({
      state: this.#state,
      alive: this.#state !== WebTransportServerState.STOPPED,
      ready,
      acceptingSessions: ready,
    });
  }

  transition(nextState: WebTransportServerStateValue): WebTransportLifecycleSnapshot {
    if (!isWebTransportServerStateTransitionAllowed(this.#state, nextState)) {
      throw new WebTransportError(
        `Invalid WebTransport server state transition: ${this.#state} -> ${nextState}`,
        {
          code: 'ERR_WEBTRANSPORT_INVALID_SERVER_STATE_TRANSITION',
          recoverable: false,
          scope: 'FATAL',
        },
      );
    }

    this.#state = nextState;
    return this.snapshot;
  }
}
