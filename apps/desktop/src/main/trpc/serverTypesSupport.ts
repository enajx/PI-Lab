/**
 * Only for the declaration build of the server's tRPC router type
 * (tsconfig.server-types.json, used by the phone app's type check). The
 * router's inferred type uses tRPC types that the public entry points do not
 * export; with this re-export in the program, `tsc --declaration` can name them
 * through `@trpc/server/unstable-core-do-not-import`. Nothing imports this file.
 */
export type {
  LegacyObservableSubscriptionProcedure,
  TrackedData,
} from "@trpc/server/unstable-core-do-not-import"
