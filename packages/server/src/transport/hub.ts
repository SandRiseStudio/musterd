import type { WSServerFrame } from '@musterd/protocol';

export interface Connection {
  connId: string;
  memberId: string;
  memberName: string;
  teamId: string;
  presenceId: string;
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
}
