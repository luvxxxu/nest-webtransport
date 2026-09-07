export interface WebTransportCodec<Value = unknown> {
  encode(value: Value): Uint8Array;
  decode(data: Uint8Array): Value;
}

export const rawWebTransportCodec: WebTransportCodec<Uint8Array> = Object.freeze({
  encode(value: Uint8Array): Uint8Array {
    return value;
  },
  decode(data: Uint8Array): Uint8Array {
    return data;
  },
});
