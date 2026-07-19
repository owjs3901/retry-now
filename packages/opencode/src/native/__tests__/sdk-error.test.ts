/**
 * `@retry-now/opencode` SDK error classification.
 *
 * `classifySdkError` maps an `AssistantMessage.error` (the installed @opencode-ai/sdk union:
 * ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError | ApiError,
 * types.gen.d.ts:106) onto the driver's two outcomes. A definitive rate-limit — an `ApiError`
 * (name "APIError") carrying HTTP 429, or any member whose rendered message matches the house
 * quota markers — is `'quota'` so the loop can PAUSE instead of burning crash-retries. Every
 * other shape, including auth failures, aborts, and unknown/undefined values, is `'crash'`.
 *
 * The object literals below mirror the real .d.ts field names (ApiError.name === "APIError" at
 * :87, data.statusCode at :90, data.message at :89) and are passed as `unknown`, so the pure
 * classifier is exercised without importing the (undeclared) SDK package.
 */
import { expect, test } from 'bun:test'

import { classifySdkError } from '../sdk-error.ts'

test('classifies an ApiError carrying HTTP 429 as quota', () => {
  expect(
    classifySdkError({
      name: 'APIError',
      data: {
        message: 'Too Many Requests',
        statusCode: 429,
        isRetryable: true,
      },
    }),
  ).toBe('quota')
})

test('classifies a rate-limit message with no 429 status as quota', () => {
  expect(
    classifySdkError({
      name: 'APIError',
      data: { message: 'rate limit exceeded', isRetryable: true },
    }),
  ).toBe('quota')
})

test('classifies a quota phrase surfaced on a non-ApiError shape as quota', () => {
  expect(
    classifySdkError({
      name: 'UnknownError',
      data: { message: 'usage limit reached for this account' },
    }),
  ).toBe('quota')
})

test('classifies a provider auth error as crash', () => {
  expect(
    classifySdkError({
      name: 'ProviderAuthError',
      data: {
        providerID: 'anthropic',
        message: 'invalid API key for anthropic',
      },
    }),
  ).toBe('crash')
})

test('classifies an aborted message as crash', () => {
  expect(
    classifySdkError({
      name: 'MessageAbortedError',
      data: { message: 'Message aborted' },
    }),
  ).toBe('crash')
})

test('classifies a non-429 ApiError with a benign message as crash', () => {
  expect(
    classifySdkError({
      name: 'APIError',
      data: {
        message: 'internal server error',
        statusCode: 500,
        isRetryable: false,
      },
    }),
  ).toBe('crash')
})

test('classifies undefined as crash', () => {
  expect(classifySdkError(undefined)).toBe('crash')
})

test('classifies null as crash', () => {
  expect(classifySdkError(null)).toBe('crash')
})

test('classifies an unrelated object as crash', () => {
  expect(classifySdkError({ foo: 'bar' })).toBe('crash')
})
