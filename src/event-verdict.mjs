/**
 * 事件装饰器：把「这一轮交付了吗」的判读挂到 pi 的 `message_end` 上（0.18.0）。
 *
 * ---------------------------------------------------------------------------
 * 为什么判读在 host 做，而不是在面板做（这是 0.18.0 的架构改动本身）
 *
 * 0.16.2~0.17.3 的形状是「表在契约、算法在面板」：`/contract` 下发判定表，
 * `client.js` 按表实现一份 80 行的孪生判据。它带来两个代价：
 *
 *   ① 同一份知识有两个实现。门禁只能靠"同一批样本喂两边、结论相等"来对账，
 *      而"两边都漏掉同一类新形态"这种共同盲区永远测不出来。
 *   ② **契约是面板判读的前置依赖。** 事件早于 `/contract` 到达时，判据只能返回
 *      `none`，而 `message_end` 只处理一次、不会重算 —— 那一轮的提示永久消失。
 *      0.17.3 的修法是把启动顺序改成「契约先就位再开会话」，那是对的症状处理：
 *      依赖还在，只是被排队绕开了。
 *
 * 现在判读在 host 发生一次，结果作为 `record.verdict` 随事件下发，面板只渲染。
 * 结果是：面板里没有第二份实现，也就不需要契约，竞态**随依赖一起消失**。
 *
 * ---------------------------------------------------------------------------
 * 只加字段，不改 pi 的事件（薄适配层的边界）
 *
 * 装饰器返回的对象 = pi 的原始记录 + 一个 `verdict` 字段。pi 的字段一个都不动，
 * host 也不会把装饰后的对象发回 pi（只用于入环与下发）。这与 `withProjectIdentity`
 * 给快照补 `displayPath` / `projectKey` 是同一个范式。
 */

import { detectTurnVerdict } from '../extensions/superpi-turn-verdict.mjs'

/**
 * 装饰一条 pi 的 RPC 记录。**永不抛**（调用点在事件热路径上）。
 *
 * @param {any} record pi 的 JSONL 记录
 * @returns {any} 原对象（就地加字段）；不是 assistant 的 message_end 时原样返回
 */
export function decoratePiEvent(record) {
  try {
    if (record === null || typeof record !== 'object') return record
    if (record.type !== 'message_end') return record
    const message = record.message
    if (message === null || typeof message !== 'object' || message.role !== 'assistant') return record
    /**
     * 每条 assistant 消息都带 verdict（哪怕是 `{delivered:true, kind:'none'}`）。
     *
     * 不省这几个字节的原因：面板靠这个字段**清除**上一轮的提示。
     * 只在"没交付"时附带，等于让面板把"没判定"和"已交付"混成同一件事 ——
     * 那会造出"这一轮好了但红条还挂着"的残留提示，比多几十字节贵得多。
     */
    record.verdict = detectTurnVerdict(message)
    return record
  } catch {
    // 判读失败最多是没有提示，绝不能让一条事件丢掉（丢事件 = 会话看起来卡住）。
    return record
  }
}
