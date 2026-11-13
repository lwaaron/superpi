import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * 扩展 UI 探针（人工验证用，不参与 npm test）。
 *
 * 为什么留在仓库里：pi 的扩展 UI 是**唯一**无法用替身覆盖的协议面 —— 它的时序是
 * 「pi 侧命令挂起等回答」，而回答必须来自真实点击。0.3.0 的四个对话框（select /
 * confirm / input / editor）与五个单向方法（notify / setStatus / setWidget /
 * setTitle / set_editor_text）都是靠它一次性验证完的，删掉就没有复现手段了。
 *
 * 用法（会改动 ~/.pi，验证完请删）：
 *   1. 复制到 pi 的全局扩展目录，任一形式：
 *        %USERPROFILE%\.pi\agent\extensions\pi-ext-ui-probe.ts
 *      或 %USERPROFILE%\.pi\agent\extensions\ui-probe\index.ts
 *      （发现规则见 pi 的 docs/extensions.md:129-136）
 *   2. 重启 pi 会话（面板里按「重连」，或 DELETE /sessions/<id> 后重新创建）。
 *      扩展在进程启动时加载，只刷新页面不够。
 *   3. 面板里输入 /dsh-ui-probe 回车，按顺序会弹：select → confirm → input → editor。
 *      每答一个，顶部都会出现一行「select -> Beta」这样的回显 notice。
 *   4. /dsh-ui-notify 验证五个单向方法：警告 notice、状态栏、widget 两行、标题、编辑器回填。
 *   5. 验证完删除该文件并再次重启 pi 会话，避免它长期留在你的 pi 里。
 *
 * 关键断言（不通过就是面板有 bug，不是探针有 bug）：
 *   · 弹窗出现时，那条 prompt 命令**不能**先超时（旧缺陷：红条与对话框并存）；
 *   · 每个弹窗的超时倒计时与 pi 自己声明的 timeout 一致（pi 没声明时用 5 分钟兜底）；
 *   · 四次都答完后命令正常返回，顶部没有 "pi command timed out" 红条。
 */
export default function (pi: ExtensionAPI) {
	pi.registerCommand("dsh-ui-probe", {
		description: "Exercise every RPC extension UI dialog",
		handler: async (_args, ctx) => {
			const picked = await ctx.ui.select("dsh-ui-probe select", ["Alpha", "Beta", "Gamma"]);
			ctx.ui.notify("select -> " + String(picked), "info");
			const ok = await ctx.ui.confirm("dsh-ui-probe confirm", "Pick Yes to continue");
			ctx.ui.notify("confirm -> " + String(ok), "info");
			const typed = await ctx.ui.input("dsh-ui-probe input", "type something");
			ctx.ui.notify("input -> " + String(typed), "info");
			const edited = await ctx.ui.editor("dsh-ui-probe editor", "line1\nline2");
			ctx.ui.notify("editor -> " + String(edited), "info");
		},
	});

	pi.registerCommand("dsh-ui-notify", {
		description: "Fire-and-forget UI methods",
		handler: async (_args, ctx) => {
			ctx.ui.notify("notify-ok", "warning");
			ctx.ui.setStatus("dsh-probe", "status-ok");
			ctx.ui.setWidget("dsh-probe", ["widget-line-1", "widget-line-2"]);
			ctx.ui.setTitle("title-ok");
			ctx.ui.setEditorText("editor-text-ok");
		},
	});
}
