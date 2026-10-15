/**
 * Client-side mirror of the addon-bus frame type (server/addons/types.ts).
 * TIDAK mengimpor dari server/ — tipe di-mirror agar aplikasi klien tidak
 * menyeret graf tipe server (node) ke tsconfig.app.json. Bentuk field harus
 * tetap sinkron dengan AddonBusPayload di server.
 */

/** A message on the cross-session addon bus (server → browser via SSE). */
export interface AddonBusPayload {
  /** v2 (A7): monotonic frame id — reconnect replay key. */
  id?: number;
  topic: string;
  payload: Record<string, unknown>;
  addonId: string;
  ts: number;
}
