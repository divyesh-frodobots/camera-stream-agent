import { describe, expect, it } from 'vitest';
import { nextEnabledChecked } from '../src/control/controlUiState';

describe('nextEnabledChecked', () => {
  it('uses the server snapshot when the checkbox is not focused', () => {
    expect(
      nextEnabledChecked({ focused: false, currentChecked: false, serverEnabled: true }),
    ).toBe(true);
    expect(
      nextEnabledChecked({ focused: false, currentChecked: true, serverEnabled: false }),
    ).toBe(false);
  });

  it('keeps the current checked value while the checkbox is focused', () => {
    expect(
      nextEnabledChecked({ focused: true, currentChecked: false, serverEnabled: true }),
    ).toBe(false);
    expect(
      nextEnabledChecked({ focused: true, currentChecked: true, serverEnabled: false }),
    ).toBe(true);
  });
});
