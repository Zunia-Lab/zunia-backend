/**
 * Notification categories, transport defaults and the one mobile push text.
 * Mobile push goes through FCM HTTP v1 (src/push/fcm.ts); Web Push and
 * chrome.notifications are still to come.
 */

export const NOTIFICATION_CONFIG = {
  schemaVersion: 1,

  categories: [
    "transfer_in",
    "transfer_out",
    "ibc_status",
    "staking",
    "governance",
    "dapp_request",
    "security",
    "price_alert",
    "product",
  ] as const,

  transports: {
    web: {
      foreground: "websocket_or_sse",
      background: "web_push_vapid",
    },
    extension: {
      foreground: "runtime_port",
      background: ["chrome_notifications", "web_push", "chrome_alarms_poll"],
    },
    mobile: {
      foreground: "in_app_banner",
      background: "fcm_apns",
      local: "flutter_local_notifications",
    },
  },

  delivery: {
    semantics: "at_least_once",
    clientDedupeByEventId: true,
    coalesceWindowSec: 60,
    maxPerUserPerHour: 30,
  },

  /**
   * The text of every mobile push. It names no amount, address or chain
   * (config/privacy.ts): the app reads the push's data and fetches the detail.
   */
  push: {
    title: "Zunia",
    body: "New activity in your wallet",
    /** The Android channel zunia-mobile creates at start. */
    androidChannelId: "zunia_activity",
  },

  deepLinks: {
    transfer: "zunia://tx/{hash}",
    proposal: "zunia://gov/{chainId}/{proposalId}",
    dappRequest: "zunia://wc",
    universalBase: "https://zunialab.com",
  },

  /** Env var names — values never committed */
  secrets: {
    vapidPublicKey: "VAPID_PUBLIC_KEY",
    vapidPrivateKey: "VAPID_PRIVATE_KEY",
    vapidSubject: "VAPID_SUBJECT",
    /** FCM HTTP v1 service account JSON path (legacy FCM_SERVER_KEY deprecated) */
    fcmServiceAccountPath: "FCM_SERVICE_ACCOUNT_PATH",
    /** Optional: overrides the project_id of the service account file */
    fcmProjectId: "FCM_PROJECT_ID",
    /** Shared secret zunia-indexer presents on POST /internal/tx-events (32+ characters) */
    internalEventsToken: "INTERNAL_EVENTS_TOKEN",
    /** zunia-indexer base URL, also used by the history proxy (default http://127.0.0.1:8787) */
    indexerApiUrl: "INDEXER_API_URL",
    /** zunia-indexer's INDEXER_API_KEY, sent as x-api-key */
    indexerApiKey: "INDEXER_API_KEY",
    /** One of zunia-indexer's INDEXER_SUBSCRIBE_TOKEN values, sent as x-zunia-subscribe-token */
    indexerSubscribeToken: "INDEXER_SUBSCRIBE_TOKEN",
    /** Peppers address hashes (src/privacy/hash.ts), 16+ characters; required by subscribe */
    addressPepper: "ADDRESS_PEPPER",
    apnsKeyId: "APNS_KEY_ID",
    apnsTeamId: "APNS_TEAM_ID",
    apnsKeyPath: "APNS_KEY_PATH",
    apnsBundleId: "APNS_BUNDLE_ID",
  },
} as const;
