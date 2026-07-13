/**
 * Internal message used to ask the Herman extension to refresh its model list.
 *
 * The desktop sends this as a prompt command via the agent RPC. The Herman
 * extension intercepts it in its `input` event handler, performs a silent
 * refresh of the server models, and returns `handled` so the prompt is not
 * recorded as a user message.
 */
export const HERMAN_REFRESH_MODELS_MESSAGE = "__herman_refresh_models__";
