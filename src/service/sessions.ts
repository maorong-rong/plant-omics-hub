/**
 * HTTP 会话表：`Mcp-Session-Id` 的签发、复用、过期与数量上限。
 *
 * 为什么要这张表（P2 的关键前提）：MCP 的 `notifications/tools/list_changed`
 * 是**服务端主动**发给某个会话的，必须有一条属于该会话的 transport 才能送达。
 * 旧的 HTTP 出口每个请求新建 server+transport（`sessionIdGenerator: undefined`），
 * 根本没有"会话"可挂通知——DSH 插件走的又正是 HTTP，所以宿主侧那半验证过也没用。
 *
 * 设计约束：
 *   - **TTL**：空闲超过 `ttlMs` 的会话按 MCP 规范语义作废（旧 id 一律 404），
 *     并在后台清扫，避免连接与内存只增不减；
 *   - **数量上限**：满了按**最近最少使用**驱逐，而不是拒绝新会话——
 *     "突然连不上"比"旧会话被回收"更难排查；
 *   - **不串工具集**：每个条目自带工具集，表本身不持有任何会话状态。
 */

/** 会话表只要求能关掉自己；具体是 MCP transport + server，还是测试替身，由调用方决定。 */
export interface ManagedSession {
  /** initialize 之后才有值；登记时由 `onsessioninitialized` 回调填入 */
  id: string;
  lastUsedAt: number;
  /** 关闭底层 transport/server；必须幂等 */
  close(): Promise<void>;
}

export interface SessionStoreOptions<T extends ManagedSession> {
  readonly ttlMs: number;
  readonly max: number;
  /** 测试注入时钟 */
  readonly now?: () => number;
  /** 驱逐/过期时的回调（日志用；不影响判定） */
  readonly onEvict?: (session: T, reason: 'ttl' | 'lru' | 'closed') => void;
}

export class SessionStore<T extends ManagedSession> {
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;
  readonly #onEvict: ((session: T, reason: 'ttl' | 'lru' | 'closed') => void) | undefined;
  /** id → 会话；Map 的迭代顺序即插入顺序，LRU 另按 lastUsedAt 找 */
  readonly #sessions = new Map<string, T>();
  #sweeper: NodeJS.Timeout | undefined;

  constructor(options: SessionStoreOptions<T>) {
    this.#ttlMs = options.ttlMs;
    this.#max = options.max;
    this.#now = options.now ?? Date.now;
    this.#onEvict = options.onEvict;
  }

  get size(): number {
    return this.#sessions.size;
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  get max(): number {
    return this.#max;
  }

  /** 取出并刷新活跃时间；过期则作废并返回 undefined（调用方回 404）。 */
  get(id: string): T | undefined {
    const session = this.#sessions.get(id);
    if (!session) return undefined;
    if (this.#now() - session.lastUsedAt > this.#ttlMs) {
      this.#sessions.delete(id);
      this.#onEvict?.(session, 'ttl');
      void session.close().catch(() => {});
      return undefined;
    }
    session.lastUsedAt = this.#now();
    return session;
  }

  /**
   * 登记一个会话。满了先驱逐最久未用者。
   *
   * 注意先驱逐再插入：如果先插入再驱逐，刚登记的会话可能因为时间戳并列被自己踢掉。
   */
  async add(session: T): Promise<void> {
    if (this.#sessions.size >= this.#max) await this.#evictLeastRecentlyUsed();
    session.lastUsedAt = this.#now();
    this.#sessions.set(session.id, session);
  }

  async delete(id: string): Promise<void> {
    const session = this.#sessions.get(id);
    if (!session) return;
    this.#sessions.delete(id);
    this.#onEvict?.(session, 'closed');
    await session.close().catch(() => {});
  }

  /** 被动关闭（例如 transport 自己关了）：只摘表，不再调用 close（避免递归）。 */
  forget(id: string): void {
    const session = this.#sessions.get(id);
    if (!session) return;
    this.#sessions.delete(id);
    this.#onEvict?.(session, 'closed');
  }

  async #evictLeastRecentlyUsed(): Promise<void> {
    let oldest: T | undefined;
    for (const session of this.#sessions.values()) {
      if (!oldest || session.lastUsedAt < oldest.lastUsedAt) oldest = session;
    }
    if (!oldest) return;
    this.#sessions.delete(oldest.id);
    this.#onEvict?.(oldest, 'lru');
    await oldest.close().catch(() => {});
  }

  /** 清扫所有过期会话；返回清掉的条数（测试/日志用）。 */
  async sweep(): Promise<number> {
    const now = this.#now();
    let removed = 0;
    for (const [id, session] of [...this.#sessions]) {
      if (now - session.lastUsedAt <= this.#ttlMs) continue;
      this.#sessions.delete(id);
      this.#onEvict?.(session, 'ttl');
      removed += 1;
      void session.close().catch(() => {});
    }
    return removed;
  }

  /** 起后台清扫；`unref()` 保证它不阻止进程退出。 */
  startSweeper(intervalMs: number): void {
    if (this.#sweeper) return;
    this.#sweeper = setInterval(() => {
      void this.sweep();
    }, intervalMs);
    this.#sweeper.unref?.();
  }

  stopSweeper(): void {
    if (!this.#sweeper) return;
    clearInterval(this.#sweeper);
    this.#sweeper = undefined;
  }

  async closeAll(): Promise<void> {
    this.stopSweeper();
    const all = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(all.map((session) => session.close().catch(() => {})));
  }
}
