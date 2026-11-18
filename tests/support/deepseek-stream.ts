/** OpenAI-compatible SSE fixture for the real installed DeepSeek SDK, never a paid endpoint. */
export function deepseekStreamResponse(text: string, finishReason = 'stop', model = 'fixture-vision'): Response {
  const chunk = (choices: unknown[], usage?: unknown) => `data: ${JSON.stringify({ id: 'fixture-completion', object: 'chat.completion.chunk', created: 0, model, choices, ...(usage ? { usage } : {}) })}\n\n`;
  const body = chunk([{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }])
    + chunk([{ index: 0, delta: {}, finish_reason: finishReason }], { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 })
    + 'data: [DONE]\n\n';
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}
