import { describe, it, expect } from 'vitest';
import { ExponentialBackoff } from '../src/monitoring/backoff';

describe('ExponentialBackoff', () => {
  it('produces exponential delays capped at max', () => {
    const backoff = new ExponentialBackoff(5, 60);
    const delays = [backoff.nextDelayMs(), backoff.nextDelayMs(), backoff.nextDelayMs(), backoff.nextDelayMs()];
    expect(delays[0]).toBe(5000);
    expect(delays[1]).toBe(10000);
    expect(delays[2]).toBe(20000);
    expect(delays[3]).toBe(40000);
    expect(backoff.nextDelayMs()).toBe(60000); // capped
    expect(backoff.nextDelayMs()).toBe(60000); // stays capped
  });

  it('tracks attempt count and resets', () => {
    const backoff = new ExponentialBackoff(1, 60);
    expect(backoff.getAttempts()).toBe(0);
    backoff.nextDelayMs();
    backoff.nextDelayMs();
    expect(backoff.getAttempts()).toBe(2);
    backoff.reset();
    expect(backoff.getAttempts()).toBe(0);
    expect(backoff.nextDelayMs()).toBe(1000);
  });

  it('guards against runaway exponent growth', () => {
    const backoff = new ExponentialBackoff(5, 60);
    for (let i = 0; i < 100; i += 1) backoff.nextDelayMs();
    expect(backoff.nextDelayMs()).toBe(60000);
  });
});