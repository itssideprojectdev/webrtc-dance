import OpenAI from 'openai/index';
import type {ZodType} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';

export async function makeOpenaiRequest<T>({
  systemMessage,
  userMessage,
  zSchema,
  model = 'gpt-3.5-turbo',
  temperature = 0,
}: {
  systemMessage: string;
  userMessage: string;
  model?: 'gpt-3.5-turbo' | 'gpt-4' | 'gpt-4o' | 'gpt-3.5-turbo-16k';
  zSchema: ZodType<T>;
  temperature?: number;
}): Promise<T | undefined> {
  const client = new OpenAI({fetch: fetch as any, apiKey: process.env.OPENAI_API_KEY});
  const schema = zodToJsonSchema(zSchema);
  let retry = 0;
  while (retry < 3) {
    const result = await client.chat.completions.create({
      // stream: true,
      model: model,
      temperature,
      messages: [
        {role: 'system', content: systemMessage},
        {role: 'user', content: userMessage},
      ],
      functions: [
        {
          name: 'print',
          parameters: schema,
        },
      ],
      function_call: {
        name: 'print',
      },
    });

    console.log(result.usage?.prompt_tokens ?? 0, result.usage?.completion_tokens ?? 0);

    try {
      if (result.choices[0]?.message?.function_call?.arguments) {
        // console.log(JSON.stringify(result, null, 2));
        return new Function('return ' + result.choices[0].message.function_call.arguments)() as T;
      }
      retry++;
      console.log('fail');
      console.log(JSON.stringify(result, null, 2));
    } catch (ex: any) {
      retry++;
      console.log(
        JSON.stringify({
          message: ex.message,
          result: result,
        })
      );
    }
  }
  return undefined;
}
export async function makeOpenaiRequestRaw({
  systemMessage,
  userMessage,
  model = 'gpt-3.5-turbo',
  temperature = 0,
}: {
  systemMessage: string;
  userMessage: string;
  model?: 'gpt-3.5-turbo' | 'gpt-4' | 'gpt-4o' | 'gpt-3.5-turbo-16k';
  temperature?: number;
}): Promise<string | undefined> {
  const client = new OpenAI({fetch: fetch as any, apiKey: process.env.OPENAI_API_KEY});
  const result = await client.chat.completions.create({
    // stream: true,
    model: model,
    temperature,
    messages: [
      {role: 'system', content: systemMessage},
      {role: 'user', content: userMessage},
    ],
  });

  console.log(result.usage?.prompt_tokens ?? 0, result.usage?.completion_tokens ?? 0);

  return result.choices[0]?.message?.content ?? '';
}
