/**
 * Exponential backoff for FFmpeg restart scheduling.
 * Delays: base, base*2, base*4, ... capped at max.
 * The attempt counter is reset once the stream has been healthy for
 * `healthyResetSeconds` (handled by the caller via resetAfterHealth()).
 */
export class ExponentialBackoff {
  private attempt = 0;

  constructor(
    private readonly baseDelaySeconds: number,
    private readonly maxDelaySeconds: number,
  ) {}

  /** Returns the delay in ms for the next restart attempt and advances. */
  nextDelayMs(): number {
    const exponent = Math.min(this.attempt, 16); // guard against runaway growth
    const raw = this.baseDelaySeconds * Math.pow(2, exponent);
    const delay = Math.min(raw, this.maxDelaySeconds) * 1000;
    this.attempt += 1;
    return delay;
  }

  /** Returns the current attempt count without advancing. */
  getAttempts(): number {
    return this.attempt;
  }

  reset(): void {
    this.attempt = 0;
  }
}