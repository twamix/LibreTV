import { describe, expect, it } from 'vitest';
import { isBlockedByDNS, isPrivateIP, isValidProxyUrl } from './ssrf';

describe('isPrivateIP', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['192.168.1.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['::1', true],
    ['fe80::1', true],
    ['fd00::1', true],
    ['8.8.8.8', false],
    ['1.2.3.4', false],
    // URL.hostname 对 IPv6 返回带方括号形式（"[::1]"），不去括号会漏判
    ['[::1]', true],
    ['[fe80::1]', true],
    ['[::]', true],
    ['::', true],
    // IPv4-mapped / IPv4-compatible：点分与十六进制写法都要归一化后再判
    ['::ffff:192.168.1.100', true],
    ['::ffff:10.0.0.1', true],
    ['::ffff:7f00:1', true],
    ['::ffff:c0a8:164', true],
    ['0:0:0:0:0:ffff:192.168.1.1', true],
    ['::ffff:8.8.8.8', false],
    ['::ffff:808:808', false],
    ['2606:4700:4700::1111', false],
  ])('%s → %s', (ip, expected) => {
    expect(isPrivateIP(ip)).toBe(expected);
  });
});

describe('isValidProxyUrl', () => {
  it('放行公网 http(s)', () => {
    expect(isValidProxyUrl('https://cdn.example.com/a.m3u8')).toBe(true);
    expect(isValidProxyUrl('http://1.2.3.4/x.ts')).toBe(true);
  });

  it('拦截内网与保留地址', () => {
    expect(isValidProxyUrl('http://localhost/x')).toBe(false);
    expect(isValidProxyUrl('http://127.0.0.1/x')).toBe(false);
    expect(isValidProxyUrl('http://192.168.1.1/x')).toBe(false);
    expect(isValidProxyUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
    // IPv6 方括号与 IPv4-mapped 形式同样拦截
    expect(isValidProxyUrl('http://[::1]/x')).toBe(false);
    expect(isValidProxyUrl('http://[::ffff:192.168.1.1]/x')).toBe(false);
    expect(isValidProxyUrl('http://[::ffff:c0a8:164]/x')).toBe(false);
  });

  it('公网 IPv6 不误杀', () => {
    expect(isValidProxyUrl('http://[2606:4700:4700::1111]/x')).toBe(true);
  });

  it('拦截非 http 协议', () => {
    expect(isValidProxyUrl('file:///etc/passwd')).toBe(false);
    expect(isValidProxyUrl('ftp://x.com/a')).toBe(false);
    expect(isValidProxyUrl('not a url')).toBe(false);
  });
});

describe('isBlockedByDNS', () => {
  it('字面量 IPv6（含方括号）走本地判断，不依赖 DNS', async () => {
    await expect(isBlockedByDNS('http://[::1]/x')).resolves.toBe(true);
    await expect(isBlockedByDNS('http://[::ffff:10.0.0.1]/x')).resolves.toBe(true);
    await expect(isBlockedByDNS('http://[2606:4700:4700::1111]/x')).resolves.toBe(false);
  });
});
