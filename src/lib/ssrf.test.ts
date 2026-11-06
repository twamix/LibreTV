import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { isBlockedByDNS, isPrivateIP, isValidProxyUrl, runWithSSRFProtection } from './ssrf';

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

/**
 * 连接级防护（参考上游 #941 / #960）：
 * 请求发出前的 DNS 预检挡不住 rebinding——域名可以先解析到公网，真正建连时
 * 再解析到内网。这里用本地 HTTP server 做真实连接测试（不 mock fetch），
 * 因为要验证的正是 socket 连接阶段的行为。
 */
describe('连接级 SSRF 防护', () => {
  /** 起一个只监听 127.0.0.1 的 server，返回端口与关闭函数 */
  async function startLocalServer(body = 'internal secret data') {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('意外的地址');
    return { port: addr.port, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  it('拦截直接连接的字面量私网 IP', async () => {
    const { port, close } = await startLocalServer();
    try {
      await expect(
        runWithSSRFProtection({ allowPrivate: false }, async () => {
          await fetch(`http://127.0.0.1:${port}/secret`);
        })
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it('拦截解析到私网的主机名（localhost）', async () => {
    const { port, close } = await startLocalServer();
    try {
      await expect(
        runWithSSRFProtection({ allowPrivate: false }, async () => {
          await fetch(`http://localhost:${port}/secret`);
        })
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it('allowPrivate: true 时放行内网（自建 IPTV 场景）', async () => {
    const { port, close } = await startLocalServer('iptv stream data');
    try {
      const text = await runWithSSRFProtection({ allowPrivate: true }, async () => {
        const res = await fetch(`http://127.0.0.1:${port}/live.m3u8`);
        return res.text();
      });
      expect(text).toBe('iptv stream data');
    } finally {
      await close();
    }
  });

  it('连接池复用不能绕过校验：先放行再严格拦截同一源', async () => {
    const { port, close } = await startLocalServer('pool test data');
    try {
      // 先在 allowPrivate 作用域内建立连接
      const text = await runWithSSRFProtection({ allowPrivate: true }, async () => {
        const res = await fetch(`http://127.0.0.1:${port}/first`);
        return res.text();
      });
      expect(text).toBe('pool test data');

      // 随后在严格作用域请求同一源：必须重新校验并拦截，不得复用已有 socket
      await expect(
        runWithSSRFProtection({ allowPrivate: false }, async () => {
          await fetch(`http://127.0.0.1:${port}/second`);
        })
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it('非受保护作用域内不干扰本地网络通信', async () => {
    const { port, close } = await startLocalServer('normal local communication');
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`);
      expect(await res.text()).toBe('normal local communication');
    } finally {
      await close();
    }
  });
});
