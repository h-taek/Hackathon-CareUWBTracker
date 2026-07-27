export type AlertView = 'idle' | 'alerting';

export interface AlertViewModel {
  tagId: string;
  name: string | null;
  eventIds: Set<string>;
  firstDetectedAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  /** 경보를 끝내는 경로는 관제사뿐이다 */
  resolution: 'dismissed' | null;
  peakAccel: number | null;
  freefall: boolean | null;
  aiScore: number | null;
  pos: { x: number; y: number } | null;
  zone: string | null;
}

export interface AlertStore {
  view: AlertView;
  activeTagId: string | null;
  alertsByTag: Map<string, AlertViewModel>;
  processedEventIds: Set<string>;
}

export interface AlertEvent {
  type?: string;
  tagId?: string;
  eventId?: string;
  name?: string;
  ts?: number;
  peakAccel?: number;
  freefall?: boolean;
  aiScore?: number;
  pos?: { x?: number; y?: number } | null;
  zone?: string | null;
}

export function createAlertStore(): AlertStore;
export function applyAlertEvent(
  store: AlertStore,
  event: AlertEvent,
  receivedAt?: number,
): { change: 'ignored' | 'activated' | 'updated'; reason: string | null; alert: AlertViewModel | null };
export function dismissAlert(store: AlertStore, tagId: string, dismissedAt?: number): AlertViewModel | null;
export function getActiveAlert(store: AlertStore): AlertViewModel | null;
