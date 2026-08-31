/** Privacy defaults for notification / address watching backend. */

export const PRIVACY_CONFIG = {
  addressWatchingDefault: "opt_in" as const,
  storeAddressAsHash: true,
  includeAmountsInPushPayload: false,
  includeAddressesInPushPayload: false,
  analyticsDefault: "opt_in" as const,
  retainDeadPushTokensDays: 30,
  publishPolicyUrl: "https://zuniawallet.com/privacy",
} as const;
