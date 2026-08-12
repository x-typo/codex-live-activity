export const SMOKE_MARKER = "CLA-APNS-SMOKE-20260812-A";

const STATES = {
  attention: {
    event: "update",
    status: "Needs attention",
    detail: "Synthetic APNs attention update received",
    attentionRequired: true,
    sequence: 1,
  },
  ready: {
    event: "update",
    status: "Ready",
    detail: "Synthetic APNs completion update received",
    attentionRequired: false,
    sequence: 2,
  },
  end: {
    event: "end",
    status: "Ready",
    detail: "Synthetic APNs end update received",
    attentionRequired: false,
    sequence: 3,
  },
};

export function buildSmokePayload(kind, timestamp = Math.floor(Date.now() / 1000)) {
  const definition = STATES[kind];
  if (!definition) {
    throw new TypeError(`kind must be one of: ${Object.keys(STATES).join(", ")}`);
  }
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new TypeError("timestamp must be a positive integer in epoch seconds");
  }

  const aps = {
    timestamp,
    event: definition.event,
    "content-state": {
      status: definition.status,
      detail: definition.detail,
      attentionRequired: definition.attentionRequired,
      marker: SMOKE_MARKER,
      sequence: definition.sequence,
    },
  };

  if (kind === "attention" || kind === "ready") {
    aps["stale-date"] = timestamp + 300;
  }
  if (kind === "end") {
    aps["dismissal-date"] = timestamp + 30;
  }

  return { aps };
}
