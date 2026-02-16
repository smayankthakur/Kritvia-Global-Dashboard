export interface LlmGenerateArgs {
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
  maxTokens: number;
  temperature: number;
}

export interface LlmGenerateResult {
  json: unknown;
  text?: string;
  usage?: {
    tokensIn?: number;
    tokensOut?: number;
  };
  model?: string;
  provider?: string;
}

export interface LlmProvider {
  generate(args: LlmGenerateArgs): Promise<LlmGenerateResult>;
}
