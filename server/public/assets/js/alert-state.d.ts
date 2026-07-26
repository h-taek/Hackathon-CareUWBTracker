export type AlertPhase = 'candidate' | 'confirmed' | 'canceled';
export type AlertView = 'idle' | 'alerting' | 'resolved';

export interface AlertViewModel {
  tagId: string;
  name: string | null;
  eventIds: Set<string>;
  phase: AlertPhase;
  firstDetectedAt: number;
  updatedAt: number;
  acknowledgedAt: number | null;
  resolvedAt: number | null;
  resolution: 'auto_canceled' | 'dismissed' | null;
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
): { change: 'ignored' | 'activated' | 'updated' | 'resolved'; reason: string | null; alert: AlertViewModel | null };
export function acknowledgeAlert(store: AlertStore, tagId: string, acknowledgedAt?: number): AlertViewModel | null;
export function dismissAlert(store: AlertStore, tagId: string, dismissedAt?: number): AlertViewModel | null;
export function finishResolved(store: AlertStore, tagId: string): boolean;
export function getActiveAlert(store: AlertStore): AlertViewModel | null;
