/**
 * host 半区冒烟测试：不用 DSH，用桩 ctx 把 apply() 跑起来，直接打 HTTP 面。
 * 目的：在接进 DSH 之前先证明「spawn pi → prompt → 事件流」这条链路是通的。
 *
 * 跑法：node test/host-smoke.mjs
 */
import { runSmoke } from './_harness.mjs'

process.exit(await runSmoke({ entry: new URL('../index.js', import.meta.url).href }))
