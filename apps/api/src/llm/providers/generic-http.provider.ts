import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { LlmGenerateArgs, LlmGenerateResult, LlmProvider } from "./provider.interface";

@Injectable()
export class GenericHttpLlmProvider implements LlmProvider {
  async generate(args: LlmGenerateArgs): Promise<LlmGenerateResult> {
    const endpoint = process.env.LLM_ENDPOINT;
    const apiKey = process.env.LLM_API_KEY;

    if (!endpoint || !apiKey) {
      throw new HttpException(
        {
          code: "LLM_PROVIDER_CONFIG_ERROR",
          message: "LLM provider is not configured."
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL,
        system: args.system,
        user: args.user,
        jsonSchema: args.jsonSchema,
        maxTokens: args.maxTokens,
        temperature: args.temperature
      })
    });

    if (!response.ok) {
      throw new HttpException(
        {
          code: "LLM_PROVIDER_ERROR",
          message: "LLM provider request failed."
        },
        HttpStatus.BAD_GATEWAY
      );
    }

    const payload = (await response.json()) as {
      json?: unknown;
      text?: string;
      usage?: { tokensIn?: number; tokensOut?: number };
      model?: string;
      provider?: string;
      output?: string;
    };

    let json = payload.json;
    if (json === undefined && payload.output) {
      try {
        json = JSON.parse(payload.output);
      } catch {
        json = null;
      }
    }

    return {
      json,
      text: payload.text,
      usage: payload.usage,
      model: payload.model,
      provider: payload.provider ?? "generic-http"
    };
  }
}
