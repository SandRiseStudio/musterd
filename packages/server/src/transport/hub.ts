import type { WSServerFrame } from '@musterd/protocol';

export interface Connection {
  connId: string;
  memberId: string;
  memberName: string;
  teamId: string;
  presenceId: string;
  /** Read-only observer seat (ADR 063): no presence events, exempt from single-active displacement. */
  observer?: boolean;
  /**
   * The client's workspace (e.g. `repo@branch`), if it sent one. Agent single-active displacement is
   * scoped by this: a hello from the *same* workspace is the same seat reconnecting (a reload or a
   * health-check probe that briefly spawns the MCP server), so it must not supersede the live session
   * — only a *different* workspace is a genuinely new session that takes the seat (ADR 068).
   */
  workspace?: string | null;
  /**
   * P3.2 (ADR 077): the request_id of a pending claim this connection is waiting on. Set when the
   * server sends a `pending` frame (no-grant path); cleared when the terminal frame (occupied/refused)
   * is pushed by POST /requests/:id/decide or the expiry reaper.
   */
  awaitingClaim?: string | null;
  /** P3.2 (ADR 077): whether this seat holds is_admin capability, cached at connect time so
   *  deliverToAdmins() can push governance notifications without a DB lookup per frame. */
  isAdmin?: boolean;
  /**
   * P3.2 (ADR 077): callback set by the pending-claim WS handler on the provisional Connection.
   * The HTTP approve handler calls this to flip the WS closure's auth state and wire the real
   * presenceId — so the WS can handle subsequent frames (heartbeat, send) after occupation.
   * Only present on connections that went through the no-grant pending path.
   */
  _claimApproved?: (presenceId: string) => void;
  send: (frame: WSServerFrame) => void;
  /** Force-close the underlying socket (used to displace a superseded same-identity session). */
  close?: () => void;
}

/**
 * In-memory registry of live WS connections. Maps member -> their connections so the
 * router can push `deliver` frames to whoever is present. Durability lives in the DB;
 * the hub is purely the live-push layer.
 */
export class Hub {
  private byMember = new Map<string, Set<Connection>>();
  private byConn = new Map<string, Connection>();
  /** connIds that opted into the team firehose (`subscribe` scope `team-all`, ADR 061). */
  private firehose = new Set<string>();

  add(conn: Connection): void {
    this.byConn.set(conn.connId, conn);
    let set = this.byMember.get(conn.memberId);
    if (!set) {
      set = new Set();
      this.byMember.set(conn.memberId, set);
    }
    set.add(conn);
  }

  remove(connId: string): void {
    const conn = this.byConn.get(connId);
    if (!conn) return;
    this.byConn.delete(connId);
    this.firehose.delete(connId);
    const set = this.byMember.get(conn.memberId);
    if (set) {
      set.delete(conn);
      if (set.size === 0) this.byMember.delete(conn.memberId);
    }
  }

  /** Push a frame to all live connections of a member. Returns how many got it. */
  deliver(memberId: string, frame: WSServerFrame): number {
    const set = this.byMember.get(memberId);
    if (!set) return 0;
    for (const conn of set) conn.send(frame);
    return set.size;
  }

  /** Push a frame to every live connection in a team except an optional excluded member. */
  broadcastTeam(teamId: string, frame: WSServerFrame, exceptMemberId?: string): void {
    for (const conn of this.byConn.values()) {
      if (conn.teamId !== teamId) continue;
      if (exceptMemberId && conn.memberId === exceptMemberId) continue;
      conn.send(frame);
    }
  }

  connsForMember(memberId: string): Connection[] {
    return [...(this.byMember.get(memberId) ?? [])];
  }

  /** Look up a single connection by connId. Used by the HTTP approve handler to trigger the
   *  pending→occupied transition on the waiting WS (P3.2, ADR 077). */
  getConn(connId: string): Connection | undefined {
    return this.byConn.get(connId);
  }

  /** Opt a connection into the team firehose (ADR 061). Cleared on `remove`. */
  subscribeFirehose(connId: string): void {
    this.firehose.add(connId);
  }

  /**
   * Push a frame to every firehose subscriber on a team, skipping members in `skipMemberIds`
   * (recipients + sender already handled by `deliver`/`ack`, so no one is double-sent). Returns
   * how many connections got it.
   */
  broadcastFirehose(teamId: string, frame: WSServerFrame, skipMemberIds?: Set<string>): number {
    let n = 0;
    for (const connId of this.firehose) {
      const conn = this.byConn.get(connId);
      if (!conn || conn.teamId !== teamId) continue;
      if (skipMemberIds?.has(conn.memberId)) continue;
      conn.send(frame);
      n++;
    }
    return n;
  }

  /**
   * P3.2 (ADR 077): push an `occupied` or `refused` terminal frame to a specific connection that is
   * waiting on an admin decision (in `awaitingClaim` state). Used by POST /requests/:id/decide and
   * the expiry reaper. Returns true if the connection was found and the frame sent; false if it
   * disconnected while the admin was deliberating (the decision is still recorded, just undelivered).
   */
  deliverClaimDecision(connId: string, frame: WSServerFrame): boolean {
    const conn = this.byConn.get(connId);
    if (!conn) return false;
    conn.awaitingClaim = null;
    conn.send(frame);
    return true;
  }

  /**
   * P3.2 (ADR 077): push a governance notification frame to every connected admin seat on a team.
   * Used to surface pending claim requests to co-present admins so they can approve/deny inline
   * without polling (local-admin fast path, membership-model.md §"Claim flow"). Returns the count
   * of admin connections that received it.
   */
  deliverToAdmins(teamId: string, frame: WSServerFrame): number {
    let n = 0;
    for (const conn of this.byConn.values()) {
      if (conn.teamId !== teamId || !conn.isAdmin) continue;
      conn.send(frame);
      n++;
    }
    return n;
  }
}
