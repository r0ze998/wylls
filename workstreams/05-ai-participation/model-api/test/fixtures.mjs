// Recorded-SHAPE fixtures: the field names follow the providers' official references (contract.mjs lists
// them); every value is invented. None of these came from a real API call.

export const claude200 = (over = {}) => ({
  status: 200, headers: { 'request-id': 'req_fixture_0001' },
  body: {
    id: 'msg_fixture_0001', type: 'message', role: 'assistant', model: 'claude-fixture-model',
    content: [{ type: 'text', text: '{"proposals":[{"request":"R-1","action":"Train","fields":{"unit":0,"n":100},"reason":"defend"}],"skipped":[]}' }],
    stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
    usage: { input_tokens: 1200, cache_creation_input_tokens: 300, cache_read_input_tokens: 2000, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 },
      output_tokens: 150, output_tokens_details: { thinking_tokens: 40 }, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: 'standard', speed: 'standard', inference_geo: 'global' },
    ...over,
  },
});

export const claudeError = (status, type, headers = {}) => ({ status, headers: { 'request-id': 'req_fixture_err', ...headers }, body: { type: 'error', error: { type, message: 'fixture' }, request_id: 'req_fixture_err' } });

export const gpt200 = (over = {}) => ({
  status: 200, headers: { 'x-request-id': 'req_fixture_gpt_0001' },
  body: {
    id: 'resp_fixture_0001', object: 'response', status: 'completed', model: 'gpt-fixture-model',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"proposals":[{"request":"R-1","action":"Train","fields":{"unit":0,"n":100},"reason":"defend"}],"skipped":[]}' }] }],
    usage: { input_tokens: 3500, input_tokens_details: { cached_tokens: 2000, cache_write_tokens: 300 }, output_tokens: 150, output_tokens_details: { reasoning_tokens: 40 }, total_tokens: 3650 },
    ...over,
  },
});

export const gptError = (status, code, headers = {}) => ({ status, headers: { 'x-request-id': 'req_fixture_gpt_err', ...headers }, body: { error: { type: status === 429 ? 'rate_limit_error' : 'server_error', code, message: 'fixture' } } });
