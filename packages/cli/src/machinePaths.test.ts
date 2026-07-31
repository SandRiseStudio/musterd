import { afterEach, describe, expect, it } from 'vitest';
import { machineStatePath } from './machinePaths.js';

describe('machineStatePath (ADR 190)', () => {
  const prevConfig = process.env['MUSTERD_CONFIG'];
  const prevHost = process.env['MUSTERD_HOST_REGISTRY'];

  afterEach(() => {
    if (prevConfig === undefined) delete process.env['MUSTERD_CONFIG'];
    else process.env['MUSTERD_CONFIG'] = prevConfig;
    if (prevHost === undefined) delete process.env['MUSTERD_HOST_REGISTRY'];
    else process.env['MUSTERD_HOST_REGISTRY'] = prevHost;
  });

  it('returns the env override when set', () => {
    process.env['MUSTERD_CONFIG'] = '/tmp/isolated-config.json';
    expect(machineStatePath('MUSTERD_CONFIG', 'config.json')).toBe('/tmp/isolated-config.json');
  });

  it('throws under VITEST when the override is cleared', () => {
    expect(process.env['VITEST']).toBeTruthy();
    delete process.env['MUSTERD_CONFIG'];
    expect(() => machineStatePath('MUSTERD_CONFIG', 'config.json')).toThrow(
      /MUSTERD_CONFIG must be set when VITEST is set/,
    );
  });

  it('throws for the host registry under the same rule', () => {
    delete process.env['MUSTERD_HOST_REGISTRY'];
    expect(() => machineStatePath('MUSTERD_HOST_REGISTRY', 'host-registry.json')).toThrow(
      /MUSTERD_HOST_REGISTRY must be set when VITEST is set/,
    );
  });
});
