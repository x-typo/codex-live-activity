import { STATUS_SCHEMA_VERSION, STATES } from "./status-reducer.mjs";

export const RELAY_MARKER = "CLA-RELAY-ONE-TASK-20260812-A";

const DEFAULT_STALE_AFTER_SECONDS = 300;

const PRESENTATION = Object.freeze({
  running: {
    status: "Working",
    detail: "Codex is working",
    attentionRequired: false,
  },
  waitingForApproval: {
    status: "Needs approval",
    detail: "Review this task in Codex on Mac",
    attentionRequired: true,
  },
  waitingForInput: {
    status: "Needs input",
    detail: "Respond in Codex on Mac",
    attentionRequired: true,
  },
  ready: {
    status: "Ready",
    detail: "Codex finished this task",
    attentionRequired: false,
  },
  blocked: {
    status: "Blocked",
    detail: "Codex could not finish this task",
    attentionRequired: false,
  },
  stale: {
    status: "Status stale",
    detail: "No recent App Server lifecycle signal",
    attentionRequired: false,
  },
  disconnected: {
    status: "Disconnected",
    detail: "The relay lost its App Server stream",
    attentionRequired: false,
  },
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function defaultTimestamp(record) {
  const milliseconds = Date.parse(record.observedAt);
  if (!Number.isFinite(milliseconds)) return Number.NaN;
  return Math.floor(milliseconds / 1_000);
}

export function buildLiveActivityPayload(
  record,
  {
    sequence,
    timestamp = defaultTimestamp(record),
    staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS,
  } = {},
) {
  if (
    !isObject(record) ||
    record.schemaVersion !== STATUS_SCHEMA_VERSION ||
    !STATES.includes(record.state)
  ) {
    throw new TypeError("record must be a supported status event v1 state");
  }
  if (record.title !== null || record.summary !== null) {
    throw new TypeError("relay status title and summary must remain null");
  }
  if (record.aggregate?.total !== 1) {
    throw new TypeError("relay status must describe exactly one task");
  }
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new TypeError("sequence must be a positive safe integer");
  }
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new TypeError("timestamp must be a positive epoch-second integer");
  }
  if (!Number.isSafeInteger(staleAfterSeconds) || staleAfterSeconds <= 0) {
    throw new TypeError("staleAfterSeconds must be a positive safe integer");
  }
  const staleDate = timestamp + staleAfterSeconds;
  if (!Number.isSafeInteger(staleDate)) {
    throw new TypeError("timestamp plus staleAfterSeconds must remain a safe integer");
  }

  const presentation = PRESENTATION[record.state];
  if (record.attentionRequired !== presentation.attentionRequired) {
    throw new TypeError("record attention does not match its lifecycle state");
  }

  return {
    aps: {
      timestamp,
      event: "update",
      "content-state": {
        status: presentation.status,
        detail: presentation.detail,
        attentionRequired: presentation.attentionRequired,
        marker: RELAY_MARKER,
        sequence,
      },
      "stale-date": staleDate,
    },
  };
}
