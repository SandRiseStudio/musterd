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
  send: (frame: WSServerFrame) => void;
  /** Force-close the underlying socket (used to displace a superseded same-identity session). */
  close?: () => void;
  // P3.2 claim-handshake fields (ADR 077): set while the connection is awaiting admin approval.
  /** Pending request id while the WS is held open awaiting admin decide; cleared on occupation. */
  awaitingClaim?: string | null;
  /** Cached is_admin capability for quick admin broadcast targeting. */
  isAdmin?: boolean;
  /** Callback injected by the claim handler to flip state.authenticated from the HTTP decide path. */
  _claimApproved?: (presenceId: string) => void;
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

  /** Retrieve a connection by connId — used by the HTTP approve handler to find a pending WS. */
  getConn(connId: string): Connection | undefined {
    return this.byConn.get(connId);
  }

  /**
   * Register a pending (unauthenticated) claim connection tracked only by connId — not yet in byMember
   * so it does not receive normal deliver frames while waiting for admin approval (ADR 077).
   */
  addPending(conn: Connection): void {
    this.byConn.set(conn.connId, conn);
  }

  /** Push a terminal claim-decision frame to a specific connection by connId. Returns true if delivered. */
  deliverClaimDecision(connId: string, frame: WSServerFrame): boolean {
    const conn = this.byConn.get(connId);
    if (!conn) return false;
    conn.send(frame);
    return true;
  }

  /** Push a frame to all admin connections on a team (P3.2 admin notifications). Returns count. */
  deliverToAdmins(teamId: string, frame: WSServerFrame): number {
    let n = 0;
    for (const conn of this.byConn.values()) {
      if (conn.teamId !== teamId || !conn.isAdmin) continue;
      conn.send(frame);
      n++;
    }
    return n;
  }

  /** Opt a connection into the team firehose (ADR 061). Cleared on `remove`. */
  subscribeFirehose(connId: string): void {
    this.firehose.add(connId);
  }

  /**
   * Push a frame to every firehose subscriber on a team, skipping members in `skipMemberIds`
   * (recipients + sender already handled by `deliver`/`ack`, so no one is double-sent). When
   * `directed` is set (a member-kind envelope), only full-visibility connections receive it — admins
   * and read-only observer seats (ADR 063, localhost-trust — the /live dashboard). Every firehose
   * subscriber that reaches this loop is a non-party (parties are in `skipMemberIds`), so a regular
   * member must not see another seat's DM. team/broadcast acts stay public (`directed` false). Closes
   * the DM-leak on the live firehose for regular members. (Local-vs-shared observer scoping is a
   * tracked follow-up.) Returns how many got it.
   */
  broadcastFirehose(
    teamId: string,
    frame: WSServerFrame,
    skipMemberIds?: Set<string>,
    directed?: boolean,
  ): number {
    let n = 0;
    for (const connId of this.firehose) {
      const conn = this.byConn.get(connId);
      if (!conn || conn.teamId !== teamId) continue;
      if (skipMemberIds?.has(conn.memberId)) continue;
      if (directed && !(conn.isAdmin || conn.observer)) continue;
      conn.send(frame);
      n++;
    }
    return n;
  }
}
