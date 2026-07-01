#!/usr/bin/env node
// Minimal local OTLP/HTTP receiver — the interim "sink" for instrument-by-default dogfooding (ADR 082).
//
// It is deliberately dumb: accept OTLP/HTTP (JSON) exports on :4318, log the span names + key
// attributes and the metric data points, and append them to a file. This is the throwaway stand-in
// batond replaces — NOT a backend. When Docker is available, prefer a real collector
// (e.g. `docker run -p 4317:4317 -p 4318:4318 -p 3000:3000 grafana/otel-lgtm`); this exists so the
// dogfood daemon is measurable live with zero external dependencies.
//
// Usage: node scripts/dev-otel-sink.mjs [--port 4318] [--log ~/.musterd/otel-sink.log]
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const PORT = Number(opt('--port', process.env.PORT ?? '4318'));
const LOG = opt('--log', join(homedir(), '.musterd', 'otel-sink.log'));

function emit(line) {
  const stamped = `${new Date().toISOString()} ${line}`;
  process.stdout.write(stamped + '\n');
  try {
    appendFileSync(LOG, stamped + '\n');
  } catch {
    /* best-effort */
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let buf = Buffer.concat(chunks);
      if ((req.headers['content-encoding'] ?? '').includes('gzip')) {
        try {
          buf = gunzipSync(buf);
        } catch {
          /* leave raw */
        }
      }
      resolve(buf);
    });
  });
}

function summarizeTraces(json) {
  let n = 0;
  for (const rs of json.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        n++;
        const attrs = Object.fromEntries(
          (span.attributes ?? []).map((a) => [
            a.key,
            a.value?.stringValue ?? a.value?.intValue ?? a.value?.boolValue ?? '',
          ]),
        );
        const kv = Object.entries(attrs)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ');
        emit(`  span "${span.name}" ${kv}`);
      }
    }
  }
  return n;
}

function summarizeMetrics(json) {
  let n = 0;
  for (const rm of json.resourceMetrics ?? []) {
    for (const sm of rm.scopeMetrics ?? []) {
      for (const m of sm.metrics ?? []) {
        n++;
        const pts = m.sum?.dataPoints ?? m.gauge?.dataPoints ?? m.histogram?.dataPoints ?? [];
        const vals = pts
          .map((p) => p.asInt ?? p.asDouble ?? p.count ?? '?')
          .slice(0, 4)
          .join(',');
        emit(`  metric "${m.name}" points=[${vals}]`);
      }
    }
  }
  return n;
}

const server = createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  const buf = await readBody(req);
  let json;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch {
    emit(
      `${req.url} — ${buf.length}B non-JSON body (protobuf? set OTEL_EXPORTER_OTLP_PROTOCOL=http/json)`,
    );
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    return;
  }
  if (req.url?.endsWith('/v1/traces')) emit(`/v1/traces — ${summarizeTraces(json)} span(s)`);
  else if (req.url?.endsWith('/v1/metrics'))
    emit(`/v1/metrics — ${summarizeMetrics(json)} metric(s)`);
  else emit(`${req.url} — ${buf.length}B`);
  res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
});

server.listen(PORT, '127.0.0.1', () =>
  emit(`dev-otel-sink listening on http://127.0.0.1:${PORT} → ${LOG}`),
);
