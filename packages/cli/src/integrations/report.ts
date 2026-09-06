import {
  IntegrationDoctorReportSchema,
  type IntegrationCheck,
  type IntegrationDoctorReport,
  type IntegrationSection,
} from '@musterd/protocol';
import { theme } from '../render/theme.js';
import { sym } from '../render/ui.js';

export const INTEGRATION_LIMITS = [
  'configuration and reachability evidence only; Aperture enforcement remains off',
  'no device management, sandbox enforcement, or unrelated-harness coverage',
] as const;

function section(
  integration: 'tailscale' | 'aperture',
  selected: boolean,
  checks: IntegrationCheck[],
): IntegrationSection {
  if (!selected) return { integration, selected: false, posture: 'off', checks: [] };
  const blocked = checks.some((check) => check.state === 'fail');
  return {
    integration,
    selected: true,
    posture: blocked ? 'blocked' : integration === 'tailscale' ? 'verified' : 'ready',
    checks,
  };
}

export function composeIntegrationReport(input: {
  observedAt: number;
  tailscaleSelected: boolean;
  tailscaleChecks: IntegrationCheck[];
  apertureSelected: boolean;
  apertureChecks: IntegrationCheck[];
}): IntegrationDoctorReport {
  const tailscale = section('tailscale', input.tailscaleSelected, input.tailscaleChecks);
  const aperture = section('aperture', input.apertureSelected, input.apertureChecks);
  return IntegrationDoctorReportSchema.parse({
    version: 1,
    ok: ![tailscale, aperture].some(
      (candidate) => candidate.selected && candidate.checks.some((check) => check.state === 'fail'),
    ),
    observed_at: input.observedAt,
    tailscale,
    aperture,
    limits: [...INTEGRATION_LIMITS],
  });
}

function renderCheck(check: IntegrationCheck): string {
  const marker =
    check.state === 'ok'
      ? theme.ok(sym.ok)
      : check.state === 'fail'
        ? theme.err(sym.err)
        : theme.meta(sym.dot);
  const line = `${marker} ${check.label}${check.detail ? ` — ${check.detail}` : ''}`;
  return check.fix ? `${line}\n  ${theme.meta(`${sym.arrow} ${check.fix}`)}` : line;
}

function tailscaleHeading(section: IntegrationSection): string {
  return `TAILSCALE TRANSPORT — ${section.posture}`;
}

function apertureHeading(section: IntegrationSection): string {
  if (section.posture === 'ready') return 'APERTURE MODEL ENFORCEMENT — off (configuration ready)';
  if (section.posture === 'blocked') return 'APERTURE MODEL ENFORCEMENT — blocked (configuration not ready)';
  return 'APERTURE MODEL ENFORCEMENT — off';
}

export function renderIntegrationReport(report: IntegrationDoctorReport): string {
  const tailscale = [
    theme.accent(tailscaleHeading(report.tailscale)),
    ...report.tailscale.checks.map(renderCheck),
  ];
  const aperture = [
    theme.accent(apertureHeading(report.aperture)),
    ...report.aperture.checks.map(renderCheck),
  ];
  const limits = [theme.accent('LIMITS'), ...report.limits.map((limit) => `${theme.meta(sym.dot)} ${limit}`)];
  return ['integration doctor', '', ...tailscale, '', ...aperture, '', ...limits].join('\n');
}
