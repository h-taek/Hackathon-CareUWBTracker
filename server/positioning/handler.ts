import { positionFromIngest, type PositionFromIngestOptions, type PositionResult } from './from-ingest.ts';

type IngestPayload = Parameters<typeof positionFromIngest>[0];

export type PositioningHandler = (payload: IngestPayload) => PositionResult | null;

export function createPositioningHandler(
  options: PositionFromIngestOptions,
  onPosition: (position: PositionResult) => void = () => {},
): PositioningHandler {
  if (typeof onPosition !== 'function') throw new TypeError('onPosition must be a function');

  return function handlePositioning(payload: IngestPayload): PositionResult | null {
    const position = positionFromIngest(payload, options);
    if (position) onPosition(position);
    return position;
  };
}
