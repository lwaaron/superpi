import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { scanTextBytes } from './superpi-text-bytes.mjs'

const CUSTOM_ANSWER = '其他… / Other…'
const ANSWER_PLACEHOLDER = '输入回答 / Type an answer'
const WAIT_MS = 5 * 60_000

type Outcome =
  | { status: 'answered'; answer: string; source: 'option' | 'input' }
  | { status: 'unanswered' | 'aborted' | 'unavailable' | 'invalid'; message: string }

function reply(details: Outcome) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details }
}

export default function askUser(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'ask_user',
    label: 'Ask user',
    description: 'Ask one focused question in the user’s language and wait for their answer. Supply options when there are clear choices. The user can always type their own answer.',
    promptSnippet: 'Ask the user for essential missing information or a decision and wait for their answer.',
    promptGuidelines: [
      'Use ask_user when essential information is missing or the user needs to make a decision before you can proceed. Resolve routine details with available evidence and safe, reversible assumptions.',
      'Call ask_user on its own when further actions depend on the reply. Proceed on an answered result. If no answer is available, leave dependent actions pending and explain what is needed in chat.',
    ],
    parameters: Type.Object({
      question: Type.String({ description: 'One self-contained question, including any context the user needs.', minLength: 1, maxLength: 600 }),
      options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), {
        description: 'Two to five distinct choices. A free-form answer is offered automatically.',
        minItems: 2, maxItems: 5, uniqueItems: true,
      })),
    }, { additionalProperties: false }),
    executionMode: 'sequential',
    annotations: { readOnlyHint: true },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) return reply({ status: 'unavailable', message: 'This session has no interactive UI. Ask the question in chat.' })
      if (signal?.aborted) return reply({ status: 'aborted', message: 'The activity was stopped.' })

      const question = params.question.trim()
      const options = (params.options ?? []).map(option => option.trim())
      if ([question, ...options].some(value => value === '' || !scanTextBytes(value).clean) ||
          options.includes(CUSTOM_ANSWER) || new Set(options).size !== options.length) {
        return reply({ status: 'invalid', message: 'Supply a non-empty question and distinct, valid options. The tool adds the free-form option automatically.' })
      }

      const dialog = { signal, timeout: WAIT_MS }
      let answer: string | undefined
      let source: 'option' | 'input' = 'input'
      if (options.length > 0) {
        const selected = await ctx.ui.select(question, [...options, CUSTOM_ANSWER], dialog)
        if (selected === CUSTOM_ANSWER && !signal?.aborted) {
          answer = await ctx.ui.input(question, ANSWER_PLACEHOLDER, dialog)
        } else if (selected !== undefined && options.includes(selected)) {
          answer = selected
          source = 'option'
        }
      } else {
        answer = await ctx.ui.input(question, ANSWER_PLACEHOLDER, dialog)
      }

      if (signal?.aborted) return reply({ status: 'aborted', message: 'The activity was stopped.' })
      if (answer === undefined || answer.trim() === '') return reply({ status: 'unanswered', message: 'The user did not provide an answer.' })
      return reply({ status: 'answered', answer, source })
    },
  })
}
