export function nextEnabledChecked(opts: {
  focused: boolean;
  currentChecked: boolean;
  serverEnabled: boolean;
}): boolean {
  return opts.focused ? opts.currentChecked : opts.serverEnabled;
}
