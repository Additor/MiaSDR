export type ConnectLinkStatus = "pending" | "completed" | "expired" | "failed";

export interface ConnectLink {
  id: string;
  organizationId: string;
  /** The `name` sent to Unipile, echoed back on the callback. */
  providerName: string;
  /** Hex SHA-256 of the notify secret. The secret itself is never stored. */
  secretHash: string;
  status: ConnectLinkStatus;
  expiresAt: Date;
  providerAccountId: string | null;
  lastError: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

/** Pending hosted-auth links (`linkedin_connect_links`). */
export interface LinkedInConnectStore {
  create(link: { id: string; organizationId: string; providerName: string; secretHash: string; expiresAt: Date; createdBy: string }): Promise<void>;
  /** By id only: the public callback does not know the organization until the secret has matched. */
  find(id: string): Promise<ConnectLink | null>;
  /** Moves a pending link to completed. False when it was not pending (a repeat callback). */
  complete(id: string, input: { providerAccountId: string; now: Date }): Promise<boolean>;
  fail(id: string, error: string): Promise<boolean>;
  /** Records a retryable problem (the sync failed) and leaves the link pending. */
  noteError(id: string, error: string): Promise<void>;
  /** Marks this organization's pending links past their expiry as expired. */
  expireDue(organizationId: string, now: Date): Promise<number>;
  countPending(organizationId: string, now: Date): Promise<number>;
  listRecent(organizationId: string, limit: number, now: Date): Promise<Array<Pick<ConnectLink, "id" | "status" | "expiresAt" | "createdAt" | "completedAt" | "lastError">>>;
}
