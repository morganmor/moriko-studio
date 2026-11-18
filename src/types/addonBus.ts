


export interface AddonBusPayload {
  
  id?: number;
  topic: string;
  payload: Record<string, unknown>;
  addonId: string;
  ts: number;
}
