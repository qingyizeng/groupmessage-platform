import { Ajv, type ValidateFunction } from 'ajv';

export type ToolName = 'get_recent_messages' | 'send_message' | 'kick_user' | 'finish';

export interface ToolDefinition {
  name: ToolName;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, object>;
    required: string[];
    additionalProperties: false;
  };
}

/** Exactly the four tools of section 2.2. The same schemas are sent to the agent and used to validate its input. */
export const TOOLS: ToolDefinition[] = [
  {
    name: 'get_recent_messages',
    description:
      'Returns the most recent messages of the group in ascending sentAt order, including the trigger messages and ' +
      'messages that arrived during this run. At most 50 messages; longer texts are truncated to 500 characters.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many recent messages to return (max 50).' } },
      required: ['limit'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_message',
    description:
      'Sends a text message to the group as one of our service accounts. Repeating a call with the same ' +
      'idempotency_key does not send again; it returns the current status of the first message.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 4000, description: 'Message text.' },
        idempotency_key: { type: 'string', minLength: 1, maxLength: 200, description: 'Unique key for this message.' },
      },
      required: ['text', 'idempotency_key'],
      additionalProperties: false,
    },
  },
  {
    name: 'kick_user',
    description: 'Removes a user from the group. Only allowed when the group policy enables auto-kick.',
    input_schema: {
      type: 'object',
      properties: {
        platform_user_id: { type: 'string', minLength: 1, description: 'platformUserId of the user to remove.' },
        reason: { type: 'string', description: 'Why the user is removed.' },
      },
      required: ['platform_user_id', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish',
    description: 'Ends this run. Call it when there is nothing more to do.',
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'Short summary of what was done.' } },
      required: ['summary'],
      additionalProperties: false,
    },
  },
];

const ajv = new Ajv({ allErrors: true, strict: true });
const validators = new Map<string, ValidateFunction>(TOOLS.map((t) => [t.name, ajv.compile(t.input_schema)]));

export function isKnownTool(name: string): name is ToolName {
  return validators.has(name);
}

/** Returns null when valid, otherwise a readable description of what is wrong. */
export function validateToolInput(name: ToolName, input: unknown): string | null {
  const validate = validators.get(name)!;
  if (validate(input)) return null;
  return ajv.errorsText(validate.errors, { dataVar: 'input' });
}
