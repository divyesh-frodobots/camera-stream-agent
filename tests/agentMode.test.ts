import { describe, expect, it } from 'vitest';
import { selectAgentMode, shouldStartControlServer } from '../src/localMode/agentMode';

describe('selectAgentMode', () => {
  it('uses file mode when cameras.json exists, even if API key and STREAM_URL are set', () => {
    expect(
      selectAgentMode({
        camerasFileExists: true,
        hasConfiguredCamera: false,
        streamUrl: 'rtsp://cam.example/stream',
        agentApiKey: 'agent-key',
      }),
    ).toBe('file');
  });

  it('uses file mode when any camera is configured, even if the json file check is false', () => {
    expect(
      selectAgentMode({
        camerasFileExists: false,
        hasConfiguredCamera: true,
      }),
    ).toBe('file');
  });

  it('uses env-single mode when STREAM_URL is set and there is no cameras file', () => {
    expect(
      selectAgentMode({
        camerasFileExists: false,
        hasConfiguredCamera: false,
        streamUrl: 'rtsp://cam.example/stream',
        agentApiKey: 'agent-key',
      }),
    ).toBe('env-single');
  });

  it('uses backend mode when only AGENT_API_KEY is set', () => {
    expect(
      selectAgentMode({
        camerasFileExists: false,
        hasConfiguredCamera: false,
        agentApiKey: 'agent-key',
      }),
    ).toBe('backend');
  });

  it('uses file mode with empty six rows when there is no json, STREAM_URL, or API key', () => {
    expect(
      selectAgentMode({
        camerasFileExists: false,
        hasConfiguredCamera: false,
        streamUrl: '',
        agentApiKey: '',
      }),
    ).toBe('file');
  });
});

describe('shouldStartControlServer', () => {
  it('starts the control server in file and env-single modes', () => {
    expect(shouldStartControlServer('file')).toBe(true);
    expect(shouldStartControlServer('env-single')).toBe(true);
  });

  it('skips the control server in backend mode', () => {
    expect(shouldStartControlServer('backend')).toBe(false);
  });
});
