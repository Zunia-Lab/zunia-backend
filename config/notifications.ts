/**
 * Notification categories and transport defaults.
 * Wire to FCM / Web Push / chrome.notifications in Phase 3.
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

  deepLinks: {
    transfer: "zunia://tx/{hash}",
    proposal: "zunia://gov/{chainId}/{proposalId}",
    dappRequest: "zunia://wc",
    universalBase: "https://zuniawallet.com",
  },

  /** Env var names — values never committed */
  secrets: {
    vapidPublicKey: "VAPID_PUBLIC_KEY",
    vapidPrivateKey: "VAPID_PRIVATE_KEY",
    fcmServerKey: "FCM_SERVER_KEY",
    apnsKeyId: "APNS_KEY_ID",
  },
} as const;
