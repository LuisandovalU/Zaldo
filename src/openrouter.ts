import OpenAI from "openai";
import type { Completer } from "./agent.js";
import type { AppConfig } from "./config.js";
import { audioFormat } from "./whatsapp.js";

export function openRouterCompleter(config: AppConfig): Completer {
  const client = new OpenAI({
    apiKey: config.openRouterKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/LuisandovalU/Zaldo",
      "X-Title": "Zaldo",
    },
  });
  return async ({ messages, tools }) => {
    const response = await client.chat.completions.create(
      {
        model: config.openRouterModel,
        messages: messages.map((message) => {
          if (message.role === "tool") {
            return { role: "tool" as const, tool_call_id: message.tool_call_id ?? "", content: message.content ?? "" };
          }
          if (message.tool_calls?.length) {
            return {
              role: "assistant" as const,
              content: message.content,
              tool_calls: message.tool_calls,
            };
          }
          return { role: message.role as "system" | "user" | "assistant", content: message.content ?? "" };
        }),
        tools: tools as OpenAI.Chat.ChatCompletionTool[],
        tool_choice: "auto",
      },
      { timeout: 30_000 },
    );
    const choice = response.choices[0]?.message;
    const toolCalls = (choice?.tool_calls ?? []).flatMap((call) => {
      if (call.type !== "function") return [];
      return [
        {
          id: call.id,
          type: "function" as const,
          function: { name: call.function.name, arguments: call.function.arguments },
        },
      ];
    });
    return { content: choice?.content ?? null, toolCalls };
  };
}

export async function transcribeWithOpenRouter(
  config: AppConfig,
  bytes: Uint8Array,
  mime: string,
): Promise<string> {
  const response = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openRouterKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.transcribeModel,
      language: "es",
      input_audio: {
        data: Buffer.from(bytes).toString("base64"),
        format: audioFormat(mime),
      },
    }),
    signal: AbortSignal.timeout(40_000),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      if (response.ok) return text.trim();
      throw new Error(text.slice(0, 180));
    }
  }
  if (!response.ok) throw new Error(String(body.error ?? body.message ?? "No pude transcribir").slice(0, 180));
  return String(body.text ?? body.transcript ?? "").trim();
}
