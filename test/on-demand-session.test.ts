import { describe, expect, it } from 'vitest';

import { invokeTool } from '../src/core/invoke.js';
import { OnDemandToolset } from '../src/on-demand/session.js';
import type { OnDemandConfig } from '../src/on-demand/config.js';
import { registry } from '../src/sources/index.js';

/**
 * 按需展开会话的单元测试：初始 2 个元工具、find 后 top-N 展开、幂等、上限、会话隔离。
 *
 * 这些判据与 `scripts/check-on-demand.mjs` 的 A1/A2/A5/A6 同源，只是不经过 HTTP 传输层：
 * 传输层另由 test/on-demand-http.test.ts 与验收脚本覆盖，两层都要有，缺一层就等于
 * "单测过了、链路上不成立"。
 */

const QUESTION = '小麦 春化 已知基因';
/** 候选 ≥ 6 的问题：用于验证「每次 top-5」与累计上限，窄问题只有 2 个候选。 */
const BROAD_QUESTION = '小麦 基因 表达 变异 同源';

function config(overrides: Partial<OnDemandConfig> = {}): OnDemandConfig {
  return {
    enabled: true,
    notify: true,
    perCallMax: 5,
    softMax: 40,
    hardMax: 80,
    sessionTtlMs: 1_800_000,
    sessionMax: 64,
    ...overrides,
  };
}

function toolset(overrides: Partial<OnDemandConfig> = {}): OnDemandToolset {
  return new OnDemandToolset(registry, { config: config(overrides), version: 'test+svc.1' });
}

async function find(session: OnDemandToolset, question = QUESTION): Promise<{ text: string; raw: Record<string, unknown> }> {
  const tool = session.getTool('hub_find_sources');
  if (!tool) throw new Error('hub_find_sources 不在会话里');
  const result = await invokeTool(tool, { question, species_hint: '小麦' });
  return { text: result.text, raw: result.raw as Record<string, unknown> };
}

describe('按需展开会话：初始工具集', () => {
  it('初始只有 2 个元工具（不是 49），且业务工具一个都取不到', () => {
    const session = toolset();
    expect(session.listTools().map((tool) => tool.name)).toEqual(['hub_find_sources', 'hub_status']);
    expect(session.getTool('wheatomics_search_known_genes')).toBeUndefined();
    expect(session.getTool('hub_status')).toBeDefined();
  });

  it('未加载的元工具以外的一切（包括未知名字）都不可调用', () => {
    const session = toolset();
    expect(session.getTool('hub_does_not_exist')).toBeUndefined();
    expect(session.getTool('wheatomics_anything')).toBeUndefined();
  });
});

describe('按需展开会话：find 后展开', () => {
  it('hub_find_sources 把 top-N 候选装进本会话，并发一次 list_changed', async () => {
    const session = toolset();
    const notifications: string[][] = [];
    session.setOnToolsChanged((added) => notifications.push([...added]));

    const before = session.listTools().length;
    const { raw } = await find(session);
    const expansion = raw.expansion as {
      added: string[];
      rejected: string[];
      perCallMax: number;
      hardMax: number;
      softMax: number;
      totalLoadedBusiness: number;
    };
    expect(expansion).toBeDefined();
    // 该问题实测 2 个候选：「每次 top 3–5」是上限区间，不是"至少 3 个"；
    // top-5 截断另用 BROAD_QUESTION（6 个候选）验证。
    expect(expansion.added.length).toBeGreaterThanOrEqual(1);
    expect(expansion.added.length).toBeLessThanOrEqual(5);
    expect(expansion.perCallMax).toBe(5);
    expect(expansion.hardMax).toBe(80);
    expect(expansion.softMax).toBe(40);

    const after = session.listTools();
    expect(after.length).toBe(before + expansion.added.length);
    for (const name of expansion.added) {
      expect(after.map((tool) => tool.name)).toContain(name);
      expect(session.getTool(name)).toBeDefined();
    }
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual(expansion.added);
  });

  it('正文写明「已展开」并可指出下一步要调的工具', async () => {
    const session = toolset();
    const { text, raw } = await find(session);
    const added = (raw.expansion as { added: string[] }).added;
    expect(text).toContain('展开：本次新增');
    expect(text).toContain(added[0]!);
    expect(text).toContain('已展开');
    expect(text).toContain(`直接调 ${added[0]}`);
  });

  it('幂等：同样的 find 再问一次，不重复注册、不再发通知', async () => {
    const session = toolset();
    const notifications: string[][] = [];
    session.setOnToolsChanged((added) => notifications.push([...added]));
    await find(session);
    const countAfterFirst = session.listTools().length;

    const { raw, text } = await find(session);
    const expansion = raw.expansion as { added: string[]; alreadyLoaded: string[] };
    expect(expansion.added).toHaveLength(0);
    expect(expansion.alreadyLoaded.length).toBeGreaterThan(0);
    expect(session.listTools().length).toBe(countAfterFirst);
    expect(notifications).toHaveLength(1);
    expect(text).toContain('本次新增 0 个');
  });

  it('每次上限压到 2 时，一次 find 最多装 2 个', async () => {
    const session = toolset({ perCallMax: 2 });
    const { raw } = await find(session, BROAD_QUESTION);
    expect((raw.expansion as { added: string[] }).added).toHaveLength(2);
  });

  it('默认每次上限 5：6 个候选只展开前 5 个', async () => {
    const session = toolset();
    const { raw } = await find(session, BROAD_QUESTION);
    const expansion = raw.expansion as { added: string[]; rejected: string[] };
    expect(expansion.added).toHaveLength(5);
    expect(expansion.rejected.length).toBeGreaterThan(0);
    expect(session.listTools()).toHaveLength(2 + 5);
  });

  it('软建议：加载数超过 softMax 时正文警示，但继续展开（不拒绝）', async () => {
    const session = toolset({ perCallMax: 3, softMax: 2 });
    const { text, raw } = await find(session, BROAD_QUESTION);
    expect((raw.expansion as { added: string[] }).added).toHaveLength(3);
    expect(text).toContain('超过软建议');
  });

  it('硬上限：达到 hardMax 后不再展开，正文给出退路且不发通知', async () => {
    const session = toolset({ perCallMax: 3, hardMax: 3, softMax: 40 });
    const notifications: string[][] = [];
    session.setOnToolsChanged((added) => notifications.push([...added]));
    await find(session, BROAD_QUESTION);
    expect(session.listTools()).toHaveLength(2 + 3);

    const { text, raw } = await find(session, BROAD_QUESTION);
    const expansion = raw.expansion as { added: string[]; rejected: string[]; reason?: string };
    expect(expansion.added).toHaveLength(0);
    expect(expansion.reason).toBe('hard-limit');
    expect(text).toContain('已达会话硬上限 3');
    expect(text).toContain('显式订阅');
    expect(session.listTools()).toHaveLength(2 + 3);
    expect(notifications).toHaveLength(1);
  });
});

describe('按需展开会话：隔离与静态回滚', () => {
  it('两个会话各自展开，工具集不串', async () => {
    const first = toolset();
    const second = toolset();
    await find(first);
    expect(first.listTools().length).toBeGreaterThan(2);
    expect(second.listTools().map((tool) => tool.name)).toEqual(['hub_find_sources', 'hub_status']);
    expect(second.getTool('wheatomics_search_known_genes')).toBeUndefined();
  });

  it('PLANTOMICS_ON_DEMAND=0 的静态注册表仍是 49（会话工具集不参与回滚）', () => {
    expect(registry.listTools()).toHaveLength(49);
  });
});
