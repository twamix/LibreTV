import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { guardSettingsRequest } from './api-guard';
import { SESSION_COOKIE, signSession } from './auth';

describe('guardSettingsRequest', () => {
  const originalPassword = process.env.PASSWORD;

  beforeEach(() => {
    process.env.PASSWORD = 'settings-test-password';
  });

  afterAll(() => {
    if (originalPassword === undefined) delete process.env.PASSWORD;
    else process.env.PASSWORD = originalPassword;
  });

  it('未配置 PASSWORD 时返回 503', () => {
    process.env.PASSWORD = '';
    const response = guardSettingsRequest(new Request('https://local.test/api/publish'));
    expect(response?.status).toBe(503);
  });

  it('未解锁设置时返回 401', () => {
    const response = guardSettingsRequest(new Request('https://local.test/api/publish'));
    expect(response?.status).toBe(401);
  });

  it('带有效设置会话时放行', () => {
    const token = signSession().token;
    const request = new Request('https://local.test/api/publish', {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(guardSettingsRequest(request)).toBeNull();
  });
});
