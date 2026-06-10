/** The protocol version string carried by every envelope and handshake. */
export const PROTOCOL_VERSION = 'musterd/0.1' as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;
