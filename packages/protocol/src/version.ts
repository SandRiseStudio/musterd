/**
 * The protocol version — a pure constant, and **nothing else**.
 *
 * This module is the first thing the package barrel re-exports, so it is evaluated by *every* consumer,
 * including the browser. It must therefore stay free of Node built-ins: `readBuildStamp` used to live here
 * and imported `node:fs`, which meant a single value-import of anything from `@musterd/protocol` blew up
 * the web dev server. It now lives in `./build-stamp.ts`, behind its own entry point. Keep this file pure.
 */

/** The protocol version string carried by every envelope and handshake. */
export const PROTOCOL_VERSION = 'musterd/0.3' as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;
