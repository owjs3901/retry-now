/**
 * `@retry-now/opencode` native model-string parsing.
 *
 * Mirrors the opencode server's `provider.parseModel`: a model string is split on its FIRST
 * slash into `providerID` + `modelID`, so an embedded slash (e.g. an OpenRouter sub-path) stays
 * part of the model id. A string with no slash, an empty side, or an empty input is not a valid
 * `provider/model` pair and yields `undefined` so the caller can fall back to the agent default.
 */
import { expect, test } from 'bun:test'

import { parseModel } from '../model.ts'

test('splits a plain provider/model pair on the slash', () => {
  expect(parseModel('anthropic/claude-sonnet-4')).toEqual({
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4',
  })
})

test('keeps an embedded slash inside the model id (first-slash split only)', () => {
  expect(parseModel('openrouter/deepseek/deepseek-chat')).toEqual({
    providerID: 'openrouter',
    modelID: 'deepseek/deepseek-chat',
  })
})

test('returns undefined for an empty string', () => {
  expect(parseModel('')).toBeUndefined()
})

test('returns undefined when there is no slash', () => {
  expect(parseModel('anthropic')).toBeUndefined()
})

test('returns undefined when the provider side is empty', () => {
  expect(parseModel('/claude-sonnet-4')).toBeUndefined()
})

test('returns undefined when the model side is empty', () => {
  expect(parseModel('anthropic/')).toBeUndefined()
})
