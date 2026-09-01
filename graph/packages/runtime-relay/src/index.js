import {
  buildRuntimeEnvelopeFromLegacyRow,
  buildRuntimeEnvelopes,
  isRuntimeEnvelope,
} from '../../runtime-core/src/graphEnvelope.js';

function isLegacyRelayRow(entry) {
  return Boolean(entry && typeof entry === 'object' && entry.nodeid && entry.nodeProps && entry.labels);
}

export function getRelayNodeid(row) {
  return row?.nodeid || row?.meta?.nodeid || row?.entities?.[0]?.id;
}

export function normalizeRuntimeRelayPayloads(eventsOrRows) {
  if (!Array.isArray(eventsOrRows) || !eventsOrRows.length) {
    return [];
  }

  if (eventsOrRows.every(isRuntimeEnvelope)) {
    return eventsOrRows.filter((row) => getRelayNodeid(row));
  }

  if (eventsOrRows.every(isLegacyRelayRow)) {
    return eventsOrRows
      .map(buildRuntimeEnvelopeFromLegacyRow)
      .filter((row) => getRelayNodeid(row));
  }

  return buildRuntimeEnvelopes(eventsOrRows).filter((row) => getRelayNodeid(row));
}