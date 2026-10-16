import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readEnv } from '../apps/server/src/config.js';

const fixtureEnvironment: Record<string, string | undefined> = {
  NODE_ENV: 'test', PORT: '3000', APP_URL: 'https://assistant.example', ALLOWED_SHOPS: 'bionera-gr.myshopify.com',
  SHOPIFY_AUTH_CALLBACK_PATH: '/auth/bionera/callback',
  TAVUS_ENABLED: 'true', TAVUS_API_KEY: 'synthetic-provider-key-only', TAVUS_FACE_ID: 'rc8992fe8e8e',
  TAVUS_PILOT_SHOP: 'bionera-gr.myshopify.com', TAVUS_PREVIEW_CODE_SHA256: 'a'.repeat(64),
  TAVUS_BACKGROUND: undefined, TAVUS_ELEVENLABS_VOICE_ID: undefined, TAVUS_ELEVENLABS_MODEL: undefined,
};

beforeEach(() => { for (const [name, value] of Object.entries(fixtureEnvironment)) vi.stubEnv(name, value); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('private Tavus presentation environment', () => {
  it('preserves the existing face and voice behavior when presentation overrides are absent', () => {
    const environment = readEnv();
    expect(environment.tavus).toMatchObject({ faceId: 'rc8992fe8e8e', pilotShop: 'bionera-gr.myshopify.com' });
    expect(environment.tavus?.background).toBeUndefined();
    expect(environment.tavus?.voice).toBeUndefined();
  });

  it.each(['r53a461095cf', 'r90bbd427f71'])('accepts greenscreen for verified Phoenix-4 face %s', face => {
    vi.stubEnv('TAVUS_FACE_ID', face); vi.stubEnv('TAVUS_BACKGROUND', 'greenscreen');
    expect(readEnv().tavus).toMatchObject({ faceId: face, background: 'greenscreen' });
  });

  it.each(['rc8992fe8e8e', 'unverified-face'])('rejects greenscreen for unsupported face %s', face => {
    vi.stubEnv('TAVUS_FACE_ID', face); vi.stubEnv('TAVUS_BACKGROUND', 'greenscreen');
    expect(() => readEnv()).toThrow('Greenscreen requires a verified compatible Phoenix-4 face');
  });

  it('rejects an unrecognized background mode instead of silently enabling another presentation', () => {
    vi.stubEnv('TAVUS_BACKGROUND', 'transparent');
    expect(() => readEnv()).toThrow();
  });

  it.each(['eleven_multilingual_v2', 'eleven_flash_v2_5'])('accepts a complete external voice selection for %s', model => {
    vi.stubEnv('TAVUS_ELEVENLABS_VOICE_ID', 'aTP4J5SJLQl74WTSRXKW'); vi.stubEnv('TAVUS_ELEVENLABS_MODEL', model);
    expect(readEnv().tavus?.voice).toEqual({ externalVoiceId: 'aTP4J5SJLQl74WTSRXKW', model });
  });

  it.each([
    ['aTP4J5SJLQl74WTSRXKW', undefined],
    [undefined, 'eleven_multilingual_v2'],
    ['aTP4J5SJLQl74WTSRXKW', 'unknown-model'],
    ['https://example.test/voice', 'eleven_multilingual_v2'],
  ])('fails closed for partial or invalid external voice configuration', (voiceId, model) => {
    vi.stubEnv('TAVUS_ELEVENLABS_VOICE_ID', voiceId); vi.stubEnv('TAVUS_ELEVENLABS_MODEL', model);
    expect(() => readEnv()).toThrow();
  });

  it('does not enable Tavus merely because presentation options are supplied', () => {
    vi.stubEnv('TAVUS_ENABLED', 'false'); vi.stubEnv('TAVUS_BACKGROUND', 'greenscreen');
    vi.stubEnv('TAVUS_ELEVENLABS_VOICE_ID', 'aTP4J5SJLQl74WTSRXKW'); vi.stubEnv('TAVUS_ELEVENLABS_MODEL', 'eleven_multilingual_v2');
    expect(readEnv().tavus).toBeUndefined();
  });
});
