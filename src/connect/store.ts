import { and, count, eq, gt, isNotNull, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { connectSessions } from "../db/schema.js";

/** A relay session as persisted. Tokens are SHA-256 hashes; times are epoch milliseconds. */
export interface ConnectSessionRecord {
  id: string;
  dappTokenHash: string;
  walletJoinTokenHash: string | null;
  walletResumeTokenHash: string | null;
  verifiedOrigin: string | null;
  paired: boolean;
  expiresAt: number;
  createdAt: number;
}

export interface ConnectStore {
  insert(record: ConnectSessionRecord): Promise<void>;
  get(id: string): Promise<ConnectSessionRecord | null>;
  /**
   * Swap the join token for a resume token in one step.
   * Resolves false when the join token was already used, so only one wallet can join.
   */
  consumeJoin(id: string, resumeTokenHash: string): Promise<boolean>;
  markPaired(id: string, expiresAt: number): Promise<void>;
  remove(id: string): Promise<void>;
  /** Delete sessions that expired at or before `now` and return their ids. */
  removeExpired(now: number): Promise<string[]>;
  countLive(now: number): Promise<number>;
}

/** Sessions in process memory, for development and tests. Lost on restart. */
export class MemoryConnectStore implements ConnectStore {
  private readonly records = new Map<string, ConnectSessionRecord>();

  async insert(record: ConnectSessionRecord): Promise<void> {
    if (this.records.has(record.id)) throw new Error("Session id collision");
    this.records.set(record.id, { ...record });
  }

  async get(id: string): Promise<ConnectSessionRecord | null> {
    const record = this.records.get(id);
    return record ? { ...record } : null;
  }

  async consumeJoin(id: string, resumeTokenHash: string): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || record.walletJoinTokenHash === null) return false;
    record.walletJoinTokenHash = null;
    record.walletResumeTokenHash = resumeTokenHash;
    return true;
  }

  async markPaired(id: string, expiresAt: number): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    record.paired = true;
    record.expiresAt = expiresAt;
  }

  async remove(id: string): Promise<void> {
    this.records.delete(id);
  }

  async removeExpired(now: number): Promise<string[]> {
    const expired: string[] = [];
    for (const [id, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(id);
        expired.push(id);
      }
    }
    return expired;
  }

  async countLive(now: number): Promise<number> {
    let live = 0;
    for (const record of this.records.values()) {
      if (record.expiresAt > now) live += 1;
    }
    return live;
  }
}

/** Sessions in Postgres, so pairings survive a relay restart. */
export class PgConnectStore implements ConnectStore {
  constructor(private readonly db: Db) {}

  async insert(record: ConnectSessionRecord): Promise<void> {
    await this.db.insert(connectSessions).values({
      id: record.id,
      dappTokenHash: record.dappTokenHash,
      walletJoinTokenHash: record.walletJoinTokenHash,
      walletResumeTokenHash: record.walletResumeTokenHash,
      verifiedOrigin: record.verifiedOrigin,
      paired: record.paired,
      expiresAt: new Date(record.expiresAt),
      createdAt: new Date(record.createdAt),
    });
  }

  async get(id: string): Promise<ConnectSessionRecord | null> {
    const [row] = await this.db
      .select()
      .from(connectSessions)
      .where(eq(connectSessions.id, id))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      dappTokenHash: row.dappTokenHash,
      walletJoinTokenHash: row.walletJoinTokenHash,
      walletResumeTokenHash: row.walletResumeTokenHash,
      verifiedOrigin: row.verifiedOrigin,
      paired: row.paired,
      expiresAt: row.expiresAt.getTime(),
      createdAt: row.createdAt.getTime(),
    };
  }

  async consumeJoin(id: string, resumeTokenHash: string): Promise<boolean> {
    const rows = await this.db
      .update(connectSessions)
      .set({ walletJoinTokenHash: null, walletResumeTokenHash: resumeTokenHash })
      .where(and(eq(connectSessions.id, id), isNotNull(connectSessions.walletJoinTokenHash)))
      .returning({ id: connectSessions.id });
    return rows.length === 1;
  }

  async markPaired(id: string, expiresAt: number): Promise<void> {
    await this.db
      .update(connectSessions)
      .set({ paired: true, expiresAt: new Date(expiresAt) })
      .where(eq(connectSessions.id, id));
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(connectSessions).where(eq(connectSessions.id, id));
  }

  async removeExpired(now: number): Promise<string[]> {
    const rows = await this.db
      .delete(connectSessions)
      .where(lte(connectSessions.expiresAt, new Date(now)))
      .returning({ id: connectSessions.id });
    return rows.map((row) => row.id);
  }

  async countLive(now: number): Promise<number> {
    const [row] = await this.db
      .select({ live: count() })
      .from(connectSessions)
      .where(gt(connectSessions.expiresAt, new Date(now)));
    return Number(row?.live ?? 0);
  }
}
