/**
 * Model-string parsing for the opencode-native backend.
 *
 * opencode identifies a model as `providerID/modelID` and splits on the FIRST slash
 * (`provider.parseModel` in the opencode server), so an embedded slash — an OpenRouter sub-path
 * like `openrouter/deepseek/deepseek-chat` — stays part of the model id. This mirrors that split
 * so a `.retry-now/config.json` model string can be mapped onto a `session.prompt`
 * `model: { providerID, modelID }` body.
 */

/**
 * Split a `providerID/modelID` string on its first slash.
 *
 * Returns `undefined` — the caller's signal to fall back to the agent's default model — when the
 * input is empty, has no slash, or leaves either side empty (`''`, `'anthropic'`, `'/model'`,
 * `'provider/'`). Any slash after the first is kept inside `modelID`.
 */
export function parseModel(
  model: string,
): { providerID: string; modelID: string } | undefined {
  const [providerID, ...rest] = model.split('/')
  if (
    providerID === undefined ||
    providerID.length === 0 ||
    rest.length === 0
  ) {
    return undefined
  }
  const modelID = rest.join('/')
  if (modelID.length === 0) return undefined
  return { providerID, modelID }
}
