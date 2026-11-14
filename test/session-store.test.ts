import { describe, expect, it } from 'vitest';

import { SessionStore, type ManagedSession } from '../src/service/sessions.js';

/**
 * 会话表：TTL、数量上限（LRU 驱逐）、主动删除、后台清扫。
 *
 * 这些都是 A5 的判据，只是不经过 HTTP：表本身的行为必须先在纯函数层站稳，
 * 否则传输层测试一失败就分不清是"表坏了"还是"路由没接对"。
 */

class FakeSession implements ManagedSession {
  closed = false;
  constructor(readonly id: string, public lastUsedAt: number) {}
  async close(): Promise<void> {
    this.closed = true;
  }
}

function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('SessionStore：TTL', () => {
  it('未过期可取并刷新活跃时间；过期后取不到且自动关闭', async () => {
    const c = clock();
    const store = new SessionStore<FakeSession>({ ttlMs: 1_000, max: 10, now: c.now });
    const session = new FakeSession('a', c.now());
    await store.add(session);

    c.advance(600);
    const hit = store.get('a');
    expect(hit).toBe(session);
    expect(session.lastUsedAt).toBe(1_600);

    c.advance(900); // 距上次使用 900 < 1000
    expect(store.get('a')).toBe(session);
    c.advance(1_001);
    expect(store.get('a')).toBeUndefined();
    expect(session.closed).toBe(true);
    expect(store.size).toBe(0);
  });

  it('sweep 清掉过期会话并返回条数', async () => {
    const c = clock();
    const store = new SessionStore<FakeSession>({ ttlMs: 500, max: 10, now: c.now });
    await store.add(new FakeSession('a', c.now()));
    await store.add(new FakeSession('b', c.now()));
    c.advance(600);
    expect(await store.sweep()).toBe(2);
    expect(store.size).toBe(0);
  });
});

describe('SessionStore：数量上限', () => {
  it('达到上限时按最近最少使用驱逐，新会话总能进来', async () => {
    const c = clock();
    const store = new SessionStore<FakeSession>({ ttlMs: 60_000, max: 2, now: c.now });
    const a = new FakeSession('a', c.now());
    const b = new FakeSession('b', c.now());
    await store.add(a);
    c.advance(10);
    await store.add(b);
    c.advance(10);
    // 让 a 变成最近使用过，b 成为最久未用
    store.get('a');
    c.advance(10);
    const d = new FakeSession('d', c.now());
    await store.add(d);

    expect(store.size).toBe(2);
    expect(store.get('b')).toBeUndefined();
    expect(b.closed).toBe(true);
    expect(store.get('a')).toBe(a);
    expect(store.get('d')).toBe(d);
  });

  it('delete 关闭并从表里移除；重复 delete 幂等', async () => {
    const c = clock();
    const store = new SessionStore<FakeSession>({ ttlMs: 60_000, max: 2, now: c.now });
    const a = new FakeSession('a', c.now());
    await store.add(a);
    await store.delete('a');
    expect(a.closed).toBe(true);
    expect(store.size).toBe(0);
    await expect(store.delete('a')).resolves.toBeUndefined();
  });

  it('forget 只摘表、不调用 close（transport 自己关的时候用）', async () => {
    const c = clock();
    const store = new SessionStore<FakeSession>({ ttlMs: 60_000, max: 2, now: c.now });
    const a = new FakeSession('a', c.now());
    await store.add(a);
    store.forget('a');
    expect(store.size).toBe(0);
    expect(a.closed).toBe(false);
  });
});
